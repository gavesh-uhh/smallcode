import type { AgentSession } from "../types.ts";
import { ensureTxtExtension, getDesktopPath, sanitizeFileName } from "./exportPaths.ts";

export async function exportSessionChat(session: AgentSession, customName?: string): Promise<string> {
  const desktop = getDesktopPath();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = customName?.trim()
    ? ensureTxtExtension(customName.trim())
    : `smallcode-chat-${sanitizeFileName(session.title)}-${timestamp}.txt`;
  const filePath = `${desktop}\\${baseName}`;

  const header = [
    "smallcode chat export",
    `session: ${session.title} (${session.id})`,
    `exported_at: ${new Date().toISOString()}`,
    "",
  ].join("\n");

  const transcript = session.viewModel.exportPlainTextTranscript();
  const body = transcript || "(No chat content to export yet.)";
  await Deno.writeTextFile(filePath, `${header}${body}\n`);
  return filePath;
}
