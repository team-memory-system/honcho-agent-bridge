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
