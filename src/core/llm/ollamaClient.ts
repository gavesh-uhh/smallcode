import type { ChatChunk, GenerateOptions, Message } from "../types.ts";
import { OLLAMA_CONFIG } from "../config.ts";

interface OllamaStreamPart {
  done?: boolean;
  response?: string;
  thinking?: string;
  reasoning_content?: string;
  message?: {
    role: string;
    content: string;
    reasoning_content?: string;
    thinking?: string;
  };
  error?: string;
}

export class OllamaClient {
  private model: string;
  constructor(
    private readonly baseUrl = OLLAMA_CONFIG.baseUrl,
    defaultModel = OLLAMA_CONFIG.defaultModel,
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
        `No local Ollama models found. Pull one first, e.g. \`ollama pull ${OLLAMA_CONFIG.defaultModel}\`.`,
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
      think: options.think ?? true,
      keep_alive: options.keepAlive ?? OLLAMA_CONFIG.defaultKeepAlive,
      format: options.format,
      options: {
        temperature: options.temperature ?? OLLAMA_CONFIG.defaultTemperature,
        num_ctx: options.numCtx ?? OLLAMA_CONFIG.defaultNumCtx,
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
        think: options.think ?? true,
        keep_alive: options.keepAlive ?? OLLAMA_CONFIG.defaultKeepAlive,
        format: options.format,
        options: {
          temperature: options.temperature ?? OLLAMA_CONFIG.defaultTemperature,
          num_ctx: options.numCtx ?? OLLAMA_CONFIG.defaultNumCtx,
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
        think: options.think ?? true,
        keep_alive: options.keepAlive ?? OLLAMA_CONFIG.defaultKeepAlive,
        format: options.format,
        options: {
          temperature: options.temperature ?? OLLAMA_CONFIG.defaultTemperature,
          num_ctx: options.numCtx ?? OLLAMA_CONFIG.defaultNumCtx,
        },
      }),
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      throw new Error(`Ollama chat stream failed: ${response.status} ${text}`);
    }

    let inThinkTag = false;
    let contentCarry = "";

    for await (const part of this.streamNdjson(response.body)) {
      if (part.error) {
        throw new Error(part.error);
      }

      const reasoningChunk = part.message?.thinking ??
        part.message?.reasoning_content ??
        part.thinking ??
        part.reasoning_content;
      if (reasoningChunk) {
        yield { type: "reasoning", text: reasoningChunk };
      }

      const chunkContent = part.message?.content ?? "";
      if (chunkContent) {
        contentCarry += chunkContent;

        while (contentCarry.length > 0) {
          if (inThinkTag) {
            const closeIdx = contentCarry.toLowerCase().indexOf("</think>");
            if (closeIdx >= 0) {
              const reasoningText = contentCarry.slice(0, closeIdx);
              if (reasoningText) {
                yield { type: "reasoning", text: reasoningText };
              }
              contentCarry = contentCarry.slice(closeIdx + "</think>".length);
              inThinkTag = false;
              continue;
            }

            const keepTail = Math.max(0, contentCarry.length - 7);
            const reasoningText = contentCarry.slice(0, keepTail);
            if (reasoningText) {
              yield { type: "reasoning", text: reasoningText };
            }
            contentCarry = contentCarry.slice(keepTail);
            break;
          }

          const openIdx = contentCarry.toLowerCase().indexOf("<think>");
          if (openIdx >= 0) {
            const assistantText = contentCarry.slice(0, openIdx);
            if (assistantText) {
              yield { type: "content", text: assistantText };
            }
            contentCarry = contentCarry.slice(openIdx + "<think>".length);
            inThinkTag = true;
            continue;
          }

          const keepTail = Math.max(0, contentCarry.length - 6);
          const assistantText = contentCarry.slice(0, keepTail);
          if (assistantText) {
            yield { type: "content", text: assistantText };
          }
          contentCarry = contentCarry.slice(keepTail);
          break;
        }
      }
      if (part.done) {
        if (contentCarry) {
          yield { type: inThinkTag ? "reasoning" : "content", text: contentCarry };
          contentCarry = "";
        }
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
        `No local Ollama models found. Pull one first, e.g. \`ollama pull ${OLLAMA_CONFIG.defaultModel}\`.`,
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
