/**
 * DNA Reader — reads GGUF model files without activating them.
 * Extracts the vocabulary from each model's metadata, classifies every token
 * into a semantic cluster, and saves the routing map to disk.
 * Run once: bun dna-reader.ts
 */

import { openSync, readSync, closeSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs"
import { join } from "path"

const HOME        = process.env.USERPROFILE ?? process.env.HOME ?? ""
const OLLAMA_DIR  = join(HOME, ".ollama", "models")
const ARCH_DIR    = import.meta.dir
const ROUTING_DIR = join(ARCH_DIR, "routing")

// ── Domain token sets ─────────────────────────────────────────────────────────
// Clusters: 0 = trivial → qwen, 1 = coding → phi4-mini, 2 = reasoning → phi4-mini

const CODING_SET = new Set([
  "function","func","fn","def","class","struct","enum","interface","trait","type","typedef",
  "namespace","module","package","const","let","var","mut","static","final","readonly",
  "if","else","elif","for","while","do","switch","case","break","continue","return",
  "yield","pass","goto","new","this","self","super","extends","implements","abstract",
  "override","public","private","protected","virtual","async","await","import","export",
  "require","include","use","from","try","catch","throw","throws","finally","raise","except",
  "int","float","bool","boolean","void","null","undefined","array","list","map","dict",
  "lambda","match","impl","pub","mod","println","printf","cout","system","string","integer",
  "typeof","instanceof","regex","pattern","algorithm","compile","debug","deploy",
  "api","rest","http","json","sql","git","docker","kubernetes","thread","mutex",
  "callback","closure","prototype","inheritance","singleton","factory","library","framework",
  "typescript","javascript","python","rust","golang","java","kotlin","swift","php","ruby",
  "index","buffer","stream","socket","endpoint","middleware","handler","database","query",
  "schema","migration","component","props","render","hook","usestate","useeffect",
  "recursion","pointer","reference","stack","heap","memory","cache","coverage","assertion",
  "async","await","promise","observable","coroutine","goroutine","channel","subprocess",
  "argv","argc","stdin","stdout","stderr","env","path","dir","file","read","write","open",
  "parse","serialize","deserialize","encode","decode","hash","encrypt","decrypt",
  "request","response","header","body","status","cookie","session","token","jwt","oauth",
  "test","mock","stub","spy","fixture","describe","expect","assert","benchmark",
  "build","make","cmake","gradle","webpack","vite","rollup","esbuild","lint","format",
  "ssh","ftp","tcp","udp","ip","dns","http","https","websocket","grpc","graphql","rest",
  "orm","crud","select","insert","update","delete","join","where","group","order","limit",
  "react","vue","angular","svelte","nextjs","nuxt","express","fastapi","django","flask",
  "pandas","numpy","pytorch","tensorflow","scikit","sklearn","matplotlib","seaborn",
  "github","gitlab","ci","cd","pipeline","workflow","action","hook","webhook","deploy",
  "cpu","gpu","ram","vram","kernel","driver","interrupt","syscall","mmap","ipc",
  "regex","glob","pattern","match","group","capture","lookahead","lookbehind",
  "json","yaml","toml","xml","csv","markdown","html","css","scss","less",
])

const REASONING_SET = new Set([
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
  "summarize","summary","describe","overview","introduction","background","context",
  "estimate","approximate","roughly","exactly","precisely","generally","typically",
  "always","never","sometimes","often","rarely","usually","likely","unlikely",
  "best","worst","better","worse","improve","optimize","reduce","increase","minimize","maximize",
  "design","architecture","pattern","approach","strategy","plan","method","process",
  "why","how","what","when","where","which","who","whose","whether","either","neither",
  "difference","between","among","versus","vs","compared","relative","absolute",
  "history","origin","future","current","past","present","trend","evolution","change",
  "question","answer","problem","solution","issue","challenge","obstacle","limitation",
  "trade","cost","benefit","risk","reward","impact","effect","consequence","result",
  "true","false","correct","incorrect","right","wrong","valid","invalid","accurate",
])

// ── GGUF binary reader ────────────────────────────────────────────────────────

class Reader {
  buf: Buffer
  pos = 0

  constructor(buf: Buffer) { this.buf = buf }

  u8()  { return this.buf.readUInt8(this.pos++) }
  i8()  { const v = this.buf.readInt8(this.pos);     this.pos += 1; return v }
  u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v }
  i16() { const v = this.buf.readInt16LE(this.pos);  this.pos += 2; return v }
  u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v }
  i32() { const v = this.buf.readInt32LE(this.pos);  this.pos += 4; return v }
  f32() { const v = this.buf.readFloatLE(this.pos);  this.pos += 4; return v }
  u64() { const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v) }
  i64() { const v = this.buf.readBigInt64LE(this.pos);  this.pos += 8; return Number(v) }
  f64() { const v = this.buf.readDoubleLE(this.pos);    this.pos += 8; return v }

  str() {
    const len = this.u64()
    const v   = this.buf.slice(this.pos, this.pos + len).toString("utf8")
    this.pos += len
    return v
  }

  value(type: number): unknown {
    switch (type) {
      case 0:  return this.u8()
      case 1:  return this.i8()
      case 2:  return this.u16()
      case 3:  return this.i16()
      case 4:  return this.u32()
      case 5:  return this.i32()
      case 6:  return this.f32()
      case 7:  return this.u8() !== 0
      case 8:  return this.str()
      case 9:  {
        const itemType = this.u32()
        const count    = this.u64()
        const arr: unknown[] = new Array(count)
        for (let i = 0; i < count; i++) arr[i] = this.value(itemType)
        return arr
      }
      case 10: return this.u64()
      case 11: return this.i64()
      case 12: return this.f64()
      default: throw new Error(`Unknown GGUF value type: ${type}`)
    }
  }
}

// ── Ollama model path resolver ────────────────────────────────────────────────

function resolveModelPath(ollamaName: string): string {
  const [name, tag = "latest"] = ollamaName.split(":")
  const manifestPath = join(OLLAMA_DIR, "manifests", "registry.ollama.ai", "library", name, tag)

  if (!existsSync(manifestPath))
    throw new Error(`Manifest not found: ${manifestPath}`)

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const layer = (manifest.layers as { mediaType: string; digest: string }[])
    ?.find(l => l.mediaType === "application/vnd.ollama.image.model")

  if (!layer) throw new Error(`No model layer in manifest for ${ollamaName}`)

  const blobName = layer.digest.replace(":", "-")
  const blobPath = join(OLLAMA_DIR, "blobs", blobName)

  if (!existsSync(blobPath)) throw new Error(`Blob not found: ${blobPath}`)
  return blobPath
}

// ── GGUF metadata extractor ───────────────────────────────────────────────────

interface GGUFMeta {
  architecture: string
  tokens: string[]
  vocabSize: number
}

function readGGUFMeta(modelPath: string): GGUFMeta {
  // Read first 96 MB — covers header + full KV metadata for models up to 152k vocab
  const READ_SIZE = 96 * 1024 * 1024
  const buf = Buffer.alloc(READ_SIZE)
  const fd = openSync(modelPath, "r")
  const bytesRead = readSync(fd, buf, 0, READ_SIZE, 0)
  closeSync(fd)

  const r = new Reader(buf.slice(0, bytesRead))

  const magic = r.buf.slice(0, 4).toString("ascii")
  r.pos = 4
  if (magic !== "GGUF") throw new Error("Not a GGUF file")

  const version  = r.u32()
  const nTensors = r.u64()
  const nKV      = r.u64()

  console.log(`  GGUF v${version} | ${nTensors} tensors | ${nKV} metadata entries`)

  const kv: Record<string, unknown> = {}
  for (let i = 0; i < nKV; i++) {
    const key   = r.str()
    const vtype = r.u32()
    kv[key]     = r.value(vtype)
  }

  const architecture = (kv["general.architecture"] as string) ?? "unknown"
  const tokens       = (kv["tokenizer.ggml.tokens"] as string[]) ?? []

  return { architecture, tokens, vocabSize: tokens.length }
}

// ── Token classifier ──────────────────────────────────────────────────────────

function classifyToken(raw: string): number {
  // Strip SentencePiece sentinel (▁ = U+2581), byte tokens (<0xNN>), special tokens
  if (raw.startsWith("<") && raw.endsWith(">")) return 0
  const t = raw.replace(/^[▁\s]+/, "").toLowerCase()
  if (t.length < 2) return 0
  if (CODING_SET.has(t))    return 1
  if (REASONING_SET.has(t)) return 2
  return 0
}

// ── Cluster configuration ─────────────────────────────────────────────────────

const CLUSTERS = [
  {
    id:       0,
    label:    "trivial",
    model:    "qwen2.5-coder:1.5b",
    scaffold: "Answer directly and concisely. No preamble.",
  },
  {
    id:       1,
    label:    "coding",
    model:    "phi4-mini",
    scaffold: "[coding] Provide working, correct code. No introductory sentences. Structure: brief analysis → solution → code block.",
  },
  {
    id:       2,
    label:    "reasoning",
    model:    "phi4-mini",
    scaffold: "[reasoning] Think step by step. Be precise and concise. No repetition.",
  },
]

const STACK_MODELS = [
  { id: "phi4-mini",          ollama: "phi4-mini" },
  { id: "qwen2.5-coder:1.5b", ollama: "qwen2.5-coder:1.5b" },
]

// ── Main ──────────────────────────────────────────────────────────────────────

async function processModel(modelId: string, ollamaName: string): Promise<void> {
  console.log(`\n[dna-reader] ${modelId}`)

  let modelPath: string
  try {
    modelPath = resolveModelPath(ollamaName)
    console.log(`  Path: ...${modelPath.slice(-50)}`)
  } catch (e) {
    console.warn(`  Skipped: ${(e as Error).message}`)
    return
  }

  const meta = readGGUFMeta(modelPath)
  console.log(`  Architecture: ${meta.architecture} | Vocab: ${meta.vocabSize} tokens`)

  const tokenMap = new Uint8Array(meta.vocabSize)
  let counts = [0, 0, 0]

  for (let i = 0; i < meta.tokens.length; i++) {
    const c = classifyToken(meta.tokens[i])
    tokenMap[i] = c
    counts[c]++
  }

  console.log(`  trivial=${counts[0]}  coding=${counts[1]}  reasoning=${counts[2]}`)

  const safeId  = modelId.replace(/[/:]/g, "-")
  const mapPath = join(ROUTING_DIR, `${safeId}-token-map.bin`)
  writeFileSync(mapPath, Buffer.from(tokenMap))
  console.log(`  Saved: ${mapPath}`)
}

async function main() {
  console.log("\n[dna-reader] Reading model DNA...\n")

  if (!existsSync(ROUTING_DIR)) mkdirSync(ROUTING_DIR, { recursive: true })

  for (const { id, ollama } of STACK_MODELS) {
    await processModel(id, ollama)
  }

  const configPath = join(ROUTING_DIR, "routing-config.json")
  writeFileSync(configPath, JSON.stringify({
    clusters: CLUSTERS,
    models:   STACK_MODELS.map(m => m.id),
    built:    new Date().toISOString(),
  }, null, 2))

  console.log(`\n[dna-reader] Done → ${configPath}\n`)
}

main().catch(err => {
  console.error("[dna-reader] Fatal:", (err as Error).message)
  process.exit(1)
})
