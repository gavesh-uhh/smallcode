import { OllamaClient } from "../../core/llm/ollamaClient.ts";
import { AGENT_CONFIG, OLLAMA_CONFIG } from "../../core/config.ts";
import { InputHandler } from "../../ui/tui/input.ts";
import { Renderer } from "../../ui/tui/renderer.ts";
import type { AgentRuntimeConfig, AgentSession, AppState } from "../types.ts";

export interface AppContext {
  rootDir: string;
  llm: OllamaClient;
  renderer: Renderer;
  input: InputHandler;
  sessions: Map<string, AgentSession>;
  runtime: AgentRuntimeConfig;
  state: AppState;
}

export function createAppContext(rootDir: string): AppContext {
  return {
    rootDir,
    llm: new OllamaClient(OLLAMA_CONFIG.baseUrl, OLLAMA_CONFIG.defaultModel),
    renderer: new Renderer(),
    input: new InputHandler(),
    sessions: new Map<string, AgentSession>(),
    runtime: {
      profile: AGENT_CONFIG.defaultProfile,
      maxIterations: AGENT_CONFIG.defaultMaxIterations,
      debug: AGENT_CONFIG.defaultDebug,
    },
    state: {
      activeSessionId: "main",
      running: true,
      confirmWrites: true,
      sessionCounter: 1,
      shuttingDown: false,
    },
  };
}
