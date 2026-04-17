import {
  fitToWidth,
  formatMarkdown,
  hr,
  icon,
  splitLines,
  style,
  visibleLength,
  wrapText,
} from "./style.ts";
import type { FrameLine } from "./renderer.ts";

// ── Types ────────────────────────────────────────────────────────

interface ToolEntry {
  step: number;
  tool: string;
  status: "running" | "done" | "error";
  observation?: string;
}

interface LogEntry {
  kind: "user" | "assistant" | "thought" | "tool" | "info" | "warn" | "error" | "tool-summary";
  text: string;
  tools?: ToolEntry[];
}

type ChangeCallback = () => void;

// ── ViewModel ────────────────────────────────────────────────────

/**
 * Bridges application state into renderable terminal lines.
 *
 * Maintains:
 * - A virtual document (list of LogEntry messages)
 * - Current tool activity during an agent run
 * - Assistant streaming buffer
 * - Status bar state
 * - Input line state
 * - Viewport offset for scrolling
 */
export class ViewModel {
  private log: LogEntry[] = [];
  private activeTools: ToolEntry[] = [];
  private assistantBuffer = "";
  private reasoningBuffer = "";
  private streaming = false;
  private statusModel = "loading...";
  private statusSession = "main";
  private statusState = "idle";
  private statusContext = "";
  private tabTotal = 1;
  private tabActive = 0;
  private inputBuffer = "";
  private inputCursor = 0;
  private viewportOffset = -1;
  private changeCallbacks: ChangeCallback[] = [];

  private cachedDocLines: string[] = [];
  private docLinesDirty = true;
  private lastBuildCols = 0;

  private emitPending = false;

  get isStreaming(): boolean {
    return this.streaming;
  }

  onChange(cb: ChangeCallback): void {
    this.changeCallbacks.push(cb);
  }

  private emit(): void {
    if (this.emitPending) return;
    this.emitPending = true;
    queueMicrotask(() => {
      this.emitPending = false;
      for (const cb of this.changeCallbacks) cb();
    });
  }

  emitNow(): void {
    this.emitPending = false;
    for (const cb of this.changeCallbacks) cb();
  }

  addUserMessage(text: string): void {
    this.log.push({ kind: "user", text });
    this.markDirty();
    this.resetViewport();
    this.emit();
  }

  addToolActivity(step: number, tool: string, status: "running" | "done" | "error"): void {
    const existing = this.activeTools.find((t) => t.step === step);
    if (existing) {
      existing.tool = tool;
      existing.status = status;
    } else {
      this.activeTools.push({ step, tool, status });
    }
    this.markDirty();
    this.emit();
  }

  updateToolStatus(step: number, status: "running" | "done" | "error", observation?: string): void {
    const entry = this.activeTools.find((t) => t.step === step);
    if (entry) {
      entry.status = status;
      if (observation) entry.observation = observation;
    }
    this.markDirty();
    this.emit();
  }

  startAssistantStream(): void {
    if (this.activeTools.length > 0) {
      const count = this.activeTools.length;
      const summary = count === 1
        ? `1 tool ran: ${this.activeTools[0].tool}`
        : `${count} tools ran`;
      this.log.push({ kind: "tool-summary", text: summary, tools: [...this.activeTools] });
      this.activeTools = [];
    }
    this.streaming = true;
    this.assistantBuffer = "";
    this.reasoningBuffer = "";
    this.markDirty();
    this.emit();
  }

  appendReasoningChunk(chunk: string): void {
    this.reasoningBuffer += chunk;
    this.markDirty();
    this.resetViewport();
    this.emit();
  }

  appendAssistantChunk(chunk: string): void {
    this.assistantBuffer += chunk;
    this.markDirty();
    this.resetViewport();
    this.emit();
  }

  endAssistantStream(): void {
    if (this.reasoningBuffer.trim()) {
      this.log.push({ kind: "thought", text: this.reasoningBuffer });
    }
    this.log.push({ kind: "assistant", text: this.assistantBuffer });
    this.assistantBuffer = "";
    this.reasoningBuffer = "";
    this.streaming = false;
    this.markDirty();
    this.resetViewport();
    this.emit();
  }

  addInfo(msg: string): void {
    this.addLogLines("info", msg);
  }

  addWarning(msg: string): void {
    this.addLogLines("warn", msg);
  }

  addError(msg: string): void {
    this.addLogLines("error", msg);
  }

  private addLogLines(kind: LogEntry["kind"], msg: string): void {
    const lines = splitLines(msg);
    for (const line of lines) {
      this.log.push({ kind, text: line });
    }
    this.markDirty();
    this.resetViewport();
    this.emit();
  }

  setStatusBar(
    model: string,
    session: string,
    state: string,
    context = "",
    tabTotal = 1,
    tabActive = 0,
  ): void {
    this.statusModel = model;
    this.statusSession = session;
    this.statusContext = context;
    this.tabTotal = tabTotal;
    this.tabActive = tabActive;

    const progMatch = state.match(/^(\d+)\/(\d+)$/);
    if (progMatch) {
      const current = Math.min(Number(progMatch[1]), Number(progMatch[2]));
      const max = Number(progMatch[2]);
      const full = Array(current).fill(icon.progFull).join(" ");
      const empty = Array(Math.max(0, max - current)).fill(icon.progEmpty).join(" ");
      this.statusState = `${style.green(full)}${full && empty ? " " : ""}${style.dim(empty)}`;
    } else {
      // Check if it's "step 1 · tool"
      const toolMatch = state.match(/^(\d+) \· (.+)$/);
      if (toolMatch) {
        this.statusState = `${style.cyan(`${icon.progFull} `)} ${style.dim(toolMatch[2])}`;
      } else {
        this.statusState = state;
      }
    }

    this.emit();
  }

  setInputLine(buffer: string, cursor: number): void {
    this.inputBuffer = buffer;
    this.inputCursor = cursor;
    this.emit();
  }

  scrollUp(amount: number): void {
    const total = this.cachedDocLines.length;
    if (this.viewportOffset === -1) {
      this.viewportOffset = Math.max(0, total - amount);
    } else {
      this.viewportOffset = Math.max(0, this.viewportOffset - amount);
    }
    this.emit();
  }

  scrollDown(amount: number): void {
    if (this.viewportOffset === -1) return;
    this.viewportOffset = this.viewportOffset + amount;
    if (this.viewportOffset >= this.cachedDocLines.length) {
      this.viewportOffset = -1;
    }
    this.emit();
  }

  clearLog(): void {
    this.log = [];
    this.activeTools = [];
    this.assistantBuffer = "";
    this.streaming = false;
    this.viewportOffset = -1;
    this.markDirty();
    this.emit();
  }

  private resetViewport(): void {
    this.viewportOffset = -1;
  }

  private markDirty(): void {
    this.docLinesDirty = true;
  }
  computeFrame(
    cols: number,
    rows: number,
  ): { lines: FrameLine[] } {
    // Layout:
    // Row 0:      Status bar (bgGray)
    // Row 1:      Top separator
    // Row 2..N-4: Message viewport
    // Row N-3:    Bottom separator (with scroll indicator)
    // Row N-2:    Input line (bgDark)
    // Row N-1:    EMPTY (Windows Console safety boundary for stdin reading)
    const viewportHeight = Math.max(1, rows - 5);

    const statusLine = this.renderStatusBar(cols);
    const topSep = hr(cols);
    const inputLine = this.renderInputLine(cols);

    if (this.docLinesDirty || cols !== this.lastBuildCols) {
      this.cachedDocLines = this.buildDocumentLines(cols);
      this.docLinesDirty = false;
      this.lastBuildCols = cols;
    }
    const docLines = this.cachedDocLines;

    const totalDoc = docLines.length;
    let start: number;
    if (this.viewportOffset === -1) {
      start = Math.max(0, totalDoc - viewportHeight);
    } else {
      start = Math.min(this.viewportOffset, Math.max(0, totalDoc - viewportHeight));
    }
    const visible = docLines.slice(start, start + viewportHeight);

    while (visible.length < viewportHeight) {
      visible.push("");
    }

    const bottomSep = this.renderBottomSeparator(cols, totalDoc, viewportHeight, start);

    const frame: string[] = [statusLine, topSep, ...visible, bottomSep, inputLine, ""];

    while (frame.length < rows) {
      frame.splice(frame.length - 3, 0, "");
    }
    if (frame.length > rows) {
      frame.length = rows;
    }

    const fitted: FrameLine[] = frame.map((text, i) => {
      const maxLen = i === frame.length - 1 ? cols - 1 : cols;
      return { text: fitToWidth(text, maxLen) };
    });

    fitted[0].bg = style.prefixBgGray;
    fitted[fitted.length - 2].bg = style.prefixBgDark;

    return { lines: fitted };
  }

  private buildDocumentLines(cols: number): string[] {
    const lines: string[] = [];
    const contentWidth = Math.max(14, cols - 2);
    let prevKind: LogEntry["kind"] | null = null;

    for (const entry of this.log) {
      if (shouldSectionBreak(prevKind, entry.kind) && lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      switch (entry.kind) {
        case "user": {
          this.pushBlock(lines, ` ${style.cyan(icon.user)}  `, formatMarkdown(entry.text), contentWidth);
          break;
        }
        case "assistant": {
          this.pushBlock(
            lines,
            ` ${style.green(icon.assistant)}  `,
            formatMarkdown(entry.text),
            contentWidth,
          );
          break;
        }
        case "thought": {
          this.pushBlock(
            lines,
            ` ${style.magenta(icon.thought)}  `,
            entry.text,
            contentWidth,
            (s) => style.italic(style.dim(s)),
          );
          break;
        }
        case "tool-summary": {
          lines.push(style.dim(` ${icon.tool}  tools`));
          if (entry.tools && entry.tools.length > 0) {
            for (const t of entry.tools) {
              this.pushToolLine(lines, contentWidth, t);
            }
          } else {
            this.pushBlock(lines, ` ${style.yellow(icon.tool)}  `, style.dim(entry.text), contentWidth);
          }
          break;
        }
        case "info": {
          this.pushBlock(lines, ` ${style.blue(icon.info)}  `, entry.text, contentWidth);
          break;
        }
        case "warn": {
          this.pushBlock(
            lines,
            ` ${style.yellow(icon.warn)}  `,
            entry.text,
            contentWidth,
            (s) => style.yellow(s),
          );
          break;
        }
        case "error": {
          this.pushBlock(
            lines,
            ` ${style.red(icon.error)}  `,
            entry.text,
            contentWidth,
            (s) => style.red(s),
          );
          break;
        }
      }
      prevKind = entry.kind;
    }

    if (this.activeTools.length > 0) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(style.dim(` ${icon.tool}  active tools`));
      for (const t of this.activeTools) {
        this.pushToolLine(lines, contentWidth, t);
      }
      prevKind = "tool";
    }

    if (this.streaming) {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      if (this.reasoningBuffer) {
        this.pushBlock(
          lines,
          ` ${style.magenta(icon.thought)}  `,
          `${this.reasoningBuffer}▌`,
          contentWidth,
          (s) => style.italic(style.dim(s)),
        );
      }
      if (this.assistantBuffer) {
        this.pushBlock(
          lines,
          ` ${style.green(icon.assistant)}  `,
          `${this.assistantBuffer}▌`,
          contentWidth,
        );
      }
      prevKind = "assistant";
    }

    return lines;
  }

  private renderStatusBar(cols: number): string {
    const sep = style.dim(` ${icon.sep} `);
    const tabVisual = this.tabTotal > 1 ? `${style.dim(`${icon.tab} `)}${this.tabActive + 1}/${this.tabTotal}` : "";
    const contextPart = this.statusContext ? style.dim(this.statusContext) : "";

    const parts = [
      style.bold(" smallcode "),
      `${style.dim(`${icon.model} `)}${this.statusModel}`,
      `${style.dim(`${icon.session} `)}${this.statusSession}`,
      tabVisual,
      contextPart,
      this.statusState,
    ].filter(Boolean);

    return fitToWidth(parts.join(sep), cols);
  }

  private renderBottomSeparator(
    cols: number,
    totalDoc: number,
    viewportHeight: number,
    start: number,
  ): string {
    const overflow = totalDoc > viewportHeight;
    if (!overflow) return hr(cols);

    const atBottom = this.viewportOffset === -1 || (start + viewportHeight >= totalDoc);
    const linesAbove = start;
    const linesBelow = Math.max(0, totalDoc - start - viewportHeight);

    let indicator = "";
    if (atBottom && linesAbove > 0) {
      indicator = ` ↑ ${linesAbove} more · PgUp to scroll `;
    } else if (linesAbove > 0 && linesBelow > 0) {
      indicator = ` ↑${linesAbove} ↓${linesBelow} · PgUp/PgDn `;
    } else if (linesBelow > 0) {
      indicator = ` ↓ ${linesBelow} more · PgDn to scroll `;
    }

    if (!indicator) return hr(cols);

    const indLen = visibleLength(indicator);
    const dashLeft = Math.max(2, Math.floor((cols - indLen) / 2));
    const dashRight = Math.max(2, cols - dashLeft - indLen);
    return style.dim("─".repeat(dashLeft)) + style.dim(indicator) +
      style.dim("─".repeat(dashRight));
  }

  private getInputPrefix(): string {
    return ` ${style.cyan(icon.arrow)} `;
  }

  private renderInputLine(cols: number): string {
    const prefix = this.getInputPrefix();
    const prefixLen = visibleLength(prefix);
    const maxInput = Math.max(4, cols - prefixLen - 2);

    if (this.inputBuffer.length === 0) {
      return prefix + style.inverse(" ") + style.dim("Type a message or /help...");
    }

    const window = this.projectInputWindow(maxInput);
    const text = window.text;
    const c = Math.min(window.cursor, text.length);
    const before = text.slice(0, c);
    const activeChar = c < text.length ? text[c] : " ";
    const after = c < text.length ? text.slice(c + 1) : "";
    return prefix + before + style.inverse(activeChar) + after;
  }

  private pushToolLine(lines: string[], contentWidth: number, t: ToolEntry): void {
    const statusIcon = t.status === "running"
      ? style.yellow(icon.spinner)
      : t.status === "done"
      ? style.green(icon.check)
      : style.red(icon.cross);
    const base = `${style.dim(`#${t.step}`)} ${style.dim("·")} ${t.tool} ${statusIcon}`;
    this.pushBlock(lines, ` ${style.yellow(icon.tool)}  `, base, contentWidth);
  }

  private pushBlock(
    lines: string[],
    prefix: string,
    text: string,
    contentWidth: number,
    mapLine?: (line: string) => string,
  ): void {
    const prefixWidth = Math.max(2, visibleLength(prefix));
    const wrapWidth = Math.max(8, contentWidth - prefixWidth);
    const wrapped = wrapText(text, wrapWidth);
    if (wrapped.length === 0) {
      lines.push(prefix);
      return;
    }
    const first = mapLine ? mapLine(wrapped[0]) : wrapped[0];
    lines.push(prefix + first);
    const indent = " ".repeat(prefixWidth);
    for (let i = 1; i < wrapped.length; i++) {
      const line = mapLine ? mapLine(wrapped[i]) : wrapped[i];
      lines.push(indent + line);
    }
  }

  private projectInputWindow(maxInput: number): { text: string; cursor: number } {
    const raw = this.inputBuffer;
    if (raw.length <= maxInput) {
      return { text: raw, cursor: this.inputCursor };
    }

    const cursor = Math.min(this.inputCursor, raw.length);
    const safeWidth = Math.max(4, maxInput - 2);
    let start = Math.max(0, cursor - Math.floor(safeWidth * 0.6));
    start = Math.min(start, Math.max(0, raw.length - safeWidth));
    const end = Math.min(raw.length, start + safeWidth);
    let view = raw.slice(start, end);
    let cursorInView = cursor - start;

    if (start > 0) {
      view = `…${view}`;
      cursorInView += 1;
    }
    if (end < raw.length) {
      view = `${view}…`;
    }

    if (view.length > maxInput) {
      view = view.slice(0, maxInput);
      cursorInView = Math.min(cursorInView, view.length);
    }

    return { text: view, cursor: cursorInView };
  }
}

function shouldSectionBreak(prev: LogEntry["kind"] | null, next: LogEntry["kind"]): boolean {
  if (!prev) return false;
  const heavy = new Set<LogEntry["kind"]>(["user", "assistant", "thought"]);
  if (heavy.has(prev) || heavy.has(next)) return true;
  return prev !== next;
}
