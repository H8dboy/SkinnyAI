/**
 * Vector memory MCP server — semantic memory shared across all AI sessions.
 *
 * Uses nomic-embed-text (via Ollama) as the ONLY embedding model:
 * all sub-AIs write and read in the same vector space → zero conversion.
 *
 * Storage: %USERPROFILE%\.claude\vector-memory\memories.jsonl
 * Each line: { id, text, embedding, category, session, timestamp }
 *
 * Tools exposed:
 *   remember(text, category?)   — embed + append to store
 *   recall(query, limit?)       — cosine search → top-k results
 *   list_memories(limit?)       — most recent N memories
 *   forget(id)                  — delete a memory by id
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

const OLLAMA_BASE  = "http://localhost:11434";
const EMBED_MODEL  = "nomic-embed-text";
const HOME         = process.env.USERPROFILE ?? process.env.HOME ?? "";
const MEMORY_DIR   = join(HOME, ".claude", "vector-memory");
const MEMORY_FILE  = join(MEMORY_DIR, "memories.jsonl");
const SESSION_ID   = randomUUID().slice(0, 8);

interface Memory {
  id: string;
  text: string;
  embedding: number[];
  category: string;
  session: string;
  timestamp: string;
}

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });

// ── Embedding ──────────────────────────────────────────────────────────────────

async function embed(text: string): Promise<number[]> {
  const res = await fetch(`${OLLAMA_BASE}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Embedding failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { embedding: number[] };
  return data.embedding;
}

// ── Vector math ────────────────────────────────────────────────────────────────

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

// ── Persistence ────────────────────────────────────────────────────────────────

function loadAll(): Memory[] {
  if (!existsSync(MEMORY_FILE)) return [];
  return readFileSync(MEMORY_FILE, "utf8")
    .split("\n")
    .filter(l => l.trim())
    .map(l => {
      try { return JSON.parse(l) as Memory; } catch { return null; }
    })
    .filter(Boolean) as Memory[];
}

function saveAll(memories: Memory[]) {
  writeFileSync(MEMORY_FILE, memories.map(m => JSON.stringify(m)).join("\n") + "\n");
}

// ── Tools ──────────────────────────────────────────────────────────────────────

async function remember(text: string, category = "general"): Promise<string> {
  const embedding = await embed(text);
  const memory: Memory = {
    id: randomUUID(),
    text,
    embedding,
    category,
    session: SESSION_ID,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(MEMORY_FILE, JSON.stringify(memory) + "\n");
  return memory.id;
}

async function recall(query: string, limit = 5): Promise<{ text: string; score: number; category: string; timestamp: string; id: string }[]> {
  const memories = loadAll();
  if (!memories.length) return [];
  const qEmb = await embed(query);
  return memories
    .map(m => ({ id: m.id, text: m.text, score: cosineSim(qEmb, m.embedding), category: m.category, timestamp: m.timestamp }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function forget(id: string): boolean {
  const all = loadAll();
  const filtered = all.filter(m => m.id !== id);
  if (filtered.length === all.length) return false;
  saveAll(filtered);
  return true;
}

// ── MCP protocol (stdio JSON-RPC 2.0) ─────────────────────────────────────────

function send(msg: object) { process.stdout.write(JSON.stringify(msg) + "\n"); }

const TOOLS = [
  {
    name: "remember",
    description: "Save important information to long-term vector memory. Use at the end of a session or when the user says something worth preserving: preferences, project facts, decisions, code patterns, goals. All sub-AIs share the same vector space — no conversion needed.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The information to remember (be specific and self-contained)" },
        category: {
          type: "string",
          description: "Category for later filtering",
          enum: ["general", "code", "preference", "project", "decision", "fact"],
        },
      },
      required: ["text"],
    },
  },
  {
    name: "recall",
    description: "Search vector memory for information semantically similar to a query. Use at session start or when context about past work is needed.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for (natural language)" },
        limit: { type: "number", description: "Max results (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "list_memories",
    description: "List the most recent memories stored across all sessions.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many recent entries to show (default 10)" },
      },
    },
  },
  {
    name: "forget",
    description: "Delete a specific memory by its id (returned by remember or shown in list_memories).",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "The memory id to delete" },
      },
      required: ["id"],
    },
  },
];

async function handleMessage(msg: Record<string, unknown>) {
  const id     = msg.id;
  const method = msg.method as string;
  const params = msg.params as Record<string, unknown> | undefined;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "vector-memory", version: "1.0.0" },
    }});
  } else if (method === "notifications/initialized") {
    // no-op
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

  } else if (method === "tools/call") {
    const name = (params?.name as string) ?? "";
    const args = (params?.arguments as Record<string, unknown>) ?? {};

    try {
      if (name === "remember") {
        const memId = await remember(args.text as string, (args.category as string) ?? "general");
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Saved. id: ${memId}` }] } });

      } else if (name === "recall") {
        const results = await recall(args.query as string, (args.limit as number) ?? 5);
        if (!results.length) {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "No relevant memories found." }] } });
        } else {
          const out = results.map((r, i) =>
            `[${i + 1}] id:${r.id} | ${r.category} | score:${r.score.toFixed(3)} | ${new Date(r.timestamp).toLocaleDateString("it-IT")}\n${r.text}`
          ).join("\n\n");
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out }] } });
        }

      } else if (name === "list_memories") {
        const limit = (args.limit as number) ?? 10;
        const memories = loadAll().slice(-limit);
        if (!memories.length) {
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "No memories stored yet." }] } });
        } else {
          const out = memories.map((m, i) =>
            `[${i + 1}] id:${m.id} | ${m.category} | ${new Date(m.timestamp).toLocaleDateString("it-IT")}\n${m.text}`
          ).join("\n\n");
          send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: out }] } });
        }

      } else if (name === "forget") {
        const deleted = forget(args.id as string);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: deleted ? `Deleted ${args.id}` : `Memory not found: ${args.id}` }] } });

      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown tool: ${name}` } });
      }
    } catch (e) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e) } });
    }

  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buf += chunk;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { handleMessage(JSON.parse(trimmed)); } catch {}
  }
});
process.stdin.resume();

process.stderr.write(`[vector-memory] session:${SESSION_ID} | store:${MEMORY_FILE}\n`);
