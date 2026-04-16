import type { AgentDecision, Message } from "../types.ts";
import type { OllamaClient } from "../llm/ollamaClient.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { MemoryManager } from "../memory/memoryManager.ts";
import {
  type AgentProfile,
  buildDecisionPrompt,
  buildDecisionRepairPrompt,
  buildFinalSystemPrompt,
  buildFormattingSentinel,
  buildPlannerPrompt,
  buildStepSummaryPrompt,
  buildVerifySuccessPrompt,
} from "./prompts.ts";

interface AgentCallbacks {
  onStatus: (line: string) => void;
  onReasoningChunk?: (chunk: string) => void;
  onAssistantChunk: (chunk: string) => void;
  onAssistantDone: (full: string) => void;
}

interface AgentOptions {
  maxIterations: number;
  profile: AgentProfile;
  debug: boolean;
  decisionTemperature: number;
  decisionCtx: number;
}

export class AgentEngine {
  private settings: AgentOptions;

  constructor(
    private readonly llm: OllamaClient,
    private readonly tools: ToolRegistry,
    private readonly memory: MemoryManager,
    options: Partial<AgentOptions> = {},
  ) {
    this.settings = {
      maxIterations: options.maxIterations ?? 8,
      profile: options.profile ?? "small",
      debug: options.debug ?? false,
      decisionTemperature: options.decisionTemperature ?? 0.0,
      decisionCtx: options.decisionCtx ?? (
        options.profile === "ultra" ? 32768 : options.profile === "balanced" ? 8192 : 4096
      ),
    };
  }

  configure(options: Partial<AgentOptions>): void {
    this.settings = {
      ...this.settings,
      ...options,
    };
  }

  getContextStats(): { messages: number; chars: number; max: number } {
    return this.memory.getStats();
  }

  async run(
    task: string,
    callbacks: AgentCallbacks,
    contextSummaries: string[] = [],
  ): Promise<void> {
    this.memory.addMessage({ role: "user", content: task });
    callbacks.onStatus(
      `Task received. Iteration limit: ${this.settings.maxIterations}. Profile: ${this.settings.profile}`,
    );
    let repeatedIdenticalCount = 0;
    let previousSignature: string | null = null;

    let toolCallsCount = 0;
    const actionVerbs = [
      "create",
      "write",
      "update",
      "delete",
      "mkdir",
      "rm",
      "shell",
      "execute",
      "run",
      "save",
      "make",
      "add",
    ];
    let isActionTask = actionVerbs.some((v) => task.toLowerCase().includes(v));

    for (let i = 1; i <= this.settings.maxIterations; i++) {
      callbacks.onStatus(`Planning step ${i}`);
      const decision = await this.getDecision(task, callbacks, contextSummaries);

      if (!decision) {
        callbacks.onStatus("Could not parse decision. Asking model for direct response.");
        await this.streamFinal(task, callbacks, true);
        return;
      }

      if (decision.action === "respond") {
        if (isActionTask && toolCallsCount === 0) {
          callbacks.onStatus(
            "Minimalism detected: Model tried to finish action task without tools. Retrying with enforcement.",
          );
          this.memory.addMessage({
            role: "user",
            content:
              "You tried to finish without calling a tool, but this task requires an action (Create/Write/etc). Call the appropriate tool now or explain why you cannot.",
          });
          isActionTask = false;
          continue;
        }
        callbacks.onStatus("Finalizing response.");
        await this.streamFinal(task, callbacks, false);
        return;
      }

      const toolName = decision.tool?.trim();
      if (!toolName) {
        callbacks.onStatus("Model returned tool action without tool name. Stopping.");
        await this.streamFinal(task, callbacks, true);
        return;
      }

      const tool = this.tools.get(toolName);
      if (!tool) {
        const observation = `Unknown tool: ${toolName}`;
        this.memory.addMessage({ role: "tool", name: toolName, content: observation });
        this.memory.addScratchpadStep({
          step: i,
          action: toolName,
          input: stringifyInput(decision.input),
          observation,
        });
        callbacks.onStatus(observation);
        continue;
      }

      const criticalTools = ["file_writer", "file_edit", "shell_command"];
      if (criticalTools.includes(toolName)) {
        const critique = await this.critiqueProposal(
          task,
          toolName,
          stringifyInput(decision.input),
          decision.thought || "",
          callbacks,
        );
        if (critique.startsWith("ISSUE:")) {
          callbacks.onStatus(`Sentinel Critique: ${critique}`);
          this.memory.addMessage({
            role: "system",
            content:
              `Sentinel Critique rejected this action: ${critique}\nPlease fix the issue and propose a corrected tool call.`,
          });
          continue;
        }
      }

      const toolInput = stringifyInput(decision.input);
      const toolStatusLabel = getFriendlyToolStatus(toolName, decision.input, i + 1);
      callbacks.onStatus(toolStatusLabel);
      toolCallsCount++;
      let observation: string;
      try {
        observation = await tool.execute(toolInput);
      } catch (error) {
        observation = `Tool error: ${error instanceof Error ? error.message : String(error)}`;
      }
      this.memory.addMessage({ role: "tool", name: toolName, content: observation });
      this.memory.addScratchpadStep({
        step: i,
        action: toolName,
        input: toolInput,
        observation,
      });
      callbacks.onStatus(`Observation: ${short(observation, 280)}`);

      // Recovery hint for small models
      if (
        observation.toLowerCase().includes("error") ||
        observation.toLowerCase().includes("not found")
      ) {
        const lsTool = this.tools.get("directory_lister");
        let contextLS = "";
        if (lsTool) {
          try {
            // Pro-actively list root to help model find its way
            contextLS = await lsTool.execute(JSON.stringify({ path: ".", depth: 1 }));
          } catch { /* ignore */ }
        }

        this.memory.addMessage({
          role: "system",
          content: [
            "RECOVERY HINT: The last tool call returned an error or the path was not found. Do NOT give up.",
            contextLS
              ? `Current directory structure:\n${contextLS}`
              : "Please list the current directory to verify paths.",
            "Verify the correct paths and try again.",
          ].join("\n"),
        });
      }

      const signature = `${toolName}|${toolInput}|${short(observation, 220)}`;
      if (signature === previousSignature) {
        repeatedIdenticalCount += 1;
      } else {
        repeatedIdenticalCount = 0;
      }
      previousSignature = signature;
      if (repeatedIdenticalCount >= 1) {
        callbacks.onStatus("Detected repeated identical tool result. Finalizing with best effort.");
        await this.streamFinal(task, callbacks, true);
        return;
      }
    }

    callbacks.onStatus("Iteration limit reached.");
    await this.streamFinal(task, callbacks, true);
  }

  private async getDecision(
    task: string,
    callbacks: AgentCallbacks,
    contextSummaries: string[] = [],
  ): Promise<AgentDecision | null> {
    const summaryText = contextSummaries.length > 0
      ? `Completed sub-tasks summaries:\n- ${contextSummaries.join("\n- ")}`
      : "";

    const systemPrompt = buildDecisionPrompt({
      task,
      profile: this.settings.profile,
      toolList: this.tools.describeSchemas(),
      scratchpad: this.memory.getCompactScratchpadText(6),
      fileSummaries: this.memory.getFileSummaries(),
    });

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...(summaryText ? [{ role: "system" as const, content: summaryText }] : []),
      ...this.memory.getMessages(),
      { role: "system", content: buildFormattingSentinel() }, // THE SENTINEL: Last reminder
    ];

    // ATTEMPT 1: Strict JSON Mode
    let lastRaw = "";
    try {
      lastRaw = await this.llm.chat(messages, {
        temperature: this.settings.decisionTemperature,
        numCtx: this.settings.decisionCtx,
        format: "json",
      });
      const res = parseDecision(lastRaw);
      if (res.success) return res.decision;
    } catch (err) {
      if (this.settings.debug) callbacks.onStatus(`Strict JSON failed: ${err}`);
    }

    // ATTEMPT 2: Standard mode (Fuzzy Fallback) with Reasoning Visibility
    let fuzzyRaw = "";
    for await (
      const chunk of this.llm.chatStream(messages, {
        temperature: this.settings.decisionTemperature,
        numCtx: this.settings.decisionCtx,
      })
    ) {
      if (chunk.type === "reasoning") {
        callbacks.onReasoningChunk?.(chunk.text);
      } else {
        fuzzyRaw += chunk.text;
      }
    }

    lastRaw = fuzzyRaw;
    if (this.settings.debug) {
      callbacks.onStatus(`Decision raw: ${short(fuzzyRaw.replace(/\s+/g, " "), 220)}`);
    }
    const res = parseDecision(fuzzyRaw);
    if (res.success) return res.decision;

    callbacks.onStatus(`Decision parse failed (${res.error}); retrying with repair.`);

    const repairRaw = await this.llm.chat([
      { role: "system", content: buildDecisionRepairPrompt(res.error, lastRaw) },
      { role: "user", content: `Task: ${task}` },
    ], {
      temperature: 0.0,
      numCtx: 1024,
      format: "json",
    });

    const finalRes = parseDecision(repairRaw);
    return finalRes.success ? finalRes.decision : null;
  }

  private async critiqueProposal(
    task: string,
    tool: string,
    input: string,
    thought: string,
    callbacks: AgentCallbacks,
  ): Promise<string> {
    callbacks.onStatus("Thinking Twice (Sentinel Pass)...");

    // Non-streaming pass for critique
    try {
      const response = await this.llm.chat([
        {
          role: "system",
          content: buildCritiquePrompt({ task, tool, input, thought }),
        },
      ], {
        temperature: 0.1,
        numCtx: 1024,
      });
      return response.trim();
    } catch (err) {
      if (this.settings.debug) callbacks.onStatus(`Critique failed: ${err}`);
      return "SAFE"; // Fallback to safe if critique logic fails
    }
  }

  private async streamFinal(
    task: string,
    callbacks: AgentCallbacks,
    includeLimitWarning: boolean,
  ): Promise<void> {
    const messages: Message[] = [
      {
        role: "system",
        content: buildFinalSystemPrompt({ task, includeLimitWarning }),
      },
      ...this.memory.getMessages(),
      {
        role: "user",
        content: [
          `Original task: ${task}`,
          "Use tool observations from context if present.",
          "Provide final user-facing response.",
        ].join("\n"),
      },
    ];
    let fullContent = "";
    let fullReasoning = "";
    for await (
      const chunk of this.llm.chatStream(messages, {
        temperature: 0.2,
        numCtx: this.settings.decisionCtx,
      })
    ) {
      if (chunk.type === "reasoning") {
        fullReasoning += chunk.text;
        callbacks.onReasoningChunk?.(chunk.text);
      } else {
        fullContent += chunk.text;
        callbacks.onAssistantChunk(chunk.text);
      }
    }
    this.memory.addMessage({ role: "assistant", content: fullContent, reasoning: fullReasoning });
    callbacks.onAssistantDone(fullContent);
  }

  async generatePlan(task: string): Promise<string[]> {
    const prompt = buildPlannerPrompt(task);
    const raw = await this.llm.chat([{ role: "user", content: prompt }], {
      temperature: 0.1,
      format: "json", // Planner SHOULD output JSON array
    });
    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) return parsed.map(String);
      }
      return raw.split("\n").filter((l) => l.trim().length > 5).map((l) =>
        l.replace(/^\d+\.\s*/, "").trim()
      );
    } catch {
      return [task];
    }
  }

  async summarizeStep(task: string): Promise<string> {
    const scratchpad = this.memory.getScratchpadText(10);
    const prompt = buildStepSummaryPrompt(task, scratchpad);
    const summary = await this.llm.chat([{ role: "user", content: prompt }], {
      temperature: 0.0,
    });
    return summary.trim();
  }

  async verifyStepSuccess(task: string): Promise<boolean> {
    const history = this.memory.getScratchpadText(15);
    const prompt = buildVerifySuccessPrompt(task, history);
    const result = await this.llm.chat([{ role: "user", content: prompt }], {
      temperature: 0.0,
      numCtx: 2048,
    });
    return result.trim().toUpperCase() === "YES";
  }
}

type ParseResult = { success: true; decision: AgentDecision } | { success: false; error: string };

function parseDecision(raw: string): ParseResult {
  const trimmed = raw.trim();

  // 1. Direct JSON attempt
  const direct = tryParseJson(trimmed);
  if (direct) {
    const norm = normalizeDecision(direct);
    if (norm) return { success: true, decision: norm };
    return {
      success: false,
      error:
        "JSON is valid but missing required fields: 'thought', 'action' (must be 'tool' or 'respond').",
    };
  }

  // 2. Greedy markdown block extraction
  const blocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const block of blocks.reverse()) {
    const parsed = tryParseJson(block[1].trim());
    if (parsed) {
      const norm = normalizeDecision(parsed);
      if (norm) return { success: true, decision: norm };
    }
  }

  // 3. Brace hunt
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    const parsed = tryParseJson(candidate);
    if (parsed) {
      const norm = normalizeDecision(parsed);
      if (norm) return { success: true, decision: norm };
    }
  }

  // If we found JSON but couldn't normalize it, the candidate logic above didn't catch the error.
  if (trimmed.includes("{")) {
    return {
      success: false,
      error:
        "Output contains JSON but properties are invalid. Ensure 'action' is 'tool' or 'respond'.",
    };
  }

  return { success: false, error: "No valid JSON object found in response." };
}

function tryParseJson(value: string): Record<string, unknown> | null {
  try {
    // Basic repair for common LLM junk (like trailing commas or unquoted keys if very simple)
    let cleaned = value.trim();
    // Use a very simple repair for trailing commas in objects/arrays
    cleaned = cleaned.replace(/,\s*([\}\]])/g, "$1");

    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeDecision(raw: Record<string, unknown>): AgentDecision | null {
  const actionRaw = typeof raw.action === "string" ? raw.action.toLowerCase() : "";
  if (actionRaw !== "tool" && actionRaw !== "respond") {
    // Recovery for models that misname the action field
    if (raw.tool || raw.input) return normalizeDecision({ ...raw, action: "tool" });
    return null;
  }
  return {
    thought: typeof raw.thought === "string" ? raw.thought : undefined,
    action: actionRaw as "tool" | "respond",
    tool: typeof raw.tool === "string" ? raw.tool : undefined,
    input: raw.input,
  };
}

function stringifyInput(input: unknown): string {
  if (typeof input === "string") {
    return input;
  }
  return JSON.stringify(input ?? {});
}

function short(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function getFriendlyToolStatus(toolName: string, input: any, stepIndex: number): string {
  const verbs: Record<string, string> = {
    file_reader: "Reading",
    file_writer: "Writing",
    file_edit: "Editing",
    find_definition: "Locating",
    directory_lister: "Listing",
    shell_command: "Executing",
    grep_search: "Searching",
    fetch_url: "Fetching",
    git: "Git operations",
    delegate_task: "Delegating",
    code_runner: "Running code",
  };

  const verb = verbs[toolName] || "Running";
  let target = "";

  if (input && typeof input === "object") {
    const i = input as any;
    target = i.path || i.command || i.name || i.query || i.url || "";
  }

  const stepLabel = `Step ${stepIndex}`;
  return target ? `${stepLabel} : ${verb} (${target})` : `${stepLabel} : ${verb} ${toolName}`;
}
