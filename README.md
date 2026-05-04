# AI Architecture — 8 GB RAM / 4 GB VRAM

Architettura completa per far girare un agente AI locale su hardware modesto (Intel i5, 8 GB RAM, GPU entry-level), senza API cloud, senza costi, senza LiteLLM.

## Stack

| Componente | Ruolo | RAM |
|---|---|---|
| **phi4-mini** (Ollama) | LLM principale — coding, ragionamento, tool use | ~2.5 GB |
| **moondream** (Ollama) | Visione — descrive lo schermo per la memoria | ~1.7 GB |
| **proxy.ts** (Bun) | Traduce Anthropic API → OpenAI per Ollama | ~30 MB |
| **screen-watcher.ts** (Bun) | Screenshot ogni 90s → descrizione → memoria | ~30 MB |
| **cc-haha** | Claude Code fork — TUI completa, MCP, multi-agent | ~150 MB |
| **MCP fetch** | Accesso internet (legge qualsiasi URL) | zero |

**Totale worst-case: ~4.5 GB** — I due modelli Ollama non girano mai insieme grazie a `OLLAMA_MAX_LOADED_MODELS=1`.

## Architettura RAM

```
┌─────────────────────────────────────────────────┐
│                   8 GB RAM                       │
│                                                  │
│  OS + app      ████████   ~2.5 GB               │
│  phi4-mini     ██████████  ~2.5 GB  (o unload)  │
│  moondream     ███████     ~1.7 GB  (o unload)  │
│  proxy+watcher ▌           ~0.1 GB              │
│                                                  │
│  Ollama swappa automaticamente i modelli:        │
│  mai entrambi caricati allo stesso tempo         │
└─────────────────────────────────────────────────┘
```

## Prerequisiti

- [Ollama](https://ollama.ai) installato
- [Bun](https://bun.sh) installato
- [cc-haha](https://github.com/NanmiCoder/cc-haha) clonato e configurato
- Git for Windows (per eseguire cc-haha su Windows)

## Installazione

### 1. Clona questo repo

```powershell
git clone https://github.com/TUO-USERNAME/ai-arch-8gb
cd ai-arch-8gb
```

### 2. Scarica i modelli

```powershell
ollama pull phi4-mini    # ~2.5 GB
ollama pull moondream    # ~1.7 GB
```

### 3. Configura cc-haha

```powershell
# Clona cc-haha nella directory parent
git clone https://github.com/NanmiCoder/cc-haha ../cc-haha-main
cd ..\cc-haha-main
bun install

# Copia la configurazione
Copy-Item ..\ai-arch-8gb\.env.example .env
Copy-Item ..\ai-arch-8gb\.mcp.json .mcp.json
```

### 4. Avvia tutto

```powershell
.\start.ps1
# oppure se cc-haha è in un percorso diverso:
.\start.ps1 -CcHahaPath "C:\percorso\cc-haha-main"
```

## Come funziona

### Proxy (`proxy.ts`)
Converte le richieste Anthropic Messages API (formato usato da cc-haha) in OpenAI Chat Completions (formato Ollama). Zero dipendenze Python, gira su Bun in ~30 MB di RAM.

- `num_ctx: 4096` — finestra di contesto ridotta, dimezza il KV-cache RAM rispetto al default
- Supporto completo: streaming, tool use, system prompt, messaggi multipli

### Screen watcher (`screen-watcher.ts`)
- Screenshot ogni 90 secondi via PowerShell (.NET System.Drawing)
- **Controlla se Ollama è occupato** prima di caricare moondream — se il LLM principale sta generando, aspetta 30s e riprova
- Hash dell'immagine per rilevare schermate identiche (non loggare "desktop vuoto" 100 volte)
- Salva osservazioni in `~\.claude\screen-memory\observations.md`
- Tronca automaticamente sopra 400 KB

### Ottimizzazioni Ollama (`start.ps1`)
```
OLLAMA_MAX_LOADED_MODELS=1   → un solo modello in RAM
OLLAMA_NUM_PARALLEL=1        → una richiesta alla volta
OLLAMA_KEEP_ALIVE=2m         → scarica dopo 2 min di inattività
```

### Internet (MCP fetch)
`.mcp.json` aggiunge il server MCP `fetch` a cc-haha. L'agente può leggere qualsiasi URL senza processi extra.

## Cosa puoi chiedere all'agente

```
# Ricerca web
"cerca le ultime novità su Rust 2025"

# Coding
"scrivi una funzione Python per parsare CSV con gestione errori"

# Contesto schermo (usa la memoria accumulata)
"cosa stavo facendo prima?"

# Tutto insieme
"guarda cosa ho sullo schermo e cerca documentazione relativa"
```

## Limiti onesti

- **phi4-mini (3.8B)** è buono ma non paragonabile a GPT-4 o Claude 3.5 — tool calling complesso può avere errori
- **moondream** descrive lo schermo in inglese con qualità media — sufficiente per il contesto
- **L'apprendimento è basato su memoria testuale**, non su fine-tuning del modello
- Con Chrome + altro aperto, la RAM può avvicinarsi al limite — chiudi le app inutili

## Hardware testato

```
CPU:   Intel Core i5-8265U @ 1.60GHz (4 core / 8 thread)
RAM:   8 GB DDR4
GPU:   AMD Radeon Pro WX3200 (4 GB VRAM) — Ollama gira su CPU
OS:    Windows 11 Pro
```
