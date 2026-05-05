/**
 * Task planner — analyzes query intent and injects a precise step-by-step
 * scaffold into the system prompt so small models follow a clear execution path.
 * Pure TypeScript, < 1ms, no AI inference.
 *
 * Tool-aware: knows about cc-haha local tools (Bash, Read, Write, Edit, Glob, Grep)
 * and adjusts the plan based on whether tools are available in the request.
 */

export interface Plan {
  type:     string
  scaffold: string
}

// ── Pattern sets (EN + IT) ────────────────────────────────────────────────────

const DEBUG_RE = /\b(debug|fix|error|bug|broken|crash|traceback|exception|doesn'?t\s+work|not\s+working|errore|non\s+funziona|non\s+va|correggi|sistema|aggiusta)\b/i

const REFACTOR_RE = /\b(refactor|clean\s*up|rewrite|improve|simplify|ottimizza|migliora|riscrivi|pulisci|semplifica|riorganizza)\b/i

const CREATE_RE = /\b(create|write|implement|build|generate|add|crea|scrivi|implementa|costruisci|aggiungi|fammi)\b.{0,40}\b(file|class|function|component|hook|endpoint|api|route|schema|script|funzione|classe|componente|modulo|pagina|controller)\b/i

const SEARCH_RE = /\b(find|search|where\s+is|which\s+file|look\s+for|show\s+me\s+where|cerca|trova|dove\s+(è|si\s+trova)|quale\s+file|in\s+quale)\b/i

const EXPLAIN_RE = /\b(explain|what\s+is|how\s+does|describe|walk\s+me\s+through|spiega|cos['è]\s+|come\s+funziona|dimmi\s+come|descrivimi)\b/i

const REVIEW_RE = /\b(review|check|audit|verify|look\s+at|read\s+through|controlla|verifica|guarda|esamina|analizza)\b.{0,30}\b(code|file|function|class|codice|file|funzione|classe)\b/i

const MULTIPART_RE = /\b(and\s+then|then\s+also|after\s+that|also|finally|e\s+poi|e\s+anche|infine|dopodiché|successivamente|poi\s+anche)\b/i

// ── Plan builder ──────────────────────────────────────────────────────────────

/**
 * @param query      last user message text
 * @param cluster    nano-router cluster: "trivial" | "coding" | "reasoning"
 * @param hasTools   true if cc-haha sent tools in the request (agentic mode)
 */
export function plan(query: string, cluster: string, hasTools: boolean): Plan | null {
  // Never plan trivial queries — they go straight to qwen
  if (cluster === "trivial") return null

  // ── Debug / fix ────────────────────────────────────────────────────────────
  if (DEBUG_RE.test(query)) {
    return {
      type: "debug",
      scaffold: hasTools
        ? `[PLAN: debug]
1. Use Read tool to open the relevant file(s).
2. State the root cause in ONE sentence.
3. Use Edit or Write tool to apply the fix.
No lengthy explanations — just read, diagnose, fix.`
        : `[PLAN: debug]
1. State the root cause in ONE sentence.
2. Show the corrected code in a code block.
Be concise. No preamble.`
    }
  }

  // ── Refactor / improve ────────────────────────────────────────────────────
  if (REFACTOR_RE.test(query)) {
    return {
      type: "refactor",
      scaffold: hasTools
        ? `[PLAN: refactor]
1. Use Read tool to read the target file.
2. Apply improvements using Edit or Write tool.
3. List changes as 2-3 bullet points after the code.
Write complete refactored code — no placeholders.`
        : `[PLAN: refactor]
1. Show the refactored code in a code block.
2. List changes as 2-3 bullet points below.
Complete code only — no placeholders.`
    }
  }

  // ── Create / implement ────────────────────────────────────────────────────
  if (CREATE_RE.test(query)) {
    return {
      type: "create",
      scaffold: hasTools
        ? `[PLAN: create]
1. Use Glob or Read to check existing structure if relevant.
2. Use Write tool to create the complete implementation.
Write fully working code — no TODOs, no placeholders.`
        : `[PLAN: create]
Write the complete, working implementation in a code block.
No TODOs. No placeholders. Production-ready code.`
    }
  }

  // ── Search / find in codebase ─────────────────────────────────────────────
  if (SEARCH_RE.test(query)) {
    return {
      type: "search",
      scaffold: hasTools
        ? `[PLAN: search]
1. Use Grep with a focused pattern to find matches.
2. Use Read to examine the 1-2 most relevant results.
3. Answer with exact file:line references.`
        : `[PLAN: search]
Describe the exact pattern to grep for and where to look.
Give the grep command the user can run directly.`
    }
  }

  // ── Code review / audit ───────────────────────────────────────────────────
  if (REVIEW_RE.test(query)) {
    return {
      type: "review",
      scaffold: hasTools
        ? `[PLAN: review]
1. Use Read to open the target file(s).
2. List issues found as numbered items (max 5).
3. For each issue: file:line — problem — fix suggestion.`
        : `[PLAN: review]
List issues as numbered items (max 5).
Format: line number — problem — suggested fix.`
    }
  }

  // ── Explain / how-does-it-work ────────────────────────────────────────────
  if (EXPLAIN_RE.test(query) && cluster === "reasoning") {
    return {
      type: "explain",
      scaffold: hasTools
        ? `[PLAN: explain]
Use Read tool first if the question references specific code.
Then explain in max 3 short paragraphs. No filler phrases.`
        : `[PLAN: explain]
Answer directly in max 3 short paragraphs. No filler.`
    }
  }

  // ── Multi-part query ──────────────────────────────────────────────────────
  const multiCount = (query.match(MULTIPART_RE) ?? []).length
  if (multiCount >= 1 && query.length > 60) {
    return {
      type: "multi-step",
      scaffold: `[PLAN: multi-step]
The task has multiple parts. Execute them in strict order.
${hasTools ? "Use tools between steps as needed. " : ""}Complete ALL parts before finishing your response.`
    }
  }

  return null
}
