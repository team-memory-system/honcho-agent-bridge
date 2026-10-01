// The gateway's accounts and models, sorted the way the gateway uses them. A
// model belongs to one backend, and the gateway moves an account only past its
// neighbour of the same backend (subscription-gateway, gateway/accounts.mjs
// moveAccount), so order means something only inside a backend: in drain mode
// the first account is used until its limit, then the next. No DOM here, so a
// node test can check it.

const BACKEND_ORDER = ["codex", "claude"];

export function backendName(backend) {
  if (backend === "codex") return "Codex";
  if (backend === "claude") return "Claude";
  return backend || "기타";
}

// Codex, then Claude, then anything else in the order it first appeared.
function byBackend(entries) {
  const rank = (backend) => {
    const index = BACKEND_ORDER.indexOf(backend);
    return index < 0 ? BACKEND_ORDER.length : index;
  };
  return [...entries].sort(([a], [b]) => rank(a) - rank(b));
}

/**
 * Accounts grouped by backend, each group in the gateway's order. An account can
 * move up or down only inside a group of two or more, and never past its edge.
 */
export function accountGroups(accounts) {
  const groups = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account?.id) continue;
    const backend = account.backend || "";
    if (!groups.has(backend)) groups.set(backend, []);
    groups.get(backend).push(account);
  }
  return byBackend(groups).map(([backend, list]) => ({
    backend,
    label: backendName(backend),
    ordered: list.length > 1,
    accounts: list.map((account, index) => ({
      account,
      position: index + 1,
      canMoveUp: index > 0,
      canMoveDown: index < list.length - 1,
    })),
  }));
}

/** The groups where drain or balance changes anything: two or more accounts. */
export function sharedGroups(groups) {
  return (groups || []).filter((group) => group.ordered);
}

/** Model ids by the backend of the account that offers them, each id once. */
export function modelGroups(models, accounts) {
  const owners = new Map((Array.isArray(accounts) ? accounts : []).filter((account) => account?.id).map((account) => [account.id, account.backend]));
  const groups = new Map();
  for (const model of Array.isArray(models) ? models : []) {
    const id = typeof model === "string" ? model : model?.id;
    if (!id) continue;
    const backend = owners.get(model?.ownedBy) || model?.ownedBy || "";
    if (!groups.has(backend)) groups.set(backend, new Set());
    groups.get(backend).add(id);
  }
  return byBackend(groups).map(([backend, ids]) => ({ backend, label: backendName(backend), models: [...ids] }));
}
