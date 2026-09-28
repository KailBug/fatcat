import {
  Markdown,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import { createTuiTheme, type TuiTheme } from "./theme.js";

export interface TuiMessage {
  role: "user" | "assistant" | "system" | "tool" | "error";
  text: string;
  label?: string;
}

export interface TuiRow {
  label: string;
  value: string;
  tone?: "normal" | "accent" | "good" | "warning" | "muted";
}

export interface TuiSection {
  title: string;
  rows: TuiRow[];
  note?: string;
  meter?: { label: string; ratio: number | null };
}

export interface TuiViewState {
  model: string;
  provider: string;
  workspace: string;
  status: string;
  busy: boolean;
  messages: TuiMessage[];
  sections: TuiSection[];
  footer?: string;
  scrollOffset?: number;
  color?: boolean;
}

/** Keep display data from being interpreted as terminal commands. */
export function sanitizeTerminalText(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function singleLine(value: string): string {
  return sanitizeTerminalText(value).replace(/\n/g, " ");
}

function fit(value: string, width: number): string {
  return truncateToWidth(value, Math.max(0, width), "…", true);
}

function center(value: string, width: number): string {
  const padding = Math.max(0, Math.floor((width - visibleWidth(value)) / 2));
  return fit(" ".repeat(padding) + value, width);
}

function rule(label: string, width: number, theme: TuiTheme): string {
  const title = ` ${singleLine(label)} `;
  return theme.border("─") + theme.muted(fit(title, Math.max(0, Math.min(width - 2, visibleWidth(title)))))
    + theme.border("─".repeat(Math.max(0, width - visibleWidth(title) - 1)));
}

/** Presentation only: every metric is supplied by the observed runtime state. */
export class FatcatView implements Component {
  private cache = new WeakMap<TuiMessage, { width: number; text: string; color: boolean; lines: string[] }>();
  private maximumScroll = 0;

  constructor(public state: TuiViewState, public height: number) {}

  invalidate(): void {
    this.cache = new WeakMap();
  }

  /** Available transcript lines above the latest viewport. */
  get maxScrollOffset(): number {
    return this.maximumScroll;
  }

  render(width: number): string[] {
    width = Math.max(1, Math.floor(width));
    const height = Math.max(0, Math.floor(this.height));
    if (height === 0) return [];
    const theme = createTuiTheme(this.state.color !== false);
    const header = this.header(width, theme);
    if (height <= header.length + 2) {
      const lines = header.slice(0, height);
      while (lines.length < height) lines.push("");
      return lines.map((line) => fit(line, width));
    }
    const bodyHeight = height - header.length - 1;
    const body = width >= 110
      ? this.columns(width, bodyHeight, theme)
      : this.stacked(width, bodyHeight, theme);
    const status = `${this.state.busy ? "◌" : "●"} ${singleLine(this.state.status)}`;
    const footer = this.state.footer ?? "Enter send  ·  Alt+Enter newline  ·  /help commands";
    const right = singleLine(footer);
    const statusPaint = this.state.busy ? theme.warning : theme.good;
    const footerLine = width > visibleWidth(status) + visibleWidth(right) + 5
      ? statusPaint(` ${status}`) + " ".repeat(width - visibleWidth(status) - visibleWidth(right) - 3) + theme.muted(right) + "  "
      : statusPaint(` ${status}`);
    return [...header, ...body, footerLine].slice(0, height).map((line) => fit(line, width));
  }

  private header(width: number, theme: TuiTheme): string[] {
    const model = singleLine(this.state.model);
    const provider = singleLine(this.state.provider);
    const workspace = singleLine(this.state.workspace);
    if (width < 65) {
      return [
        ` ${theme.accent(theme.bold("F A T C A T"))} ${theme.muted("/ ")}${theme.text(model)}`,
        ` ${theme.muted("workspace ")}${theme.text(workspace)}`,
        theme.border("─".repeat(width)),
      ];
    }
    const badge = theme.muted("LOCAL CODING AGENT");
    const brand = ` ${theme.accent(" /\\_/\\ ")} ${theme.bold(theme.text("F A T C A T"))}   ${badge}`;
    return [
      brand,
      ` ${theme.accent("( o.o ) ")} ${theme.purple(model)} ${theme.muted("·")} ${theme.muted(provider)}`,
      ` ${theme.accent(" > ^ <  ")} ${theme.muted("workspace ")}${theme.text(workspace)}`,
      theme.border("─".repeat(width)),
    ];
  }

  private columns(width: number, height: number, theme: TuiTheme): string[] {
    const sidebarWidth = Math.min(44, Math.max(34, Math.floor(width * 0.29)));
    const transcriptWidth = width - sidebarWidth - 3;
    const transcript = this.transcript(transcriptWidth, height, theme);
    const sidebar = this.sidebar(sidebarWidth, height, theme);
    return Array.from({ length: height }, (_, index) =>
      fit(transcript[index] ?? "", transcriptWidth) + theme.border(" │ ") + fit(sidebar[index] ?? "", sidebarWidth));
  }

  private stacked(width: number, height: number, theme: TuiTheme): string[] {
    const rows = this.state.sections.flatMap((section) => section.rows);
    const highlighted: TuiRow[] = [];
    for (const section of this.state.sections) {
      if (/usage/i.test(section.title)) {
        const usage = section.rows.find((row) => /session|total tokens/i.test(row.label));
        if (usage) highlighted.push({ ...usage, label: "Tokens" });
      } else if (/cache|kv/i.test(section.title)) {
        const cache = section.rows.find((row) => /session hit|kv hit|hit rate/i.test(row.label));
        if (cache) highlighted.push({ ...cache, label: "Prompt cache" });
      } else if (/context|request/i.test(section.title)) {
        highlighted.push(...section.rows.filter((row) => /parent input|json body/i.test(row.label)));
      }
    }
    if (highlighted.length === 0) {
      highlighted.push(...rows.filter((row) => /tokens|kv|cache|context|request bytes/i.test(row.label)).slice(0, 4));
    }
    const items = (highlighted.length > 0 ? highlighted : rows.slice(0, 3))
      .map((row) => `${theme.muted(singleLine(row.label))} ${theme.accent(singleLine(row.value))}`);
    if (height < 6 || items.length === 0) return this.transcript(width, height, theme);
    const ribbon: string[] = [];
    let current = " ";
    for (const item of items) {
      const separator = current === " " ? "" : theme.border("  ·  ");
      if (current !== " " && visibleWidth(current + separator + item) > width) {
        ribbon.push(current);
        current = ` ${item}`;
      } else {
        current += separator + item;
      }
    }
    if (current !== " ") ribbon.push(current);
    const ribbonLines = ribbon.slice(0, 2);
    return [
      ...ribbonLines,
      theme.muted(fit(" /status full telemetry and configuration", width)),
      ...this.transcript(width, height - ribbonLines.length - 1, theme),
    ];
  }

  private sidebar(width: number, height: number, theme: TuiTheme): string[] {
    const lines: string[] = [rule("SESSION TELEMETRY", width, theme)];
    for (const section of this.state.sections) {
      lines.push(` ${theme.purple(theme.bold(singleLine(section.title).toUpperCase()))}`);
      for (const row of section.rows) {
        const label = singleLine(row.label);
        const value = singleLine(row.value);
        const paint = row.tone === "normal" || row.tone === undefined ? theme.text : theme[row.tone];
        const gap = width - visibleWidth(label) - visibleWidth(value) - 2;
        if (gap >= 1) {
          lines.push(` ${theme.muted(label)}${" ".repeat(gap)}${paint(value)} `);
        } else {
          lines.push(` ${theme.muted(label)}`);
          lines.push(...wrapTextWithAnsi(value, Math.max(1, width - 3)).map((line) => `  ${paint(line)} `));
        }
      }
      if (section.meter) {
        const ratio = section.meter.ratio;
        const known = ratio !== null && Number.isFinite(ratio) && ratio >= 0;
        const barWidth = Math.max(1, width - 4);
        const fill = known ? Math.round(Math.min(1, ratio) * barWidth) : 0;
        lines.push(` ${theme.muted(singleLine(section.meter.label))}${known ? "" : theme.muted(" · N/A")}`);
        lines.push(` ${theme.accent("━".repeat(fill))}${theme.border("─".repeat(barWidth - fill))} `);
      }
      if (section.note) {
        lines.push(...wrapTextWithAnsi(sanitizeTerminalText(section.note), Math.max(1, width - 2))
          .map((line) => ` ${theme.muted(line)} `));
      }
      lines.push("");
    }
    if (lines.length > height) return this.compactSidebar(width, height, theme);
    return [...lines, ...Array<string>(height - lines.length).fill("")];
  }

  private compactSidebar(width: number, height: number, theme: TuiTheme): string[] {
    const sections = this.state.sections;
    const lines = [rule("SESSION TELEMETRY", width, theme)];
    if (height < sections.length * 2 + 2) {
      for (const section of sections) {
        const first = section.rows[0];
        lines.push(` ${theme.purple(singleLine(section.title))}${first ? ` ${theme.text(singleLine(first.value))}` : ""}`);
      }
    } else {
      // Share the visible row budget across groups so context never disappears
      // merely because token usage and cache statistics occupy the first cards.
      let remaining = height - 1 - sections.length * 2;
      const counts = sections.map(() => 0);
      while (remaining > 0) {
        let changed = false;
        for (let index = 0; index < sections.length && remaining > 0; index++) {
          if (counts[index]! >= sections[index]!.rows.length) continue;
          counts[index]!++;
          remaining--;
          changed = true;
        }
        if (!changed) break;
      }
      for (let index = 0; index < sections.length; index++) {
        const section = sections[index]!;
        lines.push(` ${theme.purple(theme.bold(singleLine(section.title)))}`);
        for (const row of section.rows.slice(0, counts[index])) {
          const value = singleLine(row.value);
          const valueWidth = Math.min(visibleWidth(value), Math.max(6, Math.floor(width * 0.55)));
          const labelWidth = Math.max(1, width - valueWidth - 3);
          const paint = row.tone === "normal" || row.tone === undefined ? theme.text : theme[row.tone];
          lines.push(` ${theme.muted(fit(singleLine(row.label), labelWidth))} ${paint(fit(value, valueWidth))} `);
        }
        if (index < sections.length - 1) lines.push("");
      }
    }
    while (lines.length < height - 1) lines.push("");
    return [...lines.slice(0, Math.max(0, height - 1)), theme.muted(" /status for all metrics")].slice(0, height);
  }

  private transcript(width: number, height: number, theme: TuiTheme): string[] {
    if (height <= 0) return [];
    const contentHeight = Math.max(0, height - 2);
    const heading = rule("CONVERSATION", width, theme);
    if (this.state.messages.length === 0) {
      this.maximumScroll = 0;
      const intro = [
        theme.accent(" /\\_/\\"),
        theme.accent("( =^.^= )"),
        theme.accent(" (\")_(\")"),
        "",
        theme.bold(theme.text("Make something worth shipping.")),
        "",
        theme.muted("Inspect code. Make a change. Verify the result."),
        theme.muted("Your workspace, your permissions, one focused session."),
        "",
        `${theme.accent("/help")} ${theme.muted("commands")}   ${theme.accent("/status")} ${theme.muted("session details")}`,
      ];
      const selected = contentHeight >= intro.length ? intro : intro.slice(4);
      const top = Math.max(0, Math.floor((contentHeight - selected.length) / 2));
      const empty = [...Array<string>(top).fill(""), ...selected.map((line) => center(line, width))].slice(0, contentHeight);
      while (empty.length < contentHeight) empty.push("");
      return [heading, ...empty, theme.border("─".repeat(width))].slice(0, height);
    }
    const contentWidth = Math.max(1, width - 4);
    const transcriptLines: string[] = [];
    for (const message of this.state.messages) {
      const color = this.state.color !== false;
      let cached = this.cache.get(message);
      if (!cached || cached.width !== contentWidth || cached.text !== message.text || cached.color !== color) {
        const clean = sanitizeTerminalText(message.text);
        const lines = message.role === "assistant"
          ? new Markdown(clean, 0, 0, theme.markdown, { color: theme.text }, { renderLatex: false }).render(contentWidth)
          : wrapTextWithAnsi(clean, contentWidth).map((line) => theme.text(line));
        cached = { width: contentWidth, text: message.text, color, lines };
        this.cache.set(message, cached);
      }
      const paint = message.role === "user" ? theme.accent
        : message.role === "assistant" ? theme.purple
        : message.role === "error" ? theme.error : theme.muted;
      const label = singleLine(message.label ?? ({ user: "YOU", assistant: "FATCAT", system: "SESSION", tool: "TOOL", error: "ERROR" }[message.role]));
      transcriptLines.push(` ${paint(theme.bold(label))}`);
      transcriptLines.push(...cached.lines.map((line) => ` ${paint("│")} ${line}`));
      transcriptLines.push("");
    }
    this.maximumScroll = Math.max(0, transcriptLines.length - contentHeight);
    const requested = this.state.scrollOffset ?? 0;
    const offset = Number.isFinite(requested) ? Math.min(this.maximumScroll, Math.max(0, Math.floor(requested))) : 0;
    const start = Math.max(0, transcriptLines.length - contentHeight - offset);
    const visible = transcriptLines.slice(start, start + contentHeight);
    while (visible.length < contentHeight) visible.push("");
    const scrollLabel = offset > 0 ? ` ${offset} lines above latest · PgDn to return` : " Latest · PgUp/PgDn scroll";
    return [heading, ...visible, theme.muted(fit(scrollLabel, width))].slice(0, height);
  }
}
