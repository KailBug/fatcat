import {createHash, randomUUID} from "node:crypto";
import {link, open, rename, unlink} from "node:fs/promises";
import {dirname, extname, join, posix} from "node:path";
import {HarnessError, checkCancellation} from "../errors.js";
import {maxFileBytes, readTextFile, textExtensions} from "../permissions/text-file.js";
import {writeDecision} from "../permissions/policy.js";
import type {PermissionPolicy} from "../permissions/policy.js";
import type {ApproveWrite, WorkspacePermission} from "../permissions/types.js";
import type {Tool, ToolResult} from "./types.js";
import type {Workspace} from "../permissions/workspace.js";

export type {ApproveWrite, WorkspacePermission, WriteApprovalRequest} from "../permissions/types.js";
export type WriteRecord = {
    id: string;
    path: string;
    operation: "create" | "edit";
    status: "started" | "committed" | "failed" | "uncertain";
    beforeHash: string | null;
    afterHash: string;
    bytes: number;
    errorCode?: string;
    temporaryPath?: string;
};
type Replacement = { oldText: string; newText: string };
type WriteArguments = { path: string; content: string } | { path: string; edits: Replacement[] };
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function parseArguments(args: unknown, editing: boolean): WriteArguments {
    if (typeof args !== "object" || args === null || Array.isArray(args)
        || !("path" in args) || typeof args.path !== "string" || !args.path.trim() || args.path.length > 1024) {
        throw new HarnessError("INVALID_ARGUMENTS", "Expected a path containing 1 to 1024 characters.");
    }
    const keys = Object.keys(args);
    if (!editing && keys.length === 2 && "content" in args && typeof args.content === "string" && args.content.length <= maxFileBytes) {
        return {path: args.path, content: args.content};
    }
    if (editing && keys.length === 2 && "edits" in args && Array.isArray(args.edits) && args.edits.length >= 1 && args.edits.length <= 32) {
        let bytes = 0;
        const edits = args.edits.map((edit: unknown) => {
            if (!edit || typeof edit !== "object" || Array.isArray(edit) || Object.keys(edit).length !== 2
                || !("oldText" in edit) || typeof edit.oldText !== "string" || !edit.oldText.length
                || !("newText" in edit) || typeof edit.newText !== "string" || edit.oldText === edit.newText) {
                throw new HarnessError("INVALID_ARGUMENTS", "Each edit requires non-empty oldText and different newText, with no extra fields.");
            }
            bytes += Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText);
            if (bytes > 2 * maxFileBytes) throw new HarnessError("INVALID_ARGUMENTS", "Combined edit text must not exceed 2 MiB.");
            encodeText(edit.oldText);
            encodeText(edit.newText);
            return {oldText: edit.oldText, newText: edit.newText};
        });
        return {path: args.path, edits};
    }
    throw new HarnessError("INVALID_ARGUMENTS", editing
        ? "Use path and edits: an array of 1 to 32 exact replacements."
        : "Use only path and content to create a new file. Use edit to change an existing file.");
}

function encodeText(content: string): Buffer {
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > maxFileBytes) throw new HarnessError("FILE_TOO_LARGE", "Text files must not exceed 1048576 bytes.");
    if (bytes.toString("utf8") !== content || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) {
        throw new HarnessError("UNSUPPORTED_FILE", "Write content must be well-formed Unicode text without binary control characters.");
    }
    return bytes;
}

/** The journal belongs to the workspace tools, not a successful conversation turn. */
export function createWriteTool(
    workspace: Workspace,
    permission: WorkspacePermission,
    fileSystem = {open, link, rename, unlink},
    approveWrite?: ApproveWrite,
    policy?: PermissionPolicy,
) {
    const permissionPolicy = policy ?? workspace.permissionPolicy;
    const records: WriteRecord[] = [];
    let busy = false;

    async function execute(args: unknown, signal?: AbortSignal, editing = false): Promise<ToolResult> {
        checkCancellation(signal);
        const lease = permissionPolicy?.beginOperation();
        try {
            const decision = writeDecision(lease?.permission ?? permission, Boolean(approveWrite));
            if (decision === "deny") {
                throw new HarnessError("PERMISSION_DENIED", "Writing is unavailable under this workspace policy. Do not retry without user authorization.");
            }
            const input = parseArguments(args, editing);
            if (busy) throw new HarnessError("WRITE_BUSY", "Another write is already in progress for these workspace tools.");
            if (records.length >= 100) throw new HarnessError("WRITE_LIMIT", "The process-local journal has reached 100 write attempts. Start a new run after reviewing the records.");
            busy = true;
            try {
                return await performWrite(input, decision, signal);
            } finally {
                busy = false;
            }
        } finally {
            lease?.release();
        }
    }

    async function performWrite(input: WriteArguments, decision: "ask" | "allow", signal?: AbortSignal): Promise<ToolResult> {
        const creating = "content" in input;
        const target = creating
            ? await workspace.resolveNewFile(input.path, signal)
            : await workspace.resolvePath(input.path, signal);
        if (!target.unrestricted && !textExtensions.has(extname(target.absolute).toLowerCase())) {
            throw new HarnessError("UNSUPPORTED_FILE", "Only supported text file extensions can be written.");
        }
        const parentPath = target.unrestricted ? dirname(target.absolute) : posix.dirname(target.relative);
        const parent = await workspace.resolvePath(parentPath, signal);
        let before: Buffer | null = null;
        let beforeIdentity: { dev: number; ino: number } | undefined;
        let mode = 0o600;
        let bytes: Buffer;
        let approvalEdit: Replacement | undefined;
        if (creating) {
            bytes = encodeText(input.content);
        } else {
            // Resolving again provides a concrete existing-file type and identity.
            const existing = await workspace.resolvePath(input.path, signal);
            if (!existing.stat.isFile()) throw new HarnessError("UNSUPPORTED_FILE", "An exact edit requires a regular text file.");
            const original = await readTextFile(existing, signal);
            before = original.bytes;
            beforeIdentity = existing.stat;
            mode = existing.stat.mode & 0o777;
            const edits = input.edits.map((edit) => {
                const index = original.content.indexOf(edit.oldText);
                if (index < 0 || original.content.indexOf(edit.oldText, index + 1) >= 0) {
                    throw new HarnessError("WRITE_CONFLICT", "Each oldText must match exactly once in the original file. Read it again and provide unique fragments.");
                }
                return {...edit, index};
            }).sort((a, b) => a.index - b.index);
            let end = 0;
            let updated = "";
            for (const edit of edits) {
                if (edit.index < end) throw new HarnessError("WRITE_CONFLICT", "Edit regions overlap in the original file. Merge them into one replacement.");
                updated += original.content.slice(end, edit.index) + edit.newText;
                end = edit.index + edit.oldText.length;
            }
            updated += original.content.slice(end);
            approvalEdit = edits.length === 1 ? {oldText: edits[0]!.oldText, newText: edits[0]!.newText}
                : {oldText: original.content, newText: updated};
            const bom = before.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ? "\ufeff" : "";
            bytes = encodeText(bom + updated);
        }

        async function verifyTarget(): Promise<void> {
            // Approval can take time; validate again both before staging and before publication.
            const currentParent = await workspace.resolvePath(parentPath, signal);
            if (currentParent.absolute !== parent.absolute || currentParent.stat.dev !== parent.stat.dev || currentParent.stat.ino !== parent.stat.ino) {
                throw new HarnessError("WRITE_CONFLICT", "The parent directory changed during the write.");
            }
            if (before) {
                const current = await workspace.resolvePath(input.path, signal);
                const snapshot = await readTextFile(current, signal);
                if (current.absolute !== target.absolute || current.stat.dev !== beforeIdentity?.dev
                    || current.stat.ino !== beforeIdentity.ino || !snapshot.bytes.equals(before)) {
                    throw new HarnessError("WRITE_CONFLICT", "The file changed during the write. Read it again before editing.");
                }
            } else {
                const current = await workspace.resolveNewFile(input.path, signal);
                if (current.absolute !== target.absolute) {
                    throw new HarnessError("WRITE_CONFLICT", "The new file path changed during the write.");
                }
            }
        }

        if (decision === "ask") {
            const approved = await approveWrite!({
                path: target.relative, operation: creating ? "create" : "edit", bytes: bytes.length,
                ...(creating ? {newText: input.content} : approvalEdit!),
            }, signal);
            checkCancellation(signal);
            if (!approved) throw new HarnessError("PERMISSION_DENIED", "The user did not approve this write. Do not retry it unless the user asks again.");
            await verifyTarget();
        }
        checkCancellation(signal);
        const record: WriteRecord = {
            id: randomUUID(), path: target.relative, operation: creating ? "create" : "edit", status: "started",
            beforeHash: before ? hash(before) : null, afterHash: hash(bytes), bytes: bytes.length,
        };
        records.push(record);
        const temporaryName = `.fatcat-write-${record.id}.tmp`;
        const temporary = join(dirname(target.absolute), temporaryName);
        let ownsTemporary = false;
        try {
            const file = await fileSystem.open(temporary, "wx", mode);
            ownsTemporary = true;
            record.temporaryPath = target.unrestricted ? temporary : posix.join(parentPath, temporaryName);
            try {
                await file.writeFile(bytes);
                await file.sync();
            } finally {
                await file.close();
            }
            await verifyTarget();
            checkCancellation(signal);
            // No cancellation check between publication and recording its outcome.
            record.status = "uncertain";
            if (creating) await fileSystem.link(temporary, target.absolute);
            else await fileSystem.rename(temporary, target.absolute);
            record.status = "committed";
            return {
                ok: true, result: {
                    recordId: record.id, path: record.path, operation: record.operation,
                    beforeHash: record.beforeHash, afterHash: record.afterHash, bytes: record.bytes,
                }
            };
        } catch (error) {
            if (record.status === "started") record.status = "failed";
            record.errorCode = error instanceof HarnessError ? error.code : "TOOL_IO";
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
                record.status = "failed";
                record.errorCode = "WRITE_CONFLICT";
                throw new HarnessError("WRITE_CONFLICT", "The new file already exists. It was not overwritten.");
            }
            throw error;
        } finally {
            if (ownsTemporary) {
                try {
                    await fileSystem.unlink(temporary);
                    delete record.temporaryPath;
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === "ENOENT") delete record.temporaryPath;
                    else {
                        record.errorCode = "WRITE_CLEANUP";
                        throw new HarnessError("WRITE_CLEANUP", "Temporary-file cleanup failed. Inspect the write record before retrying; a committed change is not rolled back.");
                    }
                }
            }
        }
    }

    const tool: Tool = {
        definition: {
            name: "write",
            description: "Create a new UTF-8 text file with path and content; never overwrite an existing file. Use edit for existing files. Parent directories must exist. Current permission guidance defines path scope. Maximum file size is 1 MiB. Requires approval or preauthorized file-write permission. Errors do not imply rollback; inspect write records and current content before retrying."
                + (permissionPolicy ? " Current permission is supplied in request guidance and checked at execution." : ""),
            parameters: {
                type: "object", properties: {
                    path: {type: "string", minLength: 1, maxLength: 1024},
                    content: {type: "string", maxLength: maxFileBytes},
                }, required: ["path", "content"], additionalProperties: false,
            }
        }, execute,
    };
    const editTool: Tool = {
        definition: {
            name: "edit",
            description: "Edit one existing text file with 1 to 32 exact replacements. Every edits[].oldText must match a unique, non-overlapping region of the ORIGINAL file, including whitespace and line endings. Read first. All edits are validated before one publication; a conflict changes nothing. Preserve unrelated bytes and BOM. Combined replacement text is limited to 2 MiB and the final file to 1 MiB. Uses the same path permissions and approval as write. Publication/cleanup errors may retain effects: inspect records and current content before retrying.",
            parameters: {
                type: "object", properties: {
                    path: {type: "string", minLength: 1, maxLength: 1024},
                    edits: {
                        type: "array", minItems: 1, maxItems: 32, items: {
                            type: "object", properties: {
                                oldText: {type: "string", minLength: 1, maxLength: maxFileBytes},
                                newText: {type: "string", maxLength: maxFileBytes},
                            }, required: ["oldText", "newText"], additionalProperties: false
                        }
                    },
                }, required: ["path", "edits"], additionalProperties: false
            },
        },
        execute: (args, signal) => execute(args, signal, true),
    };
    return {tool, editTool, getWrites: (): WriteRecord[] => structuredClone(records)};
}
