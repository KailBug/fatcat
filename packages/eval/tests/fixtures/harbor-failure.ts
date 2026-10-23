/** Verify that an execution failure remains an exception instead of a scored attempt. */
export function createTransport(): typeof fetch {
	return async () => Response.json({ error: { message: "Injected transport failure" } }, { status: 500 });
}
