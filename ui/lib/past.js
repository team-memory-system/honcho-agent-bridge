// 지난 대화: the conversations from before this app, put into the memory server in
// the order they were started. First setup and 기억 설정 → 대화 수집 → 수정 open the
// same step between 에이전트 and 프로젝트 (pastStep): this computer always, a backup
// store (a folder or an rclone remote, read in full before 다음) and ChatGPT export
// files, one per account. The reading runs in the app's background (`past scan`,
// scripts/past.mjs); the projects step then shows what would go in (pastSummary,
// from `past overview`), and 적용 lines them up and starts them (`past plan`,
// `past start`).
import { get, post } from "./api.js";
import { h, clear } from "./dom.js";
import { pickFolder } from "./folders.js";
import { number, sourceLabel } from "./format.js";
import { opt, opts } from "./kit.js";
import { button, notice, segmented, spinner, tag } from "./ui.js";

const STORE_SUB = "내 컴퓨터들의 대화를 백업해 둔 폴더나 클라우드(rclone remote)";
const CHATGPT_SUB = "ChatGPT의 설정 → 데이터 제어 → 데이터 내보내기로 받은 zip 파일";
export const READ_HINT = "다 읽으면 다음을 누를 수 있습니다.";
/** Under each agent's plugin row while past conversations go in first. */
export const HELD = "새 대화는 지난 대화 다음에 쌓입니다.";
// The folder a backup keeps the conversations in (scripts/backup.mjs).
const ROOT = "대화";
const POLL_MS = 1000;

// ── Dates, periods and how long, the way the screens say them ──

const yearOf = (ms) => new Date(ms).getFullYear();

/** "2025년 9월 3일", or "9월 3일" without the year. */
export function dayText(ms, { year = true } = {}) {
  const date = new Date(ms);
  return `${year ? `${date.getFullYear()}년 ` : ""}${date.getMonth() + 1}월 ${date.getDate()}일`;
}

/** A day this year without its year, any other with it. */
export function shortDay(ms) {
  return dayText(ms, { year: yearOf(ms) !== new Date().getFullYear() });
}

/** "10월 10일 14:20". */
function momentText(ms) {
  const date = new Date(ms);
  return `${shortDay(ms)} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** "2024년 3월". */
export function monthText(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}년 ${date.getMonth() + 1}월`;
}

/** "2022년 12월 5일 ~ 2026년 10월 10일"; the second year goes when it is the same. */
export function periodText(first, last) {
  if (first === null || first === undefined) return "";
  if (last === null || last === undefined || dayText(first) === dayText(last)) return dayText(first);
  return `${dayText(first)} ~ ${dayText(last, { year: yearOf(first) !== yearOf(last) })}`;
}

/** "약 40분", "1분쯤". */
export function etaText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 90) return "1분쯤";
  if (seconds < 3600) return `약 ${Math.round(seconds / 60)}분`;
  if (seconds < 86_400) return `약 ${Math.round(seconds / 3600)}시간`;
  return `약 ${Math.round(seconds / 86_400)}일`;
}

/** "48MB", or "12KB" for a file under a megabyte. */
function fileSize(bytes) {
  const size = Number(bytes || 0);
  return size < 1024 * 1024 ? `${number(Math.max(1, Math.round(size / 1024)))}KB` : `${number(Math.round(size / 1024 / 1024))}MB`;
}

// ── The draft ────────────────────────────────────────────

/** Where the step starts: this computer only. */
export function pastDraft() {
  return {
    storeOn: false,
    store: { kind: "folder", path: "", remote: "", cloudPath: "" },
    // The store's fields came from the backup's place, the last run's, or the person.
    filled: false,
    chatgptOn: true,
    late: "include",
    // The last answers: how far the reading got, what earlier runs took (수정), where this computer backs up.
    scan: null,
    applied: undefined,
    backupStatus: undefined,
    remotes: undefined,
    asked: null,
    changing: false,
    uploading: null,
    uploadError: null,
    // The projects step's numbers (`past overview`), kept for 적용.
    overview: null,
    totals: null,
  };
}

/** A folder named for the store, less the 대화 folder itself when that was picked. */
function storeFolder(value) {
  const trimmed = String(value || "").trim().replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts.length > 1 && parts.at(-1) === ROOT ? trimmed.slice(0, -ROOT.length).replace(/[\\/]+$/, "") : trimmed;
}

const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/;

/** The store as `past scan` and `past plan` take it; null for none, or one not filled in yet. */
export function storeOf(past) {
  if (!past?.storeOn) return null;
  const { kind, path, remote, cloudPath } = past.store;
  if (kind === "folder") {
    const folder = storeFolder(path);
    return ABSOLUTE.test(folder) ? { kind: "folder", path: folder } : null;
  }
  return remote ? { kind: "cloud", remote, path: storeFolder(cloudPath).replace(/^\/+/, "") } : null;
}

function sameSpec(left, right) {
  if (!left || !right) return !left && !right;
  return left.kind === right.kind && (left.path || "") === (right.path || "") && (left.kind !== "cloud" || left.remote === right.remote);
}

/** A store as the screens name it: its 대화 folder. */
export function storeName(spec) {
  if (!spec) return "";
  if (spec.kind === "folder") return `${spec.path.replace(/[\\/]+$/, "")}${spec.path.includes("\\") && !spec.path.includes("/") ? "\\" : "/"}${ROOT}`;
  return `${spec.remote}:${spec.path ? `${spec.path}/` : ""}${ROOT}`;
}

/** The ChatGPT files this setup takes: every one put in before, and the new ones while the box is ticked. */
export function chosenFiles(past) {
  return (past?.scan?.chatgpt || []).filter((file) => file.applied || past.chatgptOn);
}

/** The places as `past overview` and `past plan` take them. */
export function sourcesBody(past) {
  return { store: storeOf(past), chatgpt: chosenFiles(past).map((file) => file.id) };
}

// ── Reading, in the background ───────────────────────────

/**
 * The reading of the places a draft names: asked for again when the store changes,
 * and asked how far it got every second while it runs. One per draft, so the past
 * step and the projects step see the same.
 */
function reader(past) {
  if (past.reader) return past.reader;
  const listeners = new Set();
  let timer = null;
  let pause = null;
  const tell = () => { for (const listener of [...listeners]) listener(); };
  const poll = async () => {
    clearTimeout(timer);
    timer = null;
    try {
      past.scan = await get("/api/past/scan/status");
    } catch (error) {
      past.scan = { ok: false, running: false, error: error.message };
    }
    tell();
    if (past.scan?.running && listeners.size) timer = setTimeout(poll, POLL_MS);
  };
  const self = {
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Reads this computer and the store as the draft names it now; `later` waits for typing to stop. */
    ask({ later = false } = {}) {
      clearTimeout(pause);
      const go = async () => {
        past.asked = JSON.stringify(storeOf(past));
        past.readOnce = true;
        past.asking = true;
        tell();
        try {
          past.scan = await post("/api/past/scan", { store: storeOf(past) });
        } catch (error) {
          past.scan = { ok: false, running: false, error: error.message };
        }
        past.asking = false;
        tell();
        clearTimeout(timer);
        timer = setTimeout(poll, POLL_MS);
      };
      if (!later) {
        go();
        return;
      }
      // Until the typing stops, 다음 already waits for the place being typed.
      pause = setTimeout(go, 700);
      tell();
    },
    /** Asked how far it got, once, and again while it runs. */
    refresh: poll,
    /** Asked for once in this window; until then nothing was read for it. */
    asked: () => past.asked !== null,
  };
  past.reader = self;
  return self;
}

/** The store's part of the reading, when it is the store the draft names. */
function storeScan(past) {
  const part = past.scan?.store;
  return part && sameSpec(part.spec, storeOf(past)) ? part : null;
}

/**
 * Where the reading stands for the draft: "read" when every place chosen is, "reading"
 * while it runs (or before it was asked for), "wrong" when a place could not be
 * read, with the words to show.
 */
export function readState(past) {
  const scan = past.scan;
  if (past.uploading) return { state: "reading" };
  if (past.asking || !scan || past.asked !== JSON.stringify(storeOf(past))) return { state: "reading" };
  if (scan.ok === false) return { state: "wrong", text: scan.error || "읽지 못했습니다." };
  if (past.storeOn && !storeOf(past)) {
    return { state: "wrong", text: past.store.kind === "folder" ? "백업 저장소의 폴더를 고르세요." : "백업 저장소의 rclone remote를 고르세요." };
  }
  if (scan.here?.state === "error") return { state: "wrong", text: "이 컴퓨터의 대화를 읽지 못했습니다. 다시 시도를 누르세요." };
  const store = storeOf(past) ? storeScan(past) : null;
  if (store?.state === "error") return { state: "wrong", text: scanError(store, storeOf(past)) };
  if (scan.running) return { state: "reading" };
  if (scan.here?.state !== "done") return { state: "wrong", text: "이 컴퓨터의 대화를 다 읽지 못했습니다. 다시 시도를 누르세요." };
  if (storeOf(past) && store?.state !== "done") return { state: "wrong", text: "백업 저장소를 다 읽지 못했습니다. 다시 시도를 누르세요." };
  return { state: "read" };
}

function scanError(part, spec) {
  if (part.code === "rclone-missing") return "이 컴퓨터에 rclone이 없습니다. rclone을 설치하고 터미널에서 rclone config로 클라우드를 연결한 뒤 다시 시도를 누르세요.";
  if (part.code === "rclone-failed") return "클라우드에 닿지 않습니다. 인터넷 연결과 rclone 로그인을 확인한 뒤 다시 시도를 누르세요.";
  if (part.code === "no-store") {
    return spec?.kind === "cloud"
      ? `${storeName(spec)}에 대화가 없습니다. 내 컴퓨터들이 백업하는 remote와 폴더가 맞는지 확인하세요.`
      : `${storeName(spec)} 폴더가 없습니다. 내 컴퓨터들이 백업하는 폴더(그 안에 ${ROOT} 폴더가 있는 곳)를 고르세요.`;
  }
  return "백업 저장소를 읽지 못했습니다. 다시 시도를 누르세요.";
}

/** How many conversations a place holds of the chosen agents, by its summary's counts. */
function chosenCount(part, agents) {
  if (!part?.agents) return Number(part?.count || 0);
  return Object.entries(part.agents).filter(([name]) => !agents || agents.has(name)).reduce((sum, [, count]) => sum + Number(count || 0), 0);
}

// ── The step ─────────────────────────────────────────────

/**
 * 지난 대화: where the past conversations come from. `newServer` is a server made by
 * this setup, which holds nothing yet; `edit` is 기억 설정's 수정, which shows what
 * earlier runs took. Returns { body, check, watch }: `watch(update)` hears whether
 * 다음 waits for the reading, as { blocked, hint }.
 */
export function pastStep(draft, context, { edit = false, newServer = false } = {}) {
  const past = draft.past;
  const scan = reader(past);
  const watchers = new Set();
  const body = h("div", {});
  const hereRow = opt({ type: "checkbox", name: "past-here", value: "here", checked: true, title: "이 컴퓨터", sub: h("span", {}, "") });
  // Always taken; the box shows it without being one to clear.
  hereRow.input.disabled = true;
  hereRow.classList.add("locked");
  const hereSub = hereRow.querySelector(".os");

  // ── 백업 저장소 ──
  const fields = h("div", { class: "store-where" });
  const readline = h("div", { class: "readline" });
  const storeExtra = h("div", { class: "subfields", hidden: true }, fields, h("div", { class: "hint" }, `내 컴퓨터들이 백업하는 폴더를 고르세요. 그 안의 ${ROOT} 폴더를 읽습니다.`), readline);
  const changeButton = button("바꾸기", { kind: "quiet small", onClick: () => { past.changing = true; drawStore(); } });
  const storeRow = opt({
    type: "checkbox",
    name: "past-store",
    value: "store",
    checked: past.storeOn,
    title: "백업 저장소",
    sub: h("span", {}, STORE_SUB),
    end: h("span", {}),
    extra: storeExtra,
    onChange: (on) => {
      past.storeOn = on;
      if (on) fillStore();
      drawStore();
      scan.ask();
    },
  });
  const storeSub = storeRow.querySelector(".os");
  const storeEnd = storeRow.querySelector(".oe");

  // ── ChatGPT ──
  const file = h("input", { type: "file", hidden: true, accept: ".zip,.json,application/zip,application/json" });
  const chatgptBox = h("div", {});
  file.addEventListener("change", () => {
    const chosen = file.files?.[0];
    file.value = "";
    if (chosen) upload(chosen);
  });

  /** The store's fields from what this computer already backs up to, or what the last run read. */
  function fillStore() {
    if (past.filled) return;
    const from = past.applied?.chosen?.store || past.backupStatus?.destination || null;
    if (!from) return;
    past.store = from.kind === "cloud"
      ? { kind: "cloud", path: "", remote: from.remote || "", cloudPath: from.path || "" }
      : { kind: "folder", path: from.path || "", remote: "", cloudPath: "" };
    past.filled = true;
  }

  function drawHere() {
    const part = past.scan?.here;
    const agents = draft.agents || null;
    const names = Object.keys(part?.agents || {}).filter((name) => !agents || agents.has(name)).map(sourceLabel);
    if (edit && past.applied?.last) {
      hereSub.textContent = `${(names.length ? names : [...(agents || [])].map(sourceLabel)).join(" · ")} · ${shortDay(Date.parse(past.applied.last.finishedAt || past.applied.last.startedAt))}에 가져옴`;
      return;
    }
    if (!part || part.state === "running") {
      clear(hereSub, part?.total ? `읽는 중 · ${number(part.done || 0)} / ${number(part.total)}개` : "읽는 중");
      return;
    }
    if (part.state === "error") { hereSub.textContent = "읽지 못했습니다"; return; }
    const count = chosenCount(part, agents);
    hereSub.textContent = count
      ? `${names.join(" · ")} · 대화 ${number(count)}개${part.first ? ` · ${dayText(part.first)}부터` : ""}`
      : "아직 대화가 없습니다";
  }

  /** The row a store's place is picked in: a folder, or an rclone remote and a folder in it. */
  function drawFields() {
    const store = past.store;
    const kinds = segmented([["folder", "폴더"], ["cloud", "클라우드"]], store.kind, (kind) => {
      store.kind = kind;
      past.filled = true;
      drawFields();
      scan.ask();
    });
    if (store.kind === "folder") {
      const input = h("input", { class: "input mono", value: store.path, placeholder: "/Volumes/백업드라이브", spellcheck: "false", "aria-label": "백업 저장소 폴더" });
      input.addEventListener("input", () => { store.path = input.value; past.filled = true; scan.ask({ later: true }); });
      clear(fields, kinds, input, button("폴더 고르기", { kind: "small", iconName: "folder", onClick: async () => {
        const folder = await pickFolder({ title: "백업 저장소 고르기", start: storeFolder(store.path) });
        if (!folder) return;
        store.path = folder;
        input.value = folder;
        past.filled = true;
        scan.ask();
      } }));
      return;
    }
    if (past.remotes === undefined) {
      clear(fields, kinds, spinner());
      get("/api/backup/remotes").then((remotes) => { past.remotes = remotes; }).catch(() => { past.remotes = { installed: false, remotes: [] }; })
        .then(() => { if (fields.isConnected && store.kind === "cloud") { drawFields(); if (store.remote) scan.ask(); } });
      return;
    }
    if (!past.remotes.installed || !past.remotes.remotes?.length) {
      clear(fields, kinds, h("span", { class: "muted" }, past.remotes.installed ? "rclone에 연결된 클라우드가 없습니다. 터미널에서 rclone config로 remote를 만든 뒤 이 창을 다시 여세요." : "이 컴퓨터에 rclone이 없습니다. rclone을 설치하고 rclone config로 클라우드를 연결한 뒤 이 창을 다시 여세요."));
      return;
    }
    // One remote is the store; of several, none is read until the person picks it (a
    // remote can be a whole cloud drive, and reading it means copying it down).
    const remotes = past.remotes.remotes;
    if (!remotes.includes(store.remote)) store.remote = remotes.length === 1 ? remotes[0] : "";
    const select = h("select", { class: "select input mono", "aria-label": "rclone remote" },
      store.remote ? null : h("option", { value: "", selected: true, disabled: true }, "remote 고르기"),
      remotes.map((name) => h("option", { value: name, selected: name === store.remote ? true : null }, `${name}:`)));
    select.addEventListener("change", () => { store.remote = select.value; past.filled = true; drawFields(); scan.ask(); });
    const folder = h("input", { class: "input mono", value: store.cloudPath, placeholder: "비우면 맨 위", spellcheck: "false", "aria-label": "그 안의 폴더" });
    folder.addEventListener("input", () => { store.cloudPath = folder.value; past.filled = true; scan.ask({ later: true }); });
    clear(fields, kinds, select, folder);
  }

  function drawReadline() {
    const spec = storeOf(past);
    const part = storeScan(past);
    if (!past.storeOn || !spec) { clear(readline); return; }
    if (part?.state === "error") {
      clear(readline, notice("bad", scanError(part, spec), " ", button("다시 시도", { kind: "small", onClick: () => scan.ask() })));
      return;
    }
    if (part?.state === "done") {
      const devices = (part.devices || []).map((device) => (device === past.scan?.device ? "이 컴퓨터" : device));
      if (devices.includes("이 컴퓨터")) devices.sort((a) => (a === "이 컴퓨터" ? -1 : 0));
      const count = chosenCount(part, draft.agents);
      clear(readline, h("span", { class: "ic ok" }, "✓"),
        h("span", {}, [`대화 ${number(count)}개`, part.first ? `${dayText(part.first)}부터` : null, devices.length ? devices.join(", ") : null].filter(Boolean).join(" · ")));
      return;
    }
    if (!past.scan?.running && part?.state === "waiting") {
      clear(readline, notice("bad", "백업 저장소를 읽다가 멈췄습니다. ", button("다시 시도", { kind: "small", onClick: () => scan.ask() })));
      return;
    }
    // Reading: rclone first copies a cloud down (phase copy), then every file is read.
    const total = Number(part?.total || 0);
    const done = Number(part?.done || 0);
    const percent = total ? Math.min(100, Math.floor((done / total) * 100)) : 0;
    const label = !part || part.phase === "list" ? "목록을 받는 중" : part.phase === "copy" ? "받는 중" : "읽는 중";
    clear(readline, spinner(),
      h("span", {}, total ? `${label} · ${number(done)} / ${number(total)}개` : label),
      h("span", { class: "minibar" }, h("span", { style: { width: `${percent}%` } })),
      part?.etaSec ? h("span", { class: "muted" }, etaText(part.etaSec)) : null);
  }

  function drawStore() {
    storeRow.input.checked = past.storeOn;
    const applied = edit ? past.applied?.chosen?.store || null : null;
    // 수정, with the store an earlier run read: shown by name until 바꾸기.
    const kept = applied && past.storeOn && !past.changing && sameSpec(applied, storeOf(past));
    if (kept) {
      clear(storeSub, applied.kind === "cloud" ? "클라우드 " : "폴더 ", h("span", { class: "mono" }, storeName(applied)),
        past.applied?.last ? ` · ${shortDay(Date.parse(past.applied.last.finishedAt || past.applied.last.startedAt))}에 가져옴` : "");
      clear(storeEnd, changeButton);
    } else {
      clear(storeSub, STORE_SUB);
      clear(storeEnd);
    }
    storeExtra.hidden = !past.storeOn;
    fields.hidden = Boolean(kept);
    storeExtra.querySelector(".hint").hidden = Boolean(kept);
    if (past.storeOn && !kept) drawFields();
    drawReadline();
  }

  async function upload(chosen) {
    past.uploading = { name: chosen.name, size: chosen.size };
    past.uploadError = null;
    drawChatgpt();
    tell();
    let payload;
    try {
      // The app's requests are all JSON by their header; the export goes as it is.
      const response = await fetch(`/api/past/chatgpt?${new URLSearchParams({ name: chosen.name })}`, { method: "POST", headers: { "content-type": "application/json" }, body: chosen });
      payload = await response.json().catch(() => ({ ok: false, error: "" }));
    } catch {
      payload = { ok: false, error: "" };
    }
    past.uploading = null;
    if (!payload.ok) past.uploadError = { name: chosen.name, text: chatgptError(payload.error) };
    else past.chatgptOn = true;
    await scan.refresh();
    drawChatgpt();
  }

  async function drop(id) {
    const result = await post("/api/past/chatgpt/drop", { id }).catch((error) => ({ ok: false, error: error.message }));
    if (result.ok === false) past.uploadError = { name: "", text: "이 파일을 빼지 못했습니다. 다시 누르세요." };
    await scan.refresh();
    drawChatgpt();
  }

  function drawChatgpt() {
    const files = past.scan?.chatgpt || [];
    const applied = files.some((one) => one.applied);
    const on = applied || (past.chatgptOn && files.length > 0) || Boolean(past.uploading);
    const pick = () => file.click();
    const lines = files.filter((one) => one.applied || past.chatgptOn).map((one) => h("div", { class: "fileline" },
      h("span", { class: "mono" }, one.name),
      h("span", { class: "muted" }, [fileSize(one.size), `대화 ${number(one.conversations)}개`, one.account].filter(Boolean).join(" · ")),
      one.applied ? tag("가져옴") : edit ? tag("새로 고름", "new") : null,
      h("span", { class: "sp" }),
      one.applied ? null : button("빼기", { kind: "quiet small", onClick: (event) => { event.currentTarget.disabled = true; drop(one.id); } })));
    if (past.uploading) {
      lines.push(h("div", { class: "fileline" }, spinner(), h("span", { class: "mono" }, past.uploading.name), h("span", { class: "muted" }, `${fileSize(past.uploading.size)} · 올리고 읽는 중`)));
    }
    const row = opt({
      type: "checkbox",
      name: "past-chatgpt",
      value: "chatgpt",
      checked: on,
      title: "ChatGPT 내보내기 파일",
      sub: lines.length ? null : CHATGPT_SUB,
      end: lines.length ? null : button("파일 고르기", { kind: "small", onClick: pick }),
      extra: lines.length || past.uploadError
        ? [h("div", { class: "files" }, lines),
          past.uploadError ? notice("bad", past.uploadError.name ? [h("span", { class: "mono" }, past.uploadError.name), " · "] : null, past.uploadError.text) : null,
          past.uploading ? null : h("div", { class: "files-more" }, button(lines.length ? "파일 더하기" : "파일 고르기", { kind: "small", onClick: pick }))]
        : null,
      onChange: (checked) => {
        if (checked && !files.length) {
          row.input.checked = false;
          pick();
          return;
        }
        past.chatgptOn = checked;
        drawChatgpt();
        tell();
      },
    });
    // A file put in before stays a place the conversations came from.
    if (applied) row.input.disabled = true;
    clear(chatgptBox, row);
  }

  // 다음 waits only while the reading runs; a place that could not be read says why when it is pressed.
  function tell() {
    const reading = readState(past).state === "reading";
    for (const watcher of watchers) watcher({ blocked: reading, hint: reading ? READ_HINT : "" });
  }

  // A window may build every step at once, so a step not shown yet only waits; one shown and then left stops listening.
  let shown = false;
  function drawAll() {
    if (!body.isConnected) {
      if (shown) stop();
      return;
    }
    shown = true;
    drawHere();
    drawReadline();
    if (!past.uploading) drawChatgpt();
    tell();
  }
  const stop = scan.listen(() => drawAll());

  // What the step needs first: the backup's place to fill the store from, and in 수정 what earlier runs took.
  const loads = [];
  if (past.backupStatus === undefined) loads.push(get("/api/backup/status").then((status) => { past.backupStatus = status?.ok === false ? null : status; }).catch(() => { past.backupStatus = null; }));
  if (edit && past.applied === undefined) {
    loads.push(get("/api/past/status").then((status) => {
      past.applied = status?.ok === false ? null : status;
      // The store the last run read is chosen again, until the person clears it.
      if (past.applied?.chosen?.store && !past.filled) {
        past.storeOn = true;
        fillStore();
      }
    }).catch(() => { past.applied = null; }));
  }
  Promise.all(loads).then(() => {
    if (past.storeOn) fillStore();
    drawStore();
    drawHere();
    // Read again each time the step opens: the store may hold conversations other computers backed up since.
    if (!scan.asked() || past.asked !== JSON.stringify(storeOf(past)) || !past.readOnce) {
      scan.ask();
    } else {
      scan.refresh();
    }
  });

  drawStore();
  drawHere();
  drawChatgpt();
  clear(body,
    h("h3", {}, "지난 대화를 어디서 가져올까요?"),
    h("p", { class: "lead" }, !edit && !newServer ? "가져올 곳을 모두 고르세요. 내 서버에 이미 있는 대화는 빼고 넣습니다." : "가져올 곳을 모두 고르세요. 같은 대화가 두 곳에 있어도 한 번만 들어갑니다."),
    opts(hereRow, storeRow, chatgptBox),
    file);
  return {
    body,
    watch(update) {
      watchers.add(update);
      tell();
    },
    check() {
      const now = readState(past);
      if (now.state === "reading") return READ_HINT;
      if (now.state === "wrong") return now.text;
      return null;
    },
  };
}

function chatgptError(error) {
  const text = String(error || "");
  if (/no ChatGPT conversations/i.test(text)) return "이 파일에서 ChatGPT 대화를 찾지 못했습니다. ChatGPT의 데이터 내보내기로 받은 zip 파일을 그대로 고르세요.";
  if (/larger than this UI accepts/i.test(text)) return "파일이 너무 큽니다. ChatGPT의 데이터 내보내기로 받은 zip 파일이 맞는지 확인하세요.";
  if (/empty/i.test(text)) return "빈 파일입니다. 다른 파일을 고르세요.";
  return "이 파일을 읽지 못했습니다. ChatGPT의 데이터 내보내기로 받은 zip 파일을 그대로 고르세요.";
}

// ── 프로젝트: what would go in ───────────────────────────

/**
 * The overview the projects step draws from: the folders the chosen places'
 * conversations ran in, and what of them the server holds. Waits for the reading
 * first, asking for it when this window has not (수정 opened at 프로젝트).
 */
export async function loadOverview(draft, server) {
  const past = draft.past;
  const scan = reader(past);
  if (!scan.asked()) scan.ask();
  await new Promise((resolve) => {
    const check = () => {
      if (readState(past).state === "reading") return false;
      unlisten();
      resolve();
      return true;
    };
    const unlisten = scan.listen(check);
    if (!check()) scan.refresh();
  });
  const state = readState(past);
  if (state.state === "wrong") return { ok: false, error: state.text, notRead: true };
  const body = { ...server, agents: [...(draft.agents || [])].join(","), ...sourcesBody(past) };
  const overview = await post("/api/past/overview", body).catch((error) => ({ ok: false, error: error.message }));
  past.overview = overview?.ok === false ? null : overview;
  return overview;
}

/** What the folders, 자동 실행 대화 and ChatGPT files chosen add up to. */
export function overviewTotals(overview, { checked, automation, rest }) {
  const totals = { count: 0, dupes: 0, onServer: 0, put: 0, late: 0, first: null, last: null, folders: 0, foldersOnServer: 0, chatgpt: [] };
  const add = (stats, kind) => {
    if (!stats) return;
    for (const key of ["count", "dupes", "onServer", "put", "late"]) totals[key] += Number(stats[key] || 0);
    if (stats.first !== null && stats.first !== undefined && (totals.first === null || stats.first < totals.first)) totals.first = stats.first;
    if (stats.last !== null && stats.last !== undefined && (totals.last === null || stats.last > totals.last)) totals.last = stats.last;
    if (kind === "folder") {
      totals.folders += Number(stats.count || 0);
      totals.foldersOnServer += Number(stats.onServer || 0);
    } else if (stats.put) {
      totals.chatgpt.push(stats);
    }
  };
  for (const project of overview.projects || []) if (checked.has(project.path)) add(project, "folder");
  if (automation) add(overview.automation, "folder");
  // A conversation that ran in no folder goes by 새로 생기는 폴더도 수집.
  if (rest === "take") add(overview.withoutFolder, "folder");
  for (const file of overview.chatgpt || []) add(file, "chatgpt");
  return totals;
}

/**
 * The box under the folders: how many go in and from when, what is left out and
 * why, and how long. Then, when some are older than the server's newest turn, a
 * warning; at first setup with the choice to leave them out (draft.past.late).
 */
export function pastSummary(draft, overview, totals, { edit = false, here = false } = {}) {
  const past = draft.past;
  past.totals = totals;
  const server = overview.server || {};
  const fresh = server.new || (server.reachable && !server.total);
  const unknown = !server.new && !server.reachable;
  const period = periodText(totals.first, totals.last);
  const eta = etaText(totals.put * Number(overview.secondsPerConversation || 0.1));
  const lines = [];
  if (fresh || unknown) {
    lines.push([h("b", {}, `지난 대화 ${number(totals.put)}개`), period ? ` · ${period}` : ""]);
  } else if (totals.put) {
    const only = totals.chatgpt.length === 1 && totals.chatgpt[0].put === totals.put ? totals.chatgpt[0] : null;
    lines.push([h("b", {}, `새로 넣을 대화 ${number(totals.put)}개`), only?.account ? ` · ChatGPT ${only.account}` : "", period ? ` · ${period}` : ""]);
  } else {
    lines.push(h("b", {}, "새로 넣을 대화가 없습니다"));
  }
  if (unknown) lines.push("내 서버에 닿지 않아 서버에 이미 있는 대화를 세지 못했습니다. 적용할 때 서버에 이미 있는 대화는 빼고 넣습니다.");
  else if (!fresh && totals.folders && totals.foldersOnServer === totals.folders) lines.push("고른 폴더의 대화는 모두 서버에 있습니다.");
  else if (!fresh && totals.foldersOnServer) lines.push(`고른 폴더의 대화 ${number(totals.folders)}개 중 ${number(totals.foldersOnServer)}개는 내 서버에 이미 있습니다.`);
  if (totals.dupes) lines.push(`두 곳에 있는 같은 대화 ${number(totals.dupes)}개는 한 번만 넣습니다.`);
  if (totals.put && !edit) lines.push(`시작한 시각순으로 쌓습니다 · ${eta} · 그동안 생긴 새 대화는 그다음에 쌓입니다.`);
  const box = h("div", { class: "sum" }, lines.map((line, index) => h("div", { class: index ? "r" : null }, line)));
  if (!totals.late || !server.reachable) {
    past.late = "include";
    return box;
  }
  const newest = server.newest ? momentText(server.newest) : "";
  const text = totals.late === totals.put
    ? `${number(totals.put)}개 모두 서버의 가장 새 대화(${newest})보다 하루 넘게 오래됐습니다. 넣으면 시간 순서가 어긋난 채 정리됩니다.`
    : `${number(totals.put)}개 중 ${number(totals.late)}개는 내 서버의 가장 새 대화(${newest})보다 하루 넘게 오래됐습니다. 넣으면 시간 순서가 어긋난 채 정리됩니다.`;
  if (edit) {
    past.late = "include";
    return [box, notice("warn", text, h("div", { class: "hint" }, "시간순으로 맞추려면 다 넣은 뒤 서버 → 기억 서버에서 처음부터 다시 정리를 누르세요."))];
  }
  const radio = (value, label) => {
    const input = h("input", { type: "radio", name: "past-late", value, checked: past.late === value ? true : null });
    input.addEventListener("change", () => { if (input.checked) past.late = value; });
    return h("label", {}, input, label);
  };
  return [box, notice("warn", text,
    h("div", { class: "choice" }, radio("include", "그래도 넣기"), radio("skip", `${number(totals.late)}개는 넣지 않기`)),
    h("div", { class: "hint" }, here
      ? "넣은 뒤 시간순으로 맞추려면 서버 → 기억 서버의 처음부터 다시 정리를 누르세요."
      : "넣은 뒤 시간순으로 맞추려면 서버를 둔 컴퓨터에서 서버 → 기억 서버의 처음부터 다시 정리를 누르세요."))];
}

// ── 적용 ─────────────────────────────────────────────────

/** Whether 적용 has past conversations to put in, by the projects step's numbers. */
export function pastToPut(draft) {
  const totals = draft.past?.totals;
  return !totals || totals.put > 0;
}

/** Lines up what goes in (`past plan`). Resolves its counts; throws what it could not. */
export async function planPast(draft) {
  const past = draft.past;
  const result = await post("/api/past/plan", { ...sourcesBody(past), late: past.late === "skip" ? "skip" : "include" });
  if (result?.ok === false) {
    if (result.unreachable) throw new Error("내 서버에 닿지 않습니다. 서버가 켜져 있는지 확인한 뒤 다시 시도를 누르세요.");
    if (result.code === "not-read") throw new Error("고른 곳을 다시 읽어야 합니다. 설정으로 돌아가 지난 대화 단계에서 다 읽은 뒤 다시 적용하세요.");
    throw new Error(result.error || "줄 세우지 못했습니다.");
  }
  return result;
}

/** Starts putting them in, in the background (`past start`). */
export async function startPast() {
  const result = await post("/api/past/start", {});
  if (result?.ok === false) throw new Error(result.error || "쌓기를 시작하지 못했습니다.");
  return result;
}

/** New turns wait for the past ones from now (`past hold`), so none goes in before them. */
export function holdNewTurns() {
  return post("/api/past/hold", {}).catch(() => null);
}

/** Lets held turns go when nothing was put in after all (`past stop` with no run). */
export function releaseNewTurns() {
  return post("/api/past/stop", {}).catch(() => null);
}

/**
 * "116 / 116": of the conversations there were to put in, how many went in. One with
 * nothing in it to remember, or left out by the configuration, is not one of them.
 */
export function doneCount(last) {
  const skipped = last.skipped ?? Math.max(0, Number(last.done || 0) - Number(last.sent || 0) - Number(last.failed || 0));
  return `${number(last.sent || 0)} / ${number(Math.max(0, Number(last.total || 0) - skipped))}`;
}

/**
 * Under 기억 설정's 쌓은 순서: how many of the server's conversations went in more than
 * a day out of time order (a later 더 가져오기, a computer joined late), and where they
 * are put back in order. "" with none.
 */
export function lateLine(late) {
  const count = Number(late || 0);
  return count > 0
    ? `어긋난 대화 ${number(count)}개는 시간순보다 하루 넘게 늦게 들어왔습니다. 시간순으로 맞추려면 서버 → 기억 서버에서 처음부터 다시 정리를 누르세요.`
    : "";
}

/** The run's line while it goes: "2024년 3월 대화까지 쌓음" and how far. */
export function runLine(running) {
  if (!running) return "";
  const parts = [];
  if (running.month) parts.push(`${monthText(running.month)} 대화까지`);
  if (running.total !== null && running.total !== undefined) parts.push(`${number(running.done || 0)} / ${number(running.total)}`);
  if (running.etaSec) parts.push(`${etaText(running.etaSec)} 남음`);
  return parts.join(" · ");
}
