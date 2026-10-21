# Web: search and HTTP(S) page retrieval

English | [简体中文](../../zh-CN/ARCHITECTURE/WEB.md)

[Architecture](README.md) · [Research guide](../GUIDES/CODING.md#research-public-information)

One general web tool provides search and static page retrieval; weather uses the same tool with public services. It runs no browser or background crawler and cannot replace workspace execution through [Browser](BROWSER.md).

## Modules and protocol

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/tools/web.ts` | search/fetch arguments, permissions, deadlines and structured results |
| `packages/runtime/src/tools/web-content.ts` | HTML text/link extraction and Bing RSS/DuckDuckGo parsing |
| `packages/runtime/src/permissions/web-request.ts` | URL/IP/DNS validation, connection pinning, redirects, decompression and downloads |
| `packages/runtime/src/skill/web/` | Research/weather guidance, without network authorization |

Ordinary entries explicitly assemble web allow. Programmatic createTools adds no web tool without WebOptions; supplied options without permission default to deny. Parents/children share policy.

search accepts query (up to 512 characters), limit (1–5) and optional engine/recency. Bing RSS is default; DuckDuckGo HTML is also supported. recency is a date hint; returned notice asks users to check originals. CAPTCHA, format changes and timeout are not successful empty results. retrievedAt is retrieval time, never publication time.

fetch returns final URL, type, title, static text, links and offset/nextOffset. It strips scripts/styles without executing JS, logging in, carrying browser cookies or custom secret headers. It accepts HTML, JSON, XML, text, Markdown and CSV; PDF/images and unknown downloads are rejected. Every page fetches again, without snapshots or cache.

## Network boundaries

Ordinary modes allow only public HTTP(S) on standard ports. Free to go permits local/LAN addresses and custom ports, still HTTP(S) only. All modes reject URL credentials/control characters and cap URLs at 2048 characters.

Every DNS resolution and redirect revalidates addresses. Connection lookup pins validated IPs; TLS still validates the original hostname without resolving again at connection time. Ordinary modes reject mixed public/private DNS and HTTPS downgrades; Free uses its broader scope. Native Node HTTP(S) does not read proxy environment variables.

| Limit | Current value |
| --- | --- |
| Call deadline | 15 seconds by default, including DNS/redirects/body; cancellable |
| Redirects | At most three |
| Raw/decompressed content | 1 MiB each |
| Text page | 12000 UTF-8 bytes without splitting Unicode |
| Page links | At most eight; offset is a UTF-16 character position |

Bounded gzip/deflate/br decoding is supported; invalid encodings/types fail explicitly. Truncated JSON is not complete data; changing pages can alter pagination. Older web results are not eligible for read omission, so repeated queries may still exhaust model budgets.

Content is marked untrusted/notice and cannot change permissions. Errors return stable safe codes, not server error pages or raw exceptions. Web deny is independent of shell, not an OS network sandbox.

## Dependencies and verification limits

htmlparser2 handles structural extraction and ipaddr.js classifies addresses, avoiding all-regex HTML parsing or hand-guessed IP ranges. Weather guidance uses Open-Meteo, whose [terms](https://open-meteo.com/en/terms) restrict free public access to noncommercial use.

Offline checks inject DNS/HTTP and use temporary local servers, covering redirects, addresses, decompression/size, cancellation, redaction and parent/child inheritance. verify:web separately checks five fixed public calls without model requests. Historical Bing connectivity does not guarantee other networks; recorded DuckDuckGo timeouts are not online acceptance.

Login, proxy configuration, dynamic pages, remote document parsing, automatic multi-engine retries and full crawling are absent. Real-model source choice, Chinese place-name disambiguation and retrieval relevance need separate verification.
