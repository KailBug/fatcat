import { parseArtifact, parseExperiment, type Experiment } from "./experiment.js";
import { choice, count, object, text } from "./validation.js";
import { readArtifact, relativeFile } from "./artifacts.js";

export interface Sample {
	id: string;
	prompt: string;
	files: { path: string; bytes: Buffer }[];
}

export interface Materials {
	experiment: Experiment;
	samples: Sample[];
	instruction: string;
	policy: { permission: "read-only" | "workspace-write"; maxRequestBytes: number; requestTimeoutMs: number; autoCompaction: boolean };
	answers: Record<string, string>;
}

export async function loadMaterials(input: Experiment, sourceRoot: string): Promise<Materials> {
	const experiment = parseExperiment(input);
	if (experiment.evidence !== "injected") throw new Error("This adapter requires explicitly injected model transport; live execution is not enabled.");
	const manifest = object(JSON.parse((await readArtifact(sourceRoot, experiment.dataset.manifest)).toString("utf8")), ["samples"], "manifest");
	if (!Array.isArray(manifest.samples)) throw new Error("manifest.samples must be an array.");
	const samples: Sample[] = [];
	for (const value of manifest.samples) {
		const row = object(value, ["id", "prompt", "files"], "sample");
		const id = text(row.id, "sample.id");
		if (!Array.isArray(row.files) || row.files.length > 64) throw new Error("sample.files must contain at most 64 files.");
		const files: Sample["files"] = [];
		for (const entry of row.files) {
			const file = object(entry, ["path", "artifact"], "sample.file");
			const path = relativeFile(text(file.path, "sample.file.path"));
			if (path.split("/").some((part) => part.startsWith(".") || part.toLowerCase() === "node_modules")
				|| files.some((item) => item.path.toLowerCase() === path.toLowerCase())) throw new Error("Sample paths must be distinct ordinary workspace files.");
			files.push({ path, bytes: await readArtifact(sourceRoot, parseArtifact(file.artifact, "sample.file.artifact")) });
		}
		if (samples.some((sample) => sample.id === id)) throw new Error("Duplicate sample ID.");
		samples.push({ id, prompt: text(row.prompt, "sample.prompt"), files });
	}
	if (samples.length !== experiment.dataset.sampleIds.length || samples.some((sample) => !experiment.dataset.sampleIds.includes(sample.id))) {
		throw new Error("Manifest inventory differs from the experiment sample IDs.");
	}
	const instruction = text((await readArtifact(sourceRoot, experiment.prompt)).toString("utf8"), "prompt");
	const rawPolicy = object(JSON.parse((await readArtifact(sourceRoot, experiment.policy)).toString("utf8")),
		["permission", "maxRequestBytes", "requestTimeoutMs", "autoCompaction"], "policy");
	if (typeof rawPolicy.autoCompaction !== "boolean") throw new Error("policy.autoCompaction must be boolean.");
	const policy = {
		permission: choice(rawPolicy.permission, ["read-only", "workspace-write"], "policy.permission"),
		maxRequestBytes: count(rawPolicy.maxRequestBytes, "policy.maxRequestBytes", 1),
		requestTimeoutMs: count(rawPolicy.requestTimeoutMs, "policy.requestTimeoutMs", 1), autoCompaction: rawPolicy.autoCompaction,
	};
	if (policy.maxRequestBytes > 16 * 1024 * 1024 || policy.requestTimeoutMs > 2_147_483_647
		|| experiment.budget.perAttempt.durationMs > 2_147_483_647) throw new Error("Policy exceeds supported request or timer limits.");
	const grader = object(JSON.parse((await readArtifact(sourceRoot, experiment.grader)).toString("utf8")), ["type", "answers"], "grader");
	choice(grader.type, ["exact-match"], "grader.type");
	const rawAnswers = object(grader.answers, experiment.dataset.sampleIds, "grader.answers");
	const answers = Object.fromEntries(Object.entries(rawAnswers).map(([id, answer]) => [id, text(answer, `grader.answers.${id}`)]));
	return { experiment, samples, instruction, policy, answers };
}
