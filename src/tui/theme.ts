import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

type Paint = (text: string) => string;

export interface TuiTheme {
  text: Paint;
  muted: Paint;
  border: Paint;
  accent: Paint;
  purple: Paint;
  good: Paint;
  warning: Paint;
  error: Paint;
  bold: Paint;
  markdown: MarkdownTheme;
  editor: EditorTheme;
}

export function createTuiTheme(color = true): TuiTheme {
  const ansi = (open: string, close = "39"): Paint => color
    ? (text) => `\u001b[${open}m${text}\u001b[${close}m`
    : (text) => text;
  const text = ansi("38;2;220;226;240");
  const muted = ansi("38;2;137;149;174");
  const border = ansi("38;2;65;81;109");
  const accent = ansi("38;2;87;220;214");
  const purple = ansi("38;2;186;153;255");
  const good = ansi("38;2;156;220;157");
  const warning = ansi("38;2;245;198;114");
  const error = ansi("38;2;247;130;148");
  const bold = ansi("1", "22");
  return {
    text, muted, border, accent, purple, good, warning, error, bold,
    markdown: {
      heading: (value) => bold(accent(value)),
      link: accent,
      linkUrl: muted,
      code: purple,
      codeBlock: text,
      codeBlockBorder: border,
      quote: muted,
      quoteBorder: purple,
      hr: border,
      listBullet: accent,
      bold,
      italic: ansi("3", "23"),
      strikethrough: ansi("9", "29"),
      underline: ansi("4", "24"),
      codeBlockIndent: "  ",
    },
    editor: {
      borderColor: accent,
      selectList: {
        selectedPrefix: accent,
        selectedText: (value) => bold(accent(value)),
        description: muted,
        scrollInfo: muted,
        noMatch: warning,
      },
    },
  };
}
