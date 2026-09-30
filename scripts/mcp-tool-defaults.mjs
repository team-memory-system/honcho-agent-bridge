// The MCP tools that change memory. Recall needs none of them, so they stay off
// until the user turns them on in mcp-tools.json, the file the dashboard's MCP
// tool setting also writes. tests/mcp-server.test.mjs keeps this list equal to the
// tools mcp-server.mjs marks readOnly: false.
export const WRITE_TOOLS = Object.freeze([
  "set_metadata",
  "create_peer",
  "set_peer_card",
  "create_session",
  "delete_session",
  "clone_session",
  "add_peers_to_session",
  "remove_peers_from_session",
  "add_messages_to_session",
  "create_conclusions",
  "delete_conclusion",
  "schedule_dream",
]);

// Every tool mcp-server.mjs offers, in its order. The app's tool switches accept
// only these names; tests/mcp-server.test.mjs keeps the list equal to the server's.
export const ALL_TOOLS = Object.freeze([
  "server_info", "inspect_workspace", "list_workspaces", "search", "get_metadata", "set_metadata", "create_peer",
  "list_peers", "chat", "get_peer_card", "set_peer_card", "get_peer_context", "get_representation", "create_session",
  "list_sessions", "delete_session", "clone_session", "add_peers_to_session", "remove_peers_from_session",
  "get_session_peers", "inspect_session", "add_messages_to_session", "get_session_messages", "get_session_message",
  "get_session_context", "list_conclusions", "query_conclusions", "create_conclusions", "delete_conclusion",
  "schedule_dream", "get_queue_status",
]);
