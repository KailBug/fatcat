import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import ipaddr from "ipaddr.js";
import { HarnessError } from "../errors.js";

export const maxResponseBytes = 1024 * 1024;
export type Address = { address: string; family: number };
export type WebResponse = { status: number; headers: Headers; body: ReadableStream<Uint8Array> | null };
export type WebTransport = (url: URL, address: Address, signal: AbortSignal) => Promise<WebResponse>;
export type WebResolver = (hostname: string) => Promise<Address[]>;

function denied(): never {
  throw new HarnessError("WEB_URL_NOT_ALLOWED", "Use a public HTTP(S) URL on its standard port without credentials; private and special-use addresses are blocked.");
}

export function isPublicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  // Reject mapped, transition and special-use ranges as well as private networks.
  return parsed.range() === "unicast";
}

export function publicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { return denied(); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port
    || value.length > 2048 || /[\x00-\x20\x7f]/.test(value)) denied();
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) ? !isPublicAddress(host) : !host.includes(".")
    || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)\.?$/i.test(host)) denied();
  url.hash = "";
  return url;
}

export const resolveWebHost: WebResolver = (hostname) => lookup(hostname, { all: true, verbatim: true });

/** Stop waiting promptly even if an injected transport or OS DNS lookup cannot abort. */
export async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    })]);
  } finally { signal.removeEventListener("abort", onAbort); }
}

export async function publicAddress(url: URL, resolver: WebResolver, signal: AbortSignal): Promise<Address> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
    : await abortable(resolver(host), signal);
  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family)) denied();
  return addresses[0]!;
}

/** Pin the validated address; preserve the URL hostname for HTTP Host and TLS verification. */
export const requestWeb: WebTransport = (url, address, signal) => new Promise((resolve, reject) => {
  const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
    method: "GET", signal, agent: false,
    headers: { "user-agent": "Fatcat/0.1 (public web reader)",
      accept: "text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.1",
      "accept-encoding": "gzip, deflate, br" },
    lookup: (_hostname, options, callback) => {
      if (options.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    },
  }, (response) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    let bytes = 0;
    const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > maxResponseBytes ? new HarnessError("WEB_RESPONSE_LIMIT", "The response exceeds the 1 MiB download limit.") : null, chunk);
    } });
    const encoding = headers.get("content-encoding")?.toLowerCase();
    const decoder = encoding === "gzip" ? createGunzip() : encoding === "deflate" ? createInflate()
      : encoding === "br" ? createBrotliDecompress() : undefined;
    if (encoding && encoding !== "identity" && !decoder) {
      response.destroy();
      reject(new HarnessError("WEB_CONTENT_TYPE", "The response uses an unsupported content encoding."));
      return;
    }
    const stream = decoder ?? bound;
    response.on("error", (error) => bound.destroy(error));
    bound.on("error", (error) => { response.destroy(); decoder?.destroy(error); });
    stream.on("close", () => { response.destroy(); bound.destroy(); });
    if (decoder) bound.pipe(decoder);
    response.pipe(bound);
    resolve({ status: response.statusCode ?? 0, headers,
      body: Readable.toWeb(stream) as ReadableStream<Uint8Array> });
  });
  request.on("error", reject);
  request.end();
});

export async function readWebBody(response: WebResponse, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new HarnessError("WEB_RESPONSE_LIMIT", "The decoded response exceeds 1 MiB; use a smaller page or API request.");
      chunks.push(value);
    }
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(response.headers.get("content-type") ?? "")?.[1] ?? "utf-8";
    try { return new TextDecoder(charset, { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new HarnessError("WEB_CONTENT_TYPE", "The response text encoding is unsupported or invalid."); }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
