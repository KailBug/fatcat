import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { atomicJson, boundedJson } from "@fatcat/runtime/internal/attachments/metadata-files";
import { temporaryWorkspace } from "../support/workspace.js";

describe("attachment metadata files", () => {
	it("preserves existing bytes on a size rejection and removes temporary files after failed publication", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const path = join(workspace, "metadata.json");
		await atomicJson(path, { revision: 1 }, 64);
		const before = await readFile(path);
		await assert.rejects(atomicJson(path, { revision: 2, extra: "large" }, 16), { code: "ATTACHMENT_LIMIT" });
		assert.deepEqual(await readFile(path), before);
		const blocked = join(workspace, "blocked.json");
		await mkdir(blocked);
		await assert.rejects(atomicJson(blocked, { revision: 2 }, 64));
		assert.deepEqual((await readdir(workspace)).sort(), ["blocked.json", "metadata.json"]);
		await atomicJson(path, { revision: 2 }, 64);
		assert.deepEqual(await boundedJson(path, 64), { revision: 2 });
	});

	it("treats only missing optional files as absent and enforces byte and UTF-8 boundaries", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const path = join(workspace, "metadata.json");
		assert.equal(await boundedJson(path, 64, true), undefined);
		await assert.rejects(boundedJson(path, 64), { code: "ATTACHMENT_CORRUPT" });
		const metadata = { name: "file \u{1F4C4}" };
		const bytes = Buffer.from(JSON.stringify(metadata));
		await writeFile(path, bytes);
		assert.deepEqual(await boundedJson(path, bytes.length), metadata);
		await assert.rejects(boundedJson(path, bytes.length - 1, true), { code: "ATTACHMENT_CORRUPT" });
		for (const invalid of [Buffer.from("{"), Buffer.from([0x22, 0xff, 0x22])]) {
			await writeFile(path, invalid);
			await assert.rejects(boundedJson(path, 64, true), { code: "ATTACHMENT_CORRUPT" });
		}
		await assert.rejects(boundedJson(workspace, 64, true), { code: "ATTACHMENT_CORRUPT" });
	});
});
