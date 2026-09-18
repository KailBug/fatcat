export class HarnessError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "HarnessError";
  }
}

export function checkCancellation(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HarnessError("CANCELLED", "Run cancelled.");
  }
}
