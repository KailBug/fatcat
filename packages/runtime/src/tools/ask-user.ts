import { randomUUID } from "node:crypto";
import { HarnessError, checkCancellation } from "../errors.js";
import type { Tools } from "../tools.js";
import { failure } from "./types.js";

export interface UserQuestion { question: string; options?: string[] }
export interface PendingQuestion { id: string; request: UserQuestion }
export type AskUser = (request: UserQuestion, signal?: AbortSignal) => Promise<string | null>;

export function validateUserAnswer(answer: unknown): asserts answer is string | null {
	if (answer !== null && (typeof answer !== "string" || !answer.trim() || answer.length > 4000
		|| Buffer.from(answer).toString() !== answer || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(answer))) {
		throw new HarnessError("INVALID_ARGUMENTS", "Answer must be nonblank Unicode text up to 4000 characters, or null to skip.");
	}
}

/** One fresh clarification, answered once. This never grants operation approval. */
export class QuestionCoordinator {
	private pending: { value: PendingQuestion; finish: (answer: string | null) => void } | undefined;
	constructor(private readonly changed?: () => void) {}
	snapshot(): PendingQuestion | null { return this.pending ? structuredClone(this.pending.value) : null; }
	request: AskUser = async (request, signal) => {
		checkCancellation(signal);
		if (this.pending) throw new HarnessError("QUESTION_BUSY", "Another question is pending.");
		const answer = await new Promise<string | null>((resolve) => {
			const cancel = () => finish(null);
			const finish = (answer: string | null) => {
				signal?.removeEventListener("abort", cancel);
				this.pending = undefined; resolve(answer); this.changed?.();
			};
			this.pending = { value: { id: randomUUID(), request: structuredClone(request) }, finish };
			signal?.addEventListener("abort", cancel, { once: true });
			this.changed?.();
		});
		checkCancellation(signal);
		return answer;
	};
	answer(id: string, answer: string | null): void {
		validateUserAnswer(answer);
		if (this.pending?.value.id !== id) throw new HarnessError("STALE_QUESTION", "This question is no longer pending.");
		this.pending.finish(answer);
	}
	skip(): void { this.pending?.finish(null); }
}

export function withAskUser(base: Tools, ask?: AskUser): Tools {
	if (!ask) return base;
	const definition = { name: "ask_user", description: "Ask the user one necessary clarification during this task, optionally with 2-6 suggested choices; free text and skip remain available. question max 2000 characters, each choice max 200; returned answer max 4000. At most four questions per turn. Only the parent can ask; unavailable in unattended/background work. Answers are task clarification, never file/command approval. If skipped, proceed only when a reasonable assumption is possible, otherwise explain what is missing.",
		parameters: { type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 2000 },
			options: { type: "array", minItems: 2, maxItems: 6, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 200 } } },
			required: ["question"], additionalProperties: false } };
	function forTurn(...args: Parameters<NonNullable<Tools["forTurn"]>>): Tools {
		const tools = base.forTurn?.(...args) ?? base;
		let asked = 0;
		return { ...tools, definitions: [...tools.definitions, definition], forTurn,
			async execute(name, json, signal, callId) {
				if (name !== "ask_user") return tools.execute(name, json, signal, callId);
				checkCancellation(signal);
				let value: unknown;
				try { value = JSON.parse(json); } catch { return failure("INVALID_ARGUMENTS", "Tool arguments must be valid JSON."); }
				if (!value || typeof value !== "object" || Array.isArray(value)
					|| Object.keys(value).some((key) => !["question", "options"].includes(key))
					|| !("question" in value) || typeof value.question !== "string" || !value.question.trim() || value.question.length > 2000
					|| Buffer.from(value.question).toString() !== value.question || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(value.question)) return failure("INVALID_ARGUMENTS", "Expected a nonblank question up to 2000 characters and optional choices.");
				const options = "options" in value ? value.options : undefined;
				if (options !== undefined && (!Array.isArray(options) || options.length < 2 || options.length > 6 || new Set(options).size !== options.length
					|| options.some((item) => typeof item !== "string" || !item.trim() || item.length > 200 || Buffer.from(item).toString() !== item || /[\x00-\x1f\x7f-\x9f]/.test(item)))) {
					return failure("INVALID_ARGUMENTS", "Use 2-6 distinct nonblank choices, each up to 200 characters.");
				}
				if (asked++ >= 4) return failure("QUESTION_LIMIT", "At most four questions per user turn.");
				try {
					const answer = await ask!({ question: value.question, ...(options ? { options: options as string[] } : {}) }, signal);
					checkCancellation(signal); validateUserAnswer(answer);
					return { ok: true, result: answer === null ? { status: "skipped" } : { status: "answered", answer } };
				} catch (error) {
					checkCancellation(signal);
					if (error instanceof HarnessError) { if (error.code === "CANCELLED") throw error; return failure(error.code, error.message); }
					return failure("QUESTION_UNAVAILABLE", "The host could not collect an answer.");
				}
			} };
	}
	return forTurn();
}
