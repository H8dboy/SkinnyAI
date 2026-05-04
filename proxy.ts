/**
 * Anthropic → Ollama proxy (Bun, zero dependencies)
 * Converts Anthropic Messages API calls to OpenAI-compatible format for Ollama.
 * Run: bun proxy.ts
 */

const OLLAMA_BASE   = "http://localhost:11434/v1";
const PORT          = 4000;
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "phi4-mini";

// The proxy uses the model specified in the request (set by cc-haha based on task type):
//   ANTHROPIC_DEFAULT_HAIKU_MODEL  → qwen2.5-coder:1.5b  (fast, simple tasks)
//   ANTHROPIC_DEFAULT_SONNET_MODEL → phi4-mini            (main agent, coding)
//   ANTHROPIC_DEFAULT_OPUS_MODEL   → phi4-mini            (complex tasks)
//
// num_ctx is adapted per model: small model gets a larger window, phi4 stays conservative
function resolveModel(requested: string): { model: string; numCtx: number } {
  if (requested.includes("qwen")) return { model: requested, numCtx: 8192 };
  return { model: requested || DEFAULT_MODEL, numCtx: 4096 };
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnthropicContent {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContent[];
}
interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}
interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  system?: string | { type: string; text: string }[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: unknown;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
}

// ── Message conversion ────────────────────────────────────────────────────────

function extractText(content: string | AnthropicContent[]): string {
  if (typeof content === "string") return content;
  return content.filter(b => b.type === "text" && b.text).map(b => b.text!).join("\n");
}

function toOAIMessages(req: AnthropicRequest) {
  const out: { role: string; content: string | object[] }[] = [];

  if (req.system) {
    const txt = typeof req.system === "string"
      ? req.system
      : req.system.filter(b => b.type === "text").map(b => b.text).join("\n");
    out.push({ role: "system", content: txt });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = msg.content;

    if (msg.role === "assistant") {
      const textParts = blocks.filter(b => b.type === "text");
      const toolUse   = blocks.filter(b => b.type === "tool_use");
      if (toolUse.length > 0) {
        out.push({
          role: "assistant",
          content: textParts.map(t => t.text ?? "").join("\n"),
          // @ts-ignore
          tool_calls: toolUse.map(t => ({
            id: t.id, type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
          })),
        });
      } else {
        out.push({ role: "assistant", content: extractText(blocks) });
      }
    } else {
      const toolResults = blocks.filter(b => b.type === "tool_result");
      const textBlocks  = blocks.filter(b => b.type === "text");
      if (toolResults.length > 0) {
        for (const r of toolResults) {
          const rc = typeof r.content === "string" ? r.content
            : Array.isArray(r.content) ? extractText(r.content) : "";
          // @ts-ignore
          out.push({ role: "tool", tool_call_id: r.tool_use_id, content: rc });
        }
        if (textBlocks.length > 0) out.push({ role: "user", content: extractText(textBlocks) });
      } else {
        out.push({ role: "user", content: extractText(blocks) });
      }
    }
  }
  return out;
}

function toOAITools(tools: AnthropicTool[]) {
  return tools.map(t => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.input_schema },
  }));
}

function toAnthropicResponse(oai: Record<string, unknown>, model: string) {
  const choice  = (oai.choices as Record<string, unknown>[])?.[0];
  const message = choice?.message as Record<string, unknown> | undefined;
  const content: object[] = [];

  if (message?.content && typeof message.content === "string" && message.content.trim())
    content.push({ type: "text", text: message.content });

  const tcs = message?.tool_calls as { id: string; function: { name: string; arguments: string } }[] | undefined;
  if (tcs?.length) {
    for (const tc of tcs) {
      let parsed: unknown = {};
      try { parsed = JSON.parse(tc.function.arguments); } catch {}
      content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input: parsed });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const usage = oai.usage as Record<string, number> | undefined;
  return {
    id: `msg_${Date.now()}`, type: "message", role: "assistant", content, model,
    stop_reason: choice?.finish_reason === "tool_calls" ? "tool_use" : "end_turn",
    usage: { input_tokens: usage?.prompt_tokens ?? 0, output_tokens: usage?.completion_tokens ?? 0 },
  };
}

// ── Streaming SSE conversion ──────────────────────────────────────────────────

function* convertChunk(
  line: string,
  state: { sentStart: boolean; toolAccum: Map<number, { id: string; name: string; args: string }> }
): Generator<string> {
  if (!line.startsWith("data: ")) return;
  const raw = line.slice(6).trim();
  if (raw === "[DONE]") { yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`; return; }

  let chunk: Record<string, unknown>;
  try { chunk = JSON.parse(raw); } catch { return; }

  if (!state.sentStart) {
    state.sentStart = true;
    yield `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_${Date.now()}","type":"message","role":"assistant","content":[],"model":"${DEFAULT_MODEL}","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n`;
    yield `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`;
  }

  const choices = chunk.choices as Record<string, unknown>[] | undefined;
  if (!choices?.length) return;
  const delta = choices[0].delta as Record<string, unknown> | undefined;
  if (!delta) return;

  if (delta.content && typeof delta.content === "string")
    yield `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(delta.content)}}}\n\n`;

  const tcDeltas = delta.tool_calls as { index: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined;
  if (tcDeltas) {
    for (const tc of tcDeltas) {
      if (!state.toolAccum.has(tc.index))
        state.toolAccum.set(tc.index, { id: tc.id ?? `tc_${tc.index}`, name: "", args: "" });
      const acc = state.toolAccum.get(tc.index)!;
      if (tc.function?.name) acc.name += tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
    }
  }

  if (choices[0].finish_reason) {
    yield `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`;
    let bi = 1;
    for (const [, acc] of state.toolAccum) {
      let parsed: unknown = {};
      try { parsed = JSON.parse(acc.args); } catch {}
      yield `event: content_block_start\ndata: {"type":"content_block_start","index":${bi},"content_block":{"type":"tool_use","id":${JSON.stringify(acc.id)},"name":${JSON.stringify(acc.name)},"input":{}}}\n\n`;
      yield `event: content_block_delta\ndata: {"type":"content_block_delta","index":${bi},"delta":{"type":"input_json_delta","partial_json":${JSON.stringify(JSON.stringify(parsed))}}}\n\n`;
      yield `event: content_block_stop\ndata: {"type":"content_block_stop","index":${bi}}\n\n`;
      bi++;
    }
    const stopReason = choices[0].finish_reason === "tool_calls" ? "tool_use" : "end_turn";
    yield `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}","stop_sequence":null},"usage":{"output_tokens":0}}\n\n`;
    yield `event: message_stop\ndata: {"type":"message_stop"}\n\n`;
  }
}

// ── Server ────────────────────────────────────────────────────────────────────

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health")
      return Response.json({ status: "ok", default_model: DEFAULT_MODEL });

    if (req.method === "POST" && url.pathname === "/v1/messages") {
      let body: AnthropicRequest;
      try { body = (await req.json()) as AnthropicRequest; }
      catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

      const { model, numCtx } = resolveModel(body.model ?? DEFAULT_MODEL);
      console.log(`[proxy] ${body.model ?? "?"} → ${model} (ctx=${numCtx})`);

      const oaiBody: Record<string, unknown> = {
        model,
        messages: toOAIMessages(body),
        stream: body.stream ?? false,
        temperature: body.temperature,
        top_p: body.top_p,
        options: { num_ctx: numCtx },
      };
      if (body.max_tokens)    oaiBody.max_tokens   = body.max_tokens;
      if (body.tools?.length) { oaiBody.tools = toOAITools(body.tools); oaiBody.tool_choice = "auto"; }

      const upstream = await fetch(`${OLLAMA_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(oaiBody),
      });

      if (!upstream.ok) {
        const err = await upstream.text();
        console.error("[proxy] Ollama error:", err);
        return Response.json({ error: err }, { status: upstream.status });
      }

      if (body.stream) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const enc = new TextEncoder();
        (async () => {
          const state = { sentStart: false, toolAccum: new Map<number, { id: string; name: string; args: string }>() };
          const reader = upstream.body!.getReader();
          const dec = new TextDecoder();
          let buf = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines)
              for (const out of convertChunk(line.trim(), state))
                await writer.write(enc.encode(out));
          }
          await writer.close();
        })();
        return new Response(readable, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }

      const oaiRes = (await upstream.json()) as Record<string, unknown>;
      return Response.json(toAnthropicResponse(oaiRes, body.model ?? model));
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`[proxy] http://localhost:${PORT}  →  ${DEFAULT_MODEL}`);
