export function object(value: unknown, fields: readonly string[], where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object.`);
	const record = value as Record<string, unknown>;
	if (Object.keys(record).length !== fields.length || fields.some((field) => !Object.hasOwn(record, field))) {
		throw new Error(`${where} has missing or unsupported fields.`);
	}
	return record;
}

export function text(value: unknown, where: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${where} must be nonempty text.`);
	return value;
}

export function count(value: unknown, where: string, minimum = 0): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${where} must be a safe integer >= ${minimum}.`);
	}
	return value;
}

export function amount(value: unknown, where: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${where} must be finite and nonnegative.`);
	return value;
}

export function choice<T extends string>(value: unknown, values: readonly T[], where: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) throw new Error(`${where} is invalid.`);
	return value as T;
}

export function strings(value: unknown, where: string): string[] {
	if (!Array.isArray(value)) throw new Error(`${where} must be an array.`);
	const result = value.map((item) => text(item, where));
	if (new Set(result).size !== result.length) throw new Error(`${where} contains duplicates.`);
	return result;
}

export function digest(value: unknown, where: string): string {
	const result = text(value, where);
	if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${where} must be a lowercase SHA-256 digest.`);
	return result;
}

/** Stable key order for JSON fingerprints; arrays retain their declared order. */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
	}
	throw new Error("Expected a finite JSON value.");
}
