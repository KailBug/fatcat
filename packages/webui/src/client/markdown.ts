import { parseSourceReference } from "./attachments.js";

/** A deliberately small Markdown subset. Every untrusted fragment becomes a text node. */
function inline(text: string, parent: HTMLElement, openSource?: (reference: string) => void): void {
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\)|attachment:[a-f0-9-]+@[a-f0-9]+(?:#(?:L[0-9]+-L[0-9]+|parse=[a-zA-Z0-9._%-]+&unit=[a-zA-Z0-9._%-]+))?)/g;
  const source = (reference: string, label: string): boolean => {
    if (!openSource || !parseSourceReference(reference)) return false;
    const button = document.createElement("button");
    button.type = "button"; button.className = "attachment-citation"; button.textContent = label;
    button.title = reference;
    button.addEventListener("click", () => openSource(reference));
    parent.append(button);
    return true;
  };
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(position, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      if (!source(token.slice(1, -1), "Attachment source")) {
        const code = document.createElement("code"); code.textContent = token.slice(1, -1); parent.append(code);
      }
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong"); strong.textContent = token.slice(2, -2); parent.append(strong);
    } else if (token.startsWith("attachment:")) {
      if (!source(token, "Attachment source")) parent.append(document.createTextNode(token));
    } else {
      const divider = token.indexOf("](");
      const href = token.slice(divider + 2, -1);
      if (/^https?:\/\//i.test(href)) {
        const link = document.createElement("a");
        link.textContent = token.slice(1, divider); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer";
        parent.append(link);
      } else if (!source(href, token.slice(1, divider))) parent.append(document.createTextNode(token));
    }
    position = match.index + token.length;
  }
  parent.append(document.createTextNode(text.slice(position)));
}

export function renderMarkdown(text: string, openSource?: (reference: string) => void): HTMLElement {
  const root = document.createElement("div"); root.className = "answer";
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("```")) {
      const pre = document.createElement("pre");
      const language = line.slice(3).trim();
      if (language) { const label = document.createElement("span"); label.className = "code-label"; label.textContent = language; pre.append(label); }
      const code: string[] = [];
      while (++i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i]!);
      const content = document.createElement("code"); content.textContent = code.join("\n"); pre.append(content); root.append(pre);
    } else if (/^#{1,6} /.test(line)) {
      const heading = document.createElement(`h${Math.min(line.indexOf(" ") + 1, 4)}`);
      inline(line.slice(line.indexOf(" ") + 1), heading, openSource); root.append(heading);
    } else if (/^\s*(?:[-*] |\d+\. )/.test(line)) {
      const ordered = /^\s*\d+\. /.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      const marker = ordered ? /^\s*\d+\. / : /^\s*[-*] /;
      do { const item = document.createElement("li"); inline(lines[i]!.replace(marker, ""), item, openSource); list.append(item); i++; }
      while (i < lines.length && marker.test(lines[i]!));
      i--; root.append(list);
    } else if (line.startsWith("> ")) {
      const quote = document.createElement("blockquote"); inline(line.slice(2), quote, openSource); root.append(quote);
    } else if (line.trim()) {
      const paragraph = document.createElement("p");
      const group = [line];
      while (i + 1 < lines.length && lines[i + 1]!.trim() && !/^(?:```|#{1,6} |\s*[-*] |\s*\d+\. |> )/.test(lines[i + 1]!)) group.push(lines[++i]!);
      inline(group.join("\n"), paragraph, openSource); root.append(paragraph);
    }
  }
  return root;
}
