export class HarnessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

export function formatError(error: unknown): string {
  return error instanceof HarnessError
    ? `Error [${error.code}]: ${error.message}`
    : "Error [INTERNAL]: An unexpected failure occurred.";
}

export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HarnessError("CANCELLED", "Run cancelled.");
  }
}
