// What the whole app shares: this computer's setup as the server reports it, the
// person's own choices, and a live picture of the three programs.
import { get, gateway, honcho } from "./api.js";

const PREFS_KEY = "tm.prefs";

function readPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {}; } catch { return {}; }
}

export const app = {
  context: null,
  prefs: readPrefs(),
  status: {
    honcho: { state: "idle", text: "확인 중" },
    // `pending` until the first check answers, so nothing is locked on a guess.
    gateway: { state: "idle", text: "확인 중", report: null, pending: true },
    collector: { state: "idle", text: "확인 중" },
  },
  listeners: new Set(),
};

export function savePrefs(changes) {
  Object.assign(app.prefs, changes);
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(app.prefs)); } catch {}
  emit();
}

/** The workspace and the person the screens look at: saved choice, then setup. */
export function workspace() {
  return app.prefs.workspace || app.context?.workspace || "memory";
}

export function me() {
  return app.prefs.me || app.context?.user?.peerId || "";
}

export function api() {
  return honcho(workspace());
}

export function onChange(listener) {
  app.listeners.add(listener);
  return () => app.listeners.delete(listener);
}

export function emit() {
  for (const listener of app.listeners) {
    try { listener(app); } catch (error) { console.error(error); }
  }
}

export async function loadContext() {
  app.context = await get("/api/app/context");
  emit();
  return app.context;
}

/** One pass over the three programs. Cheap enough to repeat every minute. */
export async function refreshStatus() {
  const context = app.context;
  const checks = [
    honcho(workspace()).get("/queue/status").then((queue) => {
      const pending = (queue.pending_work_units || 0) + (queue.in_progress_work_units || 0);
      app.status.honcho = { state: "on", text: pending ? `정리 중 ${pending}` : "연결됨", queue };
    }).catch((error) => {
      app.status.honcho = { state: "off", text: error.unreachable ? "꺼짐" : "오류", error: error.message };
    }),
    gateway.status().then((report) => {
      const loggedIn = (report.accounts || []).filter((account) => account.login?.loggedIn).length;
      const serving = (report.servingAccounts || []).length;
      app.status.gateway = {
        state: report.ready && serving ? "on" : loggedIn ? "warn" : "warn",
        text: serving ? `계정 ${serving}개` : loggedIn ? "연결 안 됨" : "로그인 필요",
        report,
      };
    }).catch((error) => {
      app.status.gateway = { state: error.unreachable ? "idle" : "off", text: error.unreachable ? "꺼짐" : "오류", report: null, error: error.message };
    }),
  ];
  const agents = context?.agents || {};
  const collecting = ["claude", "codex"].filter((name) => agents[name]);
  app.status.collector = context?.configured
    ? { state: collecting.length ? "on" : "warn", text: collecting.length ? collecting.map((name) => (name === "claude" ? "Claude" : "Codex")).join("·") : "에이전트 없음" }
    : context?.sharedBridge?.connected
      ? { state: "on", text: "공유 창구만" }
      : { state: "warn", text: "설정 전" };
  await Promise.allSettled(checks);
  emit();
}

export function go(path) {
  location.hash = `#/${path}`;
}
