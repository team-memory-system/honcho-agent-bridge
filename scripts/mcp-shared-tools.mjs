// How a computer's own recall tools and a teammate's shared bridge sit in one MCP
// tool list. Kept apart from mcp-server.mjs, which starts reading stdin as soon as
// it is loaded, so the merge rules can be tested on their own.
//
// The three features a computer can combine decide the shape of the list:
//   - own memory only (sync to the user's server): the local tools, as always;
//   - shared bridge only ("chat only"): the bridge's tools under their own names;
//   - both: the local tools, plus the bridge's tools renamed `shared_<name>`.

export const SHARED_PREFIX = "shared_";

/**
 * This computer sends its own conversations to the user's own server: a server
 * address, a user peer, and at least one agent whose hooks are on. A bridge-only
 * config (what `bridge connect` writes on a fresh computer) has none of those.
 */
export function hasOwnMemory(config) {
  const honcho = config?.honcho || {};
  return Boolean(
    String(honcho.baseUrl || "").trim()
      && String(config?.user?.peerId || "").trim()
      && Object.values(config?.agents || {}).some(Boolean),
  );
}

/** The host a shared tool's description names; never a credential or a path. */
export function bridgeHost(url) {
  try {
    return new URL(url).host || "the shared bridge";
  } catch {
    return "the shared bridge";
  }
}

export function sharedNote(host) {
  return `Asks the shared memory at ${host} (a teammate's memory), not yours.`;
}

export function unreachableNote(host) {
  return `The shared memory at ${host} (a teammate's memory) is unreachable right now; calls fail until it answers again.`;
}

export function isSharedName(name) {
  return typeof name === "string" && name.startsWith(SHARED_PREFIX) && name.length > SHARED_PREFIX.length;
}

export function unsharedName(name) {
  return name.slice(SHARED_PREFIX.length);
}

/**
 * The bridge's tools as this computer lists them next to its own: renamed with the
 * prefix, the description led by a note saying whose memory answers, the input
 * schema and every other field passed through unchanged.
 *
 * A prefixed name that collides with a local tool is skipped. No local tool starts
 * with `shared_` today, so this cannot happen with the current tool set; the rule
 * is here so that routing stays unambiguous if one ever does: a name the local
 * server knows is always answered locally, and a shared tool must never shadow it.
 */
export function sharedTools(bridgeTools, { host, localNames, unreachable = false }) {
  const taken = new Set(localNames);
  const listed = [];
  for (const entry of Array.isArray(bridgeTools) ? bridgeTools : []) {
    if (!entry || typeof entry.name !== "string" || !entry.name) continue;
    const name = `${SHARED_PREFIX}${entry.name}`;
    if (taken.has(name)) continue;
    taken.add(name);
    const note = unreachable ? unreachableNote(host) : sharedNote(host);
    const original = typeof entry.description === "string" ? entry.description.trim() : "";
    listed.push({
      ...entry,
      name,
      ...(entry.title ? { title: `Shared ${entry.title}` } : {}),
      description: original ? `${note} ${original}` : note,
    });
  }
  return listed;
}
