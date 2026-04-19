export type AgentProfile = "small" | "balanced" | "ultra";

type DecisionPromptArgs = {
  task: string;
  profile: AgentProfile;
  toolList: string;
  scratchpad: string;
  fileSummaries: string;
  facts: string;
  osHint: string;
  stage: string;
};

type FinalPromptArgs = {
  task: string;
  includeLimitWarning: boolean;
  mode: "action" | "analysis";
};

export const SCHEMA_DEFINITION = [
  "{",
  '  "reason": "One short sentence about why this is the best next move.",',
  '  "action": "tool" | "respond",',
  '  "tool": "name_of_tool" (required ONLY if action is "tool"),',
  '  "input": { ... } (required ONLY if action is "tool"),',
  '  "expected_observation": "Short success signal for the chosen move"',
  "}",
].join("\n");

export function buildDecisionPrompt(args: DecisionPromptArgs): string {
  const profileRules = [
    "You are optimized for low-parameter local models (<15B). Keep decisions compact and deterministic.",
    "Never claim completion unless evidence exists in tool observations.",
    "Use exactly one next action per step.",
    "Use platform-aware shell commands. OS hint is provided below.",
    "For creating/updating file contents, prefer file_writer/file_edit over shell_command.",
    "Do not use shell redirection (>, >>, Out-File, Set-Content) to write code files.",
    "If task requires file/system changes, call a tool first; do not respond early.",
    "If updating an existing file, read it first unless a trusted CONTENT_PREVIEW already provides exact current text.",
    "Keep tool input minimal and explicit; include exact path when known.",
    "Do not rewrite the whole file when a targeted edit is enough.",
    "After any write/edit, verify by reading the file before concluding.",
  ];

  return [
    "You are a local coding agent with tool-based execution.",
    ...profileRules,
    `Execution stage: ${args.stage}`,
    `Profile: ${args.profile}`,
    `OS: ${args.osHint}`,
    "Available tools:",
    args.toolList,
    "Structured facts:",
    args.facts || "No structured facts.",
    "Recent steps:",
    args.scratchpad || "No previous steps.",
    "Decision policy by stage:",
    "- decide: choose the single highest-value next tool action.",
    "- execute: prioritize actions that produce verifiable evidence (RESULT, EXIT_CODE, CONTENT_PREVIEW).",
    "- check: if evidence is missing or failing, take one corrective tool step, not a final response.",
    "- respond: only when observations prove the task is complete.",
    "Tool-choice rubric:",
    "1) file_reader/file_writer/file_edit for file content changes.",
    "2) shell_command for listing/searching/running commands, not for code-file writes.",
    "3) code_runner only when execution evidence is explicitly needed.",
    "File summaries:",
    args.fileSummaries || "No file summaries.",
    `Task: ${args.task}`,
    "Output requirements:",
    "- Return JSON only.",
    "- reason must be one short concrete sentence.",
    "- expected_observation should be measurable (e.g., includes RESULT: SUCCESS and target path).",
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
    "6. If action='tool', include both tool and input.",
    "7. If action='respond', do NOT include tool or input fields.",
    "8. Do not wrap JSON in markdown fences.",
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
    "Include verification-oriented steps near the end (Read back changed files, run checks if relevant).",
    "Avoid passive words like 'Plan', 'Discuss', 'Prepare'.",
    "Output ONLY a JSON array of sub-task strings.",
    'Example: ["List files to find source folder", "Read src/main.ts", "Create src/utils.ts"]',
    `Task: ${task}`,
  ].join("\n");
}

export function buildStepSummaryPrompt(
  task: string,
  scratchpad: string,
): string {
  return [
    "Summarize the outcome of the following task based on the execution history.",
    "Be concise and factual. Focus on what was actually accomplished.",
    "Name concrete artifacts when possible (file paths, commands, key outputs).",
    `Task: ${task}`,
    "---",
    `History:\n${scratchpad}`,
  ].join("\n");
}

export function buildVerifySuccessPrompt(
  task: string,
  history: string,
): string {
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
    "4. Prefer direct evidence such as RESULT: SUCCESS, EXIT_CODE: 0, and CONTENT_PREVIEW matching the task intent.",
    "5. A generic assistant explanation without tool evidence is NOT success.",
    "6. Output ONLY 'YES' or 'NO'. No explanation.",
  ].join("\n");
}

export function buildDecisionRepairPrompt(error: string, raw: string): string {
  return [
    `The previous JSON response was invalid: ${error}`,
    "---",
    `Raw response: ${raw}`,
    "---",
    "Re-output a single valid JSON object matching this schema exactly:",
    SCHEMA_DEFINITION,
    "Do not include markdown or extra text.",
  ].join("\n");
}

export function buildCritiquePrompt(args: {
  task: string;
  tool: string;
  input: string;
  thought: string;
}): string {
  return [
    "You are a Senior Internal Auditor.",
    "Review the proposed tool call and only block high-confidence correctness or safety failures.",
    `Task: ${args.task}`,
    `Internal Thought: ${args.thought}`,
    `Tool: ${args.tool}`,
    `Input: ${args.input}`,
    "---",
    "BLOCK ONLY FOR:",
    "1. Destructive or dangerous action.",
    "2. Clearly invalid/malformed input payload for this tool.",
    "3. Guaranteed wrong target path based on provided evidence.",
    "4. For file_writer/file_edit: content or edit intent clearly contradicts the task request.",
    "---",
    "RULES:",
    "- If uncertain, respond 'SAFE'.",
    "- If a block is necessary, respond with 'ISSUE: [one specific reason]'.",
    "- Do not speculate about missing imports or hypothetical future code issues.",
    "- Keep verdict short and deterministic.",
  ].join("\n");
}

export function buildFinalSystemPrompt(args: FinalPromptArgs): string {
  const warning = args.includeLimitWarning
    ? "If incomplete, list what remains."
    : "Respond with a concise final answer.";
  const evidencePolicy = args.mode === "action"
    ? [
      "Only state outcomes supported by tool observations in context.",
      "If evidence is partial, say what is confirmed and what is not.",
      "If a tool observation includes CONTENT_PREVIEW, treat it as canonical and do not invent a different snippet.",
      "When user asks for code that was written, quote or summarize the canonical CONTENT_PREVIEW instead of generating a new variant.",
    ]
    : [
      "For general questions, answer using standard model knowledge without requiring tool observations.",
      "If tools were used, prefer those observations when they directly apply.",
      "Do not claim you executed tools when you did not.",
    ];
  return [
    "You are a terminal coding assistant.",
    ...evidencePolicy,
    warning,
    `Original task: ${args.task}`,
  ].join("\n");
}
