import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { HarnessError } from "../src/errors.js";
import type { WebUiController } from "./controller.js";
import { isPermissionMode } from "../src/permissions/policy.js";
import { createPreviewStore, previewCsp } from "./preview.js";
import { readBrowserEvidence } from "../src/browser/evidence.js";

const assets = new Map([
  ["/", ["./public/index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["./public/styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["./client/app.js", "text/javascript; charset=utf-8"]],
  ["/markdown.js", ["./client/markdown.js", "text/javascript; charset=utf-8"]],
  ["/session-menu.js", ["./client/session-menu.js", "text/javascript; charset=utf-8"]],
  ["/session-dialog.js", ["./client/session-dialog.js", "text/javascript; charset=utf-8"]],
  ["/permission-menu.js", ["./client/permission-menu.js", "text/javascript; charset=utf-8"]],
  ["/preview.js", ["./client/preview.js", "text/javascript; charset=utf-8"]],
  ["/browser-evidence.js", ["./client/browser-evidence.js", "text/javascript; charset=utf-8"]],
  ["/icons.js", ["./client/icons.js", "text/javascript; charset=utf-8"]],
  ["/icons.svg", ["./public/icons.svg", "image/svg+xml"]],
  ["/icons-LICENSE.txt", ["./public/icons-LICENSE.txt", "text/plain; charset=utf-8"]],
  ["/favicon.svg", ["./public/favicon.svg", "image/svg+xml"]],
]);

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"] !== "application/json") throw new HttpError(415, "Expected application/json.");
  if (Number(request.headers["content-length"]) > 65_536) throw new HttpError(413, "Request body is too large.");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 65_536) { request.resume(); throw new HttpError(413, "Request body is too large."); }
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch { throw new HttpError(400, "Expected a JSON object."); }
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

/** Bind only to loopback. The fragment capability is never included in HTTP URLs. */
export async function startWebUiServer(controller: WebUiController, port = 3210) {
  const token = randomBytes(32).toString("hex");
  const previews = await createPreviewStore(controller.info.workspace);
  const shutdown = new AbortController();
  let origin = "";
  const server = createServer({ requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 }, (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; frame-src ${origin}/preview/; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
    void route(request, response).catch((error: unknown) => {
      if (response.destroyed) return;
      const status = error instanceof HttpError ? error.status
        : error instanceof HarnessError ? (["SESSION_BUSY", "SESSION_CONFLICT", "STALE_APPROVAL", "CLOSED"].includes(error.code) ? 409 : 400) : 500;
      json(response, status, { error: error instanceof HttpError || error instanceof HarnessError ? error.message : "The local server could not complete the request." });
    });
  });
  server.maxConnections = 32;
  server.timeout = 15_000;

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers.host !== new URL(origin).host) throw new HttpError(403, "Invalid local host.");
    if (request.headers.origin && request.headers.origin !== origin) throw new HttpError(403, "Cross-origin requests are not allowed.");
    const path = request.url ?? "/";
    if (request.method === "GET" && /^\/preview\/[a-f0-9]{64}$/.test(path)) {
      const snapshot = previews.take(path.slice("/preview/".length));
      if (!snapshot) throw new HttpError(404, "Preview expired. Use Refresh to read the file again.");
      response.setHeader("Content-Security-Policy", previewCsp(origin));
      response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), payment=()");
      response.writeHead(200, { "Content-Type": snapshot.contentType });
      response.end(snapshot.content);
      return;
    }
    const asset = assets.get(path);
    if (request.method === "GET" && asset) {
      const data = await readFile(new URL(asset[0]!, import.meta.url));
      response.writeHead(200, { "Content-Type": asset[1]! });
      response.end(data);
      return;
    }
    if (!path.startsWith("/api/")) throw new HttpError(404, "Not found.");
    if (request.headers.authorization !== `Bearer ${token}`) throw new HttpError(401, "Open the authenticated URL printed by pnpm start --webui.");
    const evidence = /^\/api\/browser-evidence\/([a-f0-9]{32})\/(report|screenshot)$/.exec(path);
    if (request.method === "GET" && evidence) {
      try {
        const file = await readBrowserEvidence(controller.info.workspace, evidence[1]!, evidence[2] as "report" | "screenshot");
        response.writeHead(200, { "Content-Type": evidence[2] === "report" ? "application/json; charset=utf-8" : "image/png" });
        response.end(file.bytes);
      } catch { throw new HttpError(404, "Browser evidence is unavailable. The file may have been removed or changed."); }
      return;
    }
    if (request.method === "GET" && path === "/api/state") {
      const state = controller.snapshot();
      if (request.headers["if-none-match"] === `"${state.revision}"`) { response.writeHead(304); response.end(); return; }
      response.setHeader("ETag", `"${state.revision}"`);
      json(response, 200, state);
      return;
    }
    if (request.method !== "POST") throw new HttpError(405, "Method not allowed.");
    const body = await readBody(request);
    if (path === "/api/preview") {
      if (typeof body.path !== "string" || Object.keys(body).length !== 1) throw new HttpError(400, "Expected a workspace-relative file path.");
      const disconnected = new AbortController();
      const abort = () => disconnected.abort();
      response.once("close", abort);
      try {
        const snapshot = await previews.prepare(body.path, AbortSignal.any([shutdown.signal, disconnected.signal, AbortSignal.timeout(5000)]));
        json(response, 200, snapshot);
      } finally { response.off("close", abort); }
      return;
    } else if (path === "/api/message") {
      if (typeof body.prompt !== "string" || Object.keys(body).length !== 1) throw new HttpError(400, "Expected a prompt string.");
      controller.submit(body.prompt);
    } else if (path === "/api/stop" || path === "/api/reset") {
      if (Object.keys(body).length) throw new HttpError(400, "Expected an empty object.");
      if (path === "/api/stop") controller.stop(); else await controller.reset();
    } else if (path === "/api/session/new" || path === "/api/session/fork") {
      const fields = path === "/api/session/new" ? ["name"] : ["name", "id"];
      if (Object.keys(body).some((key) => !fields.includes(key)) || (body.name !== undefined && typeof body.name !== "string")
        || (body.id !== undefined && (typeof body.id !== "string" || !body.id.trim()))) {
        throw new HttpError(400, "Expected an optional session name and, when forking, session ID.");
      }
      if (path === "/api/session/new") await controller.newSession(body.name as string | undefined);
      else await controller.fork(body.name as string | undefined, body.id as string | undefined);
    } else if (path === "/api/session/resume") {
      if (typeof body.id !== "string" || !body.id.trim() || Object.keys(body).length !== 1) {
        throw new HttpError(400, "Expected a session ID.");
      }
      await controller.resume(body.id);
    } else if (path === "/api/session/rename") {
      if (typeof body.name !== "string" || Object.keys(body).some((key) => key !== "name" && key !== "id")
        || (body.id !== undefined && (typeof body.id !== "string" || !body.id.trim()))) throw new HttpError(400, "Expected a session name and optional session ID.");
      await controller.rename(body.name, body.id as string | undefined);
    } else if (path === "/api/session/delete") {
      if (typeof body.id !== "string" || !body.id.trim() || Object.keys(body).some((key) => key !== "id" && key !== "revision")
        || (body.revision !== undefined && (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1))) {
        throw new HttpError(400, "Expected a session ID and optional positive revision.");
      }
      await controller.deleteSession(body.id, body.revision as number | undefined);
    } else if (path === "/api/permission-mode") {
      if (!isPermissionMode(body.mode) || Object.keys(body).length !== 1) throw new HttpError(400, "Expected permission mode default, acceptEdits, plan, or freeToGo.");
      controller.selectPermissionMode(body.mode);
    } else if (path === "/api/approval") {
      if (typeof body.id !== "string" || typeof body.allowed !== "boolean" || Object.keys(body).length !== 2) throw new HttpError(400, "Expected an approval ID and boolean decision.");
      controller.approve(body.id, body.allowed);
    } else throw new HttpError(404, "Not found.");
    json(response, 202, { accepted: true });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  }).catch(() => { throw new HarnessError("WEBUI_START", "Could not listen on the local port. Try --webui --port <number>."); });
  const address = server.address();
  if (!address || typeof address === "string") throw new HarnessError("WEBUI_START", "No local listening address.");
  origin = `http://127.0.0.1:${address.port}`;
  let closing: Promise<void> | undefined;
  return { url: `${origin}/#token=${token}`, origin, close(): Promise<void> {
    closing ??= (async () => {
      shutdown.abort();
      previews.close();
      const stopped = controller.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await Promise.all([stopped, closed]);
    })();
    return closing;
  } };
}
