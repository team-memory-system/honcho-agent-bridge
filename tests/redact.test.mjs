// What the CLI prints is what an agent and the setup UI read. Two things have to hold
// at once: a list of setting NAMES the user must fill in is shown, and no secret VALUE
// is, whatever field it arrives in.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatJson, NAME_ONLY_FIELDS } from "../scripts/redact.mjs";
import { serverPrepare } from "../scripts/server-manager.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a portable prepare prints the names of the fields to fill, and none of the secrets already there", async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-agent-bridge-redact-"));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  const destination = path.join(root, "installed");
  await fsp.mkdir(source, { recursive: true });
  await fsp.mkdir(destination, { recursive: true });
  await fsp.writeFile(path.join(source, "compose.yaml"), "name: test\n");
  await fsp.writeFile(path.join(source, ".env.example"), "LLM_OPENAI_API_KEY=\n");
  const secrets = ["db-password-must-not-print", "sk-embedding-key-must-not-print"];
  await fsp.writeFile(path.join(destination, ".env"), [
    `POSTGRES_PASSWORD=${secrets[0]}`,
    "DERIVER_MODEL_CONFIG__TRANSPORT=openai",
    "DERIVER_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_DERIVER_API_KEY",
    "SUMMARY_MODEL_CONFIG__TRANSPORT=openai",
    "LLM_OPENAI_API_KEY=",
    "EMBEDDING_MODEL_CONFIG__TRANSPORT=openai",
    "EMBEDDING_MODEL_CONFIG__OVERRIDES__API_KEY_ENV=LLM_EMBEDDING_API_KEY",
    `LLM_EMBEDDING_API_KEY=${secrets[1]}`,
    "",
  ].join("\n"), { mode: 0o600 });

  const result = await serverPrepare({
    profile: "portable",
    preparedPlan: { ok: true, ready: true, bundle: { directory: source } },
    honchoSourceFetcher: async () => ({ ok: true, fetched: false, directory: "(stubbed)" }),
    serverDirectory: destination,
  });
  assert.equal(result.ready, false);

  const printed = formatJson(result);
  assert.deepEqual(JSON.parse(printed).missingSecretFields, ["LLM_DERIVER_API_KEY", "LLM_OPENAI_API_KEY"]);
  for (const secret of secrets) assert.equal(printed.includes(secret), false, secret);
});

test("secret values stay redacted, and the names-only allowlist lets only setting names through", () => {
  const secrets = [
    "real-api-token",
    "real-bridge-token",
    "real-cf-secret",
    "real-router-key",
    "Bearer real-header",
    "sk-real-secret-value",
    "real-value-in-object",
    "user:pw",
    "token=x",
  ];
  const text = formatJson({
    honcho: {
      apiToken: "real-api-token",
      mcpBridgeToken: "real-bridge-token",
      accessClientSecret: "real-cf-secret",
      baseUrl: "http://user:pw@127.0.0.1:8001/?token=x",
    },
    LLM_VLLM_API_KEY: "real-router-key",
    authorization: "Bearer real-header",
    missingSecretFields: ["LLM_OPENAI_API_KEY", "LLM_VLLM_API_KEY"],
    wrongShape: {
      missingSecretFields: ["sk-real-secret-value"],
      nested: { missingSecretFields: [{ LLM_OPENAI_API_KEY: "real-value-in-object" }] },
    },
    hasBridgeCredential: true,
  });
  const printed = JSON.parse(text);
  assert.equal(printed.honcho.apiToken, "[redacted]");
  assert.equal(printed.honcho.mcpBridgeToken, "[redacted]");
  assert.equal(printed.honcho.accessClientSecret, "[redacted]");
  assert.equal(printed.honcho.baseUrl, "http://127.0.0.1:8001");
  assert.equal(printed.LLM_VLLM_API_KEY, "[redacted]");
  assert.equal(printed.authorization, "[redacted]");
  assert.deepEqual(printed.missingSecretFields, ["LLM_OPENAI_API_KEY", "LLM_VLLM_API_KEY"]);
  assert.equal(printed.wrongShape.missingSecretFields, "[redacted]", "a value is not a setting name");
  assert.equal(printed.wrongShape.nested.missingSecretFields, "[redacted]");
  assert.equal(printed.hasBridgeCredential, true);
  for (const secret of secrets) assert.equal(text.includes(secret), false, secret);
  assert.deepEqual([...NAME_ONLY_FIELDS], ["missingSecretFields"], "the allowlist grows only on purpose");
});

test("the CLI prints every result through that same formatter", async () => {
  const cli = await fsp.readFile(path.join(ROOT, "scripts", "cli.mjs"), "utf8");
  assert.match(cli, /function printJson\(value\) \{\n {2}process\.stdout\.write\(formatJson\(value\)\);\n\}/);
  assert.equal(/function redactSecrets/.test(cli), false, "there is one redaction, not two");
});
