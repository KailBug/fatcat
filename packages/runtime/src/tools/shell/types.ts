export type ProcessResult = {
	status: "completed" | "timed_out" | "output_limit" | "cancelled" | "spawn_failed" | "termination_failed";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	cleanup: "foreground-exited" | "tree-killed" | "not-started" | "unconfirmed";
};

// Capture and process termination use this bound; model-facing previews have a separate 16 KiB budget.
export const outputLimit = 1024 * 1024;
