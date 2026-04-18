import { OllamaClient } from "../../core/llm/ollamaClient.ts";
import { InputHandler } from "../../ui/tui/input.ts";
import type { AgentRuntimeConfig, AgentSession } from "../types.ts";
import { asMessage } from "../utils/errors.ts";
import { isFailureObservation, summarizeObservationForUi } from "../utils/observation.ts";

interface AgentRunnerDeps {
  llm: OllamaClient;
  input: InputHandler;
  sessions: Map<string, AgentSession>;
  runtime: AgentRuntimeConfig;
  updateStatusBar: () => void;
}

export function createAgentRunner(
  { llm, input, sessions, runtime, updateStatusBar }: AgentRunnerDeps,
) {
  async function runAgentTask(session: AgentSession, task: string): Promise<void> {
    session.status = "running";
    input.disable();
    session.viewModel.addUserMessage(task);
    updateStatusBar();

    let planningStep = 0;
    let lastToolStep = 0;

    try {
      await session.agent.run(task, {
        onStatus: (line) => {
          if (line.startsWith("Planning step")) {
            const parts = line.match(/Planning step\s+(\d+)/i);
            planningStep = parts?.[1] ? Number(parts[1]) : planningStep;
            session.viewModel.setStatusBar(
              llm.getModel(),
              session.title,
              `${planningStep}/${runtime.maxIterations}`,
              "",
              sessions.size,
              Array.from(sessions.keys()).indexOf(session.id),
            );
            return;
          }
          if (line.includes(" : ") && line.startsWith("Step ")) {
            const stepMatch = line.match(/^Step\s+(\d+)\s*:\s*(.+)$/i);
            if (stepMatch?.[1]) {
              lastToolStep = Number(stepMatch[1]);
            }
            const tool = line.split(" : ")[1].split("(")[0].trim();
            session.viewModel.addToolActivity(lastToolStep, tool, "running");
            session.viewModel.setStatusBar(
              llm.getModel(),
              session.title,
              `${lastToolStep} · ${tool}`,
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
          if (line.toLowerCase().includes("error") || line.toLowerCase().includes("failed")) {
            session.viewModel.addWarning(line);
            return;
          }
          if (runtime.debug) {
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

  return {
    runAgentTask,
  };
}
