export type AgentProfile = "small" | "balanced" | "ultra";

type DecisionPromptArgs = {
  task: string;
  profile: AgentProfile;
  toolList: string;
  scratchpad: string;
  fileSummaries: string;
};

type FinalPromptArgs = {
  task: string;
  includeLimitWarning: boolean;
};

export const SCHEMA_DEFINITION = [
  "{",
  '  "thought": "ANALYSIS: [what was learned] \\n REFLECT: [are we on track?] \\n GOAL: [detailed next micro-goal]",',
  '  "action": "tool" | "respond",',
  '  "tool": "name_of_tool" (required ONLY if action is "tool"),',
  '  "input": { ... } (required ONLY if action is "tool")',
  "}",
].join("\n");

export function buildDecisionPrompt(args: DecisionPromptArgs): string {
  const profileRules = [
    "You are running on a local model. Be extremely precise and detail-oriented.",
    "Always provide the 'thought' property with ANALYSIS, REFLECT, and GOAL.",
    "PRECISION EDITING: Prefer 'file_edit' with line ranges for modifying files.",
    "READ-THEN-EDIT: You MUST run 'file_reader' to get line numbers before calling 'file_edit'.",
    "FAIL-SAFE: 'file_writer' without 'searchString' will block destructive overwrites unless 'allowOverwrite' is true. Prefer 'file_edit'.",
    "Never hallucinate success. If you haven't called a tool to perform an action, you are NOT finished.",
  ];

  return [
    "You are a local coding agent.",
    ...profileRules,
    "Available tools:",
    args.toolList,
    "Recent steps:",
    args.scratchpad || "No previous steps.",
    "File summaries:",
    args.fileSummaries || "No file summaries.",
    `Task: ${args.task}`,
  ].join("\n");
}

export function buildFormattingSentinel(): string {
  return [
    "CRITICAL FORMATTING RULES:",
    "1. Output ONLY a single, valid JSON object.",
    "2. JSON must match this schema exactly:",
    "```json",
    SCHEMA_DEFINITION,
    "```",
    "3. Use ONLY available tools.",
    "4. If the task requires a change (create/update/delete), you MUST call a tool.",
    "5. Response must be a single block of JSON. No pre-post text.",
    "\nOutput the JSON object now:",
  ].join("\n");
}

export function buildPlannerPrompt(task: string): string {
  return [
    "You are a lead architect agent.",
    "Break down the following massive task into 5-10 atomic, sequential sub-tasks.",
    "CRITICAL: If the task contains ambiguous terms like 'folder_name', 'project folder', or 'the main files', your FIRST STEP must be to 'List files' or 'Find target folders' to resolve the ambiguity.",
    "Each sub-task must be a specific, ACTION-ORIENTED instruction a worker agent can execute.",
    "Use directive verbs: Create, Write, Update, Delete, List, Read.",
    "Avoid passive words like 'Plan', 'Discuss', 'Prepare'.",
    "Output ONLY a JSON array of sub-task strings.",
    'Example: ["List files to find source folder", "Read src/main.ts", "Create src/utils.ts"]',
    `Task: ${task}`,
  ].join("\n");
}

export function buildStepSummaryPrompt(task: string, scratchpad: string): string {
  return [
    "Summarize the outcome of the following task based on the execution history.",
    "Be concise and factual. Focus on what was actually accomplished.",
    `Task: ${task}`,
    "---",
    `History:\n${scratchpad}`,
  ].join("\n");
}

export function buildVerifySuccessPrompt(task: string, history: string): string {
  return [
    "You are a Quality Assurance critic.",
    "Analyze the execution history for the following sub-task and determine if the GOAL was ACHIEVED.",
    `Sub-task: ${task}`,
    "---",
    `History:\n${history}`,
    "---",
    "RULES:",
    "1. If the goal was met (e.g. file was written, directory was listed, information found), respond YES.",
    "2. If the goal was NOT met (e.g. file not found, error occurred, agent gave up), respond NO.",
    "3. Be extremely strict. If there is ambiguity, assume failure.",
    "4. Output ONLY 'YES' or 'NO'. No explanation.",
  ].join("\n");
}

export function buildDecisionRepairPrompt(error: string, raw: string): string {
  return [
    `The previous JSON response was invalid: ${error}`,
    "---",
    `Raw response: ${raw}`,
    "---",
    "Please re-output a single, valid JSON object matching the schema.",
  ].join("\n");
}

export function buildCritiquePrompt(
  args: { task: string; tool: string; input: string; thought: string },
): string {
  return [
    "You are a Senior Internal Auditor.",
    "Review the following proposed tool call for the task at hand.",
    `Task: ${args.task}`,
    `Internal Thought: ${args.thought}`,
    `Tool: ${args.tool}`,
    `Input: ${args.input}`,
    "---",
    "IDENTIFY POTENTIAL RISKS:",
    "1. Does the code include all necessary imports for new logic?",
    "2. Are file paths absolutely correct?",
    "3. Does the edit preserve existing exports and formatting?",
    "4. Is the regex/search string robust enough to match the actual file content?",
    "---",
    "RULES:",
    "- If the call is perfect, respond ONLY with 'SAFE'.",
    "- If you find issues, respond with 'ISSUE: [describe problem]'. Be specific.",
    "- Be extremely strict. Small models often omit imports or truncate files.",
  ].join("\n");
}

export function buildFinalSystemPrompt(args: FinalPromptArgs): string {
  const warning = args.includeLimitWarning
    ? "If incomplete, list what remains."
    : "Respond with a concise final answer.";
  return [
    "You are a terminal coding assistant.",
    warning,
    `Original task: ${args.task}`,
  ].join("\n");
}
