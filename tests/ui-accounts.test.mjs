// The gateway screen groups accounts by backend so its up/down buttons only offer
// moves the gateway actually makes.
import assert from "node:assert/strict";
import test from "node:test";

import { accountGroups, backendName, modelGroups, sharedGroups } from "../ui/lib/accounts.js";

const account = (id, backend) => ({ id, backend });

// The gateway's own rule (subscription-gateway gateway/accounts.mjs moveAccount):
// swap with the neighbour of the same backend, or leave the order alone.
function gatewayMove(accounts, id, direction) {
  const next = [...accounts];
  const index = next.findIndex((entry) => entry.id === id);
  const same = next.map((entry, position) => ({ entry, position })).filter(({ entry }) => entry.backend === next[index].backend);
  const rank = same.findIndex(({ position }) => position === index);
  const neighbour = same[direction === "up" ? rank - 1 : rank + 1];
  if (!neighbour) return next;
  [next[index], next[neighbour.position]] = [next[neighbour.position], next[index]];
  return next;
}

const ids = (list) => list.map((entry) => entry.id).join(",");

function summary(groups) {
  return groups.map((group) => ({
    backend: group.backend,
    ordered: group.ordered,
    accounts: group.accounts.map((entry) => [entry.account.id, entry.position, entry.canMoveUp, entry.canMoveDown]),
  }));
}

test("one Codex and two Claude accounts: only the Claude pair can be reordered", () => {
  const groups = accountGroups([account("codex-1", "codex"), account("claude-1", "claude"), account("claude-2", "claude")]);
  assert.deepEqual(summary(groups), [
    { backend: "codex", ordered: false, accounts: [["codex-1", 1, false, false]] },
    { backend: "claude", ordered: true, accounts: [["claude-1", 1, false, true], ["claude-2", 2, true, false]] },
  ]);
  assert.deepEqual(sharedGroups(groups).map((group) => group.backend), ["claude"]);
});

test("interleaved accounts are grouped Codex first, each group in the gateway's order", () => {
  const groups = accountGroups([
    account("claude-2", "claude"), account("codex-1", "codex"), account("claude-1", "claude"), account("codex-2", "codex"),
  ]);
  assert.deepEqual(summary(groups), [
    { backend: "codex", ordered: true, accounts: [["codex-1", 1, false, true], ["codex-2", 2, true, false]] },
    { backend: "claude", ordered: true, accounts: [["claude-2", 1, false, true], ["claude-1", 2, true, false]] },
  ]);
  assert.deepEqual(sharedGroups(groups).map((group) => group.backend), ["codex", "claude"]);
});

test("a move is offered exactly when the gateway would change the order", () => {
  const layouts = [
    [account("codex-1", "codex"), account("claude-1", "claude"), account("claude-2", "claude")],
    [account("claude-1", "claude"), account("codex-1", "codex"), account("claude-2", "claude"), account("codex-2", "codex"), account("codex-3", "codex")],
    [account("claude-1", "claude")],
  ];
  for (const accounts of layouts) {
    for (const group of accountGroups(accounts)) {
      for (const entry of group.accounts) {
        const id = entry.account.id;
        assert.equal(entry.canMoveUp, ids(gatewayMove(accounts, id, "up")) !== ids(accounts), `${ids(accounts)}: ${id} up`);
        assert.equal(entry.canMoveDown, ids(gatewayMove(accounts, id, "down")) !== ids(accounts), `${ids(accounts)}: ${id} down`);
      }
    }
  }
});

test("no accounts, broken entries and unknown backends", () => {
  assert.deepEqual(accountGroups([]), []);
  assert.deepEqual(accountGroups(undefined), []);
  assert.deepEqual(sharedGroups(accountGroups(null)), []);
  const groups = accountGroups([null, { backend: "codex" }, account("gemini-1", "gemini"), account("codex-1", "codex"), account("odd-1")]);
  assert.deepEqual(groups.map((group) => [group.backend, group.label, group.accounts.length]), [["codex", "Codex", 1], ["gemini", "gemini", 1], ["", "기타", 1]]);
  assert.equal(backendName("claude"), "Claude");
});

test("models are grouped by the backend of the account that offers them", () => {
  const accounts = [account("codex-1", "codex"), account("claude-1", "claude"), account("claude-2", "claude")];
  const models = [
    { id: "claude-opus-5-5", ownedBy: "claude-1" },
    { id: "gpt-5.5", ownedBy: "codex-1" },
    { id: "gpt-6-luna", ownedBy: "codex-1" },
    { id: "claude-sonnet-5", ownedBy: "claude-2" },
    { id: "claude-opus-5-5", ownedBy: "claude-2" },
    { id: "local-1", ownedBy: "ollama" },
    { id: "mystery" },
    { ownedBy: "codex-1" },
  ];
  assert.deepEqual(modelGroups(models, accounts).map((group) => [group.label, group.models]), [
    ["Codex", ["gpt-5.5", "gpt-6-luna"]],
    ["Claude", ["claude-opus-5-5", "claude-sonnet-5"]],
    ["ollama", ["local-1"]],
    ["기타", ["mystery"]],
  ]);
  assert.deepEqual(modelGroups(undefined, undefined), []);
});
