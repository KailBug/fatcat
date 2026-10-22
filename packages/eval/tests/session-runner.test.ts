import assert from "node:assert/strict";
import { access, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readArtifact, sha256 } from "../src/artifacts.js";
import { runSessionEvaluation } from "../src/session-runner.js";
import { deserializeResult } from "../src/result.js";
import { summarizeExperiment } from "../src/summary.js";
import { completion, readTransport, sessionFixture } from "./fixtures/session.js";

describe("injected Session evaluation", () => {
	it("runs actual file tools, preserves evidence, grades independently and cleans isolated attempts", async (t) => {
		const options = await sessionFixture(t);
		const requests: string[] = [];
		const first = await runSessionEvaluation(options, { createTransport: () => readTransport("violet", (body) => requests.push(body)) }, { sampleId: "read", repetition: 1 });
		assert.equal(first.result.status, "completed");
		assert.equal(first.result.grade.verdict, "passed");
		assert.equal(requests.length, 2);
		assert.match(requests[1]!, /The launch color is violet/);
		assert.doesNotMatch(requests.join("\n"), /exact-match|grader\.json|"answers"/);
		assert.deepEqual(first.result.usage, { requests: 2, reportedRequests: 2, inputTokens: 200, outputTokens: 20, cachedInputTokens: 40 });
		assert.equal(first.result.cost, null);
		const raw = await readArtifact(first.artifactDirectory, first.evidence);
		assert.doesNotMatch(raw.toString(), /fatcat-eval-injected|Authorization/);
		const evidence = JSON.parse(raw.toString());
		assert.equal(evidence.session.attempt, null);
		assert.equal(evidence.session.history.filter((message: { role: string }) => message.role === "user").length, 1);
		assert.ok(evidence.events.some((event: { type: string; ok?: boolean }) => event.type === "tool_result" && event.ok));
		assert.equal(evidence.events.find((event: { type: string }) => event.type === "execution_report").report.taskVerification, "not_assessed");
		await assert.rejects(access(evidence.temporaryRoot));
		assert.deepEqual(deserializeResult(await readFile(join(first.artifactDirectory, "result.json"), "utf8")), first.result);
		const second = await runSessionEvaluation(options, { createTransport: () => readTransport("orange") }, { sampleId: "other", repetition: 1 });
		assert.equal(second.result.status, "completed");
		assert.equal(second.result.grade.verdict, "failed");
		const secondEvidence = JSON.parse((await readArtifact(second.artifactDirectory, second.evidence)).toString());
		assert.notEqual(secondEvidence.session.id, evidence.session.id);
		assert.notEqual(secondEvidence.workspace, evidence.workspace);
		assert.equal(secondEvidence.session.history.filter((message: { role: string }) => message.role === "user").length, 1);
		assert.equal(summarizeExperiment(options.experiment, [first.result, second.result]).successRate, 0.5);
	});

	it("rejects tampered materials, mismatched provenance, unsupported parameters and live execution before transport", async (t) => {
		const options = await sessionFixture(t);
		let calls = 0;
		const dependencies = { createTransport: () => { calls++; return readTransport(); } };
		const attempt = { sampleId: "read", repetition: 1 };
		await assert.rejects(runSessionEvaluation({ ...options, experiment: { ...options.experiment, evidence: "live" } }, dependencies, attempt), /live execution/);
		await assert.rejects(runSessionEvaluation({ ...options, experiment: { ...options.experiment, code: { ...options.experiment.code, gitSha: "a".repeat(40) } } }, dependencies, attempt), /code or environment/);
		await assert.rejects(runSessionEvaluation({ ...options, experiment: { ...options.experiment, model: { ...options.experiment.model,
			parameters: { ...options.experiment.model.parameters, temperature: 0 } } } }, dependencies, attempt), /unsupported fields/);
		await writeFile(join(options.sourceRoot, "note.txt"), "changed");
		await assert.rejects(runSessionEvaluation(options, dependencies, attempt), /digest/);
		assert.equal(calls, 0);
		await assert.rejects(access(options.outputRoot));
	});

	it("retains observed usage for invalid responses and reports unknown usage without filling zeros", async (t) => {
		const options = await sessionFixture(t);
		const failed = await runSessionEvaluation(options, { createTransport: () => async () => Response.json({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) }, { sampleId: "read", repetition: 1 });
		assert.equal(failed.result.status, "failed");
		assert.equal(failed.result.grade.verdict, "not_assessed");
		assert.equal(failed.result.usage.inputTokens, 12);
		const unknown = await runSessionEvaluation(options, { createTransport: () => async () => completion("violet", undefined, null) }, { sampleId: "other", repetition: 1 });
		assert.equal(unknown.result.usage.reportedRequests, 0);
		assert.equal(unknown.result.usage.inputTokens, null);
		assert.equal(unknown.result.cost, null);
	});

	it("propagates cancellation and timeouts, waits for transport settlement and preserves interrupted history", async (t) => {
		for (const timeout of [false, true]) {
			const options = await sessionFixture(t);
			if (timeout) options.experiment.budget.perAttempt.durationMs = 1000;
			const controller = new AbortController();
			let settled = false;
			const result = await runSessionEvaluation(options, { createTransport: () => async (_input, init) => {
				if (!timeout) controller.abort();
				await new Promise<void>((resolve) => {
					if (init?.signal?.aborted) resolve();
					else init?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				settled = true;
				throw new DOMException("Aborted", "AbortError");
			} }, { sampleId: "read", repetition: 1 }, controller.signal);
			assert.equal(result.result.status, timeout ? "timeout" : "cancelled");
			assert.equal(settled, true);
			assert.equal(result.result.grade.verdict, "not_assessed");
			const evidence = JSON.parse((await readArtifact(result.artifactDirectory, result.evidence)).toString());
			assert.equal(evidence.session.attempt.status, "cancelled");
			await assert.rejects(access(evidence.temporaryRoot));
		}
	});

	it("allows independent concurrent samples but rejects duplicate attempt publication", async (t) => {
		const options = await sessionFixture(t);
		const dependencies = { createTransport: () => readTransport() };
		const outcomes = await Promise.all(["read", "other"].map((sampleId) => runSessionEvaluation(options, dependencies, { sampleId, repetition: 1 })));
		assert.ok(outcomes.every((outcome) => outcome.result.status === "completed"));
		await assert.rejects(runSessionEvaluation(options, dependencies, { sampleId: "read", repetition: 1 }), { code: "EEXIST" });
		assert.equal((await readdir(outcomes[0]!.artifactDirectory)).filter((name) => name === "result.json").length, 1);
	});

	it("keeps baseline and candidate configurations separate and rejects mixing their records", async (t) => {
		const baseline = await sessionFixture(t);
		const candidate = structuredClone(baseline);
		const instruction = "Read the file and return only its color, without punctuation.";
		await writeFile(join(candidate.sourceRoot, "candidate.txt"), instruction);
		candidate.experiment.prompt = { version: "2", source: "candidate.txt", sha256: sha256(instruction) };
		const attempt = { sampleId: "read", repetition: 1 };
		const first = await runSessionEvaluation(baseline, { createTransport: () => readTransport() }, attempt);
		const second = await runSessionEvaluation(candidate, { createTransport: () => readTransport("violet", (body) => {
			assert.ok(body.includes(instruction));
		}) }, attempt);
		assert.notEqual(first.result.experimentDigest, second.result.experimentDigest);
		assert.notEqual(first.artifactDirectory, second.artifactDirectory);
		assert.throws(() => summarizeExperiment(candidate.experiment, [first.result]), /experiment/i);
		assert.equal(second.result.grade.verdict, "passed");
	});

	it("publishes an infrastructure failure without exposing a transport setup exception", async (t) => {
		const options = await sessionFixture(t);
		const outcome = await runSessionEvaluation(options, { createTransport: () => { throw new Error("private setup detail"); } },
			{ sampleId: "read", repetition: 1 });
		assert.equal(outcome.result.status, "infra_error");
		assert.equal(outcome.result.grade.verdict, "not_assessed");
		const raw = await readArtifact(outcome.artifactDirectory, outcome.evidence);
		assert.doesNotMatch(raw.toString(), /private setup detail/);
		await assert.rejects(access(JSON.parse(raw.toString()).temporaryRoot));
	});

	it("uses runtime permission denials and keeps out-of-scope paths out of a materialized workspace", async (t) => {
		const options = await sessionFixture(t);
		let calls = 0;
		const denied = await runSessionEvaluation(options, { createTransport: () => async (_input, init) => {
			calls++;
			if (calls === 1) return completion(null, [{ id: "write", type: "function", function: { name: "write", arguments: '{"path":"note.txt","oldText":"violet","newText":"orange"}' } }]);
			assert.match(String(init?.body), /PERMISSION_DENIED/);
			return completion("violet");
		} }, { sampleId: "read", repetition: 1 });
		const evidence = JSON.parse((await readArtifact(denied.artifactDirectory, denied.evidence)).toString());
		assert.ok(evidence.events.some((event: { type: string; ok?: boolean }) => event.type === "tool_result" && event.ok === false));
		const manifestPath = join(options.sourceRoot, "dataset.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
		for (const path of ["../escaped.txt", "NUL.txt", "directory./note.txt", "note.txt ", "file:stream"]) {
			manifest.samples[0].files[0].path = path;
			const bytes = JSON.stringify(manifest);
			await writeFile(manifestPath, bytes);
			options.experiment.dataset.manifest.sha256 = sha256(bytes);
			await assert.rejects(runSessionEvaluation(options, { createTransport: () => readTransport() }, { sampleId: "other", repetition: 1 }), /relative file path/);
		}
	});
});
