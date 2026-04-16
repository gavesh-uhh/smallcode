export type SessionSummary = {
  id: string;
  title: string;
  status: "idle" | "running" | "error";
};

const encoder = new TextEncoder();
let progressShown = false;

export function banner(): void {
  console.log("smallcode");
  console.log("---------");
}

export function help(): void {
  console.log("Commands");
  printColumns([
    ["/help", "Show commands"],
    ["/exit", "Quit"],
    ["/clear", "Clear terminal"],
    ["/model [name]", "Show or switch model"],
    ["/confirm on|off", "Toggle file-write confirmations"],
    ["/debug on|off", "Toggle agent decision debug"],
    ["/reset", "Reset active session memory"],
    ["/files [path]", "List files via tool layer"],
    ["/run <command>", "Run shell command via tool layer"],
    ["/agent new [name]", "Create session"],
    ["/agent list", "List sessions"],
    ["/agent switch <id|n>", "Switch session"],
    ["/agent close [id]", "Close session (except main)"],
    ["/agent profile small|balanced", "Set agent profile"],
    ["/agent iterations <n>", "Set iteration cap (1..24)"],
  ]);
}

export function promptLabel(sessionTitle: string): string {
  return `[${sessionTitle}] > `;
}

export function info(message: string): void {
  endProgress();
  printBlock(message);
}

export function note(message: string): void {
  endProgress();
  printBlock(message);
}

export function warn(message: string): void {
  endProgress();
  printBlock(`WARN: ${message}`);
}

export function error(message: string): void {
  endProgress();
  printBlock(`ERROR: ${message}`);
}

export function userTask(message: string): void {
  endProgress();
  printBlock(`you> ${message}`);
}

export function assistantPrefix(): string {
  return "assistant> ";
}

export function printSessionTable(
  sessions: SessionSummary[],
  activeSessionId: string,
): void {
  console.log("Sessions");
  const rows = sessions.map((s, i) => {
    const isActive = s.id === activeSessionId;
    const marker = isActive ? "*" : " ";
    const left = `${marker} ${i + 1}. ${s.title}`;
    const right = `${s.id}  [${s.status}]`;
    return [left, right] as [string, string];
  });
  printColumns(rows);
}

export function printModelSummary(current: string, available: string[]): void {
  console.log("Model");
  printColumns([
    ["Current", current],
    ["Available", available.join(", ") || "(none)"],
  ]);
}

export function printWorkspace(path: string): void {
  console.log(path);
}

export function clearTerminal(): void {
  if (Deno.stdout.isTerminal()) {
    Deno.stdout.writeSync(encoder.encode("\x1b[2J\x1b[H"));
  }
}

export function writeRaw(chunk: string): void {
  Deno.stdout.writeSync(encoder.encode(chunk));
}

export function progress(message: string): void {
  if (!Deno.stdout.isTerminal()) {
    info(message);
    return;
  }
  const width = getTerminalWidth();
  const text = truncate(`... ${message}`, Math.max(20, width - 1));
  writeRaw(`\r\x1b[2K${text}`);
  progressShown = true;
}

export function endProgress(): void {
  if (!progressShown) {
    return;
  }
  writeRaw("\n");
  progressShown = false;
}

function printColumns(rows: Array<[string, string]>): void {
  if (rows.length === 0) {
    return;
  }
  const width = getTerminalWidth();
  const gap = 3;
  const leftTarget = Math.max(
    18,
    Math.min(34, Math.max(...rows.map(([left]) => left.length)) + 2),
  );
  const leftWidth = Math.min(
    leftTarget,
    Math.max(18, Math.floor(width * 0.42)),
  );
  const rightWidth = Math.max(8, width - leftWidth - gap);

  for (const [left, right] of rows) {
    const leftCell = truncate(left, leftWidth).padEnd(leftWidth, " ");
    const rightCell = truncate(right, rightWidth);
    console.log(`${leftCell}${" ".repeat(gap)}${rightCell}`);
  }
}

function truncate(value: string, max: number): string {
  if (max <= 0 || value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function getTerminalWidth(): number {
  try {
    return Math.max(60, Deno.consoleSize().columns);
  } catch {
    return 100;
  }
}

function printBlock(message: string): void {
  const lines = message.split("\n");
  for (const line of lines) {
    const text = line.length > 0 ? line : " ";
    console.log(text);
  }
}
