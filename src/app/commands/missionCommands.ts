import { COMMAND_USAGE } from "./commandDefinitions.ts";
import { icon, style } from "../../ui/tui/style.ts";
import type { MissionStep } from "../../core/types.ts";
import type { AgentRuntimeConfig, AgentSession } from "../types.ts";

interface MissionCommandDeps {
  runtime: AgentRuntimeConfig;
  sessions: Map<string, AgentSession>;
  getCurrentSession: () => AgentSession | undefined;
  updateStatusBar: () => void;
  invalidate: () => void;
}

export async function handleMissionCommand(
  command: string,
  arg: string,
  deps: MissionCommandDeps,
): Promise<boolean | undefined> {
  const current = deps.getCurrentSession();
  if (!current) return true;

  if (command === "/plan") {
    if (!arg) {
      current.viewModel.addError(COMMAND_USAGE.plan);
      return true;
    }
    current.viewModel.addInfo(style.dim("Deconstructing task into mission steps..."));
    current.status = "running";
    deps.updateStatusBar();
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
    deps.updateStatusBar();
    deps.invalidate();
    return true;
  }

  if (command !== "/next") {
    return undefined;
  }

  if (!current.plan) {
    current.viewModel.addError("No active plan. Create one with /plan <task>");
    return true;
  }

  const isSuppressed = (line: string) => {
    const lower = line.toLowerCase();
    return lower.startsWith("planning step") ||
      lower.startsWith("task received") ||
      lower.startsWith("finalizing response") ||
      lower.startsWith("iteration limit reached") ||
      lower.startsWith("decision raw") ||
      lower.startsWith("decision repair raw") ||
      lower.startsWith("observation:");
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
    deps.updateStatusBar();

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

      current.viewModel.addInfo(style.dim(`  ${icon.spinner} Verifying step success...`));
      const isVerified = await current.agent.verifyStepSuccess(step.instruction);

      if (!isVerified) {
        current.viewModel.addWarning(
          style.yellow(`  ${icon.warn} Step verification failed. Goal was not reached.`),
        );
        step.status = "failed";
        current.status = "idle";
        return false;
      }

      const summary = await current.agent.summarizeStep(step.instruction);
      step.resultSummary = summary;
      step.status = "completed";
      current.plan!.currentIndex += 1;

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
      await new Promise((r) => setTimeout(r, 500));
    }

    current.status = "idle";
    deps.updateStatusBar();
    deps.invalidate();

    if (current.plan && current.plan.currentIndex >= current.plan.steps.length) {
      current.viewModel.addInfo(style.bold("\nMission accomplished!"));
    }
  })();

  return true;
}
