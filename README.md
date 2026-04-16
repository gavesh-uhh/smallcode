# smallcode

**smallcode** is a local-first agentic  harness. It is specifically made for Small Language Models (8B-9B) Qwen 3.5/Gemma4/etc..

## To Do
- [ ] Centralize temperature values to a explicit file for easier tweaking
- [ ] Much Needed Code Cleanup
- [ ] Add support and tuning for other models
- [ ] Add support for other tools
- [ ] Add support for other operating systems
- [ ] Get started on Docs (thinking behevior, function calling behevior)

## Features

- **Multi-Step Missions**: Deconstruct massive tasks into singular, verifiable mission steps.
- **Verified Execution**: Autonomous success verification for every tool call.

## Getting Started

### Prerequisites

- [Deno](https://deno.land/)
- [Ollama](https://ollama.com/)

### Running Locally

```bash
# Clone the repository
git clone https://github.com/gavesh-uhh(or your forked git name)/smallcode.git

# Run the TUI
deno run --allow-all main.ts
```

## ⌨️ Commands

- `/help` : Full help window
- `/plan <task>`: Start a mission-based development loop.
- `/next`: Execute the next planned step.
- `/agent profile ultra`: Switch to maximum cognitive capacity.
- `/reset`: Clear session memory.

---

