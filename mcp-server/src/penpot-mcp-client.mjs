const endpoint = (process.env.PENPOT_MCP_URL ?? "http://localhost:4401/mcp").replace(/\/$/, "");

function parseResponse(text) {
  const payload = text.trim();
  if (!payload) return {};
  if (payload.includes("data:")) {
    const line = payload.split(/\r?\n/).find((entry) => entry.startsWith("data:"));
    if (!line) throw new Error("Penpot MCP sent an invalid SSE response.");
    return JSON.parse(line.slice(5).trim());
  }
  return JSON.parse(payload);
}

export class PenpotMcpClient {
  constructor() { this.sessionId = undefined; this.nextId = 1; }

  async request(method, params, notification = false) {
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    const message = { jsonrpc: "2.0", method, params };
    if (!notification) message.id = this.nextId++;
    let response;
    try { response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(message) }); }
    catch (error) { throw new Error(`Penpot MCP is unreachable at ${endpoint}. Start the Penpot MCP server and connect its Penpot plugin. (${error.message})`); }
    if (notification) return;
    const body = parseResponse(await response.text());
    if (!response.ok || body.error) throw new Error(body.error?.message ?? `Penpot MCP request failed (${response.status}).`);
    return { result: body.result, sessionId: response.headers.get("mcp-session-id") ?? undefined };
  }

  async connect() {
    const initialized = await this.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "penpot-unity-ui-mcp", version: "1.0.0" } });
    // Streamable HTTP implementations return this header on initialization.
    // Read it from a dedicated initialization request if a server requires it.
    if (!initialized.result || !initialized.sessionId) throw new Error("Penpot MCP did not return a Streamable HTTP session ID.");
    this.sessionId = initialized.sessionId;
    await this.request("notifications/initialized", {}, true);
  }

  async callTool(name, arguments_) {
    const response = await this.request("tools/call", { name, arguments: arguments_ });
    const result = response.result;
    if (result?.isError) throw new Error(result.content?.map((item) => item.text ?? "").join("\n") || `Penpot tool ${name} failed.`);
    return result;
  }
}

export function textContent(result) {
  const item = result?.content?.find((entry) => entry.type === "text");
  if (!item?.text) throw new Error("Penpot MCP returned no text result.");
  return item.text;
}

export function imageContent(result) {
  const item = result?.content?.find((entry) => entry.type === "image" && entry.data);
  if (!item) throw new Error("Penpot MCP returned no PNG image data.");
  return item.data;
}
