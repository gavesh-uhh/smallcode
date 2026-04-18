export type Role = "system" | "user" | "assistant" | "tool";

export interface Message {
  role: Role;
  content: string;
  name?: string;
  reasoning?: string; // For models like DeepSeek-R1 that support explicit reasoning
}

export interface ChatChunk {
  type: "content" | "reasoning";
  text: string;
}

export interface GenerateOptions {
  model?: string;
  system?: string;
  temperature?: number;
  numCtx?: number;
  format?: "json";
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(input: string): Promise<string>;
}

export type DecisionAction = "tool" | "respond";

export interface AgentDecision {
  reason?: string; // Compact rationale for small-model reliability
  thought?: string; // Backward-compatible field from older prompt versions
  action: DecisionAction;
  tool?: string;
  input?: unknown;
  expected_observation?: string;
}

export interface MissionStep {
  id: number;
  instruction: string;
  status: "pending" | "running" | "completed" | "failed";
  resultSummary?: string;
}

export interface MissionPlan {
  originalTask: string;
  steps: MissionStep[];
  currentIndex: number;
}
