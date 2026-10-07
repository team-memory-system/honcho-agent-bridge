// A teammate's memory as this computer reaches it: a remote MCP server named
// team-<name> in Claude Code and Codex, at https://<host>/mcp. The 팀 주소 the admin
// copies from 관리자 lists them one per line; first setup (팀에 들어가기) and the 팀
// page both read it here. Connecting runs `teammates connect`, and each agent then
// logs in by itself, so no token passes through the app.
import { post } from "./api.js";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** The 팀 주소 text: `<name> <address>` or just `<address>` per line. The server checks each again. */
export function parseTeamAddresses(text) {
  const found = [];
  const bad = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (!words.length || words[0].startsWith("#")) continue;
    const raw = words.length > 1 ? words[1] : words[0];
    let host = "";
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      if (url.protocol === "https:" && ["/", "/mcp", "/mcp/"].includes(url.pathname) && !url.search && !url.hash && !url.port && !url.username) host = url.hostname.toLowerCase();
    } catch {}
    const label = host.split(".")[0] || "";
    const name = (words.length > 1 ? words[0] : label.replace(/^memory-(?=.)/, "")).toLowerCase().replace(/^team-/, "");
    if (!host.includes(".") || !NAME.test(name) || words.length > 2) { bad.push(line.trim()); continue; }
    if (!found.some((item) => item.name === name)) found.push({ name, host, url: `https://${host}/mcp` });
  }
  return { found, bad };
}

/** Puts a teammate's memory into Claude Code and Codex. Resolves the CLI's answer, ok or not. */
export function connectTeammate({ name, host }) {
  return post("/api/teammates/connect", { name, address: host });
}

const CLIENTS = { claude: "Claude Code", codex: "Codex" };
const CLIENT_ACTIONS = {
  added: "넣었습니다",
  replaced: "새 주소로 바꿔 넣었습니다",
  unchanged: "이미 들어 있습니다",
  removed: "뺐습니다",
  absent: "들어 있지 않았습니다",
};

/** What `teammates connect|disconnect` did in each agent, one short line each. */
export function clientOutcome(result) {
  return Object.entries(CLIENTS).map(([key, label]) => {
    const item = result?.clients?.[key];
    if (!item) return null;
    const text = item.ok ? CLIENT_ACTIONS[item.action] || "됐습니다"
      : item.missing ? "이 컴퓨터에 없어 건너뛰었습니다"
        : `하지 못했습니다: ${item.error || "알 수 없는 오류"}`;
    return `${label}: ${text}`;
  }).filter(Boolean);
}
