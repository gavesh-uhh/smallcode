import { COMMAND_USAGE } from "./commandDefinitions.ts";
import type { AgentRuntimeConfig, AgentSession, AppState } from "../types.ts";
import { exportSessionChat } from "../export/chatExport.ts";
import { renderHelp } from "../ui/helpRenderer.ts";
import { asMessage } from "../utils/errors.ts";
import { OllamaClient } from "../../core/llm/ollamaClient.ts";
import { Renderer } from "../../ui/tui/renderer.ts";

interface GeneralCommandDeps {
  llm: OllamaClient;
  state: AppState;
  runtime: AgentRuntimeConfig;
  renderer: Renderer;
  getCurrentSession: () => AgentSession | undefined;
  updateStatusBar: () => void;
  applyAgentRuntime: () => void;
}

export async function handleGeneralCommand(
  command: string,
  arg: string,
  deps: GeneralCommandDeps,
): Promise<boolean | undefined> {
  const current = deps.getCurrentSession();
  if (!current) {
    return command === "/exit" ? false : true;
  }

  switch (command) {
    case "/help":
      renderHelp(current.viewModel);
      return true;
    case "/exit":
      return false;
    case "/clear":
      current.viewModel.clearLog();
      current.viewModel.addInfo("Screen cleared.");
      deps.updateStatusBar();
      deps.renderer.invalidate();
      return true;
    case "/export": {
      if (arg && /[<>:"/\\|?*\x00-\x1f]/.test(arg)) {
        current.viewModel.addError(COMMAND_USAGE.export);
        return true;
      }
      try {
        const path = await exportSessionChat(current, arg);
        current.viewModel.addInfo(`Chat exported: ${path}`);
      } catch (error) {
        current.viewModel.addError(`Export failed: ${asMessage(error)}`);
      }
      return true;
    }
    case "/model":
      if (!arg) {
        const models = await deps.llm.listModels();
        current.viewModel.addInfo(`Current model: ${deps.llm.getModel()}`);
        current.viewModel.addInfo(`Available: ${models.join(", ") || "(none)"}`);
        return true;
      }
      deps.llm.setModel(arg);
      current.viewModel.addInfo(`Model set to: ${deps.llm.getModel()}`);
      deps.updateStatusBar();
      return true;
    case "/confirm":
      if (arg !== "on" && arg !== "off") {
        current.viewModel.addError(COMMAND_USAGE.confirm);
        return true;
      }
      deps.state.confirmWrites = arg === "on";
      current.viewModel.addInfo(`Write confirmation: ${deps.state.confirmWrites ? "ON" : "OFF"}`);
      return true;
    case "/debug":
      if (arg !== "on" && arg !== "off") {
        current.viewModel.addError(COMMAND_USAGE.debug);
        return true;
      }
      deps.runtime.debug = arg === "on";
      deps.applyAgentRuntime();
      current.viewModel.addInfo(`Agent debug: ${deps.runtime.debug ? "ON" : "OFF"}`);
      return true;
    case "/reset":
      current.memory.reset();
      current.plan = undefined;
      current.viewModel.addInfo(`Reset memory and plan for session ${current.title}`);
      return true;
    default:
      return undefined;
  }
}
