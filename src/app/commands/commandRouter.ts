import { parseCommand } from "./commandDefinitions.ts";
import type { AgentRuntimeConfig, AgentSession, AppState } from "../types.ts";
import { handleAgentCommand } from "./agentCommands.ts";
import { handleGeneralCommand } from "./generalCommands.ts";
import { handleMissionCommand } from "./missionCommands.ts";
import { OllamaClient } from "../../core/llm/ollamaClient.ts";
import { Renderer } from "../../ui/tui/renderer.ts";

interface CommandRouterDeps {
  llm: OllamaClient;
  renderer: Renderer;
  state: AppState;
  runtime: AgentRuntimeConfig;
  sessions: Map<string, AgentSession>;
  getCurrentSession: () => AgentSession | undefined;
  createSession: (id: string, title: string) => AgentSession;
  switchSession: (id: string) => void;
  removeSession: (id: string) => boolean;
  applyAgentRuntime: () => void;
  updateStatusBar: () => void;
}

export function createCommandRouter(deps: CommandRouterDeps) {
  return async function handleCommand(line: string): Promise<boolean> {
    const { command, arg } = parseCommand(line);

    const generalResult = await handleGeneralCommand(command, arg, {
      llm: deps.llm,
      state: deps.state,
      runtime: deps.runtime,
      renderer: deps.renderer,
      getCurrentSession: deps.getCurrentSession,
      updateStatusBar: deps.updateStatusBar,
      applyAgentRuntime: deps.applyAgentRuntime,
    });
    if (generalResult !== undefined) {
      return generalResult;
    }

    const missionResult = await handleMissionCommand(command, arg, {
      runtime: deps.runtime,
      sessions: deps.sessions,
      getCurrentSession: deps.getCurrentSession,
      updateStatusBar: deps.updateStatusBar,
      invalidate: () => deps.renderer.invalidate(),
    });
    if (missionResult !== undefined) {
      return missionResult;
    }

    const agentResult = await handleAgentCommand(command, arg, {
      state: deps.state,
      runtime: deps.runtime,
      sessions: deps.sessions,
      getCurrentSession: deps.getCurrentSession,
      createSession: deps.createSession,
      switchSession: deps.switchSession,
      removeSession: deps.removeSession,
      applyAgentRuntime: deps.applyAgentRuntime,
      updateStatusBar: deps.updateStatusBar,
    });
    if (agentResult !== undefined) {
      return agentResult;
    }

    const current = deps.getCurrentSession();
    if (current) {
      current.viewModel.addError(`Unknown command: ${command}`);
    }
    return true;
  };
}
