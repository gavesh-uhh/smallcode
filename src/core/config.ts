import type { AgentProfile } from "./agent/prompts.ts";

export const OLLAMA_CONFIG = {
  baseUrl: "http://localhost:11434",
  defaultModel: "gemma4:latest",
  defaultTemperature: 0.2,
  defaultNumCtx: 4096,
  defaultKeepAlive: "30m",
} as const;

export const AGENT_CONFIG = {
  defaultProfile: "small" as AgentProfile,
  defaultMaxIterations: 8,
  defaultDebug: false,
  decision: {
    temperature: 0.0,
    ctxByProfile: {
      small: 4096,
      balanced: 8192,
      ultra: 32768,
    } as const,
    repairTemperature: 0.0,
    repairNumCtx: 1024,
  },
  planning: {
    temperature: 0.1,
  },
  summarize: {
    temperature: 0.0,
  },
  verify: {
    temperature: 0.0,
    numCtx: 2048,
  },
  preflight: {
    temperature: 0.1,
    numCtx: 1024,
  },
  final: {
    temperature: 0.2,
  },
} as const;
