# SkinnyAI — Lean AI for Weak PCs

**Skinny** because it runs on hardware everyone else ignores.  
No fat GPU. No 32 GB RAM. No cloud. Just a regular PC doing real AI work.

Built on top of **[cc-haha](https://github.com/NanmiCoder/cc-haha)** + Ollama.  
Starts with a single command: `skinny`.

> If your PC can't run the mainstream local AI stacks — this was made for you.

## How it works

```
terminal
   │
   ▼
 skinny  ◄── single command, starts everything automatically
   │
   ├── [1st run] dna-reader    reads model weights offline → builds routing map
   │
   ├── proxy (background)      Anthropic API → Ollama bridge
   │       │
   │       ├── nano-router     routes each query in < 1ms (no AI activated)
   │       │     reads model DNA → decides: trivial→qwen / coding→phi4 / reasoning→phi4
   │       │     injects a scaffold so the model answers directly, no preamble
   │       │
   │       └── inspector       post-generation quality control (< 2ms, no AI)
   │             strips filler · truncates repetition · checks relevance
   │             appends -stopped if response is incomplete
   │             appends -allucined if hallucination patterns detected
   │
   ├── screen-watcher (background)  screenshot every 90s → memory file
   │
   └── cc-haha (foreground)    TUI interface + MCP tools
           │
           ├── HAIKU  fast tasks    ──► qwen2.5-coder:1.5b  (~1 GB)
           ├── SONNET main agent   ──► phi4-mini             (~2.5 GB)
           ├── OPUS   complex tasks ──► phi4-mini            (~2.5 GB)
           │
           └── MCP tools
               ├── fetch   → internet (reads any URL)
               └── vision  → see_screen / read_screen_memory
                       │
                       └── moondream  (~1.7 GB, on-demand only)
```

**moondream** loads only when you ask to look at the screen — zero RAM usage otherwise.  
**The three Ollama models never load simultaneously** (`OLLAMA_MAX_LOADED_MODELS=1`).

## Intelligence layer

### DNA Reader (`dna-reader.ts`)
Runs once at first launch. Opens the GGUF model files as raw binary data — no model activation, no inference. Reads the tokenizer vocabulary embedded in the metadata, classifies every token into semantic clusters (trivial / coding / reasoning), and writes a compact routing map to disk (~200 KB total).

### Nano Router (`nano-router.ts`)
Loaded into RAM at proxy startup and never reloaded. Routes each incoming query in < 1ms using two levels:
- **Phrase patterns** (weighted 3–4×): regex that catch natural-language queries like *"why doesn't my code work"* or *"explain the difference between"*
- **Token lookup** (weighted 1×): exact match against domain-specific word sets (English + Italian)

No second AI is spawned. No network call. Pure math on pre-computed data.

### Inspector (`inspector.ts`)
Runs on the complete response before it reaches the user. Pure text analysis, < 2ms.

| Check | Action |
|---|---|
| Filler phrases ("I hope this helps", "Certainly!", …) | Stripped silently |
| Repetitive / oversized response | Truncated at last clean sentence boundary |
| Response relevance < 25% of query terms | Appends `-allucined` |
| Hallucination patterns (self-reference, invented URLs, contradictions) | Appends `-allucined` |
| Unclosed code block / truncated sentence / missing code / multi-part gap | Appends `-stopped` |

The inspector is cross-turn aware: it reads the conversation history to validate claims like *"as I mentioned earlier"*.

## Stack

| Component | Role | RAM |
|---|---|---|
| **phi4-mini** | Main agent — coding, reasoning, tool use | ~2.5 GB |
| **qwen2.5-coder:1.5b** | Fast tasks — summaries, simple questions | ~1.0 GB |
| **moondream** | Vision — sees the desktop on demand | ~1.7 GB |
| **dna-reader.ts** | One-time model DNA analysis → routing map | 0 at runtime |
| **nano-router.ts** | Sub-millisecond query routing + scaffold injection | ~2 MB RAM |
| **inspector.ts** | Post-generation quality control | ~0 MB RAM |
| **proxy.ts** | Anthropic→Ollama bridge | ~30 MB |
| **screen-watcher.ts** | Passive screen observation → memory file | ~30 MB |
| **vision-mcp.ts** | MCP server for active vision | ~20 MB |
| **cc-haha** | TUI interface + MCP + multi-agent | ~150 MB |

Worst case with one model loaded: ~3 GB model + ~2.5 GB OS + ~200 MB stack = ~5.7 GB out of 8 GB.

## Setup (one time)

### Prerequisites
- [Ollama](https://ollama.ai)
- [Bun](https://bun.sh)
- [Git for Windows](https://git-scm.com/download/win)
- **[cc-haha](https://github.com/NanmiCoder/cc-haha)** — the TUI interface SkinnyAI runs on top of

### Install

```powershell
# 1. Clone this repo next to cc-haha-main
git clone https://github.com/H8dboy/SkinnyAI
cd SkinnyAI

# 2. Run setup (adds `skinny` to PATH, downloads models, configures Ollama)
powershell -ExecutionPolicy Bypass -File .\setup.ps1

# 3. Copy env config to cc-haha
copy .env.example ..\cc-haha-main\.env

# 4. Open a new terminal and type:
skinny
```

On first run, `skinny` automatically reads the model DNA and builds the routing map (takes ~1–2 min, runs once only). Every subsequent start is instant.

If cc-haha is in a different path:
```powershell
set CCHAHA_DIR=C:\path\to\cc-haha-main
skinny
```

## What you can ask

```
# Look at the screen
"look at my screen and tell me what you see"
"I have an error, can you see it?"

# Work context
"what was I working on before?"
"summarize my last few hours of work"

# Coding (routed to phi4-mini with coding scaffold)
"write a function that reads a CSV file"
"why doesn't my code work?"
"find the bug in this code"

# Reasoning (routed to phi4-mini with reasoning scaffold)
"explain the difference between TCP and UDP"
"what's the best approach for this architecture?"

# Fast tasks (routed to qwen — faster response)
"translate this sentence"
"briefly explain what a mutex is"
"what time is it in Tokyo?"

# Web search (fetch MCP)
"find the Bun.serve documentation"
"what's new in phi-4?"
```

## Response quality flags

The inspector appends flags at the end of the response when needed:

| Flag | Meaning |
|---|---|
| `-stopped` | Response is incomplete — the model ran out of tokens or the answer is cut off |
| `-allucined` | Response may be inaccurate — hallucination patterns detected |
| `-stopped -allucined` | Both apply |

## Memory

Screen observations are saved to:
```
%USERPROFILE%\.claude\screen-memory\observations.md
```

The file is automatically trimmed above 400 KB. The `read_screen_memory` MCP tool lets the agent read recent observations without taking a new screenshot.

## Files

| File | Description |
|---|---|
| `skinny.cmd` | Main entry point — starts everything |
| `dna-reader.ts` | One-time model DNA analysis → `routing/` map |
| `nano-router.ts` | Sub-millisecond query router + scaffold injector |
| `inspector.ts` | Post-generation quality control |
| `proxy.ts` | Anthropic→Ollama bridge |
| `screen-watcher.ts` | Passive screen observer |
| `vision-mcp.ts` | MCP server: see_screen, read_screen_memory |
| `setup.ps1` | One-time setup |
| `.env.example` | cc-haha configuration template |

## Tested hardware

```
CPU:  Intel Core i5-8265U @ 1.60GHz (4C/8T)
RAM:  8 GB DDR4
GPU:  AMD Radeon Pro WX3200 4GB — Ollama runs on CPU
OS:   Windows 11 Pro
```
