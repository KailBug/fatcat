/** Synthetic single-step shape from Harbor 0.23.0; this is not a benchmark run. */
export function harborTrialFixture(reward = 0) {
	return {
		id: "f77d5cbe-f339-42ca-baae-d55a18bb7309",
		task_name: "synthetic-cpu-task", trial_name: "synthetic-cpu-task__one", task_checksum: "synthetic-checksum",
		trial_uri: "file:///synthetic/trial", task_id: { path: "synthetic/task" }, config: {},
		agent_info: { name: "fatcat", version: "fixture", model_info: { name: "injected-model", provider: "injected" } },
		agent_result: { n_input_tokens: 100, n_cache_tokens: 20, n_output_tokens: 10, cost_usd: null },
		verifier_result: { rewards: { reward } }, exception_info: null,
		started_at: "2026-10-22T07:00:00Z", finished_at: "2026-10-22T07:00:10Z",
		agent_execution: { started_at: "2026-10-22T07:00:01Z", finished_at: "2026-10-22T07:00:08Z" },
		verifier: { started_at: "2026-10-22T07:00:08Z", finished_at: "2026-10-22T07:00:09Z" },
		step_results: null,
	};
}
