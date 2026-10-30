import type { Tools } from "@fatcat/runtime/tools";

/** Explicit deterministic tool for protocol/loop tests; never assembled by product code. */
export const fixtureTools: Tools = {
	definitions: [{ name: "fixture_add", description: "Add synthetic fixture numbers.", parameters: {
		type: "object", properties: { numbers: { type: "array", items: { type: "number" } } }, required: ["numbers"],
	} }],
	execute: async (name, json) => {
		if (name !== "fixture_add") return { ok: false, error: { code: "UNKNOWN_TOOL", message: "Unknown fixture tool." } };
		let args: unknown;
		try { args = JSON.parse(json); }
		catch { return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "Tool arguments must be valid JSON." } }; }
		if (!args || typeof args !== "object" || !("numbers" in args) || !Array.isArray(args.numbers)
			|| !args.numbers.every((value) => typeof value === "number" && Number.isFinite(value))) {
			return { ok: false, error: { code: "INVALID_ARGUMENTS", message: "Expected fixture numbers." } };
		}
		return { ok: true, result: args.numbers.reduce((total: number, value: number) => total + value, 0) };
	},
};
