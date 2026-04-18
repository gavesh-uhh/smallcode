import { dirname, isAbsolute, join, normalize, resolve } from "jsr:@std/path";
import type { Tool } from "../types.ts";
import { createSimpleDiff } from "../utils/diff.ts";

interface ToolContext {
  rootDir: string;
  confirmWrite: (question: string, diff: string) => Promise<boolean>;
  delegateTask: (task: string) => Promise<string>;
}

function safePath(rootDir: string, targetPath: string): string {
  const abs = isAbsolute(targetPath) ? normalize(targetPath) : resolve(rootDir, targetPath);
  const root = normalize(rootDir);
  if (!abs.startsWith(root)) {
    throw new Error(`Path outside workspace is not allowed: ${targetPath}`);
  }
  return abs;
}

function shellParts(command: string): { cmd: string; args: string[] } {
  if (Deno.build.os === "windows") {
    return { cmd: "cmd", args: ["/d", "/s", "/c", command] };
  }
  return { cmd: "sh", args: ["-lc", command] };
}

function truncateOutput(output: string, maxChars = 5000): string {
  return output.length > maxChars ? output.slice(0, maxChars) + "\n...[output truncated]" : output;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function contentPreview(content: string, maxChars = 900): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}\n...[preview truncated]`
    : normalized;
}

export class ShellCommandTool implements Tool {
  readonly name = "shell_command";
  readonly description =
    "Execute shell commands for listing, searching, and running programs. Platform-aware.";
  readonly parameters = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Shell command. Unix: 'cat file', 'ls -la dir', 'grep -r pattern'. Windows: 'type file', 'Get-ChildItem', 'findstr /r pattern'",
      },
      cwd: {
        type: "string",
        description: "Working directory. Default: '.'",
      },
      timeout_ms: {
        type: "integer",
        description: "Timeout in ms. Default: 30000, Max: 300000",
      },
    },
    required: ["command"],
  };

  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const command = requireString(payload.command, "command");
    const cwd = safePath(
      this.context.rootDir,
      payload.cwd === undefined ? "." : String(payload.cwd),
    );

    const timeoutMs = Math.max(1000, Math.min(Number(payload.timeout_ms ?? 30000), 300000));

    const { cmd, args } = shellParts(command);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const process = await new Deno.Command(cmd, {
        args,
        cwd,
        stdout: "piped",
        stderr: "piped",
        signal: controller.signal,
      }).output();

      const stdout = new TextDecoder().decode(process.stdout);
      const stderr = new TextDecoder().decode(process.stderr);

      // Clean output formatting
      const success = process.code === 0;
      return [
        success ? "RESULT: SUCCESS" : "RESULT: FAILED",
        `EXIT_CODE: ${process.code}`,
        "OUTPUT:",
        truncateOutput(stdout || "(no output)", 8000),
        ...(stderr ? ["STDERR:", truncateOutput(stderr, 2000)] : []),
      ].join("\n");
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        return [
          "RESULT: TIMEOUT",
          `EXIT_CODE: -1`,
          `Command exceeded timeout of ${timeoutMs}ms and was killed.`,
        ].join("\n");
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class FileReaderTool implements Tool {
  readonly name = "file_reader";
  readonly description = "Read a UTF-8 text file from the workspace.";
  readonly parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path to a text file.",
      },
    },
    required: ["path"],
  };

  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const path = requireString(payload.path, "path");
    const filePath = safePath(this.context.rootDir, path);
    const content = await Deno.readTextFile(filePath);
    return [
      "RESULT: SUCCESS",
      "EXIT_CODE: 0",
      `PATH: ${path}`,
      "OUTPUT:",
      truncateOutput(content, 12000),
    ].join("\n");
  }
}

export class FileWriterTool implements Tool {
  readonly name = "file_writer";
  readonly description = "Create or overwrite a text file in the workspace.";
  readonly parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path to write.",
      },
      content: {
        type: "string",
        description: "Full text content to write to the file.",
      },
    },
    required: ["path", "content"],
  };

  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const path = requireString(payload.path, "path");
    const content = requireString(payload.content, "content");
    const filePath = safePath(this.context.rootDir, path);

    let before = "";
    let existed = false;
    try {
      before = await Deno.readTextFile(filePath);
      existed = true;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    const diff = createSimpleDiff(before, content);
    const approved = await this.context.confirmWrite(
      existed ? `Overwrite ${path}?` : `Create ${path}?`,
      diff,
    );
    if (!approved) {
      return "RESULT: FAILED\nEXIT_CODE: 1\nOUTPUT:\nWrite cancelled by confirmation policy.";
    }

    await Deno.mkdir(dirname(filePath), { recursive: true });
    await Deno.writeTextFile(filePath, content);
    const preview = contentPreview(content);
    return [
      "RESULT: SUCCESS",
      "EXIT_CODE: 0",
      "OUTPUT:",
      existed ? `File overwritten: ${path}` : `File created: ${path}`,
      "CONTENT_PREVIEW:",
      preview,
    ].join("\n");
  }
}

export class FileEditTool implements Tool {
  readonly name = "file_edit";
  readonly description = "Replace exact text in a workspace file.";
  readonly parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Workspace-relative path to edit.",
      },
      find: {
        type: "string",
        description: "Exact text to find.",
      },
      replace: {
        type: "string",
        description: "Replacement text.",
      },
      replace_all: {
        type: "boolean",
        description: "Replace all matches (default false).",
      },
    },
    required: ["path", "find", "replace"],
  };

  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const path = requireString(payload.path, "path");
    const find = requireString(payload.find, "find");
    const replace = requireString(payload.replace, "replace");
    const replaceAll = payload.replace_all === true;
    const filePath = safePath(this.context.rootDir, path);

    if (!find) {
      return "RESULT: FAILED\nEXIT_CODE: 1\nOUTPUT:\n'find' must be non-empty.";
    }

    const before = await Deno.readTextFile(filePath);
    const occurrences = before.split(find).length - 1;
    if (occurrences === 0) {
      return `RESULT: FAILED\nEXIT_CODE: 1\nOUTPUT:\nNo matches found for 'find' in ${path}.`;
    }

    const after = replaceAll ? before.split(find).join(replace) : before.replace(find, replace);
    const diff = createSimpleDiff(before, after);
    const approved = await this.context.confirmWrite(`Edit ${path}?`, diff);
    if (!approved) {
      return "RESULT: FAILED\nEXIT_CODE: 1\nOUTPUT:\nEdit cancelled by confirmation policy.";
    }

    await Deno.writeTextFile(filePath, after);
    const preview = contentPreview(after);
    return [
      "RESULT: SUCCESS",
      "EXIT_CODE: 0",
      "OUTPUT:",
      `Updated ${path} (${replaceAll ? occurrences : 1} replacement${
        occurrences === 1 ? "" : "s"
      }).`,
      "CONTENT_PREVIEW:",
      preview,
    ].join("\n");
  }
}

export class CodeRunnerTool implements Tool {
  readonly name = "code_runner";
  readonly description = "Execute a TypeScript/JavaScript file safely using Deno runtime.";
  readonly parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the .ts or .js file to run.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass to the script (optional).",
      },
    },
    required: ["path"],
  };

  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const path = requireString(payload.path, "path");
    const args = Array.isArray(payload.args) ? payload.args.map(String) : [];

    const filePath = safePath(this.context.rootDir, path);

    const command = new Deno.Command("deno", {
      args: ["run", "--allow-all", filePath, ...args],
      cwd: this.context.rootDir,
      stdout: "piped",
      stderr: "piped",
    });

    const out = await command.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);

    return [
      out.code === 0 ? "RESULT: SUCCESS" : "RESULT: FAILED",
      `EXIT_CODE: ${out.code}`,
      "OUTPUT:",
      truncateOutput(stdout || "(no output)", 8000),
      ...(stderr ? ["STDERR:", truncateOutput(stderr, 2000)] : []),
    ].join("\n");
  }
}

export class GitTool implements Tool {
  readonly name = "git";
  readonly description = "Execute git commands (status, diff, add, commit, log, etc).";
  readonly parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "diff", "add", "commit", "log", "pull", "push"],
        description: "Git action to perform.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments for the git action (file paths, commit message, etc).",
      },
    },
    required: ["action"],
  };

  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const action = requireString(payload.action, "action");
    const args = Array.isArray(payload.args) ? payload.args.map(String) : [];

    let cmdArgs = [action];
    if (action === "commit" && args.length > 0) {
      cmdArgs = ["commit", "-m", args.join(" ")];
    } else {
      cmdArgs.push(...args);
    }

    const command = new Deno.Command("git", {
      args: cmdArgs,
      cwd: this.context.rootDir,
      stdout: "piped",
      stderr: "piped",
    });

    const out = await command.output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);

    return [
      out.code === 0 ? "RESULT: SUCCESS" : "RESULT: FAILED",
      `EXIT_CODE: ${out.code}`,
      "OUTPUT:",
      truncateOutput(stdout || "(no output)", 6000),
      ...(stderr ? ["STDERR:", truncateOutput(stderr, 2000)] : []),
    ].join("\n");
  }
}

export class DelegateTaskTool implements Tool {
  readonly name = "delegate_task";
  readonly description =
    "Spawn a background agent to handle a specific sub-task. Returns final report when done.";
  readonly parameters = {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "Specific task description for the sub-agent.",
      },
    },
    required: ["task"],
  };

  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const task = requireString(payload.task, "task");
    return await this.context.delegateTask(task);
  }
}
