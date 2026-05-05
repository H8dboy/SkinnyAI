/**
 * Inspector — post-generation quality control.
 * Pure text analysis, < 2ms, no AI activated.
 *
 * Appends:
 *   " -stopped"   → risposta incompleta / avrebbe avuto bisogno di più token
 *   " -allucined" → risposta probabilmente errata / hallucination rilevata
 *
 * Accetta HistoryCtx per validare riferimenti cross-turno.
 */

// ── History context ───────────────────────────────────────────────────────────

export interface HistoryCtx {
  turnCount:    number    // n. di turni precedenti nella conversazione
  priorTopics:  string[]  // termini chiave estratti dai turni precedenti
  priorReplies: string[]  // ultime N risposte dell'assistente (testo grezzo)
}

export const EMPTY_HISTORY: HistoryCtx = { turnCount: 0, priorTopics: [], priorReplies: [] }

// ── Stop words ────────────────────────────────────────────────────────────────

const STOP = new Set([
  "the","a","an","is","are","was","were","it","this","that","be","to","of","and","or",
  "in","on","at","for","with","as","by","from","i","you","we","they","he","she","do",
  "not","but","if","so","can","will","my","your","its","their","our","have","has",
  "had","just","also","get","use","all","any","more","no","yes","ok","up","down",
  // Italian stop words
  "il","la","lo","le","gli","un","una","uno","di","da","in","con","su","per",
  "tra","fra","che","chi","cui","non","si","mi","ti","ci","vi","ne","ho","ha",
  "ai","ai","al","del","della","dello","delle","dei","degli","nel","nella","nei",
  "nelle","sul","sulla","sui","sulle","col","coi",
])

// ── Filler patterns ───────────────────────────────────────────────────────────

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
  // Italian filler
  /\bSpero (?:che )?(?:questo|la risposta) (?:ti |vi )?(?:sia utile|aiuti)[.!]?/gi,
  /\bFammi sapere se[^.!?]{0,60}[.!?]/gi,
  /\bCerto(?:,| )[.!]?\s*/gi,
  /\bAssolutamente[.!]?\s*/gi,
  /\bNaturalmente[.!]?\s*/gi,
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function keyTerms(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/\b[a-zà-ü][a-zà-ü0-9_]{2,}\b/g) ?? []
  return new Set(tokens.filter(t => !STOP.has(t)))
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
  const tail = text.slice(Math.floor(text.length * (1 - frac)))
  const sentences = tail.split(/(?<=[.!?])\s+/).filter(s => s.length > 25)
  if (sentences.length < 3) return false
  const unique = new Set(sentences.map(s => s.toLowerCase().trim()))
  return unique.size < sentences.length * 0.55
}

function truncateAt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const candidates = [
    slice.lastIndexOf("\n\n"),
    slice.lastIndexOf("```\n") + 3,
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
  ].filter(i => i > maxChars * 0.5)
  const cut = candidates.length ? Math.max(...candidates) + 1 : maxChars
  return text.slice(0, cut).trimEnd()
}

function stripFiller(text: string): string {
  let out = text
  for (const re of FILLER) out = out.replace(re, "")
  return out.replace(/\n{3,}/g, "\n\n").trim()
}

// ── -stopped: incompleteness detection ───────────────────────────────────────

function checkStopped(query: string, response: string): { flag: boolean; reason: string } {
  const r = response.trimEnd()

  // Unclosed code block
  if ((r.match(/```/g) ?? []).length % 2 !== 0)
    return { flag: true, reason: "unclosed code block" }

  // Ends mid-sentence
  const last = r.at(-1) ?? ""
  if (r.length > 20 && !".!?`'\"*_)]\n".includes(last))
    return { flag: true, reason: "truncated mid-sentence" }

  // Code requested but not present
  if (/\b(write|create|implement|build|generate|code|scrivi|crea|implementa|costruisci)\b/i.test(query) &&
      !/```/.test(r) && r.length < 250)
    return { flag: true, reason: "code requested but missing" }

  // Multi-part query with very short answer
  const ands = (query.match(/\b(and|e|,)\b/gi) ?? []).length
  if (ands >= 2 && r.length < 200)
    return { flag: true, reason: "multi-part query, response too short" }

  // Numbered list mismatch
  const listMatch = query.match(/\b(\d+)\s+(?:steps?|ways?|items?|things?|examples?|passi?|modi?|esempi?)\b/i)
  if (listMatch) {
    const expected = parseInt(listMatch[1])
    const found    = (r.match(/^\s*\d+[.)]/gm) ?? []).length
    if (found > 0 && found < expected)
      return { flag: true, reason: `expected ${expected} items, found ${found}` }
  }

  // Response references "next" or "following" section but then stops
  if (/\b(in the next|nella prossima|di seguito|vediamo ora|ora vedremo)\b/i.test(r) &&
      r.length < 500)
    return { flag: true, reason: "promises continuation that never comes" }

  return { flag: false, reason: "" }
}

// ── -allucined: hallucination detection ───────────────────────────────────────

function checkAllucined(
  query: string,
  response: string,
  history: HistoryCtx,
): { flag: boolean; reasons: string[] } {
  const reasons: string[] = []
  const rl = response.toLowerCase()

  // Self-reference without prior context
  if (/\b(as i mentioned|as mentioned earlier|as noted before|as i said|come dicevo|come ho detto)\b/i.test(response)) {
    if (history.turnCount === 0)
      reasons.push("self-reference with no prior turns")
    else {
      // Check if referenced topic was actually in prior replies
      const refMatch = response.match(/as i mentioned[^.]{0,60}/i)
      if (refMatch) {
        const claimed = keyTerms(refMatch[0])
        const priorText = history.priorReplies.join(" ").toLowerCase()
        const covered = [...claimed].filter(t => priorText.includes(t)).length
        if (covered < claimed.size * 0.4)
          reasons.push("self-reference to content not found in prior replies")
      }
    }
  }

  // Invented URLs not in query
  const urls = response.match(/https?:\/\/[^\s)\]"']+/g) ?? []
  for (const url of urls) {
    const domain = url.replace(/https?:\/\//, "").split("/")[0].replace("www.", "")
    if (!query.toLowerCase().includes(domain))
      reasons.push(`unverified URL: ${url}`)
  }

  // File paths not in query
  const paths = response.match(/\b[A-Za-z]:\\[^\s"'<>]{4,}/g) ?? []
  for (const p of paths)
    if (!query.includes(p.slice(0, 6))) reasons.push(`unreferenced path: ${p}`)

  // Specific version numbers not requested
  if (/version \d+\.\d+/i.test(response) && !/version|\d+\.\d+/i.test(query))
    reasons.push("version number not requested in query")

  // Low relevance to query (only for substantive queries)
  const score = relevance(query, response)
  if (score < 0.15 && keyTerms(query).size >= 6)
    reasons.push(`low relevance score: ${score.toFixed(2)}`)

  // Repeated contradictory sentences (negation flip)
  const sentences = response.split(/(?<=[.!?])\s+/).filter(s => s.length > 15)
  const normMap = new Map<string, string>()
  for (const s of sentences) {
    const norm = s.toLowerCase().replace(/\bnot?\b/g, "¬").replace(/\s+/g, " ").trim()
    const inv  = norm.replace(/¬/g, "")
    if (normMap.has(inv)) reasons.push(`contradictory statement: "${s.slice(0, 60)}"`)
    else normMap.set(norm, s)
  }

  // Topics introduced in response that have no root in query AND no prior context
  if (history.turnCount === 0) {
    const responseTerms = keyTerms(response)
    const queryTerms    = keyTerms(query)
    const novel = [...responseTerms].filter(t => !queryTerms.has(t) && t.length > 5)
    if (novel.length > queryTerms.size * 5 && queryTerms.size >= 6)
      reasons.push(`many novel topics introduced: ${novel.slice(0, 5).join(", ")}`)
  }

  return { flag: reasons.length > 0, reasons }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface InspectResult {
  text:      string    // cleaned and possibly truncated
  stopped:   boolean   // append " -stopped"
  allucined: boolean   // append " -allucined"
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

  // 1. Strip filler
  const stripped = stripFiller(text)
  if (stripped !== text) { log.push("stripped filler"); text = stripped }

  // 2. Truncate repetitive / oversized responses
  const maxChars = cluster === "coding" ? 6000 : cluster === "reasoning" ? 4000 : 2000
  if (text.length > maxChars && tailHasRepetition(text)) {
    const before = text.length
    text = truncateAt(text, maxChars)
    log.push(`truncated ${before}→${text.length} (repetition)`)
  }

  // 3. -stopped check
  const stopped = checkStopped(query, text)
  if (stopped.flag) log.push(`-stopped: ${stopped.reason}`)

  // 4. -allucined check (skip for trivial — greetings and one-liners are always fine)
  const allucined = cluster === "trivial"
    ? { flag: false, reasons: [] }
    : checkAllucined(query, text, history)
  for (const r of allucined.reasons) log.push(`-allucined: ${r}`)

  return {
    text,
    stopped:   stopped.flag,
    allucined: allucined.flag,
    log,
  }
}
