/**
 * Nano Router — carica la routing map una volta in RAM, instrada ogni query
 * al modello giusto in < 1ms. Nessuna AI attivata.
 *
 * Routing a tre livelli (dal più specifico al più generico):
 *   1. Phrase patterns (regex, peso 3) — cattura "perché il mio codice non va"
 *   2. Token set (parole singole EN+IT, peso 1) — cattura keyword esplicite
 *   3. Fallback: trivial → qwen2.5-coder:0.5b
 */

import { readFileSync, existsSync } from "fs"
import { join } from "path"

const ROUTING_DIR = join(import.meta.dir, "routing")

// ── Token sets (EN + IT) ──────────────────────────────────────────────────────

const CODING_TOKENS = new Set([
  // English
  "function","func","fn","def","class","struct","enum","interface","trait","type","typedef",
  "namespace","module","package","const","let","var","mut","static","final","readonly",
  "if","else","elif","for","while","do","switch","case","break","continue","return",
  "yield","pass","goto","new","this","self","super","extends","implements","abstract",
  "override","public","private","protected","virtual","async","await","import","export",
  "require","include","use","from","try","catch","throw","throws","finally","raise","except",
  "int","float","bool","boolean","void","null","undefined","array","list","map","dict",
  "lambda","match","impl","pub","mod","println","printf","cout","integer",
  "typeof","instanceof","regex","pattern","algorithm","compile","debug","deploy",
  "api","rest","http","json","sql","git","docker","kubernetes","thread","mutex",
  "callback","closure","prototype","inheritance","singleton","factory","library","framework",
  "typescript","javascript","python","rust","golang","java","kotlin","swift","php","ruby",
  "index","buffer","stream","socket","endpoint","middleware","handler","database","query",
  "schema","migration","component","props","render","hook","usestate","useeffect",
  "recursion","pointer","reference","stack","heap","memory","cache","coverage","assertion",
  "promise","observable","goroutine","channel","subprocess","stdin","stdout","stderr",
  "parse","serialize","deserialize","encode","decode","hash","encrypt","decrypt",
  "request","response","header","cookie","session","token","jwt","oauth",
  "test","mock","stub","spy","fixture","describe","expect","assert","benchmark",
  "build","make","cmake","gradle","webpack","vite","rollup","esbuild","lint","format",
  "tcp","udp","dns","https","websocket","grpc","graphql",
  "orm","crud","select","insert","update","delete","join","where","group","order","limit",
  "react","vue","angular","svelte","nextjs","nuxt","express","fastapi","django","flask",
  "pandas","numpy","pytorch","tensorflow","scikit","sklearn","matplotlib",
  "cpu","gpu","ram","vram","kernel","driver","syscall","mmap",
  "yaml","toml","xml","csv","markdown","html","css","scss","less","bash","shell","powershell",
  // Italian
  "codice","funzione","classe","metodo","variabile","costante","parametro","argomento",
  "errore","eccezione","bug","script","programma","algoritmo","struttura","modulo",
  "libreria","framework","server","client","frontend","backend","database","interfaccia",
  "compilare","eseguire","debuggare","testare","implementare","refactoring","ottimizzare",
  "dichiarare","definire","importare","esportare","installare","configurare",
  "ciclo","iterazione","condizione","ricorsione","puntatore","riferimento",
  "oggetto","istanza","ereditarietà","polimorfismo","incapsulamento","astrazione",
])

const REASONING_TOKENS = new Set([
  // English
  "because","therefore","however","although","since","thus","hence","consequently",
  "moreover","furthermore","nevertheless","whereas","explain","analyze","analyse",
  "compare","evaluate","understand","consider","reason","logic","hypothesis","assumption",
  "conclusion","premise","argument","evidence","proof","prove","disprove","verify",
  "solve","calculate","compute","determine","derive","deduce","infer","implies",
  "suppose","philosophy","ethics","moral","justice","mathematics","physics","chemistry",
  "biology","theory","theorem","lemma","axiom","probability","statistics","correlation",
  "causation","economics","political","historical","relationship","difference","similarity",
  "advantage","disadvantage","tradeoff","opinion","perspective","viewpoint",
  "agree","disagree","refute","counter","definition","concept","abstract","theoretical",
  "possible","impossible","certain","optimal","efficient","inefficient",
  "complex","principle","fundamental","essential","significant","crucial","critical",
  "summarize","summary","describe","overview","background","context",
  "estimate","approximately","precisely","generally","typically","likely","unlikely",
  "best","worst","better","worse","improve","optimize","minimize","maximize",
  "design","architecture","strategy","plan","process",
  "difference","between","versus","compared","relative","absolute",
  "history","origin","future","current","trend","evolution","change",
  "issue","challenge","obstacle","limitation","cost","benefit","risk","impact","effect",
  "true","false","correct","incorrect","valid","invalid","accurate",
  // Italian
  "perché","quindi","dunque","pertanto","tuttavia","sebbene","nonostante","inoltre",
  "spiegare","spiegami","analizzare","confrontare","valutare","comprendere","considerare",
  "ragionare","ipotesi","assunzione","conclusione","premessa","argomento","evidenza",
  "prova","dimostrare","verificare","risolvere","calcolare","determinare","dedurre",
  "supporre","filosofia","etica","morale","giustizia","matematica","fisica","chimica",
  "biologia","teoria","teorema","probabilità","statistica","correlazione","causalità",
  "economia","politico","storico","relazione","differenza","somiglianza","analogia",
  "vantaggio","svantaggio","compromesso","opinione","prospettiva","punto","vista",
  "definizione","concetto","astratto","teorico","possibile","impossibile","ottimale",
  "complesso","principio","fondamentale","essenziale","significativo","cruciale",
  "riassumere","descrivere","panoramica","contesto","stimare","precisamente",
  "migliorare","ridurre","massimizzare","minimizzare","progettare","strategia",
  "differenza","storia","origine","futuro","tendenza","evoluzione","cambiamento",
  "problema","sfida","limitazione","costo","beneficio","rischio","impatto","effetto",
  "corretto","errato","valido","accurato","migliore","peggiore",
])

// ── Phrase patterns (weight 3 each) ───────────────────────────────────────────
// Catturano query naturali che non contengono keyword esplicite

interface PhrasePattern { re: RegExp; weight: number }

const CODING_PATTERNS: PhrasePattern[] = [
  // Italian natural phrases
  { re: /\b(il mio |questo |quel )?codice\b/i,            weight: 3 },
  { re: /\bnon (funziona|va|compila|parte|gira)\b/i,      weight: 4 },
  { re: /\b(scrivi|crea|implementa|costruisci|fammi)\s+(un[ao]?|del|la|lo|i|gli|le)?\s*\w/i, weight: 4 },
  { re: /\b(come\s+(si\s+fa|faccio|posso|si\s+può)\s+(a\s+)?)/i, weight: 3 },
  { re: /\b(fixare|sistemare|correggere|risolvere)\s+(il|questo|l'|un)\s*\w*(errore|problema|bug)\b/i, weight: 4 },
  { re: /\b(ho\s+un\s+errore|c'è\s+un\s+errore|ottengo\s+un\s+errore)\b/i, weight: 4 },
  { re: /\bperché\s+(il\s+)?(codice|programma|script|funzione)\b/i, weight: 4 },
  { re: /\baggiungere?\s+(una?\s+)?(funzione|metodo|classe|feature)\b/i, weight: 3 },
  { re: /\brefactor(ing)?\b/i,                             weight: 3 },
  { re: /\bunit\s+test|test\s+unitari?\b/i,                weight: 3 },
  // English natural phrases
  { re: /\bmy code\b/i,                                    weight: 3 },
  { re: /\b(doesn'?t|don'?t|won'?t|can'?t)\s+work\b/i,   weight: 3 },
  { re: /\b(bug|error|exception|crash)\s+(in|on|with)\b/i, weight: 4 },
  { re: /\bhow\s+(do\s+i|to)\s+(write|create|implement|build|make)\b/i, weight: 4 },
  { re: /\b(write|create|implement|build|make)\s+(me\s+)?(a|an|the|some)\s+\w/i, weight: 3 },
  { re: /\b(debug|fix|refactor|optimize|review)\s+(this|the|my|a)\b/i, weight: 4 },
  { re: /\bwhat'?s\s+wrong\s+with\b/i,                    weight: 4 },
  { re: /\bgetting\s+(an?\s+)?(error|exception|warning)\b/i, weight: 4 },
]

const REASONING_PATTERNS: PhrasePattern[] = [
  // Italian natural phrases
  { re: /\bperché\b/i,                                     weight: 3 },
  { re: /\bcome\s+mai\b/i,                                 weight: 3 },
  { re: /\b(spiegami|spiegaci|mi\s+spieghi?|spiega\s+come)\b/i, weight: 4 },
  { re: /\bcosa\s+(è|sono|significa|vuol\s+dire|intendi)\b/i, weight: 3 },
  { re: /\bqual[eè]\s+(la\s+)?differenza\b/i,             weight: 4 },
  { re: /\b(confronta|confrontami|paragona)\b/i,            weight: 4 },
  { re: /\b(vantaggi|svantaggi)\s+(e|o)\s+(svantaggi|vantaggi)\b/i, weight: 4 },
  { re: /\b(quando\s+(usare?|conviene|è\s+meglio))\b/i,   weight: 3 },
  { re: /\b(dovrei|conviene|è\s+meglio)\s+us(are?|ando)\b/i, weight: 3 },
  { re: /\bcome\s+funziona\b/i,                             weight: 4 },
  { re: /\bperché\s+(si\s+usa|si\s+utilizza|è\s+meglio|è\s+preferito)\b/i, weight: 4 },
  { re: /\bdammi\s+(un\s+)?(riassunto|panoramica|spiegazione|esempio)\b/i, weight: 3 },
  // English natural phrases
  { re: /\bwhy\s+(is|does|do|did|would|should|can|could)\b/i, weight: 4 },
  { re: /\bhow\s+does\b/i,                                 weight: 3 },
  { re: /\bexplain\s+(why|how|what|the|me)\b/i,           weight: 4 },
  { re: /\bwhat\s+(is|are|does|makes)\b/i,                weight: 2 },
  { re: /\bdifference\s+between\b/i,                       weight: 4 },
  { re: /\b(pros?\s+and\s+cons?|advantages?\s+and\s+disadvantages?)\b/i, weight: 4 },
  { re: /\b(should\s+i|when\s+should|which\s+is\s+better)\b/i, weight: 3 },
  { re: /\bbest\s+(way|approach|practice|option)\b/i,      weight: 3 },
  { re: /\bgive\s+me\s+(a\s+)?(summary|overview|explanation)\b/i, weight: 3 },
  { re: /\bwhat\s+would\s+(you|happen)\b/i,               weight: 3 },
]

// ── State ─────────────────────────────────────────────────────────────────────

interface Cluster { id: number; label: string; model: string; scaffold: string }
interface RoutingConfig { clusters: Cluster[]; models: string[] }

let config: RoutingConfig | null = null
let ready = false

export function isReady(): boolean { return ready }

export function init(): void {
  const configPath = join(ROUTING_DIR, "routing-config.json")
  if (!existsSync(configPath)) {
    console.warn("[router] Routing map not found. Run: bun dna-reader.ts")
    return
  }
  config = JSON.parse(readFileSync(configPath, "utf8")) as RoutingConfig
  ready  = true
  console.log(`[router] Ready — ${config.clusters.length} clusters`)
}

// ── Routing (< 1ms) ───────────────────────────────────────────────────────────

function scoreQuery(query: string): { coding: number; reasoning: number } {
  let coding = 0, reasoning = 0
  const lower = query.toLowerCase()

  // Level 1: phrase patterns (higher weight)
  for (const { re, weight } of CODING_PATTERNS)
    if (re.test(query)) coding += weight

  for (const { re, weight } of REASONING_PATTERNS)
    if (re.test(query)) reasoning += weight

  // Level 2: single token matching
  const tokens = lower.match(/[a-zà-ü][a-zà-ü0-9_]*/g) ?? []
  for (const t of tokens) {
    if (CODING_TOKENS.has(t))    coding++
    else if (REASONING_TOKENS.has(t)) reasoning++
  }

  return { coding, reasoning }
}

const TRIVIAL_WORDS = new Set([
  // greetings EN
  "hi","hello","hey","thanks","thank","ok","okay","yes","no","sure","bye","good",
  // greetings IT
  "ciao","salve","buongiorno","buonasera","buonanotte","grazie","prego","sì","no",
  "ok","bene","perfetto","esatto","capito","giusto","vero","dai","allora","va",
])

export function route(query: string): { model: string | null; scaffold: string; cluster: string } {
  const none = { model: null, scaffold: "", cluster: "trivial" }
  if (!config) return none

  const trimmed   = query.trim()
  const wordCount = trimmed.split(/\s+/).length
  const trivial   = config.clusters[0]

  // Short / trivial queries → always qwen2.5-coder:0.5b (fastest)
  if (wordCount <= 3) {
    const isAllTrivial = trimmed.toLowerCase().split(/\s+/).every(w => TRIVIAL_WORDS.has(w))
    if (isAllTrivial || wordCount === 1)
      return { model: trivial.model, scaffold: trivial.scaffold, cluster: trivial.label }
  }

  const { coding, reasoning } = scoreQuery(query)

  // Not enough signal → trivial as safe default
  if (coding + reasoning < 3)
    return { model: trivial.model, scaffold: trivial.scaffold, cluster: trivial.label }

  const winner = coding >= reasoning ? 1 : 2
  const c = config.clusters[winner]
  return { model: c.model, scaffold: c.scaffold, cluster: c.label }
}
