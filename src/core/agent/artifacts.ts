export type ArtifactRequirement =
  | { kind: "file_write"; targetPath: string | null }
  | { kind: "directory_create"; targetPath: string | null }
  | { kind: "git_commit"; messageHint: string | null };

export function analyzeArtifactRequirements(
  task: string,
): ArtifactRequirement[] {
  const lower = task.toLowerCase();
  const requirements: ArtifactRequirement[] = [];

  const maybePath = extractPotentialPath(task);

  const wantsWrite =
    /\b(write|save|create|generate|export|output)\b/.test(lower) &&
    /\b(file|into|to)\b/.test(lower);
  if (wantsWrite) {
    requirements.push({ kind: "file_write", targetPath: maybePath });
  }

  const wantsDirectory =
    /\b(create|make|mkdir)\b/.test(lower) &&
    /\b(folder|directory|dir)\b/.test(lower);
  if (wantsDirectory) {
    requirements.push({ kind: "directory_create", targetPath: maybePath });
  }

  const wantsCommit =
    /\bcommit\b/.test(lower) && /\bgit\b|\bchanges\b|\bmessage\b/.test(lower);
  if (wantsCommit) {
    requirements.push({
      kind: "git_commit",
      messageHint: extractCommitMessageHint(task),
    });
  }

  return requirements;
}

export function hasArtifactEvidence(
  toolName: string,
  input: unknown,
  observation: string,
  requirement: ArtifactRequirement,
): boolean {
  if (requirement.kind === "file_write") {
    return hasFileWriteEvidence(
      toolName,
      input,
      observation,
      requirement.targetPath,
    );
  }
  if (requirement.kind === "directory_create") {
    return hasDirectoryCreateEvidence(
      toolName,
      input,
      observation,
      requirement.targetPath,
    );
  }
  if (requirement.kind === "git_commit") {
    return hasGitCommitEvidence(
      toolName,
      input,
      observation,
      requirement.messageHint,
    );
  }
  return false;
}

export function describeMissingArtifactReason(
  requirement: ArtifactRequirement,
): string {
  if (requirement.kind === "file_write") {
    return requirement.targetPath
      ? `Task requires writing ${requirement.targetPath}. No write evidence found yet.`
      : "Task requires writing an output file. No write evidence found yet.";
  }
  if (requirement.kind === "directory_create") {
    return requirement.targetPath
      ? `Task requires creating directory ${requirement.targetPath}. No creation evidence found yet.`
      : "Task requires creating a directory. No creation evidence found yet.";
  }
  if (requirement.kind === "git_commit") {
    return "Task requires a git commit. No commit evidence found yet.";
  }
  return "Required artifact evidence is missing.";
}

export function describeArtifact(requirement: ArtifactRequirement): string {
  if (requirement.kind === "file_write") {
    return requirement.targetPath
      ? `file_write:${requirement.targetPath}`
      : "file_write";
  }
  if (requirement.kind === "directory_create") {
    return requirement.targetPath
      ? `directory_create:${requirement.targetPath}`
      : "directory_create";
  }
  return requirement.messageHint
    ? `git_commit:${requirement.messageHint}`
    : "git_commit";
}

export function artifactKey(requirement: ArtifactRequirement): string {
  return describeArtifact(requirement).toLowerCase();
}

function hasFileWriteEvidence(
  toolName: string,
  input: unknown,
  observation: string,
  requiredOutputFile: string | null,
): boolean {
  if (!looksSuccessfulObservation(observation)) return false;

  const required = requiredOutputFile?.toLowerCase();
  if (toolName === "file_writer" || toolName === "file_edit") {
    if (!required) return true;
    const path = extractObjectStringField(input, "path")?.toLowerCase() ?? "";
    return path.includes(required);
  }
  if (toolName === "shell_command") {
    const command =
      extractObjectStringField(input, "command")?.toLowerCase() ?? "";
    if (!command) return false;
    const writeVerb =
      />|out-file|set-content|add-content|tee|new-item|copy-item|move-item/.test(
        command,
      );
    if (!writeVerb) return false;
    if (!required) return true;
    return command.includes(required);
  }
  return false;
}

function hasDirectoryCreateEvidence(
  toolName: string,
  input: unknown,
  observation: string,
  targetPath: string | null,
): boolean {
  if (!looksSuccessfulObservation(observation)) return false;
  const required = targetPath?.toLowerCase();

  if (toolName === "shell_command") {
    const command =
      extractObjectStringField(input, "command")?.toLowerCase() ?? "";
    if (!command) return false;
    const createsDir = /\bmkdir\b|\bnew-item\b.*\bdirectory\b/.test(command);
    if (!createsDir) return false;
    if (!required) return true;
    return command.includes(required);
  }

  return false;
}

function hasGitCommitEvidence(
  toolName: string,
  input: unknown,
  observation: string,
  messageHint: string | null,
): boolean {
  if (!looksSuccessfulObservation(observation)) return false;
  const hint = messageHint?.toLowerCase();

  if (toolName === "git") {
    const action =
      extractObjectStringField(input, "action")?.toLowerCase() ?? "";
    if (action !== "commit") return false;
    if (!hint) return true;
    const args = extractObjectArrayStringField(input, "args")
      .join(" ")
      .toLowerCase();
    return args.includes(hint) || observation.toLowerCase().includes(hint);
  }

  if (toolName === "shell_command") {
    const command =
      extractObjectStringField(input, "command")?.toLowerCase() ?? "";
    if (!/\bgit\s+commit\b/.test(command)) return false;
    if (!hint) return true;
    return command.includes(hint) || observation.toLowerCase().includes(hint);
  }

  return false;
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

function extractObjectStringField(input: unknown, key: string): string | null {
  if (!input || typeof input !== "object") return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

function extractObjectArrayStringField(input: unknown, key: string): string[] {
  if (!input || typeof input !== "object") return [];
  const value = (input as Record<string, unknown>)[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function extractPotentialPath(task: string): string | null {
  const quoted = task.match(/["']([^"']+\.[a-z0-9]+)["']/i)?.[1];
  const named = task.match(
    /\b(?:named|called|to|into)\s+([a-z0-9._\\/-]+\.[a-z0-9]+)\b/i,
  )?.[1];
  const firstPath = task.match(/\b([a-z0-9._\\/-]+\.[a-z0-9]+)\b/i)?.[1];
  const dirQuoted = task.match(/["']([^"']+[\\\/][^"']+)["']/)?.[1];
  const dirNamed = task.match(
    /\b(?:named|called|to|into)\s+([a-z0-9._\\/-]+)\b/i,
  )?.[1];
  return quoted ?? named ?? firstPath ?? dirQuoted ?? dirNamed ?? null;
}

function extractCommitMessageHint(task: string): string | null {
  const quoted = task.match(/commit message\s*[:=]?\s*["']([^"']+)["']/i)?.[1];
  if (quoted) return quoted;
  const inline = task.match(/\bmessage\s+["']([^"']+)["']/i)?.[1];
  return inline ?? null;
}
