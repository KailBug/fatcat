import { DomUtils, parseDocument } from "htmlparser2";
import { HarnessError } from "../errors.js";
import { webUrl } from "../permissions/web-request.js";
import type { NetworkAccess } from "../permissions/web-request.js";

export function clipUtf8(value: string, bytes: number): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= bytes) return value;
  let end = bytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}

export function cleanText(value: string): string {
  return value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "").replace(/\s+/g, " ").trim();
}

export function sourceUrl(value: string, base: URL, access: NetworkAccess = "public"): string | undefined {
  try { return webUrl(new URL(value, base).href, access).href; } catch { return undefined; }
}

export function extractPage(html: string, url: URL, access: NetworkAccess = "public") {
  const doc = parseDocument(html);
  const title = clipUtf8(cleanText(DomUtils.textContent(DomUtils.getElementsByTagName("title", doc)[0] ?? [])), 256);
  for (const node of DomUtils.findAll((element) => ["script", "style", "noscript", "template", "svg", "head"].includes(element.name), doc.children)) {
    DomUtils.removeElement(node);
  }
  // Insert separators before flattening, so adjacent paragraphs and table cells remain readable.
  for (const node of DomUtils.findAll((element) => ["p", "div", "br", "li", "tr", "td", "th", "h1", "h2", "h3", "section", "article"].includes(element.name), doc.children)) {
    DomUtils.appendChild(node, parseDocument("\n").children[0]!);
  }
  const content = DomUtils.textContent(doc).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "")
    .split(/\r?\n/).map(cleanText).filter(Boolean).join("\n");
  const links: { title: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const anchor of DomUtils.getElementsByTagName("a", doc)) {
    const href = anchor.attribs.href ? sourceUrl(anchor.attribs.href, url, access) : undefined;
    const text = cleanText(DomUtils.textContent(anchor));
    if (href && text && !seen.has(href)) {
      seen.add(href);
      links.push({ title: clipUtf8(text, 160), url: href });
      if (links.length === 8) break;
    }
  }
  return { title, content, links };
}

/** DuckDuckGo's documented no-JavaScript page is best-effort, not a contracted API. */
export function extractSearch(html: string, url: URL, limit: number, access: NetworkAccess = "public") {
  const doc = parseDocument(html);
  const hasClass = (classes: string | undefined, name: string) => classes?.split(/\s+/).includes(name) ?? false;
  if (/anomaly\.js|anomaly-modal|challenge-form/i.test(html)) {
    throw new HarnessError("WEB_SEARCH_UNAVAILABLE", "Search returned a bot challenge. Read a known public URL or report that search is unavailable; do not bypass the challenge.");
  }
  const results: { title: string; url: string; snippet: string }[] = [];
  const seen = new Set<string>();
  for (const block of DomUtils.findAll((element) => hasClass(element.attribs.class, "result"), doc.children)) {
    const anchor = DomUtils.findAll((element) => element.name === "a" && hasClass(element.attribs.class, "result__a"), block.children)[0];
    if (!anchor?.attribs.href) continue;
    let href: URL;
    try { href = new URL(anchor.attribs.href, url); } catch { continue; }
    if (href.hostname === "duckduckgo.com" || href.hostname.endsWith(".duckduckgo.com")) {
      const target = href.searchParams.get("uddg");
      if (target) { try { href = new URL(target); } catch { continue; } }
    }
    const link = sourceUrl(href.href, url, access);
    if (!link || seen.has(link)) continue;
    const snippet = DomUtils.findAll((element) => hasClass(element.attribs.class, "result__snippet"), block.children)[0];
    seen.add(link);
    results.push({ title: clipUtf8(cleanText(DomUtils.textContent(anchor)), 256), url: link,
      snippet: clipUtf8(cleanText(snippet ? DomUtils.textContent(snippet) : ""), 700) });
    if (results.length === limit) break;
  }
  if (!results.length && !DomUtils.findAll((element) => hasClass(element.attribs.class, "no-results"), doc.children).length) {
    throw new HarnessError("WEB_SEARCH_UNAVAILABLE", "Search returned no recognizable results. Try a known public URL; the service may be unavailable or its format may have changed.");
  }
  return results;
}

export function extractBingSearch(xml: string, url: URL, limit: number, access: NetworkAccess = "public") {
  const doc = parseDocument(xml, { xmlMode: true });
  const channel = DomUtils.getElementsByTagName("channel", doc)[0];
  if (!channel || !DomUtils.getElementsByTagName("rss", doc).length) {
    throw new HarnessError("WEB_SEARCH_UNAVAILABLE", "Search did not return a recognizable RSS feed. Try another engine or a known public URL.");
  }
  const text = (node: typeof channel, name: string) => cleanText(DomUtils.textContent(DomUtils.getElementsByTagName(name, node)[0] ?? []));
  const results: { title: string; url: string; snippet: string; publishedAt: string | null }[] = [];
  const seen = new Set<string>();
  const items = DomUtils.getElementsByTagName("item", channel);
  for (const item of items) {
    const href = text(item, "link");
    const link = href ? sourceUrl(href, url, access) : undefined;
    if (!link || seen.has(link)) continue;
    seen.add(link);
    results.push({ title: clipUtf8(text(item, "title"), 256), url: link,
      snippet: clipUtf8(cleanText(extractPage(text(item, "description"), url).content), 700),
      publishedAt: clipUtf8(text(item, "pubDate"), 100) || null });
    if (results.length === limit) break;
  }
  if (items.length && !results.length) throw new HarnessError("WEB_SEARCH_UNAVAILABLE", "Search returned no usable public source links.");
  return results;
}
