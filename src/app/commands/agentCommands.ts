import { COMMAND_USAGE } from "./commandDefinitions.ts";
import type { AgentRuntimeConfig, AgentSession, AppState } from "../types.ts";

interface AgentCommandDeps {
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

export async function handleAgentCommand(
  command: string,
  arg: string,
  deps: AgentCommandDeps,
): Promise<boolean | undefined> {
  const current = deps.getCurrentSession();
  if (!current) return true;

  if (command === "/files") {
    const cmd = arg ? `ls -la "${arg}"` : "ls -la .";
    const listText = await current.tools
      .get("shell_command")!
      .execute(JSON.stringify({ command: cmd, cwd: "." }));
    current.viewModel.addInfo(listText);
    return true;
  }

  if (command === "/run") {
    if (!arg) {
      current.viewModel.addError(COMMAND_USAGE.run);
      return true;
    }
    current.viewModel.addInfo(
      await current.tools
        .get("shell_command")!
        .execute(JSON.stringify({ command: arg, cwd: "." })),
    );
    return true;
  }

  if (command !== "/agent") {
    return undefined;
  }

  const [sub, ...subArgs] = arg.split(/\s+/).filter(Boolean);
  const subArgLine = subArgs.join(" ").trim();
  if (!sub) {
    current.viewModel.addError(COMMAND_USAGE.agent);
    return true;
  }

  if (sub === "new") {
    deps.state.sessionCounter += 1;
    const title = subArgLine || `Agent ${deps.state.sessionCounter}`;
    const id = `agent-${deps.state.sessionCounter}`;
    deps.createSession(id, title);
    deps.switchSession(id);
    const newSession = deps.sessions.get(id)!;
    newSession.viewModel.addInfo(`Created and switched to ${title} (${id})`);
    return true;
  }

  if (sub === "profile") {
    if (subArgLine !== "small" && subArgLine !== "balanced" && subArgLine !== "ultra") {
      current.viewModel.addError(COMMAND_USAGE.agentProfile);
      return true;
    }
    deps.runtime.profile = subArgLine;
    deps.applyAgentRuntime();
    current.viewModel.addInfo(`Agent profile set to ${deps.runtime.profile}`);
    return true;
  }

  if (sub === "iterations") {
    const value = Number(subArgLine);
    if (!Number.isInteger(value) || value < 1 || value > 24) {
      current.viewModel.addError(COMMAND_USAGE.agentIterations);
      return true;
    }
    deps.runtime.maxIterations = value;
    deps.applyAgentRuntime();
    current.viewModel.addInfo(`Agent iterations set to ${deps.runtime.maxIterations}`);
    return true;
  }

  if (sub === "list") {
    const sessionList = [...deps.sessions.values()];
    for (let i = 0; i < sessionList.length; i++) {
      const session = sessionList[i];
      const marker = session.id === deps.state.activeSessionId ? "▸" : " ";
      current.viewModel.addInfo(`${marker} ${i + 1}. ${session.title}  (${session.id})  [${session.status}]`);
    }
    return true;
  }

  if (sub === "switch") {
    if (!subArgLine) {
      current.viewModel.addError(COMMAND_USAGE.agentSwitch);
      return true;
    }
    const tabs = [...deps.sessions.values()];
    const index = Number(subArgLine);
    const byIndex = Number.isInteger(index) && index >= 1 && index <= tabs.length
      ? tabs[index - 1].id
      : null;
    const targetId = byIndex ?? subArgLine;
    if (!deps.sessions.has(targetId)) {
      current.viewModel.addError(`Unknown session: ${subArgLine}`);
      return true;
    }
    deps.switchSession(targetId);
    const target = deps.sessions.get(targetId)!;
    target.viewModel.addInfo(`Switched to ${target.title} (${target.id})`);
    return true;
  }

  if (sub === "close") {
    const target = subArgLine || deps.state.activeSessionId;
    if (target === "main") {
      current.viewModel.addError("Main session cannot be closed.");
      return true;
    }
    if (!deps.sessions.has(target)) {
      current.viewModel.addError(`Unknown session: ${target}`);
      return true;
    }
    deps.removeSession(target);
    if (deps.state.activeSessionId === target) {
      deps.switchSession("main");
    }
    current.viewModel.addInfo(`Closed session ${target}`);
    deps.updateStatusBar();
    return true;
  }

  current.viewModel.addError(COMMAND_USAGE.agentFallback);
  return true;
}
