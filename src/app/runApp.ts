import { createCommandRouter } from "./commands/commandRouter.ts";
import { createAgentRunner } from "./core/agentRunner.ts";
import { createAppContext } from "./core/appContext.ts";
import { createSessionManager } from "./core/sessionManager.ts";
import { updateStatusBarView } from "./ui/statusBar.ts";
import { createUiController } from "./ui/uiController.ts";
import { asMessage } from "./utils/errors.ts";
import type { AgentSession } from "./types.ts";

export async function runApp(): Promise<void> {
  const context = createAppContext(Deno.cwd());
  let resizeTimer: number | undefined;

  let redraw = () => {};
  let runAgentTaskRef: ((session: AgentSession, task: string) => Promise<void>) | null = null;

  const updateStatusBar = (): void => {
    updateStatusBarView({
      llm: context.llm,
      session: sessionManager.getCurrentSession(),
      sessions: context.sessions,
      activeSessionId: context.state.activeSessionId,
    });
  };

  const sessionManager = createSessionManager({
    context,
    updateStatusBar,
    redraw: () => redraw(),
    runAgentTaskRef: () => {
      if (!runAgentTaskRef) {
        throw new Error("runAgentTask is not ready.");
      }
      return runAgentTaskRef;
    },
  });

  const agentRunner = createAgentRunner({
    llm: context.llm,
    input: context.input,
    sessions: context.sessions,
    runtime: context.runtime,
    updateStatusBar,
  });
  runAgentTaskRef = agentRunner.runAgentTask;

  const commandRouter = createCommandRouter({
    llm: context.llm,
    renderer: context.renderer,
    state: context.state,
    runtime: context.runtime,
    sessions: context.sessions,
    getCurrentSession: sessionManager.getCurrentSession,
    createSession: sessionManager.createSession,
    switchSession: sessionManager.switchSession,
    removeSession: sessionManager.removeSession,
    applyAgentRuntime: sessionManager.applyAgentRuntime,
    updateStatusBar,
  });

  function shutdown(): void {
    if (context.state.shuttingDown) return;
    context.state.shuttingDown = true;
    if (resizeTimer !== undefined) {
      clearInterval(resizeTimer);
    }
    context.input.stop();
    context.renderer.destroy();
  }

  const uiController = createUiController({
    renderer: context.renderer,
    input: context.input,
    sessions: context.sessions,
    getCurrentSession: sessionManager.getCurrentSession,
    getActiveSessionId: () => context.state.activeSessionId,
    nextSessionId: () => {
      context.state.sessionCounter += 1;
      return `agent-${context.state.sessionCounter}`;
    },
    createSession: sessionManager.createSession,
    switchSession: sessionManager.switchSession,
    runAgentTask: agentRunner.runAgentTask,
    handleCommand: commandRouter,
    shutdown,
  });
  redraw = uiController.redraw;

  sessionManager.createSession("main", "Main");
  context.renderer.start();
  uiController.attachHandlers();

  const emergencyCleanup = () => shutdown();
  globalThis.addEventListener("unhandledrejection", emergencyCleanup);

  resizeTimer = setInterval(() => {
    if (context.renderer.checkResize()) {
      context.renderer.invalidate();
      redraw();
    }
  }, 500);

  try {
    const modelStatus = await context.llm.ensureModelAvailable();
    const current = sessionManager.getCurrentSession();
    if (current && modelStatus.changed) {
      current.viewModel.addInfo(`Model not found locally. Using ${modelStatus.model}`);
    }
    updateStatusBar();
  } catch (error) {
    const current = sessionManager.getCurrentSession();
    if (current) current.viewModel.addWarning(`Model setup: ${asMessage(error)}`);
    updateStatusBar();
  }

  const current = sessionManager.getCurrentSession();
  if (current) {
    current.viewModel.addInfo(`Workspace: ${context.rootDir}`);
    current.viewModel.addInfo("Type /help for commands. Ctrl+C to exit.");
  }

  await new Promise((r) => setTimeout(r, 50));
  context.renderer.invalidate();
  if (current) current.viewModel.emitNow();

  try {
    await context.input.start();
  } finally {
    shutdown();
  }
}
