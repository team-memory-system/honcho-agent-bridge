import path from "node:path";
import readline from "node:readline";

import { installPaths, loadConfig, readJson } from "./config.mjs";
import {
  accessRefusedMessage,
  configuredAccess,
  environmentAccess,
  fetchHoncho,
  honchoHeaders,
  isCloudflareAccessBlock,
} from "./honcho-access.mjs";
import { WRITE_TOOLS } from "./mcp-tool-defaults.mjs";
import { VERSION } from "./version.mjs";

const SERVER_NAME = "Honcho Agent Bridge";
const SERVER_VERSION = VERSION;
const DEFAULT_PROTOCOL_VERSION = "2025-11-25";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  DEFAULT_PROTOCOL_VERSION,
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

let negotiatedProtocolVersion = DEFAULT_PROTOCOL_VERSION;

const providerIndex = process.argv.indexOf("--provider");
const PROVIDER = providerIndex >= 0 ? String(process.argv[providerIndex + 1] || "agent").trim().toLowerCase() : "agent";

const STRING = { type: "string" };
const BOOLEAN = { type: "boolean" };
const INTEGER = { type: "integer", minimum: 1 };
const NUMBER = { type: "number" };
const OBJECT = { type: "object", additionalProperties: true };
const STRING_ARRAY = { type: "array", items: { type: "string" } };
const PEERS = {
  oneOf: [
    { type: "object", additionalProperties: { type: "object", additionalProperties: true } },
    { type: "array", items: { type: "object", additionalProperties: true } },
  ],
};
const MESSAGES = { type: "array", items: { type: "object", additionalProperties: true } };
const CONCLUSIONS = { type: "array", items: { type: "object", additionalProperties: true } };

function inputSchema(properties = {}, required = []) {
  const schema = { type: "object", properties, additionalProperties: false };
  if (required.length) schema.required = required;
  return schema;
}

function encode(value) {
  return encodeURIComponent(String(value));
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function publicBaseUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "[invalid URL]";
  }
}

function findById(items, id) {
  const item = Array.isArray(items) ? items.find((candidate) => candidate?.id === id) : null;
  if (!item) throw new Error(`Resource not found: ${id}`);
  return item;
}

function boolParam(value) {
  return value === undefined || value === null ? undefined : String(Boolean(value)).toLowerCase();
}

async function runtimeContext() {
  const config = await loadConfig();
  if (!config) {
    throw new Error("Honcho Agent Bridge is not configured. Run the setup-memory skill first.");
  }
  const baseUrl = String(config.honcho?.baseUrl || "http://127.0.0.1:8001").replace(/\/+$/, "");
  const workspaceId = String(config.honcho?.workspaceId || "memory");
  const userName = String(config.user?.peerId || "").trim();
  if (!userName) throw new Error("Honcho Agent Bridge has no user peer ID. Run setup again.");
  const assistantName = PROVIDER === "agent" ? "assistant" : `assistant_${PROVIDER}`;
  const token = String(config.honcho?.apiToken || process.env.HONCHO_API_BEARER_TOKEN || "").trim();
  // The memory server's own Access service token.
  const access = configuredAccess(config) || environmentAccess(process.env);
  return { config, baseUrl, workspaceId, userName, assistantName, token, access };
}

async function disabledToolNames(config) {
  const names = new Set();
  const document = await readJson(path.join(installPaths(config).dataDir, "mcp-tools.json"), null);
  const values = document?.disabled_tools;
  if (Array.isArray(values)) values.forEach((name) => names.add(String(name)));
  // No tool file at all: an install from before setup wrote one. Default to recall only.
  else if (!document) WRITE_TOOLS.forEach((name) => names.add(name));
  return names;
}

async function honchoRequest(context, method, apiPath, { body, params } = {}) {
  const url = new URL(`${context.baseUrl}${apiPath}`);
  for (const [key, value] of Object.entries(compact(params || {}))) {
    if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
    else url.searchParams.set(key, String(value));
  }
  const headers = honchoHeaders(
    { token: context.token, access: context.access },
    { Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetchHoncho(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (await isCloudflareAccessBlock(response)) throw new Error(accessRefusedMessage(context.baseUrl));
    const text = await response.text();
    if (!response.ok) throw new Error(`Honcho API ${response.status} for ${apiPath}: ${text.slice(0, 2000)}`);
    if (!text) return { ok: true, status_code: response.status };
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) return JSON.parse(text);
    try {
      return JSON.parse(text);
    } catch {
      return { text, status_code: response.status };
    }
  } finally {
    clearTimeout(timeout);
  }
}

function defaults(context, args) {
  return {
    workspace: args.workspace_id || context.workspaceId,
    user: args.user_name || context.userName,
    assistant: args.assistant_name || context.assistantName,
  };
}

function coercePeers(peers) {
  if (!Array.isArray(peers)) return peers;
  return Object.fromEntries(
    peers.map((item) => {
      const peerId = item?.peer_id || item?.id;
      if (!peerId) throw new Error("Each peer item must include peer_id or id");
      const isAgentPeer = String(peerId).startsWith("assistant_") || String(peerId).startsWith("automation_");
      return [String(peerId), { observe_me: item.observe_me ?? !isAgentPeer, observe_others: item.observe_others ?? false }];
    }),
  );
}

function coerceMessages(messages, resolved) {
  return messages.map((item) => {
    let peerId = item?.peer_id;
    if (!peerId && item?.role === "user") peerId = resolved.user;
    if (!peerId && item?.role === "assistant") peerId = resolved.assistant;
    if (!peerId) throw new Error("Each message needs peer_id, or role=user/assistant");
    if (item?.content === undefined || item?.content === null) throw new Error("Each message needs content");
    return compact({
      peer_id: String(peerId),
      content: String(item.content),
      metadata: item.metadata,
      configuration: item.configuration,
      created_at: item.created_at,
    });
  });
}

function tool(name, description, properties, required, run, { readOnly = true, destructive = false } = {}) {
  return {
    name,
    title: name.split("_").map((part) => part[0].toUpperCase() + part.slice(1)).join(" "),
    description,
    inputSchema: inputSchema(properties, required),
    annotations: {
      readOnlyHint: readOnly,
      destructiveHint: destructive,
      idempotentHint: readOnly,
      openWorldHint: true,
    },
    run,
  };
}

const workspaceProp = { workspace_id: { ...STRING, description: "Workspace ID; defaults to the configured personal workspace." } };
const filterProp = { filters: { ...OBJECT, description: "Optional Honcho API filters." } };

const TOOLS = [
  tool("server_info", "Inspect this local Honcho Agent Bridge bridge and its upstream Honcho health.", {}, [], async (context) => {
    const disabled = await disabledToolNames(context.config);
    return {
      mcp_name: SERVER_NAME,
      mcp_version: SERVER_VERSION,
      provider: PROVIDER,
      honcho_base_url: publicBaseUrl(context.baseUrl),
      workspace_id: context.workspaceId,
      user_name: context.userName,
      assistant_name: context.assistantName,
      auth_enabled: Boolean(context.token),
      disabled_tools: [...disabled].sort(),
      upstream_health: await honchoRequest(context, "GET", "/health"),
    };
  }),
  tool("inspect_workspace", "Inspect one workspace by ID.", workspaceProp, [], async (context, args) => {
    const ws = defaults(context, args).workspace;
    const result = await honchoRequest(context, "POST", "/v3/workspaces/list", { body: {} });
    return findById(result.items, ws);
  }),
  tool("list_workspaces", "List all available Honcho workspaces.", filterProp, [], (context, args) =>
    honchoRequest(context, "POST", "/v3/workspaces/list", { body: compact({ filters: args.filters }) }),
  ),
  tool(
    "search",
    "Search messages across the workspace, or narrow the search to one peer or session.",
    {
      query: { ...STRING, minLength: 1 },
      ...workspaceProp,
      peer_id: STRING,
      session_id: STRING,
      limit: { ...INTEGER, default: 10 },
      ...filterProp,
    },
    ["query"],
    (context, args) => {
      const ws = defaults(context, args).workspace;
      const body = compact({ query: args.query, limit: args.limit ?? 10, filters: args.filters });
      if (args.session_id) return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/sessions/${encode(args.session_id)}/search`, { body });
      if (args.peer_id) return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/peers/${encode(args.peer_id)}/search`, { body });
      return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/search`, { body });
    },
  ),
  tool(
    "get_metadata",
    "Get metadata for a workspace, peer, or session.",
    { scope: { type: "string", enum: ["workspace", "peer", "session"], default: "workspace" }, ...workspaceProp, peer_id: STRING, session_id: STRING },
    [],
    async (context, args) => {
      const ws = defaults(context, args).workspace;
      const scope = args.scope || "workspace";
      if (scope === "workspace") {
        const result = await honchoRequest(context, "POST", "/v3/workspaces/list", { body: {} });
        return { scope, id: ws, metadata: findById(result.items, ws).metadata || {} };
      }
      const id = scope === "peer" ? args.peer_id : args.session_id;
      if (!id) throw new Error(`${scope}_id is required when scope='${scope}'`);
      const resource = scope === "peer" ? "peers" : "sessions";
      const result = await honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/${resource}/list`, { body: {} });
      return { scope, id, metadata: findById(result.items, id).metadata || {} };
    },
  ),
  tool(
    "set_metadata",
    "Set metadata for a workspace, peer, or session.",
    { metadata: OBJECT, scope: { type: "string", enum: ["workspace", "peer", "session"], default: "workspace" }, ...workspaceProp, peer_id: STRING, session_id: STRING, configuration: OBJECT },
    ["metadata"],
    (context, args) => {
      const ws = defaults(context, args).workspace;
      const scope = args.scope || "workspace";
      const body = compact({ metadata: args.metadata, configuration: args.configuration });
      if (scope === "workspace") return honchoRequest(context, "PUT", `/v3/workspaces/${encode(ws)}`, { body });
      const id = scope === "peer" ? args.peer_id : args.session_id;
      if (!id) throw new Error(`${scope}_id is required when scope='${scope}'`);
      const resource = scope === "peer" ? "peers" : "sessions";
      return honchoRequest(context, "PUT", `/v3/workspaces/${encode(ws)}/${resource}/${encode(id)}`, { body });
    },
    { readOnly: false },
  ),
  tool(
    "create_peer",
    "Create or retrieve a peer in the workspace.",
    { peer_id: STRING, ...workspaceProp, metadata: OBJECT, configuration: OBJECT },
    ["peer_id"],
    (context, args) => {
      const ws = defaults(context, args).workspace;
      return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/peers`, { body: compact({ id: args.peer_id, metadata: args.metadata, configuration: args.configuration }) });
    },
    { readOnly: false },
  ),
  tool("list_peers", "List peers in a workspace.", { ...workspaceProp, ...filterProp }, [], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/peers/list`, { body: compact({ filters: args.filters }) });
  }),
  tool(
    "chat",
    "Ask Honcho what it knows about a peer using natural language and Honcho's internal dialectic pipeline.",
    { query: { ...STRING, minLength: 1 }, peer_id: STRING, target_peer_id: STRING, session_id: STRING, reasoning_level: { type: "string", enum: ["minimal", "low", "medium", "high", "max"], default: "low" }, ...workspaceProp },
    ["query"],
    (context, args) => {
      const resolved = defaults(context, args);
      const observer = args.peer_id || resolved.assistant;
      return honchoRequest(context, "POST", `/v3/workspaces/${encode(resolved.workspace)}/peers/${encode(observer)}/chat`, {
        body: compact({ query: args.query, target: args.target_peer_id, session_id: args.session_id, reasoning_level: args.reasoning_level || "low" }),
      });
    },
  ),
  tool("get_peer_card", "Get a compact peer card from an observer's perspective.", { peer_id: STRING, observer_id: STRING, ...workspaceProp }, ["peer_id"], (context, args) => {
    const resolved = defaults(context, args);
    return honchoRequest(context, "GET", `/v3/workspaces/${encode(resolved.workspace)}/peers/${encode(args.observer_id || resolved.assistant)}/card`, { params: { target: args.peer_id } });
  }),
  tool("set_peer_card", "Set a peer card from an observer's perspective.", { peer_id: STRING, peer_card: STRING_ARRAY, observer_id: STRING, ...workspaceProp }, ["peer_id", "peer_card"], (context, args) => {
    const resolved = defaults(context, args);
    return honchoRequest(context, "PUT", `/v3/workspaces/${encode(resolved.workspace)}/peers/${encode(args.observer_id || resolved.assistant)}/card`, { body: { peer_card: args.peer_card }, params: { target: args.peer_id } });
  }, { readOnly: false }),
  tool(
    "get_peer_context",
    "Get a target peer's representation and peer card from a selected observer perspective.",
    { peer_id: STRING, observer_id: STRING, ...workspaceProp, search_query: STRING, search_top_k: INTEGER, search_max_distance: NUMBER, include_most_frequent: { ...BOOLEAN, default: true }, max_conclusions: INTEGER },
    ["peer_id"],
    (context, args) => {
      const resolved = defaults(context, args);
      return honchoRequest(context, "GET", `/v3/workspaces/${encode(resolved.workspace)}/peers/${encode(args.observer_id || resolved.assistant)}/context`, {
        params: compact({ target: args.peer_id, search_query: args.search_query, search_top_k: args.search_top_k, search_max_distance: args.search_max_distance, include_most_frequent: args.include_most_frequent ?? true, max_conclusions: args.max_conclusions }),
      });
    },
  ),
  tool(
    "get_representation",
    "Get a textual representation of a target peer from a selected observer perspective.",
    { peer_id: STRING, observer_id: STRING, ...workspaceProp, session_id: STRING, search_query: STRING, search_top_k: INTEGER, search_max_distance: NUMBER, include_most_frequent: BOOLEAN, max_conclusions: INTEGER },
    ["peer_id"],
    (context, args) => {
      const resolved = defaults(context, args);
      return honchoRequest(context, "POST", `/v3/workspaces/${encode(resolved.workspace)}/peers/${encode(args.observer_id || resolved.assistant)}/representation`, {
        body: compact({ target: args.peer_id, session_id: args.session_id, search_query: args.search_query, search_top_k: args.search_top_k, search_max_distance: args.search_max_distance, include_most_frequent: args.include_most_frequent, max_conclusions: args.max_conclusions }),
      });
    },
  ),
  tool("create_session", "Create or retrieve a session.", { session_id: STRING, ...workspaceProp, metadata: OBJECT, configuration: OBJECT, peers: PEERS }, ["session_id"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/sessions`, { body: compact({ id: args.session_id, metadata: args.metadata, configuration: args.configuration, peers: args.peers === undefined ? undefined : coercePeers(args.peers) }) });
  }, { readOnly: false }),
  tool("list_sessions", "List sessions in a workspace.", { ...workspaceProp, ...filterProp }, [], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/sessions/list`, { body: compact({ filters: args.filters }) });
  }),
  tool("delete_session", "Delete a session and its stored messages.", { session_id: STRING, ...workspaceProp }, ["session_id"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "DELETE", `/v3/workspaces/${encode(ws)}/sessions/${encode(args.session_id)}`);
  }, { readOnly: false, destructive: true }),
  tool("clone_session", "Clone a session, optionally cutting off at a message ID.", { session_id: STRING, ...workspaceProp, message_id: STRING }, ["session_id"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/sessions/${encode(args.session_id)}/clone`, { params: compact({ message_id: args.message_id }) });
  }, { readOnly: false }),
  tool("add_peers_to_session", "Add peers and observation settings to a session.", { session_id: STRING, peers: PEERS, ...workspaceProp }, ["session_id", "peers"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/sessions/${encode(args.session_id)}/peers`, { body: coercePeers(args.peers) });
  }, { readOnly: false }),
  tool("remove_peers_from_session", "Remove peers from a session.", { session_id: STRING, peer_ids: STRING_ARRAY, ...workspaceProp }, ["session_id", "peer_ids"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "DELETE", `/v3/workspaces/${encode(ws)}/sessions/${encode(args.session_id)}/peers`, { body: args.peer_ids });
  }, { readOnly: false, destructive: true }),
  tool("get_session_peers", "List peers and observation settings in a session.", { session_id: STRING, ...workspaceProp }, ["session_id"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "GET", `/v3/workspaces/${encode(ws)}/sessions/${encode(args.session_id)}/peers`);
  }),
  tool("inspect_session", "Inspect one session by ID.", { session_id: STRING, ...workspaceProp }, ["session_id"], async (context, args) => {
    const ws = defaults(context, args).workspace;
    const result = await honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/sessions/list`, { body: {} });
    return findById(result.items, args.session_id);
  }),
  tool("add_messages_to_session", "Add messages to a session. Messages may use peer_id, or role=user/assistant.", { session_id: STRING, messages: MESSAGES, ...workspaceProp }, ["session_id", "messages"], (context, args) => {
    const resolved = defaults(context, args);
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(resolved.workspace)}/sessions/${encode(args.session_id)}/messages`, { body: { messages: coerceMessages(args.messages, resolved) } });
  }, { readOnly: false }),
  tool("get_session_messages", "List messages in a session.", { session_id: STRING, ...workspaceProp, ...filterProp }, ["session_id"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/sessions/${encode(args.session_id)}/messages/list`, { body: compact({ filters: args.filters }) });
  }),
  tool("get_session_message", "Get one message from a session.", { session_id: STRING, message_id: STRING, ...workspaceProp }, ["session_id", "message_id"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "GET", `/v3/workspaces/${encode(ws)}/sessions/${encode(args.session_id)}/messages/${encode(args.message_id)}`);
  }),
  tool(
    "get_session_context",
    "Get LLM-ready context for a session, optionally including a peer representation and card.",
    { session_id: STRING, ...workspaceProp, tokens: INTEGER, summary: { ...BOOLEAN, default: true }, search_query: STRING, peer_target: STRING, peer_perspective: STRING, limit_to_session: { ...BOOLEAN, default: false }, search_top_k: INTEGER, search_max_distance: NUMBER, include_most_frequent: { ...BOOLEAN, default: false }, max_conclusions: INTEGER },
    ["session_id"],
    (context, args) => {
      const ws = defaults(context, args).workspace;
      return honchoRequest(context, "GET", `/v3/workspaces/${encode(ws)}/sessions/${encode(args.session_id)}/context`, {
        params: compact({ tokens: args.tokens, summary: boolParam(args.summary ?? true), search_query: args.search_query, peer_target: args.peer_target, peer_perspective: args.peer_perspective, limit_to_session: boolParam(args.limit_to_session ?? false), search_top_k: args.search_top_k, search_max_distance: args.search_max_distance, include_most_frequent: boolParam(args.include_most_frequent ?? false), max_conclusions: args.max_conclusions }),
      });
    },
  ),
  tool("list_conclusions", "List derived conclusions in a workspace.", { ...workspaceProp, ...filterProp, reverse: { ...BOOLEAN, default: false } }, [], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/conclusions/list`, { body: compact({ filters: args.filters }), params: { reverse: boolParam(args.reverse ?? false) } });
  }),
  tool(
    "query_conclusions",
    "Semantic search across derived conclusions for an observer/observed peer pair.",
    { query: STRING, observer_id: STRING, observed_id: STRING, ...workspaceProp, top_k: { ...INTEGER, default: 10 }, distance: NUMBER, ...filterProp },
    ["query", "observer_id", "observed_id"],
    (context, args) => {
      const ws = defaults(context, args).workspace;
      const filters = { ...(args.filters || {}) };
      filters.observer ??= args.observer_id;
      filters.observed ??= args.observed_id;
      return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/conclusions/query`, { body: compact({ query: args.query, top_k: args.top_k ?? 10, distance: args.distance, filters }) });
    },
  ),
  tool("create_conclusions", "Create one or more derived conclusions.", { conclusions: CONCLUSIONS, ...workspaceProp }, ["conclusions"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/conclusions`, { body: { conclusions: args.conclusions } });
  }, { readOnly: false }),
  tool("delete_conclusion", "Delete a conclusion by ID.", { conclusion_id: STRING, ...workspaceProp }, ["conclusion_id"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "DELETE", `/v3/workspaces/${encode(ws)}/conclusions/${encode(args.conclusion_id)}`);
  }, { readOnly: false, destructive: true }),
  tool("schedule_dream", "Schedule Honcho dream/consolidation work for a peer pair.", { observer_id: STRING, ...workspaceProp, observed_id: STRING, dream_type: { type: "string", default: "omni" }, session_id: STRING }, ["observer_id"], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "POST", `/v3/workspaces/${encode(ws)}/schedule_dream`, { body: compact({ observer: args.observer_id, observed: args.observed_id, dream_type: args.dream_type || "omni", session_id: args.session_id }) });
  }, { readOnly: false }),
  tool("get_queue_status", "Inspect Honcho's derivation queue.", { ...workspaceProp, observer_id: STRING, sender_id: STRING, session_id: STRING }, [], (context, args) => {
    const ws = defaults(context, args).workspace;
    return honchoRequest(context, "GET", `/v3/workspaces/${encode(ws)}/queue/status`, { params: compact({ observer_id: args.observer_id, sender_id: args.sender_id, session_id: args.session_id }) });
  }),
];

const TOOL_BY_NAME = new Map(TOOLS.map((entry) => [entry.name, entry]));

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function availableTools() {
  const config = await loadConfig();
  // Before setup every call would only fail with "not configured", so offer none
  // rather than tools the agent cannot use.
  if (!String(config?.user?.peerId || "").trim()) return [];
  const disabled = await disabledToolNames(config);
  return TOOLS.filter((entry) => !disabled.has(entry.name));
}

async function callTool(name, args) {
  const toolEntry = TOOL_BY_NAME.get(name);
  if (!toolEntry) throw new Error(`Unknown tool: ${name}`);
  const config = await loadConfig();
  if (config && (await disabledToolNames(config)).has(name)) throw new Error(`Tool is disabled: ${name}`);
  const context = await runtimeContext();
  return toolEntry.run(context, args || {});
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    const requestedVersion = params?.protocolVersion;
    if (typeof requestedVersion !== "string" || !requestedVersion) {
      sendError(id, -32602, "initialize requires a protocolVersion string");
      return;
    }
    negotiatedProtocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : DEFAULT_PROTOCOL_VERSION;
    sendResult(id, {
      protocolVersion: negotiatedProtocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Self-hosted Honcho personal memory. For broad recall, read the configured user's representation from the user's own observer perspective and also run workspace-wide search.",
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    const entries = await availableTools();
    sendResult(id, { tools: entries.map(({ run, ...definition }) => definition) });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await callTool(params?.name, params?.arguments);
      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        // MCP requires an object here; search returns a list, which Claude Code rejected.
        structuredContent: result && typeof result === "object" && !Array.isArray(result) ? result : { result },
        isError: false,
      });
    } catch (error) {
      sendResult(id, {
        content: [{ type: "text", text: String(error?.message || error) }],
        isError: true,
      });
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `Method not found: ${method}`);
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = Promise.resolve();
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  pending = pending.then(() => handle(message)).catch((error) => {
    if (message.id !== undefined) sendError(message.id, -32603, String(error?.message || error));
    else process.stderr.write(`${String(error?.stack || error)}\n`);
  });
});
