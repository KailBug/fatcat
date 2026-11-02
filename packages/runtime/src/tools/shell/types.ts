export type ProcessResult = {
	status: "completed" | "timed_out" | "cancelled" | "spawn_failed" | "termination_failed";
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	outputTruncated?: boolean;
	durationMs: number;
	cleanup: "foreground-exited" | "tree-killed" | "not-started" | "unconfirmed";
};

export type OutputSink = (stream: "stdout" | "stderr", chunk: Buffer) => Promise<void>;
