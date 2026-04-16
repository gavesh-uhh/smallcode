export interface KeyEvent {
  name: string; // "return", "backspace", "up", "down", "left", "right",
  // "home", "end", "delete", "pageup", "pagedown",
  // "tab", or the character itself ("a", "A", " ", etc.)
  ctrl: boolean;
  shift: boolean;
  sequence: Uint8Array;
}

export interface InputState {
  buffer: string;
  cursorPos: number;
  history: string[];
  historyIdx: number;
  historyDraft: string;
}

type LineCallback = (line: string) => void | Promise<void>;
type KeyCallback = (key: KeyEvent) => void;
type InputChangeCallback = (buffer: string, cursor: number) => void;

export class InputHandler {
  private lineCallbacks: LineCallback[] = [];
  private keyCallbacks: KeyCallback[] = [];
  private inputChangeCallbacks: InputChangeCallback[] = [];
  private buffer = "";
  private cursorPos = 0;
  private history: string[] = [];
  private historyIdx = -1;
  private historyDraft = "";
  private running = false;
  private _enabled = true;
  private _busy = false;

  onLine(cb: LineCallback): void {
    this.lineCallbacks.push(cb);
  }

  onKey(cb: KeyCallback): void {
    this.keyCallbacks.push(cb);
  }

  onInputChange(cb: InputChangeCallback): void {
    this.inputChangeCallbacks.push(cb);
  }

  getBuffer(): string {
    return this.buffer;
  }

  getCursorPos(): number {
    return this.cursorPos;
  }

  exportState(): InputState {
    return {
      buffer: this.buffer,
      cursorPos: this.cursorPos,
      history: [...this.history],
      historyIdx: this.historyIdx,
      historyDraft: this.historyDraft,
    };
  }

  importState(state: InputState): void {
    this.buffer = state.buffer;
    this.cursorPos = state.cursorPos;
    this.history = [...state.history];
    this.historyIdx = state.historyIdx;
    this.historyDraft = state.historyDraft;
    this.emitInputChange();
  }

  disable(): void {
    this._enabled = false;
  }

  enable(): void {
    this._enabled = true;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      Deno.stdin.setRaw(true);
    } catch (e) {
      console.error("Failed to set raw mode:", e);
      return;
    }

    const buf = new Uint8Array(512);
    try {
      while (this.running) {
        const n = await Deno.stdin.read(buf);
        if (n === null) break; // EOF
        if (n === 0) continue;

        const data = buf.slice(0, n);
        this.processBytes(data);
      }
    } catch {
    }
  }

  stop(): void {
    this.running = false;
    try {
      Deno.stdin.setRaw(false);
    } catch {}
  }

  private processBytes(data: Uint8Array): void {
    let i = 0;
    while (i < data.length) {
      const byte = data[i];

      if (byte === 0x1b) {
        if (i + 1 < data.length && data[i + 1] === 0x5b) {
          let end = i + 2;
          while (end < data.length && !isCSITerminator(data[end])) {
            end++;
          }
          if (end < data.length) {
            const seq = data.slice(i, end + 1);
            this.dispatchKey(this.parseCSI(seq));
            i = end + 1;
            continue;
          }
        }
        this.dispatchKey({
          name: "escape",
          ctrl: false,
          shift: false,
          sequence: data.slice(i, i + 1),
        });
        i++;
        continue;
      }

      if (byte === 0x0d) {
        if (i + 1 < data.length && data[i + 1] === 0x0a) {
          i++;
        }
        this.dispatchKey({
          name: "return",
          ctrl: false,
          shift: false,
          sequence: new Uint8Array([0x0d]),
        });
        i++;
        continue;
      }

      if (byte === 0x0a) {
        this.dispatchKey({
          name: "return",
          ctrl: false,
          shift: false,
          sequence: new Uint8Array([0x0a]),
        });
        i++;
        continue;
      }

      if (byte >= 0x01 && byte <= 0x1a) {
        const letter = String.fromCharCode(byte + 0x60);
        this.dispatchKey({
          name: letter,
          ctrl: true,
          shift: false,
          sequence: data.slice(i, i + 1),
        });
        i++;
        continue;
      }

      if (byte === 0x7f || byte === 0x08) {
        this.dispatchKey({
          name: "backspace",
          ctrl: false,
          shift: false,
          sequence: data.slice(i, i + 1),
        });
        i++;
        continue;
      }

      if (byte === 0x09) {
        this.dispatchKey({
          name: "tab",
          ctrl: false,
          shift: false,
          sequence: data.slice(i, i + 1),
        });
        i++;
        continue;
      }

      const charLen = utf8CharLen(byte);
      if (charLen > 1 && i + charLen <= data.length) {
        const charBytes = data.slice(i, i + charLen);
        const char = new TextDecoder().decode(charBytes);
        this.dispatchKey({ name: char, ctrl: false, shift: false, sequence: charBytes });
        i += charLen;
        continue;
      }

      if (byte >= 0x20 && byte <= 0x7e) {
        const char = String.fromCharCode(byte);
        this.dispatchKey({ name: char, ctrl: false, shift: false, sequence: data.slice(i, i + 1) });
        i++;
        continue;
      }

      i++;
    }
  }

  private parseCSI(seq: Uint8Array): KeyEvent {
    const str = new TextDecoder().decode(seq);
    const csi = str.slice(2);
    const base: KeyEvent = { name: "", ctrl: false, shift: false, sequence: seq };

    switch (csi) {
      case "A":
        base.name = "up";
        return base;
      case "B":
        base.name = "down";
        return base;
      case "C":
        base.name = "right";
        return base;
      case "D":
        base.name = "left";
        return base;
      case "H":
        base.name = "home";
        return base;
      case "F":
        base.name = "end";
        return base;
      case "3~":
        base.name = "delete";
        return base;
      case "5~":
        base.name = "pageup";
        return base;
      case "6~":
        base.name = "pagedown";
        return base;
      case "1;2A":
        base.name = "up";
        base.shift = true;
        return base;
      case "1;2B":
        base.name = "down";
        base.shift = true;
        return base;
      case "1;2C":
        base.name = "right";
        base.shift = true;
        return base;
      case "1;2D":
        base.name = "left";
        base.shift = true;
        return base;
      case "1;5A":
        base.name = "up";
        base.ctrl = true;
        return base;
      case "1;5B":
        base.name = "down";
        base.ctrl = true;
        return base;
      case "1;5C":
        base.name = "right";
        base.ctrl = true;
        return base;
      case "1;5D":
        base.name = "left";
        base.ctrl = true;
        return base;
      default:
        base.name = `csi:${csi}`;
        return base;
    }
  }

  private dispatchKey(key: KeyEvent): void {
    for (const cb of this.keyCallbacks) cb(key);
    if (!this._enabled || this._busy) return;
    this.handleKey(key);
  }

  private handleKey(key: KeyEvent): void {
    if (key.ctrl && key.name === "c") {
      return;
    }

    if (key.name === "return") {
      const line = this.buffer;
      if (line.trim()) {
        this.history.push(line);
        if (this.history.length > 100) this.history.shift();
      }
      this.buffer = "";
      this.cursorPos = 0;
      this.historyIdx = -1;
      this.historyDraft = "";
      this.emitInputChange();
      this._busy = true;
      const results = this.lineCallbacks.map((cb) => cb(line));
      const promises = results.filter((r): r is Promise<void> => r instanceof Promise);
      if (promises.length > 0) {
        Promise.all(promises).finally(() => {
          this._busy = false;
        });
      } else {
        this._busy = false;
      }
      return;
    }

    if (key.name === "backspace") {
      if (this.cursorPos > 0) {
        this.buffer = this.buffer.slice(0, this.cursorPos - 1) +
          this.buffer.slice(this.cursorPos);
        this.cursorPos--;
        this.emitInputChange();
      }
      return;
    }

    if (key.name === "delete") {
      if (this.cursorPos < this.buffer.length) {
        this.buffer = this.buffer.slice(0, this.cursorPos) +
          this.buffer.slice(this.cursorPos + 1);
        this.emitInputChange();
      }
      return;
    }

    if (key.name === "left") {
      if (this.cursorPos > 0) {
        this.cursorPos--;
        this.emitInputChange();
      }
      return;
    }

    if (key.name === "right") {
      if (this.cursorPos < this.buffer.length) {
        this.cursorPos++;
        this.emitInputChange();
      }
      return;
    }

    if (key.name === "home" || (key.ctrl && key.name === "a")) {
      this.cursorPos = 0;
      this.emitInputChange();
      return;
    }

    if (key.name === "end" || (key.ctrl && key.name === "e")) {
      this.cursorPos = this.buffer.length;
      this.emitInputChange();
      return;
    }

    if (key.ctrl && key.name === "u") {
      this.buffer = this.buffer.slice(this.cursorPos);
      this.cursorPos = 0;
      this.emitInputChange();
      return;
    }

    if (key.ctrl && key.name === "k") {
      this.buffer = this.buffer.slice(0, this.cursorPos);
      this.emitInputChange();
      return;
    }

    if (key.name === "up") {
      this.navigateHistory(-1);
      return;
    }

    if (key.name === "down") {
      this.navigateHistory(1);
      return;
    }

    if (key.name.length === 1 && !key.ctrl) {
      this.buffer = this.buffer.slice(0, this.cursorPos) +
        key.name +
        this.buffer.slice(this.cursorPos);
      this.cursorPos++;
      this.emitInputChange();
      return;
    }

    if (key.name.length > 1 && !key.ctrl && !key.name.startsWith("csi:")) {
      this.buffer = this.buffer.slice(0, this.cursorPos) +
        key.name +
        this.buffer.slice(this.cursorPos);
      this.cursorPos += key.name.length;
      this.emitInputChange();
      return;
    }
  }

  private navigateHistory(direction: number): void {
    if (this.history.length === 0) return;

    if (this.historyIdx === -1 && direction === -1) {
      this.historyDraft = this.buffer;
      this.historyIdx = this.history.length - 1;
    } else if (direction === -1 && this.historyIdx > 0) {
      this.historyIdx--;
    } else if (direction === 1 && this.historyIdx >= 0) {
      this.historyIdx++;
      if (this.historyIdx >= this.history.length) {
        this.historyIdx = -1;
        this.buffer = this.historyDraft;
        this.cursorPos = this.buffer.length;
        this.emitInputChange();
        return;
      }
    } else {
      return;
    }

    if (this.historyIdx >= 0 && this.historyIdx < this.history.length) {
      this.buffer = this.history[this.historyIdx];
      this.cursorPos = this.buffer.length;
      this.emitInputChange();
    }
  }

  private emitInputChange(): void {
    for (const cb of this.inputChangeCallbacks) {
      cb(this.buffer, this.cursorPos);
    }
  }
}

function isCSITerminator(byte: number): boolean {
  return (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x7e; // ~
}

function utf8CharLen(byte: number): number {
  if ((byte & 0x80) === 0) return 1; // 0xxxxxxx
  if ((byte & 0xe0) === 0xc0) return 2; // 110xxxxx
  if ((byte & 0xf0) === 0xe0) return 3; // 1110xxxx
  if ((byte & 0xf8) === 0xf0) return 4; // 11110xxx
  return 1; // fallback
}
