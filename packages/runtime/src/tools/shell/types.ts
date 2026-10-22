export type ProcessResult = {
	status: "completed" | "timed_out" | "output_limit" | "cancelled" | "spawn_failed" | "termination_failed";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	cleanup: "foreground-exited" | "tree-killed" | "not-started" | "unconfirmed";
};

export const outputLimit = 16 * 1024;
