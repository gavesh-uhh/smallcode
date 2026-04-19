export const ESC = "\x1b";

export const style = {
  bold: (s: string) => `${ESC}[1m${s}${ESC}[22m`,
  dim: (s: string) => `${ESC}[2m${s}${ESC}[22m`,
  italic: (s: string) => `${ESC}[3m${s}${ESC}[23m`,
  underline: (s: string) => `${ESC}[4m${s}${ESC}[24m`,
  inverse: (s: string) => `${ESC}[7m${s}${ESC}[27m`,
  cyan: (s: string) => `${ESC}[36m${s}${ESC}[39m`,
  green: (s: string) => `${ESC}[32m${s}${ESC}[39m`,
  yellow: (s: string) => `${ESC}[33m${s}${ESC}[39m`,
  red: (s: string) => `${ESC}[31m${s}${ESC}[39m`,
  blue: (s: string) => `${ESC}[34m${s}${ESC}[39m`,
  magenta: (s: string) => `${ESC}[35m${s}${ESC}[39m`,
  gray: (s: string) => `${ESC}[90m${s}${ESC}[39m`,
  white: (s: string) => `${ESC}[97m${s}${ESC}[39m`,
  bgGray: (s: string) => `${ESC}[48;5;236m${s}${ESC}[49m`,
  bgDark: (s: string) => `${ESC}[48;5;237m${s}${ESC}[49m`,
  bgCyan: (s: string) => `${ESC}[46m${s}${ESC}[49m`,
  prefixBgGray: `${ESC}[48;5;236m`,
  prefixBgDark: `${ESC}[48;5;237m`,
  reset: `${ESC}[0m`,
} as const;

export const icon = {
  user: "",
  assistant: "",
  tool: "",
  check: "",
  cross: "",
  spinner: "",
  dot: "•",
  arrow: "",
  gear: "",
  working: "⟳",
  model: "󰧑",
  session: "󰥛",
  warn: "",
  error: "",
  info: "",
  folder: "",
  file: "",
  sep: "│",
  tab: "󰓩",
  progFull: "",
  progEmpty: "",
  thought: "󰟶",
} as const;

export function formatMarkdown(text: string): string {
  let inCode = false;
  const lines = text.split("\n");
  const formattedLines: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCode = !inCode;
      if (inCode) {
        const lang = line.trim().slice(3).trim() || "code";
        formattedLines.push(style.gray(`╭── ${lang}`));
      } else {
        formattedLines.push(style.gray(`╰──`));
      }
      continue;
    }

    if (inCode) {
      formattedLines.push(style.gray("│ ") + style.yellow(line));
    } else {
      let l = line;
      l = l.replace(/\*\*(.*?)\*\*/g, (_, p1) => style.bold(p1));
      l = l.replace(/`([^`]+)`/g, (_, p1) => style.yellow(p1));
      formattedLines.push(l);
    }
  }

  return formattedLines.join("\n");
}

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function visibleLength(s: string): number {
  return stripAnsi(s).replace(/[\x00-\x1f]/g, "").length;
}

export function padRight(s: string, width: number): string {
  const vl = visibleLength(s);
  if (vl >= width) return s;
  return s + " ".repeat(width - vl);
}

export function fitToWidth(s: string, width: number): string {
  const clean = s.replace(/[\n\r\t]/g, " ");
  const vl = visibleLength(clean);
  if (vl > width) {
    return truncateVisible(clean, width);
  }
  return clean;
}

export function truncateVisible(s: string, max: number): string {
  if (max <= 0) return "";
  const stripped = stripAnsi(s);
  if (stripped.length <= max) return s;

  let vis = 0;
  let i = 0;
  const raw = s;
  while (i < raw.length && vis < max - 1) {
    if (raw[i] === "\x1b" && raw[i + 1] === "[") {
      let end = i + 2;
      while (end < raw.length && !/[A-Za-z]/.test(raw[end])) {
        end++;
      }
      if (end < raw.length) {
        i = end + 1;
      } else {
        i += 2;
      }
      continue;
    }
    if (raw.charCodeAt(i) < 0x20 && raw[i] !== "\x1b") {
      i++;
      continue;
    }
    vis++;
    i++;
  }
  return raw.slice(0, i) + "…" + style.reset;
}

export function splitLines(s: string): string[] {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

export function wrapText(s: string, width: number): string[] {
  if (width <= 0) return [s];

  const paragraphs = splitLines(s);
  const allLines: string[] = [];

  for (const para of paragraphs) {
    if (para === "") {
      allLines.push("");
      continue;
    }

    const words = para.split(/ /);
    let current = "";
    let currentLen = 0;

    for (const word of words) {
      const wordLen = visibleLength(word);

      if (wordLen > width && currentLen === 0) {
        let remaining = word;
        while (visibleLength(remaining) > width) {
          allLines.push(remaining.slice(0, width));
          remaining = remaining.slice(width);
        }
        if (remaining) {
          current = remaining;
          currentLen = visibleLength(remaining);
        }
        continue;
      }

      if (
        currentLen + (currentLen > 0 ? 1 : 0) + wordLen > width &&
        currentLen > 0
      ) {
        allLines.push(current);
        current = word;
        currentLen = wordLen;
      } else {
        current += (currentLen > 0 ? " " : "") + word;
        currentLen += (currentLen > 0 ? 1 : 0) + wordLen;
      }
    }
    allLines.push(current);
  }

  if (allLines.length === 0) allLines.push("");
  return allLines;
}

export function hr(width: number): string {
  return style.dim("─".repeat(width));
}
