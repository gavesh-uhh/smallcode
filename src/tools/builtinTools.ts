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

export class FileReaderTool implements Tool {
  readonly name = "file_reader";
  readonly description = "Reads a UTF-8 file and returns its content with line numbers.";
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to read." },
      startLine: { type: "integer", description: "Optional start line number (1-indexed)." },
      endLine: { type: "integer", description: "Optional end line number (inclusive)." },
    },
    required: ["path"],
  };
  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const path = requireString(payload.path, "path");
    const startLine = asPositiveInt(payload.startLine, 1);
    const endLine = asOptionalPositiveInt(payload.endLine);
    const filePath = safePath(this.context.rootDir, path);
    const raw = await Deno.readTextFile(filePath);
    const lines = raw.split("\n");
    const start = Math.max(startLine - 1, 0);
    const end = endLine ? Math.min(endLine, lines.length) : lines.length;
    const content = lines.slice(start, end)
      .map((line, idx) => `${start + idx + 1}. ${line}`)
      .join("\n");
    return [
      "RESULT: OK",
      `LINES: ${start + 1}-${end}`,
      "OUTPUT:",
      content || "(empty)",
      "NEXT_HINT: Continue with file_writer if edits are needed.",
    ].join("\n");
  }
}

export class FileWriterTool implements Tool {
  readonly name = "file_writer";
  readonly description = "Writes, appends, or runs search/replace on a UTF-8 file.";
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to write." },
      content: {
        type: "string",
        description: "The literal content to write, or the replacement string.",
      },
      searchString: {
        type: "string",
        description: "If provided, replaces this exact string with 'content'.",
      },
      append: {
        type: "boolean",
        description: "If true, append instead of overwrite (ignored if searchString is set).",
      },
      showDiff: { type: "boolean", description: "If true, return a diff of the change." },
      requireConfirm: {
        type: "boolean",
        description: "If true, asks the user for confirmation first.",
      },
      allowOverwrite: {
        type: "boolean",
        description: "REQUIRED if overwriting a whole existing file without searchString.",
      },
    },
    required: ["path", "content"],
  };
  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);

    const path = requireString(payload.path, "path");
    const content = requireString(payload.content, "content");
    const searchString = payload.searchString !== undefined
      ? String(payload.searchString)
      : undefined;
    const append = asBoolean(payload.append, false);
    const showDiff = asBoolean(payload.showDiff, true);
    const requireConfirm = asBoolean(payload.requireConfirm, false);
    const allowOverwrite = asBoolean(payload.allowOverwrite, false);

    const filePath = safePath(this.context.rootDir, path);
    let before = "";
    try {
      before = await Deno.readTextFile(filePath);
    } catch {
      before = "";
    }

    let after = "";
    if (searchString !== undefined) {
      if (!before.includes(searchString)) {
        throw new Error(
          `Target searchString not found in file: ${path}. Use file_reader to verify content.`,
        );
      }
      after = before.replace(searchString, content);
    } else {
      if (before && !append && !allowOverwrite) {
        throw new Error(
          `Action blocked: Destructive overwrite of existing file '${path}'. Use file_edit for partial changes, or set allowOverwrite: true to replace the whole file.`,
        );
      }
      after = append ? before + content : content;
    }
    const diff = showDiff ? createSimpleDiff(before, after) : "Diff hidden by tool input.";

    if (requireConfirm) {
      const ok = await this.context.confirmWrite(`Apply write to ${path}?`, diff);
      if (!ok) {
        return ["RESULT: CANCELLED", "OUTPUT:", diff, "NEXT_HINT: Ask user to confirm write."].join(
          "\n",
        );
      }
    }

    await Deno.mkdir(dirname(filePath), { recursive: true });
    await Deno.writeTextFile(filePath, after);
    return [
      "RESULT: OK",
      `FILE: ${path}`,
      "OUTPUT:",
      diff,
      "NEXT_HINT: Re-read file_reader to verify the change.",
    ].join("\n");
  }
}

export class FileEditTool implements Tool {
  readonly name = "file_edit";
  readonly description =
    "Safely replaces a specific line range in a UTF-8 file. Ideal for precise edits.";
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the file to edit." },
      startLine: { type: "integer", description: "Start line number to replace (1-indexed)." },
      endLine: { type: "integer", description: "End line number to replace (inclusive)." },
      content: { type: "string", description: "The new content for this line range." },
    },
    required: ["path", "startLine", "endLine", "content"],
  };
  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const path = requireString(payload.path, "path");
    const startLine = asPositiveInt(payload.startLine, 1);
    const endLine = asPositiveInt(payload.endLine, 1);
    const content = String(payload.content);

    const filePath = safePath(this.context.rootDir, path);
    const beforeRaw = await Deno.readTextFile(filePath);
    const lines = beforeRaw.split("\n");

    if (startLine > lines.length || startLine < 1) {
      throw new Error(`startLine ${startLine} is out of bounds (file has ${lines.length} lines).`);
    }
    if (endLine < startLine) {
      throw new Error(`endLine must be >= startLine.`);
    }

    const beforeSlice = lines.slice(0, startLine - 1);
    const afterSlice = lines.slice(endLine);
    const newContentLines = content.split("\n");

    const merged = [...beforeSlice, ...newContentLines, ...afterSlice];
    const afterRaw = merged.join("\n");

    const diff = createSimpleDiff(beforeRaw, afterRaw);

    await Deno.writeTextFile(filePath, afterRaw);
    return [
      "RESULT: OK",
      `FILE: ${path}`,
      `LINES_REPLACED: ${startLine}-${endLine}`,
      "OUTPUT:",
      diff,
      "NEXT_HINT: Use file_reader to verify surrounding code matches expectations.",
    ].join("\n");
  }
}

export class SymbolSearchTool implements Tool {
  readonly name = "find_definition";
  readonly description =
    "Global project search for any exported symbol (class, function, variable). Returns path and line.";
  readonly parameters = {
    type: "object",
    properties: {
      name: { type: "string", description: "The name of the symbol to find (case-sensitive)." },
    },
    required: ["name"],
  };
  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const name = requireString(payload.name, "name");
    const root = safePath(this.context.rootDir, ".");

    const files: string[] = [];
    await walk(root, "", 0, 8, files);

    const pattern = new RegExp(
      `export\\s+(class|function|const|let|var|type|interface|enum)\\s+${name}(\\b|\\s)`,
      "g",
    );
    const results: string[] = [];

    for (const file of files) {
      if (file.endsWith("/")) continue;
      if (file.includes("node_modules") || file.includes(".git")) continue;

      try {
        const text = await Deno.readTextFile(join(root, file));
        if (text.includes(name)) {
          const lines = text.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i])) {
              results.push(`${file}:${i + 1}`);
            }
          }
        }
      } catch {
        continue;
      }
    }

    return [
      results.length > 0 ? "RESULT: OK" : "RESULT: NOT_FOUND",
      "OUTPUT:",
      results.join("\n") || `Symbol '${name}' not found in exports.`,
      "NEXT_HINT: Use file_reader on the returned path to see the implementation.",
    ].join("\n");
  }
}

export class DirectoryListerTool implements Tool {
  readonly name = "directory_lister";
  readonly description = "Lists files and directories in a given path up to a specified depth.";
  readonly parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the directory to list. Defaults to current directory.",
      },
      depth: { type: "integer", description: "Maximum recursion depth (1-6). Default is 2." },
    },
  };
  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    let payload: any = {};
    if (input.trim()) {
      payload = JSON.parse(input);
    }
    const path = payload.path === undefined ? "." : requireString(payload.path, "path");
    const depth = clamp(asPositiveInt(payload.depth, 2), 1, 6);
    const root = safePath(this.context.rootDir, path);
    const out: string[] = [];
    await walk(root, "", 0, depth, out);
    return [
      "RESULT: OK",
      `ROOT: ${path}`,
      "OUTPUT:",
      out.join("\n") || "(empty)",
      "NEXT_HINT: Use file_reader for a specific file.",
    ].join("\n");
  }
}

async function walk(dir: string, prefix: string, level: number, maxDepth: number, out: string[]) {
  const entries: { name: string; isDir: boolean }[] = [];
  for await (const ent of Deno.readDir(dir)) {
    if (ent.name.startsWith(".git")) {
      continue;
    }
    entries.push({ name: ent.name, isDir: ent.isDirectory });
  }
  entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
  for (const entry of entries) {
    const mark = entry.isDir ? "/" : "";
    out.push(`${prefix}${entry.name}${mark}`);
    if (entry.isDir && level + 1 < maxDepth) {
      await walk(join(dir, entry.name), `${prefix}  `, level + 1, maxDepth, out);
    }
  }
}

export class ShellCommandTool implements Tool {
  readonly name = "shell_command";
  readonly description = "Runs a shell command and returns stdout/stderr.";
  readonly parameters = {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute." },
      cwd: { type: "string", description: "The working directory for the command." },
      timeoutMs: { type: "integer", description: "Optional timeout in milliseconds." },
    },
    required: ["command"],
  };
  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const command = requireString(payload.command, "command");
    const cwd = safePath(
      this.context.rootDir,
      payload.cwd === undefined ? "." : requireString(payload.cwd, "cwd"),
    );
    const timeoutMs = clamp(asPositiveInt(payload.timeoutMs, 120000), 1000, 600000);
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
      return [
        process.code === 0 ? "RESULT: OK" : "RESULT: ERROR",
        `EXIT_CODE: ${process.code}`,
        "STDOUT:",
        truncateOutput(stdout),
        "STDERR:",
        truncateOutput(stderr),
        "NEXT_HINT: If exit code is non-zero, inspect STDERR first.",
      ].join("\n");
    } finally {
      clearTimeout(timer);
    }
  }
}

export class CodeRunnerTool implements Tool {
  readonly name = "code_runner";
  readonly description = "Runs a Deno TypeScript/JavaScript script completely isolated.";
  readonly parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: "Path to the TypeScript/JavaScript file." },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments to pass to the script.",
      },
    },
    required: ["path"],
  };
  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const path = requireString(payload.path, "path");
    const args = asStringArray(payload.args, "args");
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
      out.code === 0 ? "RESULT: OK" : "RESULT: ERROR",
      `EXIT_CODE: ${out.code}`,
      "STDOUT:",
      truncateOutput(stdout),
      "STDERR:",
      truncateOutput(stderr),
      "NEXT_HINT: Fix compile/runtime errors before retry.",
    ].join("\n");
  }
}

export class GrepSearchTool implements Tool {
  readonly name = "grep_search";
  readonly description = "Searches for a string or regex pattern across files in the workspace.";
  readonly parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "The string or regex to search for." },
      regex: { type: "boolean", description: "If true, treat query as regex." },
      include: { type: "string", description: "File glob or extension to include (e.g. '.ts')." },
    },
    required: ["query"],
  };
  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const query = requireString(payload.query, "query");
    const isRegex = asBoolean(payload.regex, false);
    const include = payload.include ? String(payload.include) : "";

    const root = safePath(this.context.rootDir, ".");
    const out: string[] = [];
    const files: string[] = [];

    await walk(root, "", 0, 6, files);

    const pattern = isRegex ? new RegExp(query, "g") : undefined;
    let matchesFound = 0;

    for (const file of files) {
      if (file.endsWith("/")) continue;
      if (include && !file.includes(include)) continue;

      try {
        const absPath = join(root, file);
        const text = await Deno.readTextFile(absPath);
        const lines = text.split("\n");
        let matchedInFile = false;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const matches = isRegex ? pattern?.test(line) : line.includes(query);
          if (matches) {
            if (!matchedInFile) {
              out.push(`\n-- ${file} --`);
              matchedInFile = true;
            }
            out.push(`${i + 1}: ${line.trim()}`);
            matchesFound++;
          }
          if (matchesFound > 200) break;
        }
      } catch {
        continue;
      }
      if (matchesFound > 200) {
        out.push("\n...[truncated limit 200 matches]...");
        break;
      }
    }

    return [
      "RESULT: OK",
      `MATCHES: ${matchesFound}`,
      "OUTPUT:",
      out.join("\n") || "(no matches found)",
    ].join("\n");
  }
}

export class FetchUrlTool implements Tool {
  readonly name = "fetch_url";
  readonly description = "Fetches a web page and converts it to basic text/markdown context.";
  readonly parameters = {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch (must start with http/https)." },
    },
    required: ["url"],
  };
  constructor(_context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const url = requireString(payload.url, "url");
    if (!url.startsWith("http")) throw new Error("URL must start with http/https");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
    const html = await res.text();

    const text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return [
      "RESULT: OK",
      "OUTPUT:",
      truncateOutput(text, 10000),
    ].join("\n");
  }
}

export class GitTool implements Tool {
  readonly name = "git";
  readonly description = "Executes safe git commands (status, diff, add, commit).";
  readonly parameters = {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["status", "diff", "add", "commit"],
        description: "The git action.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Arguments for the action (e.g. file paths or commit message).",
      },
    },
    required: ["action"],
  };
  constructor(private readonly context: ToolContext) {}

  async execute(input: string): Promise<string> {
    const payload = JSON.parse(input);
    const action = requireString(payload.action, "action");
    const args = payload.args && Array.isArray(payload.args) ? payload.args.map(String) : [];

    let cmdArgs = [action];
    if (action === "commit") {
      if (args.length === 0) throw new Error("Commit requires a message argument.");
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
      out.code === 0 ? "RESULT: OK" : "RESULT: ERROR",
      `STDOUT:`,
      truncateOutput(stdout, 6000),
      `STDERR:`,
      truncateOutput(stderr, 2000),
    ].join("\n");
  }
}

export class DelegateTaskTool implements Tool {
  readonly name = "delegate_task";
  readonly description =
    "Spawns a background worker agent to handle a specific sub-task and returns its final report.";
  readonly parameters = {
    type: "object",
    properties: {
      task: { type: "string", description: "The specific task instructions for the worker agent." },
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

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Field '${field}' must be a non-empty string.`);
  }
  return value;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error("Boolean field has invalid type.");
  }
  return value;
}

function asPositiveInt(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Numeric field must be a positive integer.");
  }
  return value;
}

function asOptionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error("Optional numeric field must be a positive integer.");
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`Field '${field}' must be an array of strings.`);
  }
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncateOutput(value: string, max = 4000): string {
  if (value.length <= max) {
    return value || "(empty)";
  }
  const head = value.slice(0, Math.floor(max * 0.6));
  const tail = value.slice(-Math.floor(max * 0.3));
  return `${head}\n...[truncated]...\n${tail}`;
}
