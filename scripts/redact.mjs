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

export function sanitizeUrlsInText(value) {
  return String(value).replace(/https?:\/\/[^\s"'<>]+/gi, (match) => publicUrl(match));
}

export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (NAME_ONLY_FIELDS.has(key) && isSettingNameList(item)) return [key, [...item]];
      if (SECRET_FIELD.test(key) && item) return [key, "[redacted]"];
      if (typeof item === "string" && /(url|uri|address)$/i.test(key)) return [key, publicUrl(item)];
      if (typeof item === "string" && /(error|message|stack)/i.test(key)) return [key, sanitizeUrlsInText(item)];
      return [key, redactSecrets(item)];
    }),
  );
}

/** Exactly what the CLI writes to stdout for a result. */
export function formatJson(value) {
  return `${JSON.stringify(redactSecrets(value), null, 2)}\n`;
}
