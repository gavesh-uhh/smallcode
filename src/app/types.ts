import type { AgentEngine } from "../core/agent/agentEngine.ts";
import type { AgentProfile } from "../core/agent/prompts.ts";
import type { InputState } from "../ui/tui/input.ts";
import type { ViewModel } from "../ui/tui/viewModel.ts";
import type { MemoryManager } from "../core/memory/memoryManager.ts";
import type { ToolRegistry } from "../platform/tools/registry.ts";
import type { MissionPlan } from "../core/types.ts";

export type AgentStatus = "idle" | "running" | "error";

export interface AgentSession {
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

export interface AdaptiveIterationConfig {
  enabled: boolean;
  startLimit: number;
  currentLimit: number;
  extendBy: number;
  maxCap: number;
  extensions: number;
}

export interface AgentRuntimeConfig {
  profile: AgentProfile;
  maxIterations: number;
  debug: boolean;
  adaptive: AdaptiveIterationConfig;
}

export interface AppState {
  activeSessionId: string;
  running: boolean;
  confirmWrites: boolean;
  sessionCounter: number;
  shuttingDown: boolean;
}
