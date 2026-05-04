# AI Architecture — 8 GB RAM / 4 GB VRAM

A complete local AI stack for modest hardware (Intel i5, 8 GB RAM, entry-level GPU). No cloud APIs, no costs. Starts with a single command: `skinny`.

## How it works

```
terminal
   │
   ▼
 skinny  ◄── single command, starts everything automatically
   │
   ├── proxy (background)         Anthropic API → Ollama router
   ├── screen-watcher (background) screenshot every 90s → memory
   └── cc-haha (foreground)       TUI interface
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

**cc-haha selects the model automatically** based on task complexity.  
**moondream** is loaded only when you ask to look at the screen — no RAM usage otherwise.

## Stack

| Component | Role | RAM |
|---|---|---|
| **phi4-mini** | Main agent — coding, reasoning, tool use | ~2.5 GB |
| **qwen2.5-coder:1.5b** | Fast tasks — summaries, simple questions | ~1.0 GB |
| **moondream** | Vision — sees the desktop on demand | ~1.7 GB |
| **proxy.ts** | Anthropic→Ollama bridge with model routing | ~30 MB |
| **screen-watcher.ts** | Passive screen observation → memory file | ~30 MB |
| **vision-mcp.ts** | MCP server for active vision | ~20 MB |
| **cc-haha** | TUI interface + MCP + multi-agent | ~150 MB |

**The three Ollama models never load simultaneously** (`OLLAMA_MAX_LOADED_MODELS=1`).  
Worst case with one model loaded: ~3 GB model + ~2.5 GB OS = ~5.5 GB out of 8 GB.

## Setup (one time)

### Prerequisites
- [Ollama](https://ollama.ai)
- [Bun](https://bun.sh)
- [Git for Windows](https://git-scm.com/download/win)
- [cc-haha](https://github.com/NanmiCoder/cc-haha) installed

### Install

```powershell
# 1. Clone this repo next to cc-haha-main
git clone https://github.com/H8dboy/ai-arch-8gb
cd ai-arch-8gb

# 2. Run setup (adds `skinny` to PATH, downloads models, configures Ollama)
powershell -ExecutionPolicy Bypass -File .\setup.ps1

# 3. Copy env config to cc-haha
copy .env.example ..\cc-haha-main\.env

# 4. Open a new terminal and type:
skinny
```

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

# Coding (phi4-mini)
"write a function that reads a CSV file"
"find the bug in this code"

# Web search (fetch MCP)
"find the Bun.serve documentation"
"what's new in phi-4?"

# Fast tasks (qwen, faster response)
"translate this sentence"
"briefly explain what a mutex is"
```

## Memory

Screen observations are saved to:
```
%USERPROFILE%\.claude\screen-memory\observations.md
```

The file is automatically trimmed above 400 KB. The `read_screen_memory` MCP tool lets the agent read recent observations without a screenshot.

## Files

| File | Description |
|---|---|
| `skinny.cmd` | Main entry point — starts everything |
| `proxy.ts` | Anthropic→Ollama bridge with model routing |
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
