import type { Tool } from "../../core/types.ts";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  describeAll(): string {
    return this.list().map((t) => `- ${t.name}: ${t.description}`).join("\n");
  }

  describeSchemas(): string {
    return JSON.stringify(
      this.list().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      null,
      2,
    );
  }
}

function toSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
