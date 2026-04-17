import { dirname, isAbsolute, join, normalize, resolve } from "jsr:@std/path";
import type { Tool } from "../types.ts";

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

export class ShellCommandTool implements Tool {
  readonly name = "shell_command";
  readonly description =
    "Execute shell commands: read files (cat/type), write (echo), list dirs (ls/dir), search (grep/findstr). Platform-aware.";
  readonly parameters = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description:
          "Shell command. Unix: 'cat file', 'echo x > file', 'ls -la dir', 'grep -r pattern'. Windows: 'type file', '(echo x) > file', 'dir /s', 'findstr /r pattern'",
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
