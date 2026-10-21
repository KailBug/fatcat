import { HarnessError } from "../errors.js";
import { decodeModelSelection, sameModel } from "../model-catalog.js";
import type { ModelSelection } from "../model-catalog.js";
import type { SessionAgentOptions } from "./agent-session.js";

/** Restore permits reading an unavailable model's transcript, but never substitutes a model. */
export function sessionModelAgent(agent: SessionAgentOptions, selection: ModelSelection | undefined): SessionAgentOptions {
	if (!selection || (agent.modelSelection && sameModel(selection, agent.modelSelection)
		&& selection.thinking === agent.modelSelection.thinking)) return agent;
	try {
		if (!agent.forModel) throw new HarnessError("MODEL_UNAVAILABLE", "This host does not support the saved model. Select a supported model before continuing.");
		return agent.forModel(decodeModelSelection(selection), agent);
	} catch (error) {
		if (!(error instanceof HarnessError) || !["MODEL_UNAVAILABLE", "MODEL_SELECTION"].includes(error.code)) throw error;
		const unavailable = async (): Promise<never> => { throw error; };
		// forSession must not rebind a generated model and accidentally revive the startup connection.
		const { forSession: _bind, ...rest } = agent;
		return { ...rest, modelSelection: structuredClone(selection), model: unavailable, compactionModel: unavailable };
	}
}
