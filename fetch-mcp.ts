/**
 * Fetch MCP server — lets cc-haha fetch URLs.
 * Replaces @modelcontextprotocol/server-fetch (removed from npm).
 * Runs via: bun fetch-mcp.ts
 */

function send(msg: object) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

const TOOLS = [
  {
    name: "fetch",
    description: "Fetches a URL and returns its content as text. Useful for reading documentation, web pages, or any HTTP resource.",
    inputSchema: {
      type: "object",
      properties: {
        url:          { type: "string",  description: "The URL to fetch" },
        max_length:   { type: "number",  description: "Max characters to return (default 20000)" },
        raw:          { type: "boolean", description: "Return raw HTML instead of extracted text (default false)" },
      },
      required: ["url"],
    },
  },
  {
    name: "fetch_markdown",
    description: "Fetches a URL and returns its content as cleaned plain text (strips HTML tags). Best for reading documentation or articles.",
    inputSchema: {
      type: "object",
      properties: {
        url:        { type: "string", description: "The URL to fetch" },
        max_length: { type: "number", description: "Max characters to return (default 20000)" },
      },
      required: ["url"],
    },
  },
];

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

async function doFetch(url: string, maxLen: number, raw: boolean): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SkinnyAI/1.0)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return `[HTTP ${res.status} ${res.statusText}]`;
  const text = await res.text();
  const content = raw ? text : stripHtml(text);
  return content.length > maxLen ? content.slice(0, maxLen) + "\n…[truncated]" : content;
}

async function handleMessage(msg: Record<string, unknown>) {
  const id     = msg.id;
  const method = msg.method as string;
  const params = msg.params as Record<string, unknown> | undefined;

  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fetch", version: "1.0.0" },
    }});
  } else if (method === "notifications/initialized") {
    // no-op
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    const name = (params?.name as string) ?? "";
    const args = (params?.arguments as Record<string, unknown>) ?? {};
    const url  = args.url as string;
    const maxLen = (args.max_length as number) ?? 20000;

    if (!url) {
      send({ jsonrpc: "2.0", id, error: { code: -32602, message: "url is required" } });
      return;
    }

    try {
      const raw = name === "fetch" ? Boolean(args.raw) : false;
      const content = await doFetch(url, maxLen, raw);
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: content }] } });
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
    const t = line.trim();
    if (!t) continue;
    try { handleMessage(JSON.parse(t)); } catch {}
  }
});
process.stdin.resume();
