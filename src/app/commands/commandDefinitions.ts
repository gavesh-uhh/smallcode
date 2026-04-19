export type ParsedCommand = {
  command: string;
  arg: string;
};

export type HelpRow = readonly [string, string];

export const HELP_COMMANDS = {
  general: [
    ["/help", "Show commands"],
    ["/exit", "Quit"],
    ["/clear", "Clear screen"],
    ["/export", "Export current chat to Desktop"],
    ["/model [name]", "Show or switch model"],
    ["/confirm on|off", "Toggle file-write confirmations"],
    ["/debug on|off", "Toggle agent decision debug"],
    ["/reset", "Reset active session memory"],
  ] as const satisfies readonly HelpRow[],
  tools: [
    ["/files [path]", "List files via tool layer"],
    ["/run <command>", "Run shell command via tool layer"],
  ] as const satisfies readonly HelpRow[],
  agent: [
    ["/agent new [name]", "Create session"],
    ["/agent list", "List sessions"],
    ["/agent switch <id|n>", "Switch session"],
    ["/agent close [id]", "Close session (except main)"],
    ["/agent profile", "Set agent profile (small|balanced|ultra)"],
    ["/agent iterations", "Set iteration cap (1..24)"],
  ] as const satisfies readonly HelpRow[],
} as const;

export const SHORTCUTS = [
  ["Ctrl+E / Ctrl+R", "Switch tab (next / previous)"],
  ["Ctrl+C", "Quit application"],
  ["Ctrl+L", "Clear entire screen"],
  ["PgUp / PgDn", "Scroll chat history"],
  ["Ctrl+B / Ctrl+N", "Jump to top / bottom"],
  ["Up / Down", "Browse input history"],
] as const satisfies readonly HelpRow[];

export const MISSION_COMMANDS = [
  [
    "/plan <task>",
    "Deconstruct a large task into a mission plan (<15B optimized)",
  ],
  ["/next", "Execute the next step in the active mission plan"],
  ["/agent", "Manage sessions (new, switch, list, close, profile)"],
  ["/reset", "Clear session memory and active plans"],
] as const satisfies readonly HelpRow[];

export const COMMAND_USAGE = {
  export: "Usage: /export [filename]",
  confirm: "Usage: /confirm on|off",
  debug: "Usage: /debug on|off",
  plan: "Usage: /plan <task description>",
  run: "Usage: /run <command>",
  agent: "Usage: /agent new|list|switch|close ...",
  agentSwitch: "Usage: /agent switch <id|index>",
  agentProfile: "Usage: /agent profile small|balanced|ultra",
  agentIterations: "Usage: /agent iterations <1..24>",
  agentFallback: "Usage: /agent new|list|switch|close|profile|iterations ...",
} as const;

export function parseCommand(line: string): ParsedCommand {
  const trimmed = line.trim();
  if (!trimmed) return { command: "", arg: "" };

  const [command = "", ...rest] = trimmed.split(/\s+/);
  return {
    command: command.toLowerCase(),
    arg: rest.join(" ").trim(),
  };
}
