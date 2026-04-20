import { OllamaClient } from "../../core/llm/ollamaClient.ts";
import { InputHandler } from "../../ui/tui/input.ts";
import type { AgentRuntimeConfig, AgentSession } from "../types.ts";
import { asMessage } from "../utils/errors.ts";
import {
  isFailureObservation,
  summarizeObservationForUi,
} from "../utils/observation.ts";

interface AgentRunnerDeps {
  llm: OllamaClient;
  input: InputHandler;
  sessions: Map<string, AgentSession>;
  runtime: AgentRuntimeConfig;
  updateStatusBar: () => void;
}

type AdaptiveDisplay = {
  enabled: boolean;
  currentLimit: number;
  extensions: number;
};

/**
 * #TODO WILL BE CHANGED! current system too ambigous
 * Formats the iteration display for the status bar.
 * Non-adaptive: "5/32"
 * Adaptive (can extend): "5/32+"
 * Adaptive (extended): "45/52↑2"
 */
function formatIterationDisplay(
  currentStep: number,
  adaptive: AdaptiveDisplay | undefined,
  maxIterations: number,
): string {
  if (!adaptive?.enabled) {
    return `${currentStep}/${maxIterations}`;
  }
  const suffix = adaptive.extensions === 0 ? "+" : `↑${adaptive.extensions}`;
  return `${currentStep}/${adaptive.currentLimit}${suffix}`;
}

function formatContextInfo(adaptive: AdaptiveDisplay | undefined): string {
  if (!adaptive?.enabled) return "";
  return adaptive.extensions > 0 ? `adapt:${adaptive.extensions}` : "adapt";
}

export function createAgentRunner({
  llm,
  input,
  sessions,
  runtime,
  updateStatusBar,
}: AgentRunnerDeps) {
  function updateStatusBarWithState(
    session: AgentSession,
    state: string,
    adaptive: AdaptiveDisplay | undefined,
  ): void {
    session.viewModel.setStatusBar(
      llm.getModel(),
      session.title,
      state,
      formatContextInfo(adaptive),
      sessions.size,
      Array.from(sessions.keys()).indexOf(session.id),
    );
  }

  async function runAgentTask(
    session: AgentSession,
    task: string,
  ): Promise<void> {
    session.status = "running";
    input.disable();
    session.viewModel.addUserMessage(task);
    updateStatusBar();

    let planningStep = 0;
    let lastToolStep = 0;
    const getAdaptive = () => session.agent.getAdaptiveConfig();

    try {
      await session.agent.run(task, {
        onStatus: (line) => {
          if (line.startsWith("Adaptive limit extended")) {
            session.viewModel.addInfo(`🔄 ${line}`);
            const step = lastToolStep || planningStep;
            updateStatusBarWithState(
              session,
              formatIterationDisplay(
                step,
                getAdaptive(),
                runtime.maxIterations,
              ),
              getAdaptive(),
            );
            return;
          }

          if (line.startsWith("Planning step")) {
            const match = line.match(/Planning step\s+(\d+)/i);
            planningStep = match?.[1] ? Number(match[1]) : planningStep;
            updateStatusBarWithState(
              session,
              formatIterationDisplay(
                planningStep,
                getAdaptive(),
                runtime.maxIterations,
              ),
              getAdaptive(),
            );
            return;
          }

          if (line.includes(" : ") && line.startsWith("Step ")) {
            const match = line.match(/^Step\s+(\d+)\s*:\s*(.+)$/i);
            if (match?.[1]) lastToolStep = Number(match[1]);
            const tool = line.split(" : ")[1].split("(")[0].trim();
            session.viewModel.addToolActivity(lastToolStep, tool, "running");
            updateStatusBarWithState(
              session,
              `${lastToolStep} · ${tool}`,
              getAdaptive(),
            );
            return;
          }

          if (line.startsWith("Observation:")) {
            const summary = line.slice("Observation:".length).trim();
            const status = isFailureObservation(summary) ? "error" : "done";
            session.viewModel.updateToolStatus(
              lastToolStep,
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

          if (
            line.toLowerCase().includes("error") ||
            line.toLowerCase().includes("failed")
          ) {
            session.viewModel.addWarning(line);
            return;
          }

          if (runtime.debug) {
            session.viewModel.addInfo(line);
          }
        },
        onReasoningChunk: (chunk) => {
          if (!session.viewModel.isStreaming)
            session.viewModel.startAssistantStream();
          session.viewModel.appendReasoningChunk(chunk);
        },
        onAssistantChunk: (chunk) => {
          if (!session.viewModel.isStreaming)
            session.viewModel.startAssistantStream();
          session.viewModel.appendAssistantChunk(chunk);
        },
        onAssistantDone: (_full) => {
          if (session.viewModel.isStreaming)
            session.viewModel.endAssistantStream();
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

  return { runAgentTask };
}
