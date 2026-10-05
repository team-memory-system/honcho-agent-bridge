import path from "node:path";

const NOISE_TAGS = [
  "permissions instructions", "app-context", "environment_context",
  "local-command-caveat", "command-message", "command-name",
  "local-command-stdout", "local-command-stderr", "bash-input",
  "bash-stdout", "bash-stderr", "task-notification",
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

// Match the complete app-injected policy envelope, not a heading in a real request.
// In particular, old Codex versions omitted the "for <path>" suffix.
export function isInjectedPolicyText(text) {
  const opening = text.match(/^# (?:AGENTS|CLAUDE)\.md instructions(?: for [^\n]+)?\n+<INSTRUCTIONS>/);
  if (!opening) return false;
  const closing = text.indexOf("</INSTRUCTIONS>", opening[0].length);
  if (closing < 0) return false;
  const suffix = text.slice(closing + "</INSTRUCTIONS>".length).trim();
  if (!suffix) return true;
  if (!suffix.startsWith("<environment_context>")) return false;
  const environmentEnd = suffix.indexOf("</environment_context>");
  return environmentEnd >= 0 && !suffix.slice(environmentEnd + "</environment_context>".length).trim();
}

// Recognize complete envelopes only. If another sentence follows, retain the
// whole message rather than silently dropping a possibly genuine user request.
export function isInjectedContextText(text, tags) {
  let rest = text;
  while (rest) {
    if (isInjectedPolicyText(rest)) return true;
    // Empty slash-command arguments are UI metadata. Nonempty arguments can be
    // the only copy of a user's /goal (or other request), so never discard them.
    const emptyArgs = rest.match(/^<command-args>\s*<\/command-args>\s*/);
    if (emptyArgs) {
      rest = rest.slice(emptyArgs[0].length);
      continue;
    }
    const tag = tags.find((name) => rest.startsWith(`<${name}>`) || rest.startsWith(`<${name} `));
    if (!tag) return false;
    const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const block = rest.match(new RegExp(`^<${escaped}(?:\\s[^<>]*)?>[\\s\\S]*?<\\/${escaped}>\\s*`));
    if (!block) return false;
    rest = rest.slice(block[0].length);
  }
  return true;
}

// Claude Code marks the user-role rows it writes itself with isMeta: skill and
// command bodies, image markers ("[Image: source: …]"), hook feedback, caveats,
// messages from other sessions, resume notes. Of these, only a slash command's
// arguments or a goal are the person's own words.
function metaCarriesPersonText(text) {
  if (/<command-args>\s*\S[\s\S]*?<\/command-args>/.test(text)) return true;
  if (/^\/[^\s/]+\s+\S/.test(text)) return true;
  return /^<system-reminder>\s*Current goal:/.test(text);
}

export function normalizeText(text, role = "user", isMeta = false) {
  const normalized = normalizeRawText(text);
  if (!normalized) return "";
  if (role !== "user") return normalized;
  if (isMeta && !metaCarriesPersonText(normalized)) return "";
  if (isInjectedContextText(normalized, NOISE_TAGS)) return "";
  if (/^\[Request interrupted by user(?: for tool use)?\]$/.test(normalized)) return "";
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
