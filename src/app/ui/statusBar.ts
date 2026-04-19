import { OllamaClient } from "../../core/llm/ollamaClient.ts";
import type { AgentSession } from "../types.ts";

interface StatusBarDeps {
  llm: OllamaClient;
  session?: AgentSession;
  sessions: Map<string, AgentSession>;
  activeSessionId: string;
}

export function updateStatusBarView({ llm, session, sessions, activeSessionId }: StatusBarDeps): void {
  if (!session) return;

  const stats = session.agent.getContextStats();
  const tokenEst = Math.round(stats.chars / 4);
  const ctxText = `${formatK(tokenEst)} ctx`;

  session.viewModel.setStatusBar(
    llm.getModel(),
    session.title,
    session.status,
    ctxText,
    sessions.size,
    Array.from(sessions.keys()).indexOf(activeSessionId),
  );
}

function formatK(value: number): string {
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}k`;
  }
  return `${value}`;
}
