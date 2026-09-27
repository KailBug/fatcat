import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { FatcatView, sanitizeTerminalText, type TuiViewState } from "../src/tui/view.js";

function fixture(): TuiViewState {
  return {
    model: "deepseek-flash",
    provider: "DeepSeek / global",
    workspace: "D:\\project",
    status: "Ready",
    busy: false,
    messages: [],
    sections: [
      {
        title: "Usage",
        rows: [
          { label: "Total tokens", value: "N/A", tone: "accent" },
          { label: "KV hit rate", value: "N/A", tone: "muted" },
          { label: "Request bytes", value: "N/A / 256 KiB" },
        ],
        meter: { label: "Request budget", ratio: null },
        note: "No provider usage reported yet.",
      },
      {
        title: "Configuration",
        rows: [{ label: "Write permission", value: "ask" }, { label: "Shell permission", value: "ask" }],
      },
    ],
  };
}

function plain(view: FatcatView, width = 120): string {
  return view.render(width).map(stripTerminalSequences).join("\n");
}

test("TUI renders exact bounded rows at wide, narrow, and very small terminal sizes", () => {
  const state = fixture();
  state.messages = [
    { role: "user", text: "Inspect \u4e2d\u6587\u4ee3\u7801 and update the \ud83d\udc08 fixture." },
    { role: "assistant", text: "## Result\n\nUpdated **one file**.\n\n```ts\nconst total = 123;\n```\n\n" + "longvalue".repeat(30) },
  ];
  const view = new FatcatView(state, 25);
  for (const width of [1, 8, 30, 64, 80, 109, 110, 120, 180]) {
    for (const height of [0, 1, 5, 12, 25, 50]) {
      view.height = height;
      const lines = view.render(width);
      assert.equal(lines.length, height, `height ${width}x${height}`);
      for (const line of lines) assert.equal(visibleWidth(line), width, `width ${width}x${height}`);
    }
  }
});

test("TUI displays observed values and unknown telemetry without fabricating zeroes", () => {
  const view = new FatcatView(fixture(), 36);
  const output = plain(view);
  assert.match(output, /F A T C A T/);
  assert.match(output, /deepseek-flash/);
  assert.match(output, /D:\\project/);
  assert.match(output, /KV hit rate\s+N\/A/);
  assert.match(output, /Request budget.*N\/A/);
  assert.doesNotMatch(output, /0\.0%/);
  view.state.sections[0]!.rows[1]!.value = "73.4% (reported requests)";
  assert.match(plain(view), /73\.4% \(reported requests\)/);
  assert.match(plain(view, 78), /\/status full telemetry/);
});

test("TUI strips terminal command injection from messages, model names, paths, and metrics", () => {
  const injected = "visible\u001b[2J\u001b]52;c;c2VjcmV0\u0007\u001b[31mtext\u001b[0m\u0007\u0085";
  const state = fixture();
  state.model = injected;
  state.workspace = injected;
  state.sections[0]!.rows[0]!.value = injected;
  state.messages = [
    { role: "user", label: injected, text: injected },
    { role: "assistant", text: injected },
  ];
  const output = new FatcatView(state, 40).render(120).join("\n");
  assert.match(output, /visibletext/);
  assert.doesNotMatch(output, /\u001b\[2J|\u001b\]52|c2VjcmV0|\u0007|\u0085/);
  assert.equal(sanitizeTerminalText("one\r\ntwo\tthree\rmore"), "one\ntwo    three\nmore");
});

test("TUI no-color rendering preserves content without ANSI styling", () => {
  const state = fixture();
  state.color = false;
  state.messages = [{ role: "assistant", text: "# Heading\n\n**Bold** and `code`." }];
  const output = new FatcatView(state, 32).render(120).join("\n");
  assert.match(output, /Heading/);
  assert.match(output, /Bold.*code/);
  assert.doesNotMatch(output, /\u001b\[/);
});

test("TUI transcript paging retains older messages and clamps offsets", () => {
  const state = fixture();
  state.messages = Array.from({ length: 25 }, (_, index) => ({ role: "user", text: `message ${index}` }));
  const view = new FatcatView(state, 24);
  assert.match(plain(view), /message 24/);
  assert.doesNotMatch(plain(view), /message 0\b/);
  assert.ok(view.maxScrollOffset > 0);
  state.scrollOffset = 999999;
  const older = plain(view);
  assert.match(older, /message 0\b/);
  assert.match(older, /lines above latest/);
  state.scrollOffset = 0;
  assert.match(plain(view), /message 24/);
});

test("TUI reports hidden sidebar information and renders unknown meter safely", () => {
  const state = fixture();
  state.sections[0]!.meter!.ratio = Number.NaN;
  const view = new FatcatView(state, 16);
  assert.match(plain(view), /\/status for all metrics/);
  view.height = 40;
  assert.match(plain(view), /Request budget.*N\/A/);
});

test("compact telemetry keeps every metric group and exposes narrow-screen essentials", () => {
  const state = fixture();
  state.sections = [
    { title: "TOKEN USAGE", rows: [{ label: "Session", value: "12,345" }, { label: "In / out", value: "10,000 / 2,345" }, { label: "Coverage", value: "3/3 reported" }] },
    { title: "PROMPT CACHE / KV", rows: [{ label: "Session hit", value: "75.0%" }, { label: "Cached / input", value: "7,500 / 10,000" }, { label: "Coverage", value: "3/3 requests" }] },
    { title: "CONTEXT / REQUEST", rows: [{ label: "Parent input", value: "4,000 tokens" }, { label: "JSON body", value: "25,000 B" }, { label: "Byte budget", value: "262,144 B" }] },
    { title: "CONVERSATION", rows: [{ label: "Saved turns", value: "2" }, { label: "Turn", value: "3 / answered" }, { label: "Requests P/C", value: "2 / 1" }] },
  ];
  for (const section of state.sections) {
    section.note = "Additional metric definitions remain accessible through /status.";
    section.meter = { label: "Synthetic request budget", ratio: 0.5 };
  }
  const view = new FatcatView(state, 26);
  const wide = plain(view);
  for (const section of state.sections) assert.ok(wide.includes(section.title));
  for (const value of ["12,345", "75.0%", "4,000 tokens", "25,000 B", "262,144 B"]) {
    assert.ok(wide.includes(value), value);
  }
  const narrow = plain(view, 80);
  assert.match(narrow, /Tokens 12,345/);
  assert.match(narrow, /Prompt cache 75\.0%/);
  assert.match(narrow, /Parent input 4,000 tokens/);
  assert.match(narrow, /JSON body 25,000 B/);
});
