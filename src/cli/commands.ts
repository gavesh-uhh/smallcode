export function parseCommand(line: string): { command: string; arg: string } {
  const trimmed = line.trim();
  const [command, ...rest] = trimmed.split(/\s+/);
  return {
    command: command.toLowerCase(),
    arg: rest.join(" ").trim(),
  };
}
