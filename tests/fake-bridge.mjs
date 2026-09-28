// A stand-in for local-mcp-bridge's HTTP endpoint: it refuses a wrong bearer at the
// HTTP layer, as the real one does, and answers initialize and tools/list with the
// single `chat` tool a shared bridge exposes.
import http from "node:http";

export const BRIDGE_TOKEN = "bridge-token-value";

export function startBridge({ token = BRIDGE_TOKEN } = {}) {
  const seen = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const message = raw ? JSON.parse(raw) : null;
    seen.push({ headers: request.headers, message });
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized: missing or invalid bearer token" }));
      return;
    }
    if (message?.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result = message.method === "initialize"
      ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "Local Honcho MCP", version: "1" } }
      : { tools: [{ name: "chat", description: "Ask Honcho", inputSchema: { type: "object" } }] };
    response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "session-1" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    server,
    seen,
    url: `http://127.0.0.1:${server.address().port}/mcp`,
  })));
}
