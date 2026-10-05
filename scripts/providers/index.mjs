import * as codex from "./codex.mjs";
import * as claude from "./claude.mjs";
import * as agy from "./agy.mjs";
import * as chatgpt from "./chatgpt.mjs";
import * as grok from "./grok.mjs";

const providers = { codex, claude, agy, chatgpt, grok };

export function getProvider(name) {
  const provider = providers[name];
  if (!provider) throw new Error(`unsupported provider: ${name}`);
  return provider;
}
