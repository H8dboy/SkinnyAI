# SkinnyAI — Claude Code su PC con 8 GB di RAM

**SkinnyAI** fa girare Claude Code (la CLI ufficiale di Anthropic) su hardware modesto usando modelli locali quantizzati via Ollama — senza cloud, senza GPU da gaming, senza 32 GB di RAM.

Built on top of **[cc-haha](https://github.com/NanmiCoder/cc-haha)** + Ollama.  
Si avvia con un solo comando: `skinny`.

> Testato su Intel i5-8265U, 8 GB RAM, AMD Radeon Pro WX3200 4 GB.  
> Se il tuo PC è considerato "troppo debole" per l'AI locale — questo progetto è nato per te.

---

## Come funziona

```
terminale
   │
   ▼
 skinny  ◄── un comando, avvia tutto automaticamente
   │
   ├── ollama serve  (avviato con OLLAMA_VULKAN=1 via bash)
   │       └── gemma4:e4b → 42/43 layer su AMD GPU via Vulkan → ~5 tok/s
   │
   ├── proxy (background, porta 4000)
   │       │
   │       ├── cortex (pre-processing, < 2ms, senza AI)
   │       │     ├── parseProtocol()   strip tag interni di Claude Code
   │       │     ├── regexClassify()   classifica query: trivial/read/write/exec/agent
   │       │     ├── selectTools()     filtra tool per livello di attivazione
   │       │     └── buildSystem()     comprime system prompt 8000→20 token
   │       │
   │       ├── nano-router   inietta scaffold di risposta (< 1ms)
   │       ├── planner       piano task per query complesse (< 1ms)
   │       └── inspector     quality control post-generazione (< 2ms)
   │
   └── cc-haha (foreground — interfaccia TUI di Claude Code)
           ├── HAIKU  → qwen2.5-coder:7b  (query triviali)
           ├── SONNET → gemma4:e4b         (coding, spiegazioni)
           └── OPUS   → gemma4:e4b         (agent, tool use, ragionamento)
```

---

## La scoperta chiave: Vulkan + gemma4

gemma4:e4b nasce per girare su dispositivi edge (telefoni, tablet con NPU).  
Su Windows con AMD, Ollama usa **Vulkan** per offloadare i layer alla GPU:

```
gemma4:e4b (10 GB totali)
  ├── 42/43 layer → AMD Radeon Pro WX3200 (Vulkan)  ← veloci
  └──  1/43 layer → CPU                              ← solo output layer
```

Risultato: **5.1 tok/s** invece di 2.1 tok/s su CPU pura.  
**Vulkan deve essere attivato esplicitamente** — l'aggiornamento automatico di Ollama lo resetta.  
`skinny.cmd` lo avvia sempre correttamente via bash.

---

## Stack modelli

| Modello | Dimensione | Velocità | Uso |
|---------|-----------|---------|-----|
| **gemma4:e4b** | 10 GB (Q4_K_M, 8B param) | ~5 tok/s GPU | coding, agent, reasoning |
| **qwen2.5-coder:7b** | 4.7 GB (Q4_K_M) | ~3 tok/s split | fallback query triviali |
| **nomic-embed-text** | 274 MB | — | vector memory (opzionale) |
| **moondream** | 1.7 GB | — | vision MCP (on-demand) |

> **Perché gemma4 è più veloce del 7b su questo hardware?**  
> Il 7b (4.7 GB) supera i 4 GB di VRAM → split GPU+CPU → bottleneck.  
> gemma4 (10 GB) con Vulkan mette 42/43 layer nella VRAM AMD dedicata  
> (usando anche la shared memory dell'Intel UHD 620) → quasi tutto su GPU.

---

## Cortex — il cervello del proxy

Il sistema più importante è il **cortex** (dentro `inspector.ts`).  
Intercetta ogni richiesta di Claude Code *prima* che arrivi al modello:

### 1. Tag Registry — protocollo interno di Claude Code
Claude Code inietta tag speciali nei messaggi (`<system-reminder>`, `<function_calls>`, `<function_results>`, ecc.).  
I modelli locali non sono stati addestrati su questi tag e li interpretano male.  
Il cortex li riconosce, li rimuove o li converte in testo piano prima della classificazione.

### 2. Classificazione query (regex, < 1ms)
```
trivial  → "ciao", "ok", "grazie"          → dormant → 7b
read     → "spiega", "cerca", "mostra"     → light   → gemma4
write    → "scrivi", "crea", "modifica"    → light   → gemma4
exec     → "esegui", "installa", "testa"   → light   → gemma4
agent    → "pianifica", "multi-step"       → active  → gemma4
```

### 3. Compressione system prompt
Claude Code invia ~8000 token di system prompt (descrizione di tutti i tool, istruzioni, ecc.).  
Il cortex lo comprime drasticamente per livello:

| Livello | System prompt | Tool |
|---------|--------------|------|
| dormant | 8 token | nessuno |
| light   | 20 token | solo search/web |
| active  | primi 900 char dell'originale | tutti (compressi) |

### 4. CC_TOOLS Registry
Mappa tutti i tool nativi di Claude Code (`Read`, `Edit`, `Bash`, `Agent`, ecc.) al livello minimo di attivazione necessario:
- `Read`, `Glob`, `Grep` → light (basta il 7b)
- `Edit`, `Write`, `Bash` → active (serve gemma4)
- `Agent`, `TaskCreate` → active

---

## Inspector — quality control post-generazione

Dopo che il modello risponde, l'inspector analizza il testo (< 2ms, nessuna AI):

| Controllo | Azione |
|-----------|--------|
| Filler phrases ("I hope this helps", "Certainly!") | Rimossi silenziosamente |
| Risposta ripetitiva | Troncata all'ultimo confine pulito |
| Rilevanza < 25% dei termini della query | Appende `-allucined` |
| Blocco codice non chiuso / frase troncata | Appende `-stopped` |

---

## Hardware testato e performance

```
CPU:  Intel Core i5-8265U @ 1.60GHz (4C/8T) — 2018
RAM:  8 GB DDR4
GPU:  AMD Radeon Pro WX3200 4GB VRAM (Vulkan)
OS:   Windows 11 Pro
```

| Query | Modello | Tempo |
|-------|---------|-------|
| "ciao" | qwen2.5-coder:7b | ~12s |
| "scrivi fibonacci in Python" (80 tok) | gemma4:e4b | ~15s |
| Tool use (Read + Edit) | gemma4:e4b | ~30-60s |

*I tempi includono prompt evaluation. Per query successive (modello già caricato) è più veloce.*

---

## Setup

### Prerequisiti
- [Ollama](https://ollama.ai) (≥ 0.23.1)
- [Bun](https://bun.sh)
- [Git for Windows](https://git-scm.com/download/win) (include bash.exe)
- **[cc-haha](https://github.com/NanmiCoder/cc-haha)** — interfaccia TUI Claude Code

### Installazione

```powershell
# 1. Clona questo repo
git clone https://github.com/H8dboy/SkinnyAI
cd SkinnyAI

# 2. Scarica i modelli
ollama pull gemma4:e4b
ollama pull qwen2.5-coder:7b-instruct-q4_K_M
ollama pull moondream

# 3. Imposta la variabile per cc-haha
set CCHAHA_DIR=C:\path\to\cc-haha-main

# 4. Avvia
skinny
```

### Prima esecuzione
Al primo avvio, `skinny`:
1. Termina eventuali processi ollama esistenti
2. Avvia `ollama serve` con `OLLAMA_VULKAN=1` (via bash — necessario per ereditarietà env var)
3. Attende che ollama sia pronto
4. Pre-carica gemma4 in GPU (42 layer su AMD, ~60s la prima volta)
5. Avvia il proxy sulla porta 4000
6. Lancia cc-haha

### Variabile d'ambiente obbligatoria
```powershell
# In PowerShell (permanente):
[Environment]::SetEnvironmentVariable("CCHAHA_DIR", "C:\path\to\cc-haha-main", "User")

# O al volo:
set CCHAHA_DIR=C:\path\to\cc-haha-main
skinny
```

---

## File

| File | Descrizione |
|------|-------------|
| `skinny.cmd` | Entry point — avvia tutto |
| `proxy.ts` | Bridge Anthropic API → Ollama (porta 4000) |
| `inspector.ts` | Cortex (pre-processing) + Inspector (post-processing) |
| `nano-router.ts` | Router sub-millisecondo + injection scaffold |
| `planner.ts` | Generatore piani task per query complesse |
| `dna-reader.ts` | Analisi offline pesi modello → mappa routing |
| `proxy-run.cmd` | Loop di restart proxy |
| `vision-mcp.ts` | MCP server: see_screen, read_screen_memory |
| `fetch-mcp.ts` | MCP server: fetch URL |
| `screen-watcher.ts` | Osservatore schermo passivo → file memoria |
| `vector-memory.ts` | Memoria vettoriale (opzionale, richiede nomic-embed-text) |
| `routing/routing-config.json` | Config cluster nano-router |

---

## Perché non usare direttamente Ollama?

Claude Code è progettato per girare con i modelli Anthropic (Haiku/Sonnet/Opus) che hanno:
- System prompt di 8000+ token
- Tool use strutturato con JSON schema
- Tag di protocollo interni (`<function_calls>`, `<system-reminder>`, ecc.)

I modelli locali non reggono tutto questo. SkinnyAI fa da traduttore:
comprime, filtra, adatta ogni richiesta al modello locale disponibile,
e restituisce risposte nel formato che Claude Code si aspetta.

---

## Contribuire

PR benvenute. Se hai hardware simile (4-8 GB VRAM, < 16 GB RAM) e vuoi testare:
apri una issue con le tue specifiche e i tempi misurati.

L'obiettivo è costruire un reference stack che funzioni su hardware del 2018-2020
senza sacrificare le funzionalità di Claude Code.
