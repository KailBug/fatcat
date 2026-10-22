import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createAgent } from "@fatcat/runtime/agent";
import type { Config } from "@fatcat/runtime/config";
import { HarnessError } from "@fatcat/runtime/errors";
import { createTurnReporter, type ReportEvent } from "@fatcat/runtime/execution-report";
import type { LoopEvent } from "@fatcat/runtime/loop";
import { validateModelSelection } from "@fatcat/runtime/model-catalog";
import { resolveModelProtocol } from "@fatcat/runtime/model-protocol";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { experimentDigest, type ArtifactReference, type Experiment } from "./experiment.js";
import { inside, inspectExecution, sha256, writeArtifact } from "./artifacts.js";
import { loadMaterials } from "./materials.js";
import { parseResult, serializeResult, type EvalResult, type EvalUsage } from "./result.js";
import { canonicalJson, count, object } from "./validation.js";

export interface Attempt {
	sampleId: string;
	repetition: number;
}

export interface SessionEvaluationOptions {
	experiment: Experiment;
	sourceRoot: string;
	outputRoot: string;
}

export interface SessionEvaluationDependencies {
	/** Trusted test transport factory; one fresh instance per attempt. Never forwarded in reports. */
	createTransport: (attempt: Attempt) => typeof fetch;
}

export interface SessionEvaluation {
	result: EvalResult;
	answer: string | null;
	artifactDirectory: string;
	evidence: ArtifactReference;
}

function usageFrom(events: readonly ReportEvent[]): EvalUsage {
	let requests = 0;
	const reports: { input: number; output: number; cached: number | null }[] = [];
	function observe(event: LoopEvent) {
		if (event.type === "subagent_event") observe(event.event);
		else if (event.type === "model_request") requests++;
		else if (event.type === "model_usage" && event.usage) reports.push({ input: event.usage.promptTokens,
			output: event.usage.completionTokens, cached: event.usage.cachedPromptTokens ?? null });
	}
	for (const event of events) if (event.type !== "execution_report") observe(event);
	const input = reports.reduce((total, report) => total + report.input, 0);
	const output = reports.reduce((total, report) => total + report.output, 0);
	const cached = reports.reduce((total, report) => total + (report.cached ?? 0), 0);
	const known = reports.length > 0 && Number.isSafeInteger(input) && Number.isSafeInteger(output);
	return { requests, reportedRequests: reports.length, inputTokens: known ? input : null, outputTokens: known ? output : null,
		cachedInputTokens: known && reports.every((report) => report.cached !== null) && Number.isSafeInteger(cached) ? cached : null };
}

/** Run the product Session path once; orchestration never owns Session state or approvals. */
export async function runSessionEvaluation(options: SessionEvaluationOptions, dependencies: SessionEvaluationDependencies,
	attempt: Attempt, signal?: AbortSignal): Promise<SessionEvaluation> {
	if (typeof dependencies?.createTransport !== "function") throw new Error("An explicit injected transport factory is required.");
	const materials = await loadMaterials(options.experiment, options.sourceRoot);
	const { experiment, policy } = materials;
	count(attempt.repetition, "repetition", 1);
	if (!experiment.dataset.selectedIds.includes(attempt.sampleId) || attempt.repetition > experiment.repetitions) {
		throw new Error("Attempt is outside the experiment plan.");
	}
	const sample = materials.samples.find((item) => item.id === attempt.sampleId)!;
	const parameters = object(experiment.model.parameters, ["region", "thinking"], "model.parameters");
	const selection = validateModelSelection({ provider: experiment.model.provider, model: experiment.model.id, ...parameters });
	const execution = await inspectExecution();
	if (canonicalJson(experiment.code) !== canonicalJson(execution.code)
		|| canonicalJson(experiment.environment) !== canonicalJson(execution.environment)) throw new Error("Experiment code or environment differs from this execution.");
	const fingerprint = experimentDigest(experiment);
	const output = resolve(options.outputRoot, fingerprint);
	await mkdir(output, { recursive: true });
	const artifactDirectory = join(output, `${sha256(attempt.sampleId)}-${attempt.repetition}`);
	// Atomic claim also rejects concurrent duplicates across provider instances/processes.
	await mkdir(artifactDirectory);
	const start = performance.now();
	let temporary: string | undefined;
	let status: EvalResult["status"] = "infra_error";
	let reason: string | null = "Attempt preparation failed.";
	let answer: string | null = null;
	let session: SessionManager | undefined;
	let store: SessionStore | undefined;
	let workspace: string | undefined;
	const events: ReportEvent[] = [];
	const requests: unknown[] = [];
	const observe = createTurnReporter((event) => events.push(structuredClone(event)));
	const deadline = new AbortController();
	const runSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	const timer = setTimeout(() => deadline.abort(), experiment.budget.perAttempt.durationMs);
	try {
		if (runSignal.aborted) throw new HarnessError("CANCELLED", "Run cancelled.");
		temporary = await mkdtemp(join(tmpdir(), "fatcat-eval-attempt-"));
		workspace = join(temporary, "workspace");
		await mkdir(workspace);
		for (const file of sample.files) {
			const path = join(workspace, file.path);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, file.bytes, { flag: "wx" });
		}
		const injected = dependencies.createTransport({ ...attempt });
		const transport: typeof fetch = async (input, init) => {
			// SDK headers include credentials; capture only the prepared JSON body.
			if (typeof init?.body === "string") requests.push(JSON.parse(init.body));
			return injected(input, init);
		};
		const config: Config = { provider: selection.provider, region: selection.region, model: selection.model,
			thinking: selection.thinking, apiKey: "fatcat-eval-injected", maxIterations: experiment.budget.perAttempt.requests,
			maxRequestBytes: policy.maxRequestBytes, requestTimeoutMs: policy.requestTimeoutMs, autoCompaction: policy.autoCompaction };
		const tools = await createTools(workspace, policy.permission, undefined, { permission: "deny" });
		const agent = createAgent(config, tools, transport);
		store = new SessionStore({ root: join(temporary, "sessions") });
		session = await SessionManager.open(agent, { workspace, store });
		status = "failed";
		answer = await session.run(`${materials.instruction}\n\n${sample.prompt}`, { signal: runSignal, onEvent: observe });
		status = "completed";
		reason = null;
	} catch (error) {
		const code = error instanceof HarnessError ? error.code : "INFRA_ERROR";
		status = deadline.signal.aborted ? "timeout" : signal?.aborted || code === "CANCELLED" ? "cancelled"
			: code === "MODEL_TIMEOUT" ? "timeout" : code === "INFRA_ERROR" || code === "SESSION_STORAGE" ? "infra_error" : "failed";
		reason = `Execution stopped: ${status === "timeout" ? "TIMEOUT" : code}.`;
	} finally {
		clearTimeout(timer);
	}
	let snapshot: unknown = null;
	try {
		if (session && store && workspace) snapshot = await store.load(workspace, session.current.id);
	} catch {
		status = "infra_error";
		reason = "Session evidence could not be read.";
	}
	const usage = usageFrom(events);
	const evidence = await writeArtifact(artifactDirectory, "evidence.json", {
		experiment, execution, attempt, answer, status, failureReason: reason, events, requests, session: snapshot,
		modelSelection: selection, generation: resolveModelProtocol(selection).generation,
		workspace, temporaryRoot: temporary ?? null,
	});
	// Preserve evidence before cleanup, and never delete an arbitrary configured directory.
	try {
		if (temporary) {
			if (!inside(resolve(tmpdir()), resolve(temporary)) || !basename(temporary).startsWith("fatcat-eval-attempt-")) {
				throw new Error("Unexpected temporary directory.");
			}
			await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
		}
	} catch {
		status = "infra_error";
		reason = "Temporary execution resources could not be cleaned up; see evidence for their location.";
	}
	const graded = status === "completed";
	const verdict = graded ? answer === materials.answers[attempt.sampleId] ? "passed" : "failed" : "not_assessed";
	const gradeEvidence = graded ? await writeArtifact(artifactDirectory, "grade.json", {
		grader: experiment.grader, sampleId: sample.id, expected: materials.answers[sample.id], actual: answer, verdict, evidence,
	}) : null;
	const result = parseResult({ schemaVersion: "fatcat.eval.result.v1", experimentId: experiment.id, experimentDigest: fingerprint,
		...attempt, status, grade: { verdict, reason: graded ? "Exact comparison with the separately stored reference answer." : "Execution did not complete.",
			evidence: gradeEvidence ? [evidence, gradeEvidence] : [] }, durationMs: Math.ceil(performance.now() - start), usage, cost: null, failureReason: reason });
	await writeFile(join(artifactDirectory, "result.json"), serializeResult(result), { flag: "wx" });
	return { result, answer, artifactDirectory, evidence };
}
