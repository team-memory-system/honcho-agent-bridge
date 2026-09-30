// What `cli.mjs` prints, and what it keeps out of it.
//
// Every CLI result is printed as JSON, and the setup UI shows that JSON as it is.
// A field whose name looks like it holds a secret is printed as "[redacted]"
// whatever it contains, so a secret that reaches a result by mistake still does
// not reach a terminal or a page.

// Fields that only ever hold the NAMES of settings, never their values. Their names
// contain "secret", so without this list the one thing the user needed to see - which
// settings to fill in - printed as "[redacted]". They pass only while they look like
// a list of setting names; anything else under the same key is redacted as before.
export const NAME_ONLY_FIELDS = new Set(["missingSecretFields"]);
const SETTING_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;
const SECRET_FIELD = /(token|secret|api[_-]?key|authorization)/i;

function isSettingNameList(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && SETTING_NAME.test(item));
}

export function publicUrl(value) {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "[invalid URL]";
  }
}

// Only characters a URL can hold, and no parentheses, so a URL inside a sentence
// ends where the sentence goes on - including a Korean particle with no space
// before it, as in the gateway's own messages.
const URL_IN_TEXT = /https?:\/\/[A-Za-z0-9\-._~:\/?#[\]@!$&*+,;=%]+/gi;

export function sanitizeUrlsInText(value) {
  return String(value).replace(URL_IN_TEXT, (match) => {
    // Sentence punctuation after a URL stays with the sentence.
    const [, url, trailing] = match.match(/^(.*?)([.,;:!?]*)$/);
    return `${publicUrl(url)}${trailing}`;
  });
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (NAME_ONLY_FIELDS.has(key) && isSettingNameList(item)) return [key, [...item]];
      // A number or a flag is a count or a setting, never a credential: server verify's
      // minimumPromptTokens printed as "[redacted]" in the 2026-09-30 install test.
      if (SECRET_FIELD.test(key) && item && typeof item !== "number" && typeof item !== "boolean") return [key, "[redacted]"];
      if (typeof item === "string" && /(url|uri|address)$/i.test(key)) return [key, publicUrl(item)];
      if (typeof item === "string" && /(error|message|stack)/i.test(key)) return [key, sanitizeUrlsInText(item)];
      return [key, redactSecrets(item)];
    }),
  );
}

/**
 * The one exception, for `server share token` alone: its whole purpose is to show
 * the gate token so the owner can copy it to another computer. Nothing but `ok`
 * and that token is printed, so nothing else can ride along unredacted.
 */
export function formatRevealedToken({ ok, token }) {
  return `${JSON.stringify({ ok: Boolean(ok), token: typeof token === "string" ? token : "" }, null, 2)}\n`;
}

/** Exactly what the CLI writes to stdout for a result. */
export function formatJson(value) {
  return `${JSON.stringify(redactSecrets(value), null, 2)}\n`;
}
