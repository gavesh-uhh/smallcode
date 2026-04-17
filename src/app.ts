import { AgentEngine } from "./agent/agentEngine.ts";
import { parseCommand } from "./cli/commands.ts";
import { OllamaClient } from "./llm/ollamaClient.ts";
import { MemoryManager } from "./memory/memoryManager.ts";

import {
  CodeRunnerTool,
  DelegateTaskTool,
  GitTool,
  ShellCommandTool,
} from "./tools/tools.ts";

import { ToolRegistry } from "./tools/registry.ts";
import type { Message, MissionPlan, MissionStep } from "./types.ts";
import type { AgentProfile } from "./agent/prompts.ts";
import { Renderer } from "./tui/renderer.ts";
import { InputHandler, type InputState } from "./tui/input.ts";
import { ViewModel } from "./tui/viewModel.ts";
import { icon, style } from "./tui/style.ts";

type AgentStatus = "idle" | "running" | "error";

interface AgentSession {
  id: string;
  title: string;
  memory: MemoryManager;
  agent: AgentEngine;
  status: AgentStatus;
  viewModel: ViewModel;
  tools: ToolRegistry;
  inputState: InputState | null;
  plan?: MissionPlan;
}

export async function runApp(): Promise<void> {
  const rootDir = Deno.cwd();
  const llm = new OllamaClient("http://localhost:11434", "qwen2.5:7b");
  const tools = new ToolRegistry();
  const sessions = new Map<string, AgentSession>();
  let activeSessionId = "main";
  let running = true;
  let confirmWrites = true;
  let sessionCounter = 1;
  const agentRuntime = {
    profile: "small" as AgentProfile,
    maxIterations: 8,
    debug: false,
  };

  const renderer = new Renderer();
  const input = new InputHandler();

  function redraw(): void {
    const current = getCurrentSession();
    if (!current) return;

    if (renderer.checkResize()) {
      renderer.invalidate();
    }
    const { cols, rows } = renderer.getSize();

    const { lines } = current.viewModel.computeFrame(cols, rows);
    renderer.render(lines);
  }

  createSession("main", "Main");

  renderer.start();

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(resizeTimer);
    input.stop();
    renderer.destroy();
  }

  const emergencyCleanup = () => shutdown();
  globalThis.addEventListener("unhandledrejection", emergencyCleanup);

  const resizeTimer = setInterval(() => {
    if (renderer.checkResize()) {
      renderer.invalidate();
      redraw();
    }
  }, 500);

  try {
    const modelStatus = await llm.ensureModelAvailable();
    const current = getCurrentSession();
    if (current && modelStatus.changed) {
      current.viewModel.addInfo(`Model not found locally. Using ${modelStatus.model}`);
    }
    updateStatusBar();
  } catch (error) {
    const current = getCurrentSession();
    if (current) current.viewModel.addWarning(`Model setup: ${asMessage(error)}`);
    updateStatusBar();
  }

  const current = getCurrentSession();
  if (current) {
    current.viewModel.addInfo(`Workspace: ${rootDir}`);
    current.viewModel.addInfo("Type /help for commands. Ctrl+C to exit.");
  }

  await new Promise((r) => setTimeout(r, 50));

  renderer.invalidate();
  if (current) current.viewModel.emitNow();

  input.onInputChange((buffer, cursor) => {
    const session = getCurrentSession();
    if (session) session.viewModel.setInputLine(buffer, cursor);
  });

  input.onKey((key) => {
    const current = getCurrentSession();
    if (!current) return;

    if (key.ctrl && key.name === "e") {
      const keys = Array.from(sessions.keys());
      if (keys.length <= 1) {
        sessionCounter++;
        const id = `agent-${sessionCounter}`;
        createSession(id, `Agent ${sessionCounter}`);
      }
      const sessionKeys = Array.from(sessions.keys());
      const idx = sessionKeys.indexOf(activeSessionId);
      const nextIdx = (idx + 1) % sessionKeys.length;
      switchSession(sessionKeys[nextIdx]);
      return;
    }

    if (key.ctrl && key.name === "c") {
      shutdown();
      return;
    }
    if (key.ctrl && key.name === "l") {
      current.viewModel.clearLog();
      current.viewModel.addInfo("Screen cleared. Type /help for commands.");
      renderer.invalidate();
      return;
    }
    if (key.name === "pageup") {
      current.viewModel.scrollUp(10);
      return;
    }
    if (key.name === "pagedown") {
      current.viewModel.scrollDown(10);
      return;
    }
  });

  input.onLine(async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed.startsWith("/")) {
      running = await handleCommand(trimmed);
      if (!running) shutdown();
      return;
    }

    const session = getCurrentSession();
    if (!session) {
      return;
    }

    await runAgentTask(session, trimmed);
  });

  try {
    await input.start();
  } finally {
    shutdown();
  }

  function getCurrentSession(): AgentSession | undefined {
    let session = sessions.get(activeSessionId);
    if (!session) {
      const fallback = sessions.values().next().value as AgentSession | undefined;
      if (fallback) {
        activeSessionId = fallback.id;
        session = fallback;
      }
    }
    return session;
  }

  function updateStatusBar(): void {
    const session = getCurrentSession();
    if (!session) return;

    const stats = session.agent.getContextStats();
    const tokenEst = stats.chars > 1000
      ? `${(stats.chars / 4000).toFixed(1)}k`
      : `${Math.round(stats.chars / 4)}`;
    const ctxText = `${stats.messages}/${stats.max} · ${tokenEst}`;

    session.viewModel.setStatusBar(
      llm.getModel(),
      session.title,
      session.status,
      ctxText,
      sessions.size,
      Array.from(sessions.keys()).indexOf(session.id),
    );
  }

  async function handleCommand(line: string): Promise<boolean> {
    const { command, arg } = parseCommand(line);
    const current = getCurrentSession();
    if (!current) {
      return true;
    }

    switch (command) {
      case "/help":
        showHelp(current.viewModel);
        return true;
      case "/exit":
        return false;
      case "/clear":
        current.viewModel.clearLog();
        current.viewModel.addInfo("Screen cleared.");
        updateStatusBar();
        renderer.invalidate();
        return true;
      case "/model":
        if (!arg) {
          const models = await llm.listModels();
          current.viewModel.addInfo(`Current model: ${llm.getModel()}`);
          current.viewModel.addInfo(`Available: ${models.join(", ") || "(none)"}`);
          return true;
        }
        llm.setModel(arg);
        current.viewModel.addInfo(`Model set to: ${llm.getModel()}`);
        updateStatusBar();
        return true;
      case "/confirm":
        if (arg !== "on" && arg !== "off") {
          current.viewModel.addError("Usage: /confirm on|off");
          return true;
        }
        confirmWrites = arg === "on";
        current.viewModel.addInfo(`Write confirmation: ${confirmWrites ? "ON" : "OFF"}`);
        return true;
      case "/debug":
        if (arg !== "on" && arg !== "off") {
          current.viewModel.addError("Usage: /debug on|off");
          return true;
        }
        agentRuntime.debug = arg === "on";
        applyAgentRuntime();
        current.viewModel.addInfo(`Agent debug: ${agentRuntime.debug ? "ON" : "OFF"}`);
        return true;
      case "/reset":
        current.memory.reset();
        current.plan = undefined;
        current.viewModel.addInfo(`Reset memory and plan for session ${current.title}`);
        return true;
      case "/plan": {
        if (!arg) {
          current.viewModel.addError("Usage: /plan <task description>");
          return true;
        }
        current.viewModel.addInfo(style.dim("Deconstructing task into mission steps..."));
        current.status = "running";
        updateStatusBar();
        try {
          const rawSteps = await current.agent.generatePlan(arg);
          const steps: MissionStep[] = rawSteps.map((s, idx) => ({
            id: idx + 1,
            instruction: s,
            status: "pending",
          }));
          current.plan = {
            originalTask: arg,
            steps,
            currentIndex: 0,
          };
          current.viewModel.addInfo(style.bold(`${icon.check} Mission Roadmap Generated:`));
          steps.forEach((s) => {
            current.viewModel.addInfo(`${s.id}. [ ] ${s.instruction}`);
          });
          current.viewModel.addInfo(style.dim("\nType '/next' to begin the first step."));
        } catch (err) {
          current.viewModel.addError(`Planning failed: ${err}`);
        }
        current.status = "idle";
        updateStatusBar();
        renderer.invalidate();
        return true;
      }
      case "/next": {
        if (!current.plan) {
          current.viewModel.addError("No active plan. Create one with /plan <task>");
          return true;
        }

        const isSuppressed = (line: string) => {
          const l = line.toLowerCase();
          return l.startsWith("planning step") ||
            l.startsWith("task received") ||
            l.startsWith("finalizing response") ||
            l.startsWith("iteration limit reached") ||
            l.startsWith("decision raw") ||
            l.startsWith("decision repair raw") ||
            l.startsWith("observation:");
        };

        const executeStep = async () => {
          if (current.plan!.currentIndex >= current.plan!.steps.length) return false;

          const step = current.plan!.steps[current.plan!.currentIndex];
          current.viewModel.addInfo(
            style.bold(`\n${icon.working} Step ${step.id}: ${step.instruction}`),
          );

          const prevSummaries = current.plan!.steps
            .slice(0, current.plan!.currentIndex)
            .map((s) => s.resultSummary)
            .filter((s): s is string => !!s);

          current.status = "running";
          updateStatusBar();

          try {
            await current.agent.run(step.instruction, {
              onStatus: (line) => {
                if (!isSuppressed(line)) {
                  current.viewModel.addInfo(style.dim(`  ${line}`));
                }
              },
              onAssistantChunk: (chunk) => {
                if (!current.viewModel.isStreaming) {
                  current.viewModel.startAssistantStream();
                }
                current.viewModel.appendAssistantChunk(chunk);
              },
              onAssistantDone: (_full) => {
                if (current.viewModel.isStreaming) {
                  current.viewModel.endAssistantStream();
                }
              },
            }, prevSummaries);

            // Verification Gate
            current.viewModel.addInfo(style.dim(`  ${icon.spinner} Verifying step success...`));
            const isVerified = await current.agent.verifyStepSuccess(step.instruction);

            if (!isVerified) {
              current.viewModel.addWarning(
                style.yellow(`  ${icon.warn} Step verification failed. Goal was not reached.`),
              );
              step.status = "failed";
              current.status = "idle";
              return false; // Stop the loop
            }

            // Summarize
            const summary = await current.agent.summarizeStep(step.instruction);
            step.resultSummary = summary;
            step.status = "completed";
            current.plan!.currentIndex++;

            current.viewModel.addInfo(style.green(`  ${icon.check} Step ${step.id} finished.`));
            return true;
          } catch (err) {
            step.status = "failed";
            current.viewModel.addError(`Step execution error: ${err}`);
            return false;
          }
        };

        (async () => {
          while (current.plan && current.plan.currentIndex < current.plan.steps.length) {
            const success = await executeStep();
            if (!success) break;

            // Brief pause between steps for visual clarity
            await new Promise((r) => setTimeout(r, 500));
          }
          current.status = "idle";
          updateStatusBar();
          renderer.invalidate();

          if (current.plan && current.plan.currentIndex >= current.plan.steps.length) {
            current.viewModel.addInfo(style.bold("\nMission accomplished!"));
          }
        })();

        return true;
      }
      case "/files": {
        const cmd = arg ? `ls -la "${arg}"` : "ls -la .";
        const listText = await current.tools
          .get("shell_command")!
          .execute(JSON.stringify({ command: cmd, cwd: "." }));
        current.viewModel.addInfo(listText);
        return true;
      }
      case "/run":
        if (!arg) {
          current.viewModel.addError("Usage: /run <command>");
          return true;
        }
        current.viewModel.addInfo(
          await current.tools
            .get("shell_command")!
            .execute(JSON.stringify({ command: arg, cwd: "." })),
        );
        return true;
      case "/agent": {
        const [sub, ...subArgs] = arg.split(/\s+/).filter(Boolean);
        const subArgLine = subArgs.join(" ").trim();
        if (!sub) {
          current.viewModel.addError("Usage: /agent new|list|switch|close ...");
          return true;
        }
        if (sub === "new") {
          sessionCounter += 1;
          const title = subArgLine || `Agent ${sessionCounter}`;
          const id = `agent-${sessionCounter}`;
          createSession(id, title);
          switchSession(id);
          const newSession = sessions.get(id)!;
          newSession.viewModel.addInfo(`Created and switched to ${title} (${id})`);
          return true;
        }
        if (sub === "profile") {
          if (subArgLine !== "small" && subArgLine !== "balanced" && subArgLine !== "ultra") {
            current.viewModel.addError("Usage: /agent profile small|balanced|ultra");
            return true;
          }
          agentRuntime.profile = subArgLine;
          applyAgentRuntime();
          current.viewModel.addInfo(`Agent profile set to ${agentRuntime.profile}`);
          return true;
        }
        if (sub === "iterations") {
          const value = Number(subArgLine);
          if (!Number.isInteger(value) || value < 1 || value > 24) {
            current.viewModel.addError("Usage: /agent iterations <1..24>");
            return true;
          }
          agentRuntime.maxIterations = value;
          applyAgentRuntime();
          current.viewModel.addInfo(`Agent iterations set to ${agentRuntime.maxIterations}`);
          return true;
        }
        if (sub === "list") {
          const sessionList = [...sessions.values()];
          for (let i = 0; i < sessionList.length; i++) {
            const s = sessionList[i];
            const marker = s.id === activeSessionId ? "▸" : " ";
            current.viewModel.addInfo(`${marker} ${i + 1}. ${s.title}  (${s.id})  [${s.status}]`);
          }
          return true;
        }
        if (sub === "switch") {
          if (!subArgLine) {
            current.viewModel.addError("Usage: /agent switch <id|index>");
            return true;
          }
          const tabs = [...sessions.values()];
          const index = Number(subArgLine);
          const byIndex = Number.isInteger(index) && index >= 1 && index <= tabs.length
            ? tabs[index - 1].id
            : null;
          const targetId = byIndex ?? subArgLine;
          if (!sessions.has(targetId)) {
            current.viewModel.addError(`Unknown session: ${subArgLine}`);
            return true;
          }
          switchSession(targetId);
          const target = sessions.get(targetId)!;
          target.viewModel.addInfo(`Switched to ${target.title} (${target.id})`);
          return true;
        }
        if (sub === "close") {
          const target = subArgLine || activeSessionId;
          if (target === "main") {
            current.viewModel.addError("Main session cannot be closed.");
            return true;
          }
          if (!sessions.has(target)) {
            current.viewModel.addError(`Unknown session: ${target}`);
            return true;
          }
          sessions.delete(target);
          if (activeSessionId === target) {
            switchSession("main");
          }
          current.viewModel.addInfo(`Closed session ${target}`);
          updateStatusBar();
          return true;
        }
        current.viewModel.addError("Usage: /agent new|list|switch|close|profile|iterations ...");
        return true;
      }
      default:
        current.viewModel.addError(`Unknown command: ${command}`);
        return true;
    }
  }

  function switchSession(id: string): void {
    const current = getCurrentSession();
    if (current) {
      current.inputState = input.exportState();
    }
    activeSessionId = id;
    const target = sessions.get(id);
    if (!target) return;

    if (target.inputState) {
      input.importState(target.inputState);
    } else {
      input.importState({
        buffer: "",
        cursorPos: 0,
        history: [],
        historyIdx: -1,
        historyDraft: "",
      });
    }

    target.viewModel.emitNow(); // Triggers redraw
    updateStatusBar();
  }

  function showHelp(vm: ViewModel): void {
    const generalCmds = [
      ["/help", "Show commands"],
      ["/exit", "Quit"],
      ["/clear", "Clear screen"],
      ["/model [name]", "Show or switch model"],
      ["/confirm on|off", "Toggle file-write confirmations"],
      ["/debug on|off", "Toggle agent decision debug"],
      ["/reset", "Reset active session memory"],
    ];
    const toolCmds = [
      ["/files [path]", "List files via tool layer"],
      ["/run <command>", "Run shell command via tool layer"],
    ];
    const agentCmds = [
      ["/agent new [name]", "Create session"],
      ["/agent list", "List sessions"],
      ["/agent switch <id|n>", "Switch session"],
      ["/agent close [id]", "Close session (except main)"],
      ["/agent profile", "Set agent profile (small|balanced)"],
      ["/agent iterations", "Set iteration cap (1..24)"],
    ];

    vm.addInfo(""); // spacer

    vm.addInfo(`  ${style.bold(style.cyan("─── General Commands ───"))}`);
    for (const [cmd, desc] of generalCmds) {
      vm.addInfo(`  ${style.yellow(cmd.padEnd(28))} ${style.dim(desc)}`);
    }

    vm.addInfo(`\n  ${style.bold(style.cyan("─── Sub-Tools ───"))}`);
    for (const [cmd, desc] of toolCmds) {
      vm.addInfo(`  ${style.yellow(cmd.padEnd(28))} ${style.dim(desc)}`);
    }

    vm.addInfo(`\n  ${style.bold(style.cyan("─── Multi-Agent ───"))}`);
    vm.addInfo(
      `${
        style.bold("  /plan <task> ")
      } - Deconstruct a large task into a mission plan (<15B optimized)`,
    );
    vm.addInfo(
      `${style.bold("  /next        ")} - Execute the next step in the active mission plan`,
    );
    vm.addInfo(
      `${style.bold("  /agent       ")} - Manage sessions (new, switch, list, close, profile)`,
    );
    vm.addInfo(`${style.bold("  /reset       ")} - Clear session memory and active plans`);
    vm.addInfo(`  ${style.yellow("Ctrl+E".padEnd(28))} ${style.dim("Switch active tab")}`);
    vm.addInfo(`  ${style.yellow("Ctrl+C".padEnd(28))} ${style.dim("Quit application")}`);
    vm.addInfo(`  ${style.yellow("Ctrl+L".padEnd(28))} ${style.dim("Clear entire screen")}`);
    vm.addInfo(`  ${style.yellow("PgUp / PgDn".padEnd(28))} ${style.dim("Scroll chat history")}`);
    vm.addInfo(`  ${style.yellow("Up / Down".padEnd(28))} ${style.dim("Browse input history")}`);
    vm.addInfo("");
  }

  async function runAgentTask(
    session: AgentSession,
    task: string,
  ): Promise<void> {
    session.status = "running";
    input.disable();
    session.viewModel.addUserMessage(task);
    updateStatusBar();

    let currentStep = 0;

    try {
      await session.agent.run(task, {
        onStatus: (line) => {
          if (line.startsWith("Planning step")) {
            const parts = line.match(/Planning step\s+(\d+)/i);
            currentStep = parts?.[1] ? Number(parts[1]) : currentStep;
            session.viewModel.setStatusBar(
              llm.getModel(),
              session.title,
              `${currentStep}/${agentRuntime.maxIterations}`,
              "",
              sessions.size,
              Array.from(sessions.keys()).indexOf(session.id),
            );
            return;
          }
          if (line.includes(" : ") && line.startsWith("Step ")) {
            const tool = line.split(" : ")[1].split("(")[0].trim();
            session.viewModel.addToolActivity(currentStep, tool, "running");
            session.viewModel.setStatusBar(
              llm.getModel(),
              session.title,
              `${currentStep} · ${tool}`,
              "",
              sessions.size,
              Array.from(sessions.keys()).indexOf(session.id),
            );
            return;
          }
          if (line.startsWith("Observation:")) {
            const summary = line.slice("Observation:".length).trim();
            const status = isFailureObservation(summary) ? "error" : "done";
            session.viewModel.updateToolStatus(
              currentStep,
              status,
              summarizeObservationForUi(summary, status),
            );
            return;
          }

          if (
            line.startsWith("Task received.") ||
            line.startsWith("Finalizing response.") ||
            line.startsWith("Iteration limit reached.")
          ) {
            return;
          }
          if (line.toLowerCase().includes("error") || line.toLowerCase().includes("failed")) {
            session.viewModel.addWarning(line);
            return;
          }
          if (agentRuntime.debug) {
            session.viewModel.addInfo(line);
          }
        },
        onReasoningChunk: (chunk) => {
          if (!session.viewModel.isStreaming) {
            session.viewModel.startAssistantStream();
          }
          session.viewModel.appendReasoningChunk(chunk);
        },
        onAssistantChunk: (chunk) => {
          if (!session.viewModel.isStreaming) {
            session.viewModel.startAssistantStream();
          }
          session.viewModel.appendAssistantChunk(chunk);
        },
        onAssistantDone: (_full) => {
          if (session.viewModel.isStreaming) {
            session.viewModel.endAssistantStream();
          }
        },
      });
      session.status = "idle";
    } catch (err) {
      session.status = "error";
      session.viewModel.addError(`Agent error: ${asMessage(err)}`);
    }

    input.enable();
    updateStatusBar();
  }

  function createSession(id: string, title: string): AgentSession {
    const memory = new MemoryManager();
    const vm = new ViewModel();
    const toolsContext = new ToolRegistry();

    const context = {
      rootDir,
      confirmWrite: async (question: string, diff: string): Promise<boolean> => {
        if (!confirmWrites) return true;
        vm.addInfo(`${question}`);
        if (diff.trim()) {
          vm.addInfo(diff.length > 200 ? diff.slice(0, 200) + "…" : diff);
        }
        return true;
      },
      delegateTask: async (task: string): Promise<string> => {
        sessionCounter++;
        const workerId = `agent-${sessionCounter}`;
        const workerTitle = `Worker ${sessionCounter}`;
        const workerSession = createSession(workerId, workerTitle);
        vm.addInfo(`Delegating sub-task (Worker ${sessionCounter})...`);

        await runAgentTask(workerSession, task);

        const lastMsg = workerSession.memory.getMessages()
          .filter((m) => m.role === "assistant")
          .pop();
        return lastMsg?.content ?? "No response from worker.";
      },
    };

    toolsContext.register(new ShellCommandTool(context));
    toolsContext.register(new CodeRunnerTool(context));
    toolsContext.register(new GitTool(context));
    toolsContext.register(new DelegateTaskTool(context));

    const agent = new AgentEngine(llm, toolsContext, memory, {
      maxIterations: agentRuntime.maxIterations,
      profile: agentRuntime.profile,
      debug: agentRuntime.debug,
    });

    vm.onChange(() => {
      if (activeSessionId === id && !shuttingDown) {
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
    sessions.set(id, session);
    return session;
  }

  function applyAgentRuntime(): void {
    for (const session of sessions.values()) {
      session.agent.configure({
        maxIterations: agentRuntime.maxIterations,
        profile: agentRuntime.profile,
        debug: agentRuntime.debug,
      });
      session.memory.setMaxHistory(agentRuntime.profile === "ultra" ? 128 : 64);
    }
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFailureObservation(summary: string): boolean {
  const lower = summary.toLowerCase();
  return lower.includes("tool error") ||
    lower.includes("result: failed") ||
    lower.includes("result: timeout") ||
    lower.includes("exit_code: -1") ||
    lower.includes("not found");
}

function summarizeObservationForUi(
  summary: string,
  status: "done" | "error",
): string {
  if (status === "error") {
    if (summary.toLowerCase().includes("timeout")) return "Timed out";
    if (summary.toLowerCase().includes("not found")) return "Not found";
    return "Failed";
  }
  return "Completed";
}
