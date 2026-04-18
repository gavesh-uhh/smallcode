import type { AgentDecision, Message } from "../types.ts";
import type { OllamaClient } from "../llm/ollamaClient.ts";
import type { ToolRegistry } from "../../platform/tools/registry.ts";
import type { MemoryManager } from "../memory/memoryManager.ts";
import { AGENT_CONFIG } from "../config.ts";
import {
  type AgentProfile,
  buildCritiquePrompt,
  buildDecisionPrompt,
  buildDecisionRepairPrompt,
  buildFinalSystemPrompt,
  buildFormattingSentinel,
  buildPlannerPrompt,
  buildStepSummaryPrompt,
  buildVerifySuccessPrompt,
} from "./prompts.ts";
import {
  analyzeArtifactRequirements,
  artifactKey,
  type ArtifactRequirement,
  describeArtifact,
  describeMissingArtifactReason,
  hasArtifactEvidence,
} from "./artifacts.ts";

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

type TaskMode = "action" | "analysis";
type ExecutionStage = "classify" | "decide" | "execute" | "check" | "respond";

interface TaskPolicy {
  mode: TaskMode;
}

interface RunState {
  policy: TaskPolicy;
  stage: ExecutionStage;
  toolCallsCount: number;
  nonDelegateToolCalls: number;
  hasSuccessfulObservation: boolean;
  hasFailureObservation: boolean;
  lastObservation: string;
  previousSignature: string | null;
  repeatedIdenticalCount: number;
  requiredArtifacts: ArtifactRequirement[];
  satisfiedArtifacts: Set<string>;
}

type StepFlow = "continue" | "finish";

const PREFLIGHT_TOOLS = new Set(["file_writer", "file_edit"]);

export class AgentEngine {
  private settings: AgentOptions;

  constructor(
    private readonly llm: OllamaClient,
    private readonly tools: ToolRegistry,
    private readonly memory: MemoryManager,
    options: Partial<AgentOptions> = {},
  ) {
    this.settings = {
      maxIterations: options.maxIterations ?? AGENT_CONFIG.defaultMaxIterations,
      profile: options.profile ?? AGENT_CONFIG.defaultProfile,
      debug: options.debug ?? AGENT_CONFIG.defaultDebug,
      decisionTemperature: options.decisionTemperature ?? AGENT_CONFIG.decision.temperature,
      decisionCtx: options.decisionCtx ??
        AGENT_CONFIG.decision.ctxByProfile[
          options.profile ?? AGENT_CONFIG.defaultProfile
        ],
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
    const state = this.createRunState(task);
    this.seedTaskFacts(task, state.policy.mode);

    callbacks.onStatus(
      `Task received. Iteration limit: ${this.settings.maxIterations}. Profile: ${this.settings.profile}. Mode: ${state.policy.mode}`,
    );

    for (let i = 1; i <= this.settings.maxIterations; i++) {
      this.memory.nextTurn();
      const flow = await this.runSingleStep(
        task,
        i,
        state,
        callbacks,
        contextSummaries,
      );
      if (flow === "finish") {
        return;
      }
    }

    callbacks.onStatus("Iteration limit reached.");
    await this.streamFinal(task, callbacks, true);
  }

  async generatePlan(task: string): Promise<string[]> {
    const prompt = buildPlannerPrompt(task);
    const raw = await this.llm.chat([{ role: "user", content: prompt }], {
      temperature: AGENT_CONFIG.planning.temperature,
      format: "json",
    });

    try {
      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed)) {
          return parsed.map(String);
        }
      }
      return raw
        .split("\n")
        .filter((l) => l.trim().length > 5)
        .map((l) => l.replace(/^\d+\.\s*/, "").trim());
    } catch {
      return [task];
    }
  }

  async summarizeStep(task: string): Promise<string> {
    const scratchpad = this.memory.getScratchpadText(10);
    const prompt = buildStepSummaryPrompt(task, scratchpad);
    const summary = await this.llm.chat([{ role: "user", content: prompt }], {
      temperature: AGENT_CONFIG.summarize.temperature,
    });
    return summary.trim();
  }

  async verifyStepSuccess(task: string): Promise<boolean> {
    const history = this.memory.getScratchpadText(15);
    const prompt = buildVerifySuccessPrompt(task, history);
    const result = await this.llm.chat([{ role: "user", content: prompt }], {
      temperature: AGENT_CONFIG.verify.temperature,
      numCtx: AGENT_CONFIG.verify.numCtx,
    });
    return result.trim().toUpperCase() === "YES";
  }

  private createRunState(task: string): RunState {
    const artifactRequirements = analyzeArtifactRequirements(task);
    return {
      policy: classifyTaskPolicy(task),
      stage: "classify",
      toolCallsCount: 0,
      nonDelegateToolCalls: 0,
      hasSuccessfulObservation: false,
      hasFailureObservation: false,
      lastObservation: "",
      previousSignature: null,
      repeatedIdenticalCount: 0,
      requiredArtifacts: artifactRequirements,
      satisfiedArtifacts: new Set<string>(),
    };
  }

  private async runSingleStep(
    task: string,
    iteration: number,
    state: RunState,
    callbacks: AgentCallbacks,
    contextSummaries: string[],
  ): Promise<StepFlow> {
    state.stage = "decide";
    callbacks.onStatus(`Planning step ${iteration}`);
    const decision = await this.getDecision(
      task,
      callbacks,
      contextSummaries,
      state.stage,
    );

    if (!decision) {
      callbacks.onStatus(
        "Could not parse decision. Asking model for direct response.",
      );
      await this.streamFinal(task, callbacks, true);
      return "finish";
    }

    if (decision.action === "respond") {
      return await this.handleRespondDecision(task, state, callbacks);
    }

    return await this.handleToolDecision(
      task,
      iteration,
      state,
      callbacks,
      decision,
    );
  }

  private async handleRespondDecision(
    task: string,
    state: RunState,
    callbacks: AgentCallbacks,
  ): Promise<StepFlow> {
    state.stage = "check";
    const readiness = this.assessResponseReadiness(state);
    if (!readiness.ready) {
      callbacks.onStatus(`Response blocked: ${readiness.reason}`);
      this.memory.addMessage({
        role: "system",
        content: `${readiness.reason}\nTake one corrective step.`,
      });
      return "continue";
    }

    state.stage = "respond";
    callbacks.onStatus("Finalizing response.");
    await this.streamFinal(task, callbacks, false);
    return "finish";
  }

  private async handleToolDecision(
    task: string,
    iteration: number,
    state: RunState,
    callbacks: AgentCallbacks,
    decision: AgentDecision,
  ): Promise<StepFlow> {
    const toolName = decision.tool?.trim();
    if (!toolName) {
      callbacks.onStatus(
        "Model returned tool action without tool name. Stopping.",
      );
      await this.streamFinal(task, callbacks, true);
      return "finish";
    }

    const tool = this.tools.get(toolName);
    if (!tool) {
      const observation = `Unknown tool: ${toolName}`;
      this.addToolObservation(iteration, toolName, decision.input, observation);
      callbacks.onStatus(observation);
      return "continue";
    }

    const policyRejection = this.getToolRejection(
      task,
      iteration,
      state,
      toolName,
      decision.input,
    );
    if (policyRejection) {
      callbacks.onStatus(policyRejection.statusLine);
      this.memory.addMessage({
        role: "system",
        content: policyRejection.memoryMessage,
      });
      return "continue";
    }

    if (PREFLIGHT_TOOLS.has(toolName)) {
      const critique = await this.critiqueProposal(
        task,
        toolName,
        stringifyInput(decision.input),
        decision.reason || decision.thought || "",
        callbacks,
      );
      if (critique !== "SAFE") {
        callbacks.onStatus(`Preflight: ${critique}`);
        this.memory.addMessage({
          role: "system",
          content:
            `Preflight rejected this action: ${critique}\nPlease fix the issue and propose a corrected tool call.`,
        });
        return "continue";
      }
    }

    state.stage = "execute";
    const toolInput = stringifyInput(decision.input);
    const toolStep = state.toolCallsCount + 1;
    callbacks.onStatus(
      getFriendlyToolStatus(toolName, decision.input, toolStep),
    );

    state.toolCallsCount += 1;
    if (toolName !== "delegate_task") {
      state.nonDelegateToolCalls += 1;
    }

    const observation = await executeTool(tool, toolInput);
    this.addToolObservation(toolStep, toolName, decision.input, observation);
    callbacks.onStatus(`Observation: ${short(observation, 280)}`);

    this.updateStateFromObservation(
      state,
      toolName,
      decision.input,
      observation,
    );
    await this.injectRecoveryHintIfNeeded(observation);

    if (this.detectToolLoop(state, toolName, toolInput, observation)) {
      callbacks.onStatus(
        "Detected repeated identical tool result. Finalizing with best effort.",
      );
      await this.streamFinal(task, callbacks, true);
      return "finish";
    }

    return "continue";
  }

  private getToolRejection(
    task: string,
    iteration: number,
    state: RunState,
    toolName: string,
    input: unknown,
  ): { statusLine: string; memoryMessage: string } | null {
    const toolPolicyIssue = validateToolDecision(toolName, input);
    if (toolPolicyIssue) {
      return {
        statusLine: `Tool policy rejected call: ${toolPolicyIssue}`,
        memoryMessage:
          `Tool policy rejection for ${toolName}: ${toolPolicyIssue}. Propose a corrected tool call.`,
      };
    }

    if (toolName === "delegate_task") {
      const delegation = assessDelegationReadiness(
        task,
        iteration,
        state.nonDelegateToolCalls,
      );
      if (!delegation.allowed) {
        return {
          statusLine: `Delegation blocked: ${delegation.reason}`,
          memoryMessage: `${delegation.reason}\nUse local tools or respond directly instead.`,
        };
      }
    }

    return null;
  }

  private detectToolLoop(
    state: RunState,
    toolName: string,
    toolInput: string,
    observation: string,
  ): boolean {
    const signature = `${toolName}|${toolInput}|${short(observation, 220)}`;
    state.repeatedIdenticalCount = signature === state.previousSignature
      ? state.repeatedIdenticalCount + 1
      : 0;
    state.previousSignature = signature;
    return state.repeatedIdenticalCount >= 1;
  }

  private updateStateFromObservation(
    state: RunState,
    toolName: string,
    input: unknown,
    observation: string,
  ): void {
    state.lastObservation = observation;
    const success = looksSuccessfulObservation(observation);
    state.hasSuccessfulObservation = state.hasSuccessfulObservation || success;
    state.hasFailureObservation = state.hasFailureObservation ||
      looksFailureObservation(observation);
    if (state.requiredArtifacts.length > 0 && success) {
      for (const requirement of state.requiredArtifacts) {
        const key = artifactKey(requirement);
        if (state.satisfiedArtifacts.has(key)) continue;
        if (hasArtifactEvidence(toolName, input, observation, requirement)) {
          state.satisfiedArtifacts.add(key);
        }
      }
    }
  }

  private addToolObservation(
    step: number,
    toolName: string,
    input: unknown,
    observation: string,
  ): void {
    this.memory.addMessage({
      role: "tool",
      name: toolName,
      content: observation,
    });
    this.memory.addScratchpadStep({
      step,
      action: toolName,
      input: stringifyInput(input),
      observation,
    });
  }

  private async injectRecoveryHintIfNeeded(observation: string): Promise<void> {
    if (!isRecoveryNeeded(observation)) {
      return;
    }

    const lister = this.tools.get("directory_lister");
    let contextLS = "";
    if (lister) {
      try {
        contextLS = await lister.execute(
          JSON.stringify({ path: ".", depth: 1 }),
        );
      } catch {
        contextLS = "";
      }
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

  private seedTaskFacts(task: string, mode: TaskMode): void {
    this.memory.setFact("task_mode", mode, "classifier", 0.95, 24);
    this.memory.setFact("os", Deno.build.os, "runtime", 1.0, 64);
    this.memory.setFact("model_target", "<15b-optimized", "harness", 1.0, 64);
    const artifacts = analyzeArtifactRequirements(task);
    for (let i = 0; i < artifacts.length; i++) {
      this.memory.setFact(
        `required_artifact_${i + 1}`,
        describeArtifact(artifacts[i]),
        "task",
        0.95,
        32,
      );
    }

    const clauses = task
      .split(/[.!?\n]/)
      .map((line) => line.trim())
      .filter((line) => /(must|only|without|do not|don't|never|avoid)/i.test(line))
      .slice(0, 4);

    clauses.forEach((clause, idx) => {
      this.memory.setFact(`constraint_${idx + 1}`, clause, "task", 0.9, 18);
    });
  }

  private assessResponseReadiness(state: RunState): {
    ready: boolean;
    reason: string;
  } {
    if (state.policy.mode === "action" && state.toolCallsCount === 0) {
      return {
        ready: false,
        reason:
          "Action task requires tool evidence before responding. Call an appropriate tool first.",
      };
    }

    if (state.hasFailureObservation && !state.hasSuccessfulObservation) {
      return {
        ready: false,
        reason:
          "Recent execution has failures but no confirmed success signal. Recover with another tool step.",
      };
    }

    if (looksFailureObservation(state.lastObservation)) {
      return {
        ready: false,
        reason:
          "Last observation indicates failure. Resolve it or provide a tool-backed explanation.",
      };
    }

    const missing = state.requiredArtifacts.find(
      (r) => !state.satisfiedArtifacts.has(artifactKey(r)),
    );
    if (missing) {
      return {
        ready: false,
        reason: describeMissingArtifactReason(missing),
      };
    }

    return { ready: true, reason: "ok" };
  }

  private async getDecision(
    task: string,
    callbacks: AgentCallbacks,
    contextSummaries: string[] = [],
    stage: ExecutionStage = "decide",
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
      facts: this.memory.getFactsText(8),
      osHint: Deno.build.os,
      stage,
    });

    const messages: Message[] = [
      { role: "system", content: systemPrompt },
      ...(summaryText ? [{ role: "system" as const, content: summaryText }] : []),
      ...this.memory.getMessages(),
      { role: "system", content: buildFormattingSentinel() },
    ];

    let lastRaw = "";
    try {
      lastRaw = await this.llm.chat(messages, {
        temperature: this.settings.decisionTemperature,
        numCtx: this.settings.decisionCtx,
        format: "json",
      });
      const strict = parseDecision(lastRaw);
      if (strict.success) {
        return strict.decision;
      }
    } catch (err) {
      if (this.settings.debug) {
        callbacks.onStatus(`Strict JSON failed: ${err}`);
      }
    }

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
      callbacks.onStatus(
        `Decision raw: ${short(fuzzyRaw.replace(/\s+/g, " "), 220)}`,
      );
    }

    const fuzzy = parseDecision(fuzzyRaw);
    if (fuzzy.success) {
      return fuzzy.decision;
    }

    callbacks.onStatus(
      `Decision parse failed (${fuzzy.error}); retrying with repair.`,
    );
    const repairRaw = await this.llm.chat(
      [
        {
          role: "system",
          content: buildDecisionRepairPrompt(fuzzy.error, lastRaw),
        },
        { role: "user", content: `Task: ${task}` },
      ],
      {
        temperature: AGENT_CONFIG.decision.repairTemperature,
        numCtx: AGENT_CONFIG.decision.repairNumCtx,
        format: "json",
      },
    );

    const repaired = parseDecision(repairRaw);
    return repaired.success ? repaired.decision : null;
  }

  private async critiqueProposal(
    task: string,
    tool: string,
    input: string,
    thought: string,
    callbacks: AgentCallbacks,
  ): Promise<string> {
    callbacks.onStatus("Preflight...");

    try {
      const response = await this.llm.chat(
        [
          {
            role: "system",
            content: buildCritiquePrompt({ task, tool, input, thought }),
          },
        ],
        {
          temperature: AGENT_CONFIG.preflight.temperature,
          numCtx: AGENT_CONFIG.preflight.numCtx,
        },
      );
      const verdict = response.trim();
      if (verdict === "SAFE") {
        return "SAFE";
      }
      if (verdict.startsWith("ISSUE:")) {
        return verdict;
      }
      return `ISSUE: Invalid Preflight verdict (${short(verdict, 120)}).`;
    } catch (err) {
      if (this.settings.debug) {
        callbacks.onStatus(`Critique failed: ${err}`);
      }
      return "ISSUE: Preflight unavailable; cannot safely proceed with code write.";
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
        temperature: AGENT_CONFIG.final.temperature,
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

    this.memory.addMessage({
      role: "assistant",
      content: fullContent,
      reasoning: fullReasoning,
    });
    callbacks.onAssistantDone(fullContent);
  }
}

type ParseResult =
  | { success: true; decision: AgentDecision }
  | { success: false; error: string };

function parseDecision(raw: string): ParseResult {
  const trimmed = raw.trim();

  const direct = tryParseJson(trimmed);
  if (direct) {
    const normalized = normalizeDecision(direct);
    if (normalized) {
      return { success: true, decision: normalized };
    }
    return {
      success: false,
      error: "JSON is valid but missing required fields: 'action' (must be 'tool' or 'respond').",
    };
  }

  const blocks = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  for (const block of blocks.reverse()) {
    const parsed = tryParseJson(block[1].trim());
    if (!parsed) continue;
    const normalized = normalizeDecision(parsed);
    if (normalized) {
      return { success: true, decision: normalized };
    }
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const parsed = tryParseJson(trimmed.slice(start, end + 1));
    if (parsed) {
      const normalized = normalizeDecision(parsed);
      if (normalized) {
        return { success: true, decision: normalized };
      }
    }
  }

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
    let cleaned = value.trim();
    cleaned = cleaned.replace(/,\s*([\}\]])/g, "$1");
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeDecision(raw: Record<string, unknown>): AgentDecision | null {
  const actionRaw = typeof raw.action === "string" ? raw.action.toLowerCase() : "";
  if (actionRaw !== "tool" && actionRaw !== "respond") {
    if (raw.tool || raw.input) {
      return normalizeDecision({ ...raw, action: "tool" });
    }
    return null;
  }

  return {
    reason: typeof raw.reason === "string" ? raw.reason : undefined,
    thought: typeof raw.thought === "string" ? raw.thought : undefined,
    action: actionRaw as "tool" | "respond",
    tool: typeof raw.tool === "string" ? raw.tool : undefined,
    input: raw.input,
    expected_observation: typeof raw.expected_observation === "string"
      ? raw.expected_observation
      : undefined,
  };
}

async function executeTool(
  tool: { execute(input: string): Promise<string> },
  input: string,
): Promise<string> {
  try {
    return await tool.execute(input);
  } catch (error) {
    return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function stringifyInput(input: unknown): string {
  return typeof input === "string" ? input : JSON.stringify(input ?? {});
}

function short(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function getFriendlyToolStatus(
  toolName: string,
  input: unknown,
  stepIndex: number,
): string {
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

  const target = extractToolTarget(input);
  const label = `Step ${stepIndex}`;
  const verb = verbs[toolName] ?? "Running";
  return target ? `${label} : ${verb} (${target})` : `${label} : ${verb} ${toolName}`;
}

function extractToolTarget(input: unknown): string {
  if (!input || typeof input !== "object") {
    return "";
  }
  const payload = input as Record<string, unknown>;
  const candidate = payload.path ??
    payload.command ??
    payload.name ??
    payload.query ??
    payload.url;
  return typeof candidate === "string" ? candidate : "";
}

function classifyTaskPolicy(task: string): TaskPolicy {
  const lower = task.toLowerCase();
  if (isExplicitAgentDirective(lower)) {
    return { mode: "action" };
  }
  if (/^\s*(hi|hello|hey|yo|hola)\b/.test(lower)) {
    return { mode: "analysis" };
  }
  if (
    /\b(create|write|update|delete|edit|rename|remove|run|execute|fix|implement|refactor|add|change)\b/
      .test(
        lower,
      )
  ) {
    return { mode: "action" };
  }
  if (
    /\b(plan|strategy|analyze|explain|design|compare|review|document)\b/.test(
      lower,
    )
  ) {
    return { mode: "analysis" };
  }
  return { mode: "analysis" };
}

function looksSuccessfulObservation(observation: string): boolean {
  const lower = observation.toLowerCase();
  return (
    lower.includes("result: success") ||
    lower.includes("exit_code: 0") ||
    lower.includes("completed") ||
    lower.includes("finished")
  );
}

function looksFailureObservation(observation: string): boolean {
  const lower = observation.toLowerCase();
  const hasNonZeroExit = /exit_code:\s*(-?\d+)/i.test(lower) && !/exit_code:\s*0\b/i.test(lower);
  return (
    lower.includes("result: failed") ||
    lower.includes("result: timeout") ||
    lower.includes("tool error:") ||
    lower.includes("not found") ||
    lower.includes("exit_code: -1") ||
    hasNonZeroExit
  );
}

function isRecoveryNeeded(observation: string): boolean {
  const lower = observation.toLowerCase();
  return lower.includes("error") || lower.includes("not found");
}

function validateToolDecision(toolName: string, input: unknown): string | null {
  const payload = input && typeof input === "object" ? (input as Record<string, unknown>) : {};

  if (toolName === "shell_command") {
    const command = typeof payload.command === "string" ? payload.command.trim() : "";
    if (!command) {
      return "shell_command requires a non-empty 'command' string.";
    }
    const dangerous = /(rm\s+-rf\s+\/|del\s+\/s\s+\/q\s+c:\\|format\s+[a-z]:|shutdown|reboot)/i;
    if (dangerous.test(command)) {
      return "shell_command contains a destructive command pattern.";
    }
    const shellWritePattern =
      /(>\s*[^>\n]+|>>\s*[^>\n]+|\becho\s+.+\s*>\s*\S+|\bset-content\b|\badd-content\b|\bout-file\b|\btee\b)/i;
    if (shellWritePattern.test(command)) {
      return "Use file_writer/file_edit for file content changes instead of shell redirection.";
    }
  }

  if (toolName === "file_reader") {
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!path) {
      return "file_reader requires a 'path'.";
    }
  }

  if (toolName === "file_writer") {
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!path) {
      return "file_writer requires a 'path'.";
    }
    if (typeof payload.content !== "string") {
      return "file_writer requires string 'content'.";
    }
  }

  if (toolName === "file_edit") {
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    const find = typeof payload.find === "string" ? payload.find : "";
    if (!path) {
      return "file_edit requires a 'path'.";
    }
    if (!find) {
      return "file_edit requires non-empty 'find'.";
    }
    if (typeof payload.replace !== "string") {
      return "file_edit requires string 'replace'.";
    }
  }

  if (toolName === "code_runner") {
    const path = typeof payload.path === "string" ? payload.path.trim() : "";
    if (!path) {
      return "code_runner requires a 'path'.";
    }
    if (!/\.(ts|js)$/i.test(path)) {
      return "code_runner path must end with .ts or .js.";
    }
  }

  if (toolName === "delegate_task") {
    const task = typeof payload.task === "string" ? payload.task.trim() : "";
    if (task.length < 6) {
      return "delegate_task requires a specific 'task' description.";
    }
  }

  return null;
}

function assessDelegationReadiness(
  task: string,
  iteration: number,
  nonDelegateToolCalls: number,
): { allowed: boolean; reason: string } {
  const lower = task.toLowerCase();
  const explicitDelegation = isExplicitAgentDirective(lower) ||
    /\b(delegate|sub-?agent|worker|spawn)\b/.test(lower);
  if (explicitDelegation) {
    return { allowed: true, reason: "explicit delegation request" };
  }

  const simplePrompt = /^\s*(hi|hello|hey|yo|hola)\b/.test(lower) ||
    lower.split(/\s+/).filter(Boolean).length <= 8;
  if (simplePrompt) {
    return { allowed: false, reason: "Task appears simple; do not delegate." };
  }

  const complexPrompt =
    /\b(complex|massive|large|multi-?step|across|multiple files|end-to-end)\b/.test(
      lower,
    ) || lower.length >= 160;
  if (!complexPrompt) {
    return {
      allowed: false,
      reason: "Delegation is reserved for clearly complex tasks.",
    };
  }

  if (iteration < 3 || nonDelegateToolCalls < 1) {
    return {
      allowed: false,
      reason: "Try at least one local tool step before delegating.",
    };
  }

  return { allowed: true, reason: "complex task with local-attempt evidence" };
}

function isExplicitAgentDirective(lowerTask: string): boolean {
  return (
    /\b(open|create|start|spawn|launch)\s+(a\s+)?(new\s+)?(sub-?)?agent\b/.test(
      lowerTask,
    ) || /\bnew\s+agent\b/.test(lowerTask)
  );
}
