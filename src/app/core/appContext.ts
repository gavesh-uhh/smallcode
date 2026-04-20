import { OllamaClient } from "../../core/llm/ollamaClient.ts";
import { AGENT_CONFIG, OLLAMA_CONFIG } from "../../core/config.ts";
import { InputHandler } from "../../ui/tui/input.ts";
import { Renderer } from "../../ui/tui/renderer.ts";
import type {
  AdaptiveIterationConfig,
  AgentRuntimeConfig,
  AgentSession,
  AppState,
} from "../types.ts";

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
  const adaptiveConfig: AdaptiveIterationConfig = {
    enabled: AGENT_CONFIG.adaptive.enabled,
    startLimit: AGENT_CONFIG.adaptive.startLimit,
    currentLimit: AGENT_CONFIG.adaptive.startLimit,
    extendBy: AGENT_CONFIG.adaptive.extendBy,
    maxCap: AGENT_CONFIG.adaptive.maxCap,
    extensions: 0,
  };

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
      adaptive: adaptiveConfig,
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
