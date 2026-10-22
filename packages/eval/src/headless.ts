import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createAgent } from "@fatcat/runtime/agent";
import type { Config } from "@fatcat/runtime/config";
import { HarnessError } from "@fatcat/runtime/errors";
import { createTurnReporter, type ReportEvent } from "@fatcat/runtime/execution-report";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { canonicalWorkspace, SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { inside } from "./artifacts.js";
import { count, object, text } from "./validation.js";

export interface HeadlessOptions {
	taskCwd: string;
	instruction: string;
	resultDirectory: string;
	permission: { files: "read-only" | "workspace-write"; shell: "deny" | "allow" };
	requests: number;
	durationMs: number;
}

export function parseHeadlessOptions(value: unknown): HeadlessOptions {
	const raw = object(value, ["taskCwd", "instruction", "resultDirectory", "permission", "requests", "durationMs"], "headless options");
	const taskCwd = text(raw.taskCwd, "taskCwd");
	const resultDirectory = text(raw.resultDirectory, "resultDirectory");
	if (!isAbsolute(taskCwd) || !isAbsolute(resultDirectory)) throw new Error("Task and result paths must be absolute.");
	const instruction = text(raw.instruction, "instruction");
	if (Buffer.byteLength(instruction) > 32768) throw new Error("Instruction exceeds 32 KiB.");
	const permission = object(raw.permission, ["files", "shell"], "permission");
	if (permission.files !== "read-only" && permission.files !== "workspace-write"
		|| permission.shell !== "deny" && permission.shell !== "allow"
		|| permission.files === "read-only" && permission.shell !== "deny") {
		throw new Error("Use explicit read-only/deny or workspace-write with allow/deny; interactive approval is unavailable.");
	}
	const requests = count(raw.requests, "requests", 1);
	const durationMs = count(raw.durationMs, "durationMs", 100);
	if (requests > 32 || durationMs > 120000) throw new Error("Injected runs are limited to 32 requests and 120 seconds.");
	return { taskCwd, instruction, resultDirectory, permission: { files: permission.files, shell: permission.shell }, requests, durationMs };
}

/** Execute in the caller's task directory; Session owns state and the runtime owns all tool policy. */
export async function runHeadlessTask(input: HeadlessOptions, createTransport: () => typeof fetch, signal?: AbortSignal) {
	const options = parseHeadlessOptions(input);
	if (typeof createTransport !== "function") throw new Error("An explicit injected transport factory is required.");
	const workspace = await canonicalWorkspace(options.taskCwd);
	// Canonicalize parents before publishing; results and private Session state must stay outside task inputs.
	const output = join(await realpath(dirname(options.resultDirectory)), basename(options.resultDirectory));
	const temporaryParent = await realpath(tmpdir());
	if (inside(workspace, output) || inside(workspace, temporaryParent)) {
		throw new Error("Results and temporary Session storage must be outside the task workspace.");
	}
	await mkdir(output);
	const startedAt = new Date().toISOString();
	const start = performance.now();
	const events: ReportEvent[] = [];
	const requests: unknown[] = [];
	const deadline = new AbortController();
	const runSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	const timer = setTimeout(() => deadline.abort(), options.durationMs);
	let status: "completed" | "cancelled" | "timeout" | "failed" | "infra_error" = "infra_error";
	let failureCode: string | null = null;
	let answer: string | null = null;
	let temporary: string | undefined;
	let session: SessionManager | undefined;
	let store: SessionStore | undefined;
	let tools: Awaited<ReturnType<typeof createTools>> | undefined;
	try {
		if (runSignal.aborted) throw new HarnessError("CANCELLED", "Run cancelled.");
		temporary = await mkdtemp(join(temporaryParent, "fatcat-headless-"));
		const injected = createTransport();
		if (typeof injected !== "function") throw new Error("Transport factory must return a fetch function.");
		const transport: typeof fetch = async (input, init) => {
			// Never retain SDK headers or credentials. This transport has no network fallback.
			if (typeof init?.body === "string") requests.push(JSON.parse(init.body));
			return injected(input, init);
		};
		const config: Config = { provider: "deepseek", region: "global", model: "deepseek-flash", thinking: "off",
			apiKey: "fatcat-headless-injected", maxIterations: options.requests, maxRequestBytes: 262144,
			requestTimeoutMs: Math.min(options.durationMs, 30000), autoCompaction: true };
		tools = await createTools(workspace, options.permission.files, undefined, { permission: options.permission.shell });
		store = new SessionStore({ root: join(temporary, "sessions") });
		session = await SessionManager.open(createAgent(config, tools, transport), { workspace, store });
		status = "failed";
		answer = await session.run(options.instruction, { signal: runSignal, onEvent: createTurnReporter((event) => events.push(structuredClone(event))) });
		status = "completed";
	} catch (error) {
		failureCode = error instanceof HarnessError ? error.code : "INFRA_ERROR";
		status = deadline.signal.aborted ? "timeout" : signal?.aborted || failureCode === "CANCELLED" ? "cancelled"
			: failureCode === "MODEL_TIMEOUT" ? "timeout" : failureCode === "INFRA_ERROR" || failureCode === "SESSION_STORAGE" ? "infra_error" : "failed";
	} finally {
		clearTimeout(timer);
	}
	let snapshot: unknown = null;
	try {
		if (session && store) snapshot = await store.load(workspace, session.current.id);
	} catch {
		status = "infra_error";
		failureCode = "EVIDENCE_READ_FAILED";
	}
	const evidence = { evidence: "injected", startedAt, finishedAt: new Date().toISOString(),
		durationMs: Math.ceil(performance.now() - start), platform: process.platform, node: process.version,
		workspace, options, temporaryRoot: temporary ?? null, status, failureCode, answer, requests, events,
		consumption: session?.contextUsage?.consumption ?? null, session: snapshot,
		commands: tools?.getCommands?.() ?? [], writes: tools?.getWrites?.() ?? [] };
	// Publish interrupted history and command outcomes before removing only our own temporary state.
	await writeFile(join(output, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
	let cleanup: "removed" | "not-created" | "unconfirmed" = temporary ? "unconfirmed" : "not-created";
	try {
		if (temporary) {
			if (!inside(temporaryParent, resolve(temporary)) || !basename(temporary).startsWith("fatcat-headless-")) throw new Error("Unexpected temporary path.");
			await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
			cleanup = "removed";
		}
	} catch {
		status = "infra_error";
		failureCode = "CLEANUP_FAILED";
	}
	const result = { evidence: "injected" as const, status, failureCode, answer, cleanup, evidenceFile: join(output, "evidence.json") };
	await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
	return result;
}
