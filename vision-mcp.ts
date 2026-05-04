/**
 * Vision MCP server — espone see_screen e read_screen_memory a cc-haha.
 * Claude Code lo chiama quando vuole vedere il desktop o leggere la memoria visiva.
 * Lanciato automaticamente da .mcp.json come processo stdio.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const OLLAMA_BASE  = "http://localhost:11434";
const VISION_MODEL = "moondream";
const HOME         = process.env.USERPROFILE ?? process.env.HOME ?? "";
const MEMORY_FILE  = join(HOME, ".claude", "screen-memory", "observations.md");
const SHOT_TMP     = join(process.env.TEMP ?? "C:\\Temp", "vision-mcp-screen.png");
const PS1_PATH     = join(process.env.TEMP ?? "C:\\Temp", "vision-mcp-shot.ps1");

// Script PowerShell per screenshot
writeFileSync(PS1_PATH, [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
  "$bmp = New-Object System.Drawing.Bitmap($s.Width, $s.Height)",
  "$gfx = [System.Drawing.Graphics]::FromImage($bmp)",
  "$pt = New-Object System.Drawing.Point(0, 0)",
  "$gfx.CopyFromScreen($s.Location, $pt, $s.Size)",
  `$bmp.Save('${SHOT_TMP.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  "$gfx.Dispose()",
  "$bmp.Dispose()",
].join("\r\n"));

// ── Vision ────────────────────────────────────────────────────────────────────

async function seeScreen(): Promise<string> {
  execSync(`powershell -NonInteractive -ExecutionPolicy Bypass -File "${PS1_PATH}"`, { stdio: "pipe" });
  const b64 = readFileSync(SHOT_TMP).toString("base64");

  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      prompt: "What is on this screen? Describe what you see in detail.",
      images: [b64],
      stream: false,
      options: { num_predict: 200, temperature: 0.2, num_ctx: 2048 },
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) return `[errore moondream: ${res.status}]`;
  const data = await res.json() as { response: string };
  return data.response?.trim() || "[nessuna descrizione]";
}

function readScreenMemory(lastN = 10): string {
  if (!existsSync(MEMORY_FILE)) return "Nessuna osservazione disponibile. Lo screen-watcher non è ancora stato avviato.";
  const lines = readFileSync(MEMORY_FILE, "utf8").split("\n").filter(l => l.startsWith("**["));
  const recent = lines.slice(-lastN).join("\n");
  return recent || "Nessuna osservazione ancora registrata.";
}

// ── MCP Protocol (stdio JSON-RPC 2.0) ────────────────────────────────────────

function send(msg: object) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const TOOLS = [
  {
    name: "see_screen",
    description: "Scatta uno screenshot del desktop dell'utente e lo descrive. Usa questo tool quando l'utente chiede di guardare lo schermo, ha un errore visivo, vuole aiuto su cosa sta vedendo, o chiede 'cosa c'è sullo schermo'.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_screen_memory",
    description: "Legge le osservazioni recenti dello schermo accumulate in background. Usa questo tool per capire il contesto di lavoro dell'utente: cosa stava facendo prima, quali app ha usato, su cosa sta lavorando.",
    inputSchema: {
      type: "object",
      properties: {
        last_n: { type: "number", description: "Quante osservazioni recenti leggere (default 10)" },
      },
    },
  },
];

async function handleMessage(msg: Record<string, unknown>) {
  const id = msg.id;
  const method = msg.method as string;
  const params = msg.params as Record<string, unknown> | undefined;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "vision", version: "1.0.0" },
    }});
  } else if (method === "notifications/initialized") {
    // no-op
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    const name = (params?.name as string) ?? "";
    const args = (params?.arguments as Record<string, unknown>) ?? {};
    try {
      if (name === "see_screen") {
        const desc = await seeScreen();
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: desc }] } });
      } else if (name === "read_screen_memory") {
        const mem = readScreenMemory((args.last_n as number) ?? 10);
        send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: mem }] } });
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Tool sconosciuto: ${name}` } });
      }
    } catch (e) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e) } });
    }
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  }
}

// Leggi da stdin linea per linea
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
