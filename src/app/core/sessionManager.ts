import { AgentEngine } from "../../core/agent/agentEngine.ts";
import { MemoryManager } from "../../core/memory/memoryManager.ts";
import {
  CodeRunnerTool,
  DelegateTaskTool,
  FileEditTool,
  FileReaderTool,
  FileWriterTool,
  GitTool,
  ShellCommandTool,
} from "../../platform/tools/tools.ts";
import { ToolRegistry } from "../../platform/tools/registry.ts";
import { ViewModel } from "../../ui/tui/viewModel.ts";
import type { AgentSession } from "../types.ts";
import type { AppContext } from "./appContext.ts";

type RunAgentTask = (session: AgentSession, task: string) => Promise<void>;

interface SessionManagerDeps {
  context: AppContext;
  updateStatusBar: () => void;
  redraw: () => void;
  runAgentTaskRef: () => RunAgentTask;
}

export function createSessionManager(
  { context, updateStatusBar, redraw, runAgentTaskRef }: SessionManagerDeps,
) {
  function getCurrentSession(): AgentSession | undefined {
    let session = context.sessions.get(context.state.activeSessionId);
    if (!session) {
      const fallback = context.sessions.values().next().value as AgentSession | undefined;
      if (fallback) {
        context.state.activeSessionId = fallback.id;
        session = fallback;
      }
    }
    return session;
  }

  function switchSession(id: string): void {
    const current = getCurrentSession();
    if (current) {
      current.inputState = context.input.exportState();
    }

    context.state.activeSessionId = id;
    const target = context.sessions.get(id);
    if (!target) return;

    if (target.inputState) {
      context.input.importState(target.inputState);
    } else {
      context.input.importState({
        buffer: "",
        cursorPos: 0,
        history: [],
        historyIdx: -1,
        historyDraft: "",
      });
    }

    target.viewModel.emitNow();
    updateStatusBar();
  }

  function createSession(id: string, title: string): AgentSession {
    const memory = new MemoryManager();
    const vm = new ViewModel();
    const toolsContext = new ToolRegistry();

    const toolExecutionContext = {
      rootDir: context.rootDir,
      confirmWrite: async (question: string, _diff: string): Promise<boolean> => {
        if (!context.state.confirmWrites) return true;
        if (/^overwrite\s+/i.test(question)) {
          vm.addInfo("Overwriting file...");
        } else if (/^create\s+/i.test(question)) {
          vm.addInfo("Creating file...");
        } else if (/^edit\s+/i.test(question)) {
          vm.addInfo("Editing file...");
        } else {
          vm.addInfo("Applying file change...");
        }
        return true;
      },
      delegateTask: async (task: string): Promise<string> => {
        context.state.sessionCounter += 1;
        const workerId = `agent-${context.state.sessionCounter}`;
        const workerTitle = `Worker ${context.state.sessionCounter}`;
        const workerSession = createSession(workerId, workerTitle);
        vm.addInfo(`Delegating sub-task (Worker ${context.state.sessionCounter})...`);

        await runAgentTaskRef()(workerSession, task);

        const lastMsg = workerSession.memory.getMessages()
          .filter((m) => m.role === "assistant")
          .pop();
        return lastMsg?.content ?? "No response from worker.";
      },
    };

    toolsContext.register(new ShellCommandTool(toolExecutionContext));
    toolsContext.register(new FileReaderTool(toolExecutionContext));
    toolsContext.register(new FileWriterTool(toolExecutionContext));
    toolsContext.register(new FileEditTool(toolExecutionContext));
    toolsContext.register(new CodeRunnerTool(toolExecutionContext));
    toolsContext.register(new GitTool(toolExecutionContext));
    toolsContext.register(new DelegateTaskTool(toolExecutionContext));

    const agent = new AgentEngine(context.llm, toolsContext, memory, {
      maxIterations: context.runtime.maxIterations,
      profile: context.runtime.profile,
      debug: context.runtime.debug,
    });

    vm.onChange(() => {
      if (context.state.activeSessionId === id && !context.state.shuttingDown) {
        redraw();
      }
    });

    const session: AgentSession = {
      id,
      title,
      memory,
      agent,
      status: "idle",
      viewModel: vm,
      tools: toolsContext,
      inputState: null,
    };

    context.sessions.set(id, session);
    return session;
  }

  function removeSession(id: string): boolean {
    return context.sessions.delete(id);
  }

  function applyAgentRuntime(): void {
    for (const session of context.sessions.values()) {
      session.agent.configure({
        maxIterations: context.runtime.maxIterations,
        profile: context.runtime.profile,
        debug: context.runtime.debug,
      });
      session.memory.setMaxHistory(context.runtime.profile === "ultra" ? 128 : 64);
    }
  }

  return {
    getCurrentSession,
    switchSession,
    createSession,
    removeSession,
    applyAgentRuntime,
  };
}
