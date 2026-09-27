import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { VERSION } from "../scripts/version.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function json(relativePath) {
  return JSON.parse(await fsp.readFile(path.join(ROOT, relativePath), "utf8"));
}

test("Codex, Claude, package, and marketplace metadata stay aligned", async () => {
  const [codex, claude, marketplace, pkg, codexMcp, claudeMcp] = await Promise.all([
    json(".codex-plugin/plugin.json"),
    json(".claude-plugin/plugin.json"),
    json(".claude-plugin/marketplace.json"),
    json("package.json"),
    json(".mcp.json"),
    json(".mcp.claude.json"),
  ]);
  assert.equal(codex.name, "honcho-agent-bridge");
  assert.equal(claude.name, codex.name);
  assert.equal(pkg.name, codex.name);
  assert.equal(marketplace.name, codex.name);
  assert.equal(marketplace.plugins[0].name, codex.name);
  assert.equal(marketplace.plugins[0].source, "./");
  assert.deepEqual([codex.version, claude.version, pkg.version], [VERSION, VERSION, VERSION]);
  assert.equal(codex.mcpServers, "./.mcp.json");
  assert.equal(claude.mcpServers, "./.mcp.claude.json");
  assert.ok(codexMcp.mcpServers["honcho-agent-bridge"]);
  assert.ok(claudeMcp.mcpServers["honcho-agent-bridge"]);
});
