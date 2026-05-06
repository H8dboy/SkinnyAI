/**
 * Inspector — pipeline unificata pre + post generazione.
 *
 * PRE  (cortexProcess): riceve la richiesta da Claude Code, analizza i tag
 *      di protocollo, classifica il task con smollm, comprime system prompt
 *      e tool definitions, sveglia il modello dormiente minimo necessario.
 *
 * POST (inspect): riceve la risposta del modello, strip filler, tronca
 *      ripetizioni, rileva risposte incomplete e allucinazioni.
 *
 * Nessuna AI attivata nel pre-processing ad eccezione del classificatore
 * smollm2:135m (già dormiente in RAM, < 800ms, fallback a regex).
 */

// ═══════════════════════════════════════════════════════════════════════════════
// SEZIONE 1 — TIPI CONDIVISI
// ═══════════════════════════════════════════════════════════════════════════════

interface Content {
  type:         string
  text?:        string
  name?:        string
  tool_use_id?: string
  content?:     string | Content[]
}
interface Message { role: string; content: string | Content[] }
interface Tool    { name: string; description?: string; input_schema: Record<string, unknown> }

export interface CortexRequest {
  model:        string
  system?:      string | { type: string; text: string }[]
  messages:     Message[]
  tools?:       Tool[]
  tool_choice?: unknown
  [k: string]:  unknown
}

export interface CortexResult {
  level:  "dormant" | "light" | "active"
  model:  string
  numCtx: number
  reason: string
}

export interface HistoryCtx {
  turnCount:    number
  priorTopics:  string[]
  priorReplies: string[]
}

export const EMPTY_HISTORY: HistoryCtx = { turnCount: 0, priorTopics: [], priorReplies: [] }

type Level = "dormant" | "light" | "active"
type Cat   = "search" | "modify" | "exec" | "agent" | "web" | "meta" | "notebook"

const LEVEL_RANK: Record<Level, number> = { dormant: 0, light: 1, active: 2 }
function maxLevel(a: Level, b: Level): Level {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEZIONE 2 — REGISTRY TAG PROTOCOLLO INTERNO DI CLAUDE CODE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Claude (Opus/Sonnet) conosce questi tag perché ci è stato addestrato sopra.
// I modelli locali non li conoscono. L'inspector li interpreta qui al loro posto.
//
// action  → strip: rimuovi dal testo | extract: estrai contenuto | translate: converti in testo piano
// signal  → livello minimo di attivazione imposto dalla presenza del tag

type TagAction = "strip" | "extract" | "translate"
interface TagSpec { action: TagAction; signal?: Level; label?: string }

const TAG_REGISTRY: Record<string, TagSpec> = {
  // ── Injections runtime (Claude Code → conversazione) ──────────────────────
  "system-reminder":          { action: "strip",                       label: "runtime reminder"       },
  "user-prompt-submit-hook":  { action: "strip",                       label: "hook output"            },
  "context":                  { action: "extract",                     label: "injected context"       },

  // ── Protocollo chiamata tool (modello → Claude Code) ──────────────────────
  "antml:function_calls":     { action: "extract", signal: "active",   label: "tool call attempt"      },
  "antml:invoke":             { action: "extract", signal: "active",   label: "tool invocation"        },
  "antml:parameter":          { action: "extract",                     label: "tool parameter"         },

  // ── Protocollo risultato tool (Claude Code → modello) ─────────────────────
  "function_results":         { action: "extract", signal: "active",   label: "tool results"           },
  "result":                   { action: "extract",                     label: "tool result content"    },

  // ── Protocollo skill / command ─────────────────────────────────────────────
  "command-name":             { action: "extract", signal: "active",   label: "skill invocation"       },
  "skill":                    { action: "extract", signal: "active",   label: "skill call"             },

  // ── Definizioni funzioni / schemi ──────────────────────────────────────────
  "functions":                { action: "strip",                       label: "function definitions"   },
  "function":                 { action: "strip",                       label: "function schema"        },

  // ── Protocollo plan / task ─────────────────────────────────────────────────
  "plan":                     { action: "extract", signal: "active",   label: "task plan"              },
  "task":                     { action: "extract", signal: "active",   label: "task definition"        },

  // ── Memory / sessione ─────────────────────────────────────────────────────
  "memory":                   { action: "extract", signal: "light",    label: "memory content"         },
  "session":                  { action: "strip",                       label: "session metadata"       },

  // ── Loop / automazione ────────────────────────────────────────────────────
  "loop":                     { action: "extract", signal: "active",   label: "loop instruction"       },
  "cron":                     { action: "extract", signal: "active",   label: "cron schedule"          },
}

export interface ParsedProtocol {
  cleanText:  string
  extracted:  Record<string, string[]>
  minLevel:   Level
  tagsFound:  string[]
}

const TAG_BLOCK_RE = /<([a-zA-Z_:][a-zA-Z0-9_:\-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g

export function parseProtocol(text: string): ParsedProtocol {
  const extracted: Record<string, string[]> = {}
  const tagsFound: string[] = []
  let minLevel: Level = "dormant"

  const cleanText = text.replace(TAG_BLOCK_RE, (match, tagName: string) => {
    const spec = TAG_REGISTRY[tagName.toLowerCase()]
    if (!spec) return match

    tagsFound.push(tagName)
    if (spec.signal && LEVEL_RANK[spec.signal] > LEVEL_RANK[minLevel])
      minLevel = spec.signal

    if (spec.action === "strip") return ""

    const inner = match
      .replace(new RegExp(`^<${tagName}[^>]*>`, "i"), "")
      .replace(new RegExp(`</${tagName}>$`, "i"), "")
      .trim()

    const key = spec.label ?? tagName
    if (!extracted[key]) extracted[key] = []
    if (inner) extracted[key].push(inner)

    return spec.action === "translate" ? `[${key}: ${inner.slice(0, 120)}]` : ""
  }).replace(/\s{3,}/g, "\n\n").trim()

  return { cleanText, extracted, minLevel, tagsFound }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEZIONE 3 — REGISTRY TOOL NATIVI DI CLAUDE CODE
// ═══════════════════════════════════════════════════════════════════════════════

interface ToolSpec { min: Level; cat: Cat }

const CC_TOOLS: Record<string, ToolSpec> = {
  // Lettura filesystem
  Read:                 { min: "light",  cat: "search"   },
  Glob:                 { min: "light",  cat: "search"   },
  Grep:                 { min: "light",  cat: "search"   },
  LSP:                  { min: "light",  cat: "search"   },
  ToolSearch:           { min: "light",  cat: "search"   },
  // Scrittura filesystem
  Edit:                 { min: "active", cat: "modify"   },
  Write:                { min: "active", cat: "modify"   },
  NotebookEdit:         { min: "active", cat: "notebook" },
  // Esecuzione shell
  Bash:                 { min: "active", cat: "exec"     },
  Monitor:              { min: "active", cat: "exec"     },
  // Web
  WebSearch:            { min: "light",  cat: "web"      },
  WebFetch:             { min: "light",  cat: "web"      },
  // Agent / orchestrazione
  Agent:                { min: "active", cat: "agent"    },
  TaskCreate:           { min: "active", cat: "agent"    },
  TaskUpdate:           { min: "active", cat: "agent"    },
  TaskGet:              { min: "active", cat: "agent"    },
  TaskList:             { min: "active", cat: "agent"    },
  TaskStop:             { min: "active", cat: "agent"    },
  TaskOutput:           { min: "active", cat: "agent"    },
  RemoteTrigger:        { min: "active", cat: "agent"    },
  Skill:                { min: "active", cat: "agent"    },
  // Modalità plan / worktree
  EnterPlanMode:        { min: "active", cat: "meta"     },
  ExitPlanMode:         { min: "active", cat: "meta"     },
  EnterWorktree:        { min: "active", cat: "meta"     },
  ExitWorktree:         { min: "active", cat: "meta"     },
  // Interazione / scheduling
  AskUserQuestion:      { min: "light",  cat: "meta"     },
  PushNotification:     { min: "active", cat: "meta"     },
  ScheduleWakeup:       { min: "active", cat: "meta"     },
  CronCreate:           { min: "active", cat: "meta"     },
  CronDelete:           { min: "active", cat: "meta"     },
  CronList:             { min: "light",  cat: "meta"     },
  ShareOnboardingGuide: { min: "active", cat: "meta"     },
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEZIONE 4 — PRE-PROCESSING (ex cortex.ts)
// ═══════════════════════════════════════════════════════════════════════════════

// gemma4:e4b con Vulkan: 42/43 layer su GPU AMD → 5.1 tok/s.
// 7b (Q4, 4.7GB) supera i 4GB VRAM → split GPU+CPU → 3 tok/s + reload time.
// Con OLLAMA_MAX_LOADED_MODELS=1, switchare 7b↔gemma4 costa 40-60s di reload.
// Soluzione: un solo modello per tutti i livelli — gemma4 già caldo non va mai evicto.
const MODELS: Record<Level, string> = {
  dormant: "gemma4:e4b",
  light:   "gemma4:e4b",
  active:  "gemma4:e4b",
}
const CTX: Record<Level, number> = { dormant: 2048, light: 2048, active: 2048 }

const SYS_DORMANT    = "You are a helpful assistant. Be brief."
const SYS_LIGHT      = "You are a coding assistant. Write clean correct code. Use tools only when needed. Be concise."
const SYS_ACTIVE_MAX = 900

function buildSystem(sys: CortexRequest["system"], level: Level): string {
  if (level === "dormant") return SYS_DORMANT
  if (level === "light")   return SYS_LIGHT
  if (!sys) return SYS_LIGHT
  const raw = typeof sys === "string" ? sys : sys.filter(b => b.type === "text").map(b => b.text).join("\n")
  return raw.slice(0, SYS_ACTIVE_MAX)
}

function compressSchema(s: Record<string, unknown>): Record<string, unknown> {
  const props = s.properties as Record<string, Record<string, unknown>> | undefined
  if (!props) return { type: s.type }
  const slim: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props))
    slim[k] = v.enum ? { type: v.type, enum: v.enum } : { type: v.type }
  return { type: s.type, required: s.required ?? [], properties: slim }
}

function slimTool(t: Tool): Tool {
  return { name: t.name, description: (t.description ?? "").slice(0, 80), input_schema: compressSchema(t.input_schema) }
}

function selectTools(tools: Tool[] | undefined, level: Level, cats: Set<Cat>): Tool[] | undefined {
  if (!tools?.length || level === "dormant") return undefined
  if (level === "active") return tools.map(slimTool)
  const allowed = tools.filter(t => {
    const s = CC_TOOLS[t.name]
    return s && LEVEL_RANK[s.min] <= LEVEL_RANK["light"] && cats.has(s.cat)
  })
  return allowed.length ? allowed.map(slimTool) : undefined
}

function extractLastUserText(messages: Message[]): { query: string; protoLevel: Level } {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== "user") continue
    const c   = messages[i].content
    const raw = typeof c === "string"
      ? c
      : (c as Content[]).filter(b => b.type === "text").map(b => b.text ?? "").join(" ")
    const { cleanText, minLevel, tagsFound } = parseProtocol(raw)
    if (tagsFound.length) console.log(`[inspector] protocol tags: ${tagsFound.join(", ")}`)
    if (cleanText.length > 0) return { query: cleanText, protoLevel: minLevel }
  }
  return { query: "", protoLevel: "dormant" }
}

function usedToolNames(messages: Message[]): Set<string> {
  const names = new Set<string>()
  for (const m of messages.slice(-8)) {
    if (typeof m.content === "string") continue
    for (const b of m.content as Content[])
      if (b.type === "tool_use" && b.name) names.add(b.name)
  }
  return names
}

const TRIVIAL_WORDS = new Set([
  "ciao","hello","hi","hey","grazie","thanks","ok","sì","si","no","bene",
  "perfetto","esatto","capito","giusto","vero","dai","allora","va","sure",
  "yes","bye","salve","buongiorno","prego","okay","yep","nope",
])

const SIG_MODIFY = [
  /\b(modifica|scrivi|crea|aggiung|rimuov|cancell|esegui|installa|costruisci|implementa|refactor|salva|rinomina)\w*/i,
  /\b(edit|write|create|delete|remove|execute|run|build|install|implement|deploy|fix|save|rename|move)\b/i,
]
const SIG_EXEC = [
  /\b(esegui|avvia|lancia|testa|compila|builda|installa)\w*/i,
  /\b(run|execute|launch|test|compile|build|install|start|restart)\b/i,
  /\bnpm |yarn |bun |python |node |cargo |go run\b/i,
]
const SIG_SEARCH = [
  /\b(leggi|mostra|vedi|trova|cerca|analizza|spiega|apri|guarda|lista)\w*/i,
  /\b(read|show|find|search|list|look|check|open|explain|analyze|grep|glob)\b/i,
  /\.[a-z]{1,6}\b/,
]
const SIG_WEB   = [
  /\b(cerca online|cerca su|cerca nel web)\b/i,
  /\b(search online|look up|fetch|scrape)\b/i,
  /https?:\/\//,
]
const SIG_AGENT = [
  /\b(agente|sotto.?agente|pianifica|multi.?step|parallelo)\b/i,
  /\b(agent|spawn|plan|multi.?step|parallel|orchestrate|schedule)\b/i,
]

// ── Classificatore neurale (smollm2:135m dormiente in RAM) ────────────────────

const CLASSIFIER_PROMPT =
  "Classify the user request with ONE word only.\n" +
  "Options: trivial | read | write | exec | agent\n" +
  "trivial = greetings, yes/no, chitchat\n" +
  "read    = explain code, search files, read content\n" +
  "write   = edit files, create code, refactor\n" +
  "exec    = run commands, tests, builds, installs\n" +
  "agent   = multi-step plans, spawn agents, schedules\n" +
  "Reply with the single word, nothing else."

type ClsLabel = "trivial" | "read" | "write" | "exec" | "agent"

async function neuralClassify(query: string): Promise<ClsLabel> {
  // qwen2.5-coder:0.5b ignora le istruzioni di classificazione e genera codice.
  // La regex è istantanea e precisa per i pattern IT+EN — nessun overhead neurale.
  return regexClassify(query)
}

function regexClassify(query: string): ClsLabel {
  if (SIG_AGENT.some(r => r.test(query)))  return "agent"
  if (SIG_MODIFY.some(r => r.test(query))) return "write"
  if (SIG_EXEC.some(r => r.test(query)))   return "exec"
  if (SIG_SEARCH.some(r => r.test(query))) return "read"
  const words = query.trim().split(/\s+/)
  return words.length <= 3 && words.every(w => TRIVIAL_WORDS.has(w.toLowerCase())) ? "trivial" : "read"
}

function clsToLevel(cls: ClsLabel): Level {
  if (cls === "trivial") return "dormant"
  if (cls === "agent")   return "active"   // solo multi-step → gemma4
  return "light"                           // read/write/exec → 7b (GPU, ~30s)
}

function clsToCats(cls: ClsLabel): Set<Cat> {
  const c = new Set<Cat>()
  if (cls === "read")  { c.add("search"); c.add("web") }
  if (cls === "write") { c.add("modify"); c.add("search") }
  if (cls === "exec")  { c.add("exec");   c.add("modify"); c.add("search") }
  if (cls === "agent") { c.add("agent");  c.add("exec");   c.add("modify"); c.add("search") }
  return c
}

export async function cortexProcess(
  req: CortexRequest,
): Promise<{ req: CortexRequest; result: CortexResult }> {

  const { query, protoLevel } = extractLastUserText(req.messages)
  const words     = query.trim().split(/\s+/).filter(Boolean)
  const usedTools = usedToolNames(req.messages)

  let level: Level = protoLevel
  let reason = protoLevel !== "dormant" ? "protocol tag" : "trivial"

  // Vincoli dai tool usati in storia
  for (const name of usedTools) {
    const s = CC_TOOLS[name]
    if (s) level = maxLevel(level, s.min)
  }
  if (usedTools.size) reason = `history: ${[...usedTools].slice(0, 3).join(", ")}`

  // MCP tool → sempre active
  if (req.tools?.some(t => t.name.startsWith("mcp__"))) level = maxLevel(level, "active")

  // Classificatore neurale
  console.log(`[inspector] query="${query.slice(0, 80)}"`)
  const cls       = await neuralClassify(query)
  const needsCats = clsToCats(cls)
  level  = maxLevel(level, clsToLevel(cls))
  if (reason === "trivial") reason = `neural: ${cls}`

  // Fallback word count: solo dormant→light
  if (level === "dormant" && words.length > 5) { level = "light"; reason = "non-trivial query" }

  const keep  = level === "dormant" ? 2 : level === "light" ? 6 : 12
  const tools = selectTools(req.tools, level, needsCats)

  const compressed: CortexRequest = {
    ...req,
    model:    MODELS[level],
    system:   buildSystem(req.system, level),
    messages: req.messages.slice(-keep),
    tools,
  }
  if (!tools) delete compressed.tool_choice

  return {
    req:    compressed,
    result: { level, model: MODELS[level], numCtx: CTX[level], reason },
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEZIONE 5 — POST-PROCESSING (quality control sulla risposta)
// ═══════════════════════════════════════════════════════════════════════════════

const STOP_WORDS = new Set([
  "the","a","an","is","are","was","were","it","this","that","be","to","of","and","or",
  "in","on","at","for","with","as","by","from","i","you","we","they","he","she","do",
  "not","but","if","so","can","will","my","your","its","their","our","have","has",
  "had","just","also","get","use","all","any","more","no","yes","ok","up","down",
  "il","la","lo","le","gli","un","una","uno","di","da","in","con","su","per",
  "tra","fra","che","chi","cui","non","si","mi","ti","ci","vi","ne","ho","ha",
  "ai","al","del","della","dello","delle","dei","degli","nel","nella","nei",
  "nelle","sul","sulla","sui","sulle","col","coi",
])

const FILLER: RegExp[] = [
  /\bI hope (?:this|that) helps[.!]?\b/gi,
  /\bLet me know if (?:you )?(?:have|need|want)[^.!?]{0,60}[.!?]/gi,
  /\bFeel free to ask[^.!?]{0,60}[.!?]/gi,
  /\bDon'?t hesitate to[^.!?]{0,60}[.!?]/gi,
  /\bIf you (?:have|need) (?:any )?(?:more )?(?:questions|help)[^.!?]{0,60}[.!?]/gi,
  /\bAs an AI(?: language model)?\b[^.!?\n]{0,80}[.!?]/gi,
  /\bHappy to help[.!]?/gi,
  /\bOf course[!.]?\s*/gi,
  /\bCertainly[!.]?\s*/gi,
  /\bAbsolutely[!.]?\s*/gi,
  /\bSure[!.]?\s+(?=\w)/gi,
  /\bGreat question[!.]?\s*/gi,
  /\bSpero (?:che )?(?:questo|la risposta) (?:ti |vi )?(?:sia utile|aiuti)[.!]?/gi,
  /\bFammi sapere se[^.!?]{0,60}[.!?]/gi,
  /\bCerto(?:,| )[.!]?\s*/gi,
  /\bAssolutamente[.!]?\s*/gi,
  /\bNaturalmente[.!]?\s*/gi,
]

function keyTerms(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/\b[a-zà-ü][a-zà-ü0-9_]{2,}\b/g) ?? []
  return new Set(tokens.filter(t => !STOP_WORDS.has(t)))
}

function relevance(query: string, response: string): number {
  const qt = keyTerms(query)
  if (qt.size === 0) return 1
  const rl = response.toLowerCase()
  let hits = 0
  for (const t of qt) if (rl.includes(t)) hits++
  return hits / qt.size
}

function tailHasRepetition(text: string, frac = 0.30): boolean {
  if (text.length < 300) return false
  const tail      = text.slice(Math.floor(text.length * (1 - frac)))
  const sentences = tail.split(/(?<=[.!?])\s+/).filter(s => s.length > 25)
  if (sentences.length < 3) return false
  const unique = new Set(sentences.map(s => s.toLowerCase().trim()))
  return unique.size < sentences.length * 0.55
}

function truncateAt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const cut = Math.max(
    ...[slice.lastIndexOf("\n\n"), slice.lastIndexOf("```\n") + 3,
        slice.lastIndexOf(". "),  slice.lastIndexOf(".\n")]
      .filter(i => i > maxChars * 0.5),
    maxChars,
  )
  return text.slice(0, cut).trimEnd()
}

function stripFiller(text: string): string {
  let out = text
  for (const re of FILLER) out = out.replace(re, "")
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

function checkStopped(query: string, response: string): { flag: boolean; reason: string } {
  const r = response.trimEnd()
  if ((r.match(/```/g) ?? []).length % 2 !== 0)
    return { flag: true, reason: "unclosed code block" }
  const last = r.at(-1) ?? ""
  if (r.length > 20 && !".!?`'\"*_)]\n".includes(last))
    return { flag: true, reason: "truncated mid-sentence" }
  if (/\b(write|create|implement|build|generate|code|scrivi|crea|implementa|costruisci)\b/i.test(query) &&
      !/```/.test(r) && r.length < 250)
    return { flag: true, reason: "code requested but missing" }
  const ands = (query.match(/\b(and|e|,)\b/gi) ?? []).length
  if (ands >= 2 && r.length < 200)
    return { flag: true, reason: "multi-part query, response too short" }
  const listMatch = query.match(/\b(\d+)\s+(?:steps?|ways?|items?|things?|examples?|passi?|modi?|esempi?)\b/i)
  if (listMatch) {
    const expected = parseInt(listMatch[1])
    const found    = (r.match(/^\s*\d+[.)]/gm) ?? []).length
    if (found > 0 && found < expected)
      return { flag: true, reason: `expected ${expected} items, found ${found}` }
  }
  if (/\b(in the next|nella prossima|di seguito|vediamo ora|ora vedremo)\b/i.test(r) && r.length < 500)
    return { flag: true, reason: "promises continuation that never comes" }
  return { flag: false, reason: "" }
}

function checkAllucined(
  query: string, response: string, history: HistoryCtx,
): { flag: boolean; reasons: string[] } {
  const reasons: string[] = []

  if (/\b(as i mentioned|as mentioned earlier|as i said|come dicevo|come ho detto)\b/i.test(response)) {
    if (history.turnCount === 0) {
      reasons.push("self-reference with no prior turns")
    } else {
      const refMatch = response.match(/as i mentioned[^.]{0,60}/i)
      if (refMatch) {
        const claimed   = keyTerms(refMatch[0])
        const priorText = history.priorReplies.join(" ").toLowerCase()
        const covered   = [...claimed].filter(t => priorText.includes(t)).length
        if (covered < claimed.size * 0.4)
          reasons.push("self-reference to content not found in prior replies")
      }
    }
  }

  const urls = response.match(/https?:\/\/[^\s)\]"']+/g) ?? []
  for (const url of urls) {
    const domain = url.replace(/https?:\/\//, "").split("/")[0].replace("www.", "")
    if (!query.toLowerCase().includes(domain)) reasons.push(`unverified URL: ${url}`)
  }

  const paths = response.match(/\b[A-Za-z]:\\[^\s"'<>]{4,}/g) ?? []
  for (const p of paths)
    if (!query.includes(p.slice(0, 6))) reasons.push(`unreferenced path: ${p}`)

  if (/version \d+\.\d+/i.test(response) && !/version|\d+\.\d+/i.test(query))
    reasons.push("version number not requested in query")

  const score = relevance(query, response)
  if (score < 0.15 && keyTerms(query).size >= 6)
    reasons.push(`low relevance score: ${score.toFixed(2)}`)

  const sentences = response.split(/(?<=[.!?])\s+/).filter(s => s.length > 15)
  const normMap   = new Map<string, string>()
  for (const s of sentences) {
    const norm = s.toLowerCase().replace(/\bnot?\b/g, "¬").replace(/\s+/g, " ").trim()
    const inv  = norm.replace(/¬/g, "")
    if (normMap.has(inv)) reasons.push(`contradictory statement: "${s.slice(0, 60)}"`)
    else normMap.set(norm, s)
  }

  if (history.turnCount === 0) {
    const rTerms = keyTerms(response)
    const qTerms = keyTerms(query)
    const novel  = [...rTerms].filter(t => !qTerms.has(t) && t.length > 5)
    if (novel.length > qTerms.size * 5 && qTerms.size >= 6)
      reasons.push(`many novel topics introduced: ${novel.slice(0, 5).join(", ")}`)
  }

  return { flag: reasons.length > 0, reasons }
}

export interface InspectResult {
  text:      string
  stopped:   boolean
  allucined: boolean
  log:       string[]
}

export function inspect(
  query:    string,
  response: string,
  cluster:  string,
  history:  HistoryCtx = EMPTY_HISTORY,
): InspectResult {
  const log: string[] = []
  let text = response

  const stripped = stripFiller(text)
  if (stripped !== text) { log.push("stripped filler"); text = stripped }

  const maxChars = cluster === "coding" ? 6000 : cluster === "reasoning" ? 4000 : 2000
  if (text.length > maxChars && tailHasRepetition(text)) {
    const before = text.length
    text = truncateAt(text, maxChars)
    log.push(`truncated ${before}→${text.length} (repetition)`)
  }

  const stopped = checkStopped(query, text)
  if (stopped.flag) log.push(`-stopped: ${stopped.reason}`)

  const allucined = cluster === "trivial"
    ? { flag: false, reasons: [] }
    : checkAllucined(query, text, history)
  for (const r of allucined.reasons) log.push(`-allucined: ${r}`)

  return { text, stopped: stopped.flag, allucined: allucined.flag, log }
}
