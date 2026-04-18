import { ESC } from "./style.ts";

const encoder = new TextEncoder();

/**
 *   renderer.ts
 *   Manages the terminal lifecycle:
 *   start() → enter alt screen, hide cursor
 *   render(lines) → paint full frame (one string per terminal row)
 *   destroy() → restore original screen, show cursor
 *
 *   Critical: The last row is handled specially. Writing to the last
 *   column of the last row can trigger auto-scroll in some terminals
 *   (especially Windows). We avoid this by NOT erasing the last row
 *   and by writing one fewer character.
 */
export interface FrameLine {
  text: string;
  bg?: string;
}

export class Renderer {
  private prevFrame: FrameLine[] = [];
  private started = false;
  private lastCols = 0;
  private lastRows = 0;

  private write(s: string): void {
    Deno.stdout.writeSync(encoder.encode(s));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { cols, rows } = this.getSize();
    this.lastCols = cols;
    this.lastRows = rows;
    this.write(`${ESC}[?1049h` + `${ESC}[?25l` + `${ESC}[2J` + `${ESC}[H`);
    this.prevFrame = [];
  }

  /**
   * Render a frame of lines and optionally position the cursor.
   * Batches all output into a single writeSync to prevent flicker.
   *
   * @param lines     Array of strings, one per terminal row.
   * @param cursorRow 0-indexed row for cursor, or undefined to hide cursor.
   * @param cursorCol 0-indexed column for cursor.
   */
  render(lines: FrameLine[], cursorRow?: number, cursorCol?: number): void {
    if (!this.started) return;

    const buf: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      const prev = this.prevFrame[i];
      if (!prev || lines[i].text !== prev.text || lines[i].bg !== prev.bg) {
        buf.push(`${ESC}[${i + 1};1H`);
        buf.push(`${ESC}[0m`);
        if (lines[i].bg) {
          buf.push(lines[i].bg!);
        }
        buf.push(`${ESC}[2K`);
        buf.push(lines[i].text);
        buf.push(`${ESC}[0m`);
      }
    }

    for (let i = lines.length; i < this.prevFrame.length; i++) {
      buf.push(`${ESC}[${i + 1};1H${ESC}[0m${ESC}[2K`);
    }

    if (cursorRow !== undefined && cursorCol !== undefined) {
      buf.push(`${ESC}[${cursorRow + 1};${cursorCol + 1}H`);
      buf.push(`${ESC}[?25h`);
    } else {
      buf.push(`${ESC}[?25l`);
    }

    if (buf.length > 0) {
      this.write(buf.join(""));
    }
    this.prevFrame = [...lines];
  }

  getSize(): { cols: number; rows: number } {
    try {
      const { columns, rows } = Deno.consoleSize();
      return { cols: Math.max(40, columns), rows: Math.max(10, rows) };
    } catch {
      return { cols: 100, rows: 30 };
    }
  }

  /**
   * Check if the terminal has been resized since the last frame.
   * Returns true if the size changed (caller should invalidate + redraw).
   */
  checkResize(): boolean {
    const { cols, rows } = this.getSize();
    if (cols !== this.lastCols || rows !== this.lastRows) {
      this.lastCols = cols;
      this.lastRows = rows;
      this.prevFrame = [];
      return true;
    }
    return false;
  }

  invalidate(): void {
    this.prevFrame = [];
  }

  destroy(): void {
    if (!this.started) return;
    this.started = false;
    this.write(`${ESC}[0m` + `${ESC}[?25h` + `${ESC}[?1049l`);
    this.prevFrame = [];
  }
}
