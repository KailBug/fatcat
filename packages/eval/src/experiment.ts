import { createHash } from "node:crypto";
import { amount, canonicalJson, choice, count, digest, object, strings, text } from "./validation.js";

export interface ArtifactReference {
	source: string;
	sha256: string;
}

export interface Budget {
	requests: number;
	tokens: number;
	durationMs: number;
	costUsd: number | null;
}

export interface Experiment {
	schemaVersion: "fatcat.eval.v1";
	id: string;
	code: { gitSha: string; dirty: boolean };
	environment: { os: string; node: string; pnpm: string };
	evidence: "synthetic" | "injected" | "live";
	level: "contract" | "model_quality" | "task_acceptance";
	model: { provider: string; id: string; parameters: Record<string, string | number | boolean | null> };
	dataset: {
		id: string;
		version: string;
		manifest: ArtifactReference;
		sampleIds: string[];
		developmentIds: string[];
		holdoutIds: string[];
		selectedIds: string[];
		split: "development" | "holdout";
		coverage: "subset" | "full";
	};
	prompt: ArtifactReference & { version: string };
	policy: ArtifactReference & { version: string };
	grader: ArtifactReference & { version: string };
	repetitions: number;
	budget: { perAttempt: Budget; experiment: Budget };
}

export function parseArtifact(value: unknown, where: string): ArtifactReference {
	const record = object(value, ["source", "sha256"], where);
	return { source: text(record.source, `${where}.source`), sha256: digest(record.sha256, `${where}.sha256`) };
}

function versionedArtifact(value: unknown, where: string): ArtifactReference & { version: string } {
	const record = object(value, ["source", "sha256", "version"], where);
	return { ...parseArtifact({ source: record.source, sha256: record.sha256 }, where), version: text(record.version, `${where}.version`) };
}

function budget(value: unknown, where: string): Budget {
	const record = object(value, ["requests", "tokens", "durationMs", "costUsd"], where);
	return {
		requests: count(record.requests, `${where}.requests`, 1),
		tokens: count(record.tokens, `${where}.tokens`, 1),
		durationMs: count(record.durationMs, `${where}.durationMs`, 1),
		costUsd: record.costUsd === null ? null : amount(record.costUsd, `${where}.costUsd`),
	};
}

function parameters(value: unknown): Experiment["model"]["parameters"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("model.parameters must be an object.");
	return Object.fromEntries(Object.entries(value).map(([key, item]) => {
		if (!key.trim() || /key|secret|credential|authorization|password|endpoint|baseurl/i.test(key)) {
			throw new Error("model.parameters must contain non-secret generation settings only.");
		}
		if (item !== null && typeof item !== "string" && typeof item !== "boolean"
			&& !(typeof item === "number" && Number.isFinite(item))) throw new Error("model.parameters values must be finite JSON scalars.");
		return [key, item];
	}));
}

export function parseExperiment(value: unknown): Experiment {
	const record = object(value, ["schemaVersion", "id", "code", "environment", "evidence", "level", "model", "dataset",
		"prompt", "policy", "grader", "repetitions", "budget"], "experiment");
	const code = object(record.code, ["gitSha", "dirty"], "code");
	const gitSha = text(code.gitSha, "code.gitSha");
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(gitSha)) throw new Error("code.gitSha must be a full lowercase Git object ID.");
	if (typeof code.dirty !== "boolean") throw new Error("code.dirty must be boolean.");
	const environment = object(record.environment, ["os", "node", "pnpm"], "environment");
	const model = object(record.model, ["provider", "id", "parameters"], "model");
	const data = object(record.dataset, ["id", "version", "manifest", "sampleIds", "developmentIds", "holdoutIds",
		"selectedIds", "split", "coverage"], "dataset");
	const sampleIds = strings(data.sampleIds, "dataset.sampleIds");
	const developmentIds = strings(data.developmentIds, "dataset.developmentIds");
	const holdoutIds = strings(data.holdoutIds, "dataset.holdoutIds");
	const selectedIds = strings(data.selectedIds, "dataset.selectedIds");
	const split = choice(data.split, ["development", "holdout"], "dataset.split");
	const coverage = choice(data.coverage, ["subset", "full"], "dataset.coverage");
	const samples = new Set(sampleIds);
	const development = new Set(developmentIds);
	const selectedSplit = new Set(split === "development" ? developmentIds : holdoutIds);
	if (!sampleIds.length || !selectedIds.length) throw new Error("Dataset and selection must be nonempty.");
	if ([...developmentIds, ...holdoutIds].some((id) => !samples.has(id))
		|| holdoutIds.some((id) => development.has(id))) throw new Error("Dataset splits must be disjoint subsets of sampleIds.");
	if (selectedIds.some((id) => !selectedSplit.has(id))) throw new Error("Selection must belong to the declared split.");
	if (coverage === "full" && selectedIds.length !== sampleIds.length) throw new Error("A subset cannot be labeled full coverage.");
	const repetitions = count(record.repetitions, "repetitions", 1);
	count(selectedIds.length * repetitions, "planned attempts", 1);
	const limits = object(record.budget, ["perAttempt", "experiment"], "budget");
	return {
		schemaVersion: choice(record.schemaVersion, ["fatcat.eval.v1"], "schemaVersion"),
		id: text(record.id, "id"), code: { gitSha, dirty: code.dirty },
		environment: { os: text(environment.os, "environment.os"), node: text(environment.node, "environment.node"), pnpm: text(environment.pnpm, "environment.pnpm") },
		evidence: choice(record.evidence, ["synthetic", "injected", "live"], "evidence"),
		level: choice(record.level, ["contract", "model_quality", "task_acceptance"], "level"),
		model: { provider: text(model.provider, "model.provider"), id: text(model.id, "model.id"), parameters: parameters(model.parameters) },
		dataset: { id: text(data.id, "dataset.id"), version: text(data.version, "dataset.version"), manifest: parseArtifact(data.manifest, "dataset.manifest"),
			sampleIds, developmentIds, holdoutIds, selectedIds, split, coverage },
		prompt: versionedArtifact(record.prompt, "prompt"), policy: versionedArtifact(record.policy, "policy"),
		grader: versionedArtifact(record.grader, "grader"), repetitions,
		budget: { perAttempt: budget(limits.perAttempt, "budget.perAttempt"), experiment: budget(limits.experiment, "budget.experiment") },
	};
}

/** Bind results to every setting, including the fixed split, prompt and grader references. */
export function experimentDigest(value: Experiment): string {
	return createHash("sha256").update(canonicalJson(parseExperiment(value))).digest("hex");
}
