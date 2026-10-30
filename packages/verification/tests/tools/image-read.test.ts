import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "@fatcat/runtime/errors";
import { withImageRead } from "@fatcat/runtime/internal/tools/image-read";
import type { DocumentVision } from "@fatcat/runtime/internal/documents/vision";
import { createTools } from "@fatcat/runtime/tools";
import { temporaryWorkspace } from "../support/workspace.js";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ7sAAAAASUVORK5CYII=", "base64");

function injectedVision(onRequest: () => void): DocumentVision {
	return {
		capability: { supported: true, nativeFileInput: false, provider: "kimi", model: "offline", reason: "fixture" },
		analyze: async (images, options) => {
			assert.equal(images.length, 1);
			assert.equal(images[0]!.width, 1);
			options.beforeRequest?.();
			onRequest();
			options.observe?.({ type: "model_usage", usage: null });
			return { text: "A small image", provider: "kimi", model: "offline", mode: "visual", sourceKind: "model-description" };
		},
	};
}

test("local images reuse workspace reads, bounded worker decoding and auxiliary request accounting", async (t) => {
	const { workspace, outside } = await temporaryWorkspace(t);
	await writeFile(join(workspace, "image.png"), png);
	await writeFile(join(outside, "private.png"), png);
	const base = await createTools(workspace);
	let calls = 0, reservations = 0, observations = 0;
	const tools = withImageRead(base, injectedVision(() => { calls++; })).forTurn!(undefined, {
		documentRequest: () => { reservations++; return () => { observations++; }; },
	});
	const result = await tools.execute("image_read", '{"path":"image.png","question":"What is visible?"}');
	assert.equal(result.ok, true, JSON.stringify(result));
	assert.match(JSON.stringify(result), /"sha256":"[a-f0-9]{64}"/);
	assert.doesNotMatch(JSON.stringify(result), /base64|iVBORw0KGgo/);
	assert.equal(calls, 1);
	assert.equal(reservations, 1);
	assert.equal(observations, 1);
	const denied = await tools.execute("image_read", JSON.stringify({ path: join(outside, "private.png"), question: "Read" }));
	assert.equal(denied.ok, false);
	assert.equal(calls, 1);
	await assert.rejects(tools.execute("image_read", '{"path":"image.png","question":"Read"}', AbortSignal.abort()), { code: "CANCELLED" });
});

test("images cannot bypass final-answer reservation, unsupported vision, or a changed source", async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	await writeFile(join(workspace, "image.png"), png);
	const base = await createTools(workspace);
	let calls = 0;
	const vision = injectedVision(() => { calls++; });
	const args = '{"path":"image.png","question":"Read"}';
	const exhausted = withImageRead(base, vision).forTurn!(undefined, {
		documentRequest: () => { throw new HarnessError("DOCUMENT_BUDGET", "Reserved for final delivery"); },
	});
	assert.match(JSON.stringify(await exhausted.execute("image_read", args)), /DOCUMENT_BUDGET/);
	const unsupported = withImageRead(base, { ...vision, capability: { ...vision.capability, supported: false } });
	assert.match(JSON.stringify(await unsupported.execute("image_read", args)), /DOCUMENT_VISION_UNAVAILABLE/);
	let reads = 0;
	const direct = withImageRead({ ...base, readImportFile: async (...input) => {
		const file = await base.readImportFile!(...input);
		return ++reads === 2 ? { ...file, bytes: Buffer.from("changed") } : file;
	} }, vision, { documentRequest: () => () => {} });
	assert.match(JSON.stringify(await direct.execute("image_read", args)), /IMAGE_CHANGED/);
	assert.equal(calls, 0);
});
