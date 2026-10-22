import FatcatProvider from "../../src/promptfoo-provider.js";
import type { SessionEvaluationOptions } from "../../src/session-runner.js";
import { readTransport } from "./session.js";

/** Standard file-provider constructor, with a trusted offline transport supplied explicitly. */
export default class InjectedFatcatProvider extends FatcatProvider {
	constructor(options: { id?: string; config: SessionEvaluationOptions }) {
		super(options, { createTransport: (attempt) => readTransport(attempt.sampleId === "read" ? "violet" : "orange") });
	}
}
