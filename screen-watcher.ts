/**
 * Screen watcher — captures the screen every 90s using moondream.
 * Skips the cycle if Ollama is busy to avoid model swapping under load.
 * Observations are saved to %USERPROFILE%\.claude\screen-memory\observations.md
 * Run: bun screen-watcher.ts
 */

import { execSync } from "child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";

const OLLAMA_BASE   = "http://localhost:11434";
const VISION_MODEL  = "moondream";
const INTERVAL_MS   = 90_000;   // 90 seconds
const BUSY_COOLDOWN = 30_000;   // retry after 30s if Ollama is busy

const HOME        = process.env.USERPROFILE ?? process.env.HOME ?? "";
const MEMORY_DIR  = join(HOME, ".claude", "screen-memory");
const MEMORY_FILE = join(MEMORY_DIR, "observations.md");
const SHOT_TMP    = join(process.env.TEMP ?? "C:\\Temp", "ai-arch-screen.png");
const PS1_PATH    = join(process.env.TEMP ?? "C:\\Temp", "ai-arch-screenshot.ps1");

// ── Setup ─────────────────────────────────────────────────────────────────────

if (!existsSync(MEMORY_DIR)) mkdirSync(MEMORY_DIR, { recursive: true });
if (!existsSync(MEMORY_FILE))
  writeFileSync(MEMORY_FILE, "# Screen observations\n\nUpdated automatically by screen-watcher.\n\n");

// Write PowerShell screenshot script once at startup
writeFileSync(PS1_PATH, [
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
  "$bmp = New-Object System.Drawing.Bitmap($s.Width, $s.Height)",
  "$gfx = [System.Drawing.Graphics]::FromImage($bmp)",
  "$origin = New-Object System.Drawing.Point(0, 0)",
  "$gfx.CopyFromScreen($s.Location, $origin, $s.Size)",
  `$bmp.Save('${SHOT_TMP.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
  "$gfx.Dispose()",
  "$bmp.Dispose()",
].join("\r\n"));

// ── Ollama helpers ─────────────────────────────────────────────────────────────

/** Returns true if a non-vision model is currently loaded (main LLM in use) */
async function isOllamaBusy(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/ps`, { signal: AbortSignal.timeout(3_000) });
    if (!res.ok) return false;
    const data = await res.json() as { models?: { name: string; size_vram: number }[] };
    return (data.models ?? []).some(m => !m.name.startsWith(VISION_MODEL) && m.size_vram > 0);
  } catch {
    return false;
  }
}

async function ensureModel() {
  const res  = await fetch(`${OLLAMA_BASE}/api/tags`);
  const data = await res.json() as { models: { name: string }[] };
  if (data.models.some(m => m.name.startsWith(VISION_MODEL))) return;
  console.log(`[watcher] Downloading ${VISION_MODEL} (~1.7 GB)...`);
  await fetch(`${OLLAMA_BASE}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: VISION_MODEL, stream: false }),
  });
  console.log(`[watcher] ${VISION_MODEL} ready.`);
}

async function describeScreen(b64: string): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: VISION_MODEL,
      prompt: "What is on this screen? Describe briefly.",
      images: [b64],
      stream: false,
      options: { num_predict: 120, temperature: 0.2, num_ctx: 2048 },
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json() as { response: string };
  return data.response?.trim() ?? "";
}

// ── Screenshot + dedup ────────────────────────────────────────────────────────

function takeScreenshot(): string {
  execSync(`powershell -NonInteractive -ExecutionPolicy Bypass -File "${PS1_PATH}"`, { stdio: "pipe" });
  return readFileSync(SHOT_TMP).toString("base64");
}

function imageHash(b64: string): string {
  const sample = b64.split("").filter((_, i) => i % 500 === 0).join("");
  return createHash("md5").update(sample).digest("hex").slice(0, 8);
}

const recentHashes: string[] = [];
function isDuplicate(hash: string): boolean {
  if (recentHashes.includes(hash)) return true;
  recentHashes.push(hash);
  if (recentHashes.length > 8) recentHashes.shift();
  return false;
}

// ── Memory ────────────────────────────────────────────────────────────────────

function saveObservation(desc: string) {
  const ts = new Date().toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  appendFileSync(MEMORY_FILE, `**[${ts}]** ${desc}\n\n`);
}

function trimMemory() {
  try {
    const c = readFileSync(MEMORY_FILE, "utf8");
    if (c.length < 400_000) return;
    const lines = c.split("\n");
    writeFileSync(MEMORY_FILE,
      lines.slice(0, 4).join("\n") + "\n\n*(older entries removed)*\n\n" +
      lines.slice(Math.floor(lines.length / 2)).join("\n")
    );
  } catch {}
}

// ── Main loop ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("[watcher] Started");
  console.log(`[watcher] Memory → ${MEMORY_FILE}`);
  console.log(`[watcher] Interval: ${INTERVAL_MS / 1000}s | Model: ${VISION_MODEL}\n`);

  await ensureModel();

  let lastHash = "";

  while (true) {
    try {
      if (await isOllamaBusy()) {
        process.stdout.write("[busy] ");
        await Bun.sleep(BUSY_COOLDOWN);
        continue;
      }

      const b64  = takeScreenshot();
      const hash = imageHash(b64);

      if (hash === lastHash || isDuplicate(hash)) {
        process.stdout.write(".");
        await Bun.sleep(INTERVAL_MS);
        continue;
      }
      lastHash = hash;

      process.stdout.write(`\n[${new Date().toLocaleTimeString("en-GB")}] analyzing... `);
      const desc = await describeScreen(b64);

      if (desc.length > 5) {
        console.log(desc);
        saveObservation(desc);
        trimMemory();
      } else {
        process.stdout.write("(empty response)\n");
      }
    } catch (err: unknown) {
      console.error(`\n[error] ${err instanceof Error ? err.message : err}`);
    }

    await Bun.sleep(INTERVAL_MS);
  }
}

main().catch(console.error);
