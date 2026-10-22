import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

// No ambient model/network access, even if the third-party runner attempts telemetry.
const networkAttempts = [];
function denyNetwork() {
	const error = new Error("Unexpected network access in an injected evaluation.");
	networkAttempts.push(error.stack);
	throw error;
}
let blockedTelemetry = 0;
globalThis.fetch = async (input, init) => {
	// 0.124.1 sends a disabled-notice even with PROMPTFOO_DISABLE_TELEMETRY.
	// Reject it locally too; it must never reach a socket or become a permitted request.
	if (String(input) === "https://r.promptfoo.app/" && typeof init?.body === "string"
		&& JSON.parse(init.body).meta?.feature === "telemetry disabled") {
		blockedTelemetry++;
		throw new Error("Telemetry disabled-notice blocked by offline test.");
	}
	return denyNetwork();
};
http.request = denyNetwork;
https.request = denyNetwork;
net.Socket.prototype.connect = denyNetwork;
syncBuiltinESMExports();

const { evaluate } = await import("promptfoo");
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const provider = fileURLToPath(new URL("../../dist/tests/fixtures/promptfoo-provider.js", import.meta.url));
const evaluation = await evaluate({
	prompts: ["{{sampleId}}"],
	providers: [{ id: `file://${provider}`, config }],
	tests: config.experiment.dataset.selectedIds.map((sampleId) => ({ vars: { sampleId }, assert: [{ type: "equals", value: "violet" }] })),
	writeLatestResults: false,
}, { cache: false, repeat: config.experiment.repetitions, maxConcurrency: 1, generateSuggestions: false, showProgressBar: false });
const summary = await evaluation.toEvaluateSummary();
assert.equal(networkAttempts.length, 0, networkAttempts.join("\n"));
assert.equal(blockedTelemetry, 1, "Review telemetry behavior when changing the pinned promptfoo version.");
await writeFile(process.argv[3], JSON.stringify(summary));
