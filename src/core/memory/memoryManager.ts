import type { Message } from "../types.ts";

interface ScratchStep {
  step: number;
  action: string;
  input: string;
  observation: string;
}

interface MemoryFact {
  key: string;
  value: string;
  source: string;
  confidence: number;
  ttlTurns: number;
  createdAtTurn: number;
}

export class MemoryManager {
  private history: Message[] = [];
  private scratchpad: ScratchStep[] = [];
  private fileSummaries = new Map<string, string>();
  private facts = new Map<string, MemoryFact>();
  private turn = 0;

  constructor(private maxHistory = 64) {}

  setMaxHistory(limit: number): void {
    this.maxHistory = limit;
  }

  nextTurn(): void {
    this.turn += 1;
    this.pruneExpiredFacts();
  }

  addMessage(message: Message): void {
    this.history.push(message);
  }

  getMessages(): Message[] {
    if (this.history.length <= this.maxHistory) {
      return [...this.history];
    }
    const older = this.history.slice(0, this.history.length - this.maxHistory);
    const newer = this.history.slice(-this.maxHistory);
    const summary = older.map((m) => `${m.role}: ${trim(m.content, 120)}`).join("\n");
    return [{ role: "system", content: `Compressed prior context:\n${summary}` }, ...newer];
  }

  addScratchpadStep(step: ScratchStep): void {
    this.scratchpad.push({
      ...step,
      input: trim(step.input, 600),
      observation: trim(step.observation, 1200),
    });
  }

  getScratchpadText(limit = 8): string {
    if (this.scratchpad.length === 0) {
      return "No previous tool steps.";
    }
    return this.scratchpad.slice(-limit).map((s) =>
      `Step ${s.step}\nAction: ${s.action}\nInput: ${s.input}\nObservation: ${s.observation}`
    ).join("\n\n");
  }

  getCompactScratchpadText(limit = 8): string {
    if (this.scratchpad.length === 0) {
      return "";
    }
    return this.scratchpad.slice(-limit).map((s) => {
      const obs = trim(s.observation.replace(/\s+/g, " "), 120);
      return `${s.step}|${s.action}|${trim(s.input.replace(/\s+/g, " "), 80)}|${obs}`;
    }).join("\n");
  }

  setFileSummary(path: string, summary: string): void {
    this.fileSummaries.set(path, trim(summary, 400));
  }

  setFact(
    key: string,
    value: string,
    source: string,
    confidence: number,
    ttlTurns = 8,
  ): void {
    this.facts.set(key, {
      key: trim(key, 80),
      value: trim(value, 220),
      source: trim(source, 80),
      confidence: Math.max(0, Math.min(1, confidence)),
      ttlTurns: Math.max(1, Math.min(64, ttlTurns)),
      createdAtTurn: this.turn,
    });
  }

  getFactsText(limit = 8): string {
    if (this.facts.size === 0) {
      return "";
    }
    const rows = [...this.facts.values()]
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, limit)
      .map((fact) => {
        const confidence = fact.confidence.toFixed(2);
        const age = this.turn - fact.createdAtTurn;
        return `${fact.key}=${fact.value} (src:${fact.source},c:${confidence},age:${age})`;
      });
    return rows.join("\n");
  }

  getFileSummaries(): string {
    if (this.fileSummaries.size === 0) {
      return "No file summaries.";
    }
    return [...this.fileSummaries.entries()].map(([path, summary]) => `${path}: ${summary}`).join(
      "\n",
    );
  }

  getStats(): { messages: number; chars: number; max: number } {
    const chars = this.history.reduce((acc, m) => acc + m.content.length, 0);
    return {
      messages: this.history.length,
      chars,
      max: this.maxHistory,
    };
  }

  reset(): void {
    this.history = [];
    this.scratchpad = [];
    this.fileSummaries.clear();
    this.facts.clear();
    this.turn = 0;
  }

  private pruneExpiredFacts(): void {
    for (const [key, fact] of this.facts.entries()) {
      if (this.turn - fact.createdAtTurn >= fact.ttlTurns) {
        this.facts.delete(key);
      }
    }
  }
}

function trim(input: string, max: number): string {
  if (input.length <= max) {
    return input;
  }
  return `${input.slice(0, max)} ...[truncated]`;
}
