import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { inspectExecution, sha256 } from "../../src/artifacts.js";
import type { Experiment } from "../../src/experiment.js";
import type { SessionEvaluationOptions } from "../../src/session-runner.js";

export async function sessionFixture(t: TestContext): Promise<SessionEvaluationOptions> {
	const root = await mkdtemp(join(tmpdir(), "fatcat-eval-fixture-"));
	t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
	const sourceRoot = join(root, "materials");
	await mkdir(sourceRoot);
	async function artifact(source: string, content: string) {
		await writeFile(join(sourceRoot, source), content);
		return { source, sha256: sha256(content) };
	}
	const file = await artifact("note.txt", "The launch color is violet.\n");
	const manifest = await artifact("dataset.json", JSON.stringify({ samples: [
		{ id: "read", prompt: "Read note.txt and answer with just the launch color.", files: [{ path: "note.txt", artifact: file }] },
		{ id: "other", prompt: "Read note.txt and answer with just the launch color.", files: [{ path: "note.txt", artifact: file }] },
	] }));
	const prompt = await artifact("prompt.txt", "Use the workspace file as evidence. Do not change it.");
	const policy = await artifact("policy.json", JSON.stringify({ permission: "read-only", maxRequestBytes: 262144, requestTimeoutMs: 5000, autoCompaction: true }));
	const grader = await artifact("grader.json", JSON.stringify({ type: "exact-match", answers: { read: "violet", other: "violet" } }));
	const observed = await inspectExecution();
	const budget = { requests: 4, tokens: 10000, durationMs: 10000, costUsd: null };
	const experiment: Experiment = { schemaVersion: "fatcat.eval.v1", id: "injected-file-reading", code: observed.code,
		environment: observed.environment, evidence: "injected", level: "contract",
		model: { provider: "deepseek", id: "deepseek-flash", parameters: { region: "global", thinking: "off" } },
		dataset: { id: "local-read", version: "1", manifest, sampleIds: ["read", "other"], developmentIds: ["read", "other"],
			holdoutIds: [], selectedIds: ["read", "other"], split: "development", coverage: "full" },
		prompt: { ...prompt, version: "1" }, policy: { ...policy, version: "1" }, grader: { ...grader, version: "1" },
		repetitions: 1, budget: { perAttempt: budget, experiment: { ...budget, requests: 8 } } };
	return { experiment, sourceRoot, outputRoot: join(root, "results") };
}

export function completion(content: string | null, toolCalls?: { id: string; type: "function"; function: { name: string; arguments: string } }[], usage: unknown = {
	prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, prompt_cache_hit_tokens: 20,
}): Response {
	return Response.json({ id: "injected", object: "chat.completion", model: "deepseek-flash", created: 0,
		choices: [{ index: 0, finish_reason: toolCalls ? "tool_calls" : "stop", message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) } }], usage });
}

export function readTransport(answer = "violet", onRequest?: (body: string) => void): typeof fetch {
	let calls = 0;
	return async (_input, init) => {
		onRequest?.(String(init?.body));
		calls++;
		return calls === 1 ? completion(null, [{ id: "read-file", type: "function", function: { name: "read", arguments: '{"path":"note.txt"}' } }]) : completion(answer);
	};
}
