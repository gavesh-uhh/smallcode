import type { ChatChunk, GenerateOptions, Message } from "../types.ts";

interface OllamaStreamPart {
  done?: boolean;
  response?: string;
  message?: {
    role: string;
    content: string;
    reasoning_content?: string;
  };
  error?: string;
}

export class OllamaClient {
  private model: string;
  constructor(
    private readonly baseUrl = "http://localhost:11434",
    defaultModel = "qwen2.5:7b",
  ) {
    this.model = defaultModel;
  }

  getModel(): string {
    return this.model;
  }

  setModel(model: string): void {
    this.model = model.trim();
  }

  async ensureModelAvailable(): Promise<{
    model: string;
    changed: boolean;
    available: string[];
  }> {
    const available = await this.listModels();
    if (available.length === 0) {
      throw new Error(
        "No local Ollama models found. Pull one first, e.g. `ollama pull qwen2.5:7b`.",
      );
    }
    if (available.includes(this.model)) {
      return { model: this.model, changed: false, available };
    }
    const fallback = this.selectFallbackModel(available, this.model);
    this.model = fallback;
    return { model: fallback, changed: true, available };
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseUrl}/api/tags`);
    if (!res.ok) {
      throw new Error(`Failed to list models: ${res.status} ${res.statusText}`);
    }
    const data = await res.json();
    if (!Array.isArray(data.models)) {
      return [];
    }
    return data.models
      .map((m: { name?: string }) => m.name ?? "")
      .filter(Boolean);
  }

  async *generate(
    prompt: string,
    options: GenerateOptions = {},
  ): AsyncGenerator<string> {
    const model = await this.resolveModelForRequest(options.model);
    const body = {
      model,
      prompt,
      system: options.system,
      stream: true,
      format: options.format,
      options: {
        temperature: options.temperature ?? 0.2,
        num_ctx: options.numCtx ?? 4096,
      },
    };
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(`Ollama generate failed: ${response.status} ${text}`);
    }

    for await (const part of this.streamNdjson(response.body)) {
      if (part.error) {
        throw new Error(part.error);
      }
      if (part.response) {
        yield part.response;
      }
      if (part.done) {
        break;
      }
    }
  }

  async chat(
    messages: Message[],
    options: GenerateOptions = {},
  ): Promise<string> {
    const model = await this.resolveModelForRequest(options.model);
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        format: options.format,
        options: {
          temperature: options.temperature ?? 0.2,
          num_ctx: options.numCtx ?? 4096,
        },
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Ollama chat failed: ${response.status} ${text}`);
    }
    const data = await response.json();
    return data?.message?.content ?? "";
  }

  async *chatStream(
    messages: Message[],
    options: GenerateOptions = {},
  ): AsyncGenerator<ChatChunk> {
    const model = await this.resolveModelForRequest(options.model);
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        format: options.format,
        options: {
          temperature: options.temperature ?? 0.2,
          num_ctx: options.numCtx ?? 4096,
        },
      }),
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(`Ollama chat stream failed: ${response.status} ${text}`);
    }

    for await (const part of this.streamNdjson(response.body)) {
      if (part.error) {
        throw new Error(part.error);
      }
      if (part.message?.reasoning_content) {
        yield { type: "reasoning", text: part.message.reasoning_content };
      }
      if (part.message?.content) {
        yield { type: "content", text: part.message.content };
      }
      if (part.done) {
        break;
      }
    }
  }

  private async *streamNdjson(
    body: ReadableStream<Uint8Array>,
  ): AsyncGenerator<OllamaStreamPart> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (line) {
            yield JSON.parse(line) as OllamaStreamPart;
          }
          nl = buffer.indexOf("\n");
        }
      }
      const tail = buffer.trim();
      if (tail) {
        yield JSON.parse(tail) as OllamaStreamPart;
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async resolveModelForRequest(
    overrideModel?: string,
  ): Promise<string> {
    if (overrideModel?.trim()) {
      return overrideModel.trim();
    }
    const available = await this.listModels();
    if (available.length === 0) {
      throw new Error(
        "No local Ollama models found. Pull one first, e.g. `ollama pull qwen2.5:7b`.",
      );
    }
    if (available.includes(this.model)) {
      return this.model;
    }
    const fallback = this.selectFallbackModel(available, this.model);
    this.model = fallback;
    return fallback;
  }

  private selectFallbackModel(available: string[], requested: string): string {
    const base = requested.split(":")[0]?.toLowerCase();
    const directFamily = base
      ? available.find((m) => m.toLowerCase().startsWith(`${base}:`))
      : undefined;
    if (directFamily) {
      return directFamily;
    }

    const preferredFamilies = [
      "qwen",
      "mistral",
      "llama3",
      "llama",
      "gemma",
      "phi",
    ];

    for (const family of preferredFamilies) {
      const hit = available.find((m) => m.toLowerCase().includes(family));
      if (hit) {
        return hit;
      }
    }
    return available[0];
  }
}
