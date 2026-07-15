import path from "node:path";

const REQUEST_MARKERS = ["## My request for Codex:", "My request for Codex:"];
const NOISE_PREFIXES = [
  "# AGENTS.md instructions for ",
  "# CLAUDE.md instructions for ",
  "<permissions instructions>",
  "<app-context>",
  "<environment_context>",
  "<local-command-caveat>",
  "<command-message>",
  "<command-name>",
  "<local-command-stdout>",
  "<local-command-stderr>",
  "<bash-input>",
  "<bash-stdout>",
  "<bash-stderr>",
  "<task-notification>",
  "Base directory for this skill:",
];
const NOISE_SUBSTRINGS = [
  "This file defines global defaults for coding agents on this machine.",
  "## Node.js Package Manager",
  "## Python Package Manager",
  "Global Agent Policy",
];

export function normalizeCreatedAt(value) {
  if (typeof value === "number") {
    const seconds = value > 1_000_000_000_000 ? value / 1000 : value;
    const date = new Date(seconds * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return normalizeCreatedAt(numeric);
  return trimmed;
}

export function normalizeRawText(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

export function normalizeText(text) {
  let normalized = normalizeRawText(text);
  if (!normalized) return "";
  for (const marker of REQUEST_MARKERS) {
    if (normalized.includes(marker)) {
      normalized = normalized.split(marker, 2)[1].trim();
      break;
    }
  }
  if (NOISE_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "";
  if (NOISE_SUBSTRINGS.some((token) => normalized.includes(token))) return "";
  return normalized;
}

export function sanitizeId(value, prefix = "") {
  const base = prefix ? `${prefix}-${value}` : String(value);
  const stem = path.parse(base).name;
  const cleaned = stem.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "session").slice(0, 100);
}

export function extractTextBlocks(items, normalize = normalizeText) {
  const texts = [];
  for (const item of items || []) {
    if (!item || typeof item !== "object") continue;
    if (!["input_text", "output_text", "text"].includes(item.type)) continue;
    if (typeof item.text === "string" && item.text.trim()) texts.push(item.text.trim());
  }
  return normalize(texts.join("\n\n"));
}

export function extractTag(text, tagName) {
  const match = text.match(new RegExp(`<${tagName}>\\s*([\\s\\S]*?)\\s*</${tagName}>`, "i"));
  return match ? match[1].trim() : "";
}
