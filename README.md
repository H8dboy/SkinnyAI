# AI Architecture — 8 GB RAM / 4 GB VRAM

Stack AI locale completo su hardware modesto. Si avvia con un solo comando: `claude`.

## Come funziona

```
terminale
   │
   ▼
 claude  ◄── comando unico, avvia tutto in automatico
   │
   ├── proxy (background)        Anthropic API → Ollama
   ├── screen-watcher (background) screenshot ogni 90s → memoria
   └── cc-haha (foreground)      interfaccia TUI
           │
           ├── HAIKU  task veloci   ──► qwen2.5-coder:1.5b  (~1 GB)
           ├── SONNET main agent   ──► phi4-mini             (~2.5 GB)
           ├── OPUS   task complessi ► phi4-mini             (~2.5 GB)
           │
           └── MCP tools
               ├── fetch       → internet (legge qualsiasi URL)
               └── vision      → see_screen / read_screen_memory
                       │
                       └── moondream  (~1.7 GB, on-demand)
```

**cc-haha sceglie il modello automaticamente** in base alla complessità del task.  
**moondream** viene caricato solo quando chiedi di guardare lo schermo — non occupa RAM il resto del tempo.

## Stack

| Componente | Ruolo | RAM |
|---|---|---|
| **phi4-mini** | Main agent — coding, ragionamento, tool use | ~2.5 GB |
| **qwen2.5-coder:1.5b** | Task veloci — summary, domande semplici | ~1.0 GB |
| **moondream** | Visione — vede il desktop su richiesta | ~1.7 GB |
| **proxy.ts** | Bridge Anthropic→Ollama, routing modelli | ~30 MB |
| **screen-watcher.ts** | Osservazione passiva schermo → memoria | ~30 MB |
| **vision-mcp.ts** | MCP server per visione attiva | ~20 MB |
| **cc-haha** | Interfaccia TUI + MCP + multi-agent | ~150 MB |

**I tre modelli Ollama non girano mai insieme** (`OLLAMA_MAX_LOADED_MODELS=1`).  
Worst case con uno solo caricato: ~3 GB modello + ~2.5 GB OS = ~5.5 GB su 8 GB.

## Setup (una volta sola)

### Prerequisiti
- [Ollama](https://ollama.ai)
- [Bun](https://bun.sh)
- [Git for Windows](https://git-scm.com/download/win)
- [cc-haha](https://github.com/NanmiCoder/cc-haha) installato

### Installazione

```powershell
# 1. Clona questo repo accanto a cc-haha
git clone https://github.com/H8dboy/ai-arch-8gb
cd ai-arch-8gb

# 2. Setup (aggiunge `claude` al PATH, scarica i modelli, configura Ollama)
.\setup.ps1

# 3. Configura cc-haha
copy .env.example ..\cc-haha-main\.env
# modifica .env se cc-haha è in un percorso diverso

# 4. Apri un nuovo terminale e digita:
claude
```

Se cc-haha è in un percorso diverso:
```powershell
$env:CCHAHA_DIR = "C:\percorso\cc-haha-main"
claude
```

## Cosa puoi fare

```
# Guarda lo schermo
"guarda lo schermo e dimmi cosa c'è"
"ho un errore, puoi vedere?"

# Contesto di lavoro
"cosa stavo facendo prima?"
"riassumi le ultime ore di lavoro"

# Coding (phi4-mini)
"scrivi una funzione che legge un CSV"
"trova il bug in questo codice"

# Ricerca web (fetch MCP)
"cerca la documentazione di Bun.serve"
"trova le ultime novità su phi-4"

# Task semplici (qwen, più veloce)
"traduci questa frase"
"spiega brevemente cos'è un mutex"
```

## File

| File | Descrizione |
|---|---|
| `claude.cmd` | Comando principale — avvia tutto |
| `proxy.ts` | Bridge Anthropic→Ollama con routing modelli |
| `screen-watcher.ts` | Osservatore passivo schermo |
| `vision-mcp.ts` | MCP server visione (see_screen, read_screen_memory) |
| `setup.ps1` | Setup una-tantum |
| `.env.example` | Configurazione cc-haha |
| `.mcp.json` | Template MCP (rigenerato da claude.cmd) |

## Hardware testato

```
CPU:  Intel Core i5-8265U @ 1.60GHz (4C/8T)
RAM:  8 GB DDR4
GPU:  AMD Radeon Pro WX3200 4GB — Ollama su CPU
OS:   Windows 11 Pro
```
