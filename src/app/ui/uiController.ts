import type { InputHandler } from "../../ui/tui/input.ts";
import type { Renderer } from "../../ui/tui/renderer.ts";
import type { AgentSession } from "../types.ts";

interface UiControllerDeps {
  renderer: Renderer;
  input: InputHandler;
  sessions: Map<string, AgentSession>;
  getCurrentSession: () => AgentSession | undefined;
  getActiveSessionId: () => string;
  nextSessionId: () => string;
  createSession: (id: string, title: string) => AgentSession;
  switchSession: (id: string) => void;
  runAgentTask: (session: AgentSession, task: string) => Promise<void>;
  handleCommand: (line: string) => Promise<boolean>;
  shutdown: () => void;
}

export function createUiController(deps: UiControllerDeps) {
  function redraw(): void {
    const current = deps.getCurrentSession();
    if (!current) return;

    if (deps.renderer.checkResize()) {
      deps.renderer.invalidate();
    }
    const { cols, rows } = deps.renderer.getSize();
    const { lines } = current.viewModel.computeFrame(cols, rows);
    deps.renderer.render(lines);
  }

  function attachHandlers(): void {
    deps.input.onInputChange((buffer, cursor) => {
      const session = deps.getCurrentSession();
      if (session) session.viewModel.setInputLine(buffer, cursor);
    });

    deps.input.onKey((key) => {
      const current = deps.getCurrentSession();
      if (!current) return;

      if (key.ctrl && key.name === "e") {
        const keys = Array.from(deps.sessions.keys());
        if (keys.length <= 1) {
          const id = deps.nextSessionId();
          deps.createSession(id, `Agent ${id.split("-")[1]}`);
        }
        const sessionKeys = Array.from(deps.sessions.keys());
        const idx = sessionKeys.indexOf(deps.getActiveSessionId());
        const nextIdx = (idx + 1) % sessionKeys.length;
        deps.switchSession(sessionKeys[nextIdx]);
        return;
      }

      if (key.ctrl && key.name === "r") {
        const sessionKeys = Array.from(deps.sessions.keys());
        if (sessionKeys.length <= 1) return;
        const idx = sessionKeys.indexOf(deps.getActiveSessionId());
        const prevIdx = (idx - 1 + sessionKeys.length) % sessionKeys.length;
        deps.switchSession(sessionKeys[prevIdx]);
        return;
      }

      if (key.ctrl && key.name === "c") {
        deps.shutdown();
        return;
      }

      if (key.ctrl && key.name === "l") {
        current.viewModel.clearLog();
        current.viewModel.addInfo("Screen cleared. Type /help for commands.");
        deps.renderer.invalidate();
        return;
      }

      if (key.ctrl && key.name === "j") {
        current.viewModel.scrollUp(10);
        return;
      }

      if (key.ctrl && key.name === "k") {
        current.viewModel.scrollDown(10);
        return;
      }

      if (key.name === "pageup") {
        current.viewModel.scrollUp(16);
        return;
      }

      if (key.name === "pagedown") {
        current.viewModel.scrollDown(16);
        return;
      }

      if (key.ctrl && key.name === "b") {
        current.viewModel.scrollToTop();
        return;
      }

      if (key.ctrl && key.name === "n") {
        current.viewModel.scrollToBottom();
        return;
      }
    });

    deps.input.onLine(async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      if (trimmed.startsWith("/")) {
        const running = await deps.handleCommand(trimmed);
        if (!running) deps.shutdown();
        return;
      }

      const session = deps.getCurrentSession();
      if (!session) return;
      await deps.runAgentTask(session, trimmed);
    });
  }

  return {
    redraw,
    attachHandlers,
  };
}
