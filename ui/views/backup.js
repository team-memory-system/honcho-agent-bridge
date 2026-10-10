// 백업: where this computer's conversation originals are copied (a folder, or a cloud
// through rclone), when, and how the last run went, as one block. 수정 opens a window
// for where and when. Each action is the same `cli.mjs backup` command a terminal
// would run (scripts/backup.mjs).
import { cli, get } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { pickFolder } from "../lib/folders.js";
import { ago, fullDate, number } from "../lib/format.js";
import { block, field, kv, modal, opt, opts } from "../lib/kit.js";
import { button, busy, details, errorNotice, notice, pageHead, spinner, tag, toast, toggle } from "../lib/ui.js";

const REASONS = {
  missing: "폴더를 찾을 수 없습니다. 드라이브나 NAS가 연결돼 있는지 확인하세요.",
  "not-mounted": "드라이브가 연결돼 있지 않습니다.",
  "not-directory": "고른 경로가 폴더가 아닙니다.",
  "not-writable": "이 폴더에 쓸 수 없습니다. 권한을 확인하세요.",
  "not-absolute": "폴더 경로는 / 나 드라이브 문자로 시작하는 전체 경로로 적습니다.",
  "rclone-missing": "이 컴퓨터에 rclone이 없습니다.",
  "rclone-failed": "rclone이 답하지 않습니다.",
  "remote-missing": "rclone에 이 클라우드(remote)가 없습니다.",
  "unauthorized-or-offline": "클라우드에 닿지 않습니다. 인터넷 연결과 rclone 로그인을 확인하세요.",
};

const BUCKET_LABELS = [
  ["new", "새로 복사"],
  ["prefix-replace", "늘어난 파일 갱신"],
  ["own-replace", "이 컴퓨터가 올린 파일 갱신"],
  ["keep-both", "둘 다 남김"],
  ["archive-moves", "_아카이브로 옮김"],
  ["version-moves", "_원본버전에서 옮김"],
  ["unchanged", "그대로"],
];

const pad = (value) => String(value).padStart(2, "0");

function stateTag(status) {
  if (!status.destination || status.state === "off") return tag("꺼짐");
  if (status.state === "running") return tag("백업 중", "accent");
  if (status.state === "waiting") return tag("연결 대기", "warn");
  if (status.lastRun && !status.lastRun.ok) return tag("오류", "bad");
  return tag("연결됨", "ok");
}

function countsLine(counts) {
  if (!counts) return "";
  return BUCKET_LABELS.filter(([key]) => counts[key]).map(([key, label]) => `${label} ${number(counts[key])}`).join(" · ") || "바뀐 것 없음";
}

function reasonText(run) {
  return REASONS[run?.reason] || run?.detail || run?.error || "";
}

function where(destination) {
  if (!destination) return "없음";
  return [destination.kind === "cloud" ? "클라우드 " : "폴더 ", h("span", { class: "mono muted" }, destination.label)];
}

/** While a problem lasts: the same words as the notification this computer shows. */
function alertBanner(alert) {
  if (!alert?.problem || !alert.message) return null;
  return notice("bad",
    h("b", {}, alert.message.title),
    h("div", {}, alert.message.lines?.[0] || ""),
    h("div", {}, `${alert.since ? `${fullDate(alert.since)}부터 이어지고 있어요. ` : ""}원인을 해결하고 지금 백업을 누르세요. 백업이 한 번 성공하면 알림이 멈춰요.`));
}

/**
 * 백업 설정: where to copy, and whether and when to every day. With no place yet it
 * starts at the backup store 지난 대화 read (where this person's other computers back
 * up), every day.
 */
async function openSettings(status, onApplied) {
  const win = modal({ title: "백업 설정", big: true, small: true });
  const destination = status.destination || null;
  const schedule = status.schedule || {};
  const start = destination || (await get("/api/past/status").catch(() => null))?.chosen?.store || null;
  const chosen = { kind: start?.kind || "folder", path: start?.kind === "folder" ? start.path || "" : "", remote: start?.remote || "", cloudPath: start?.kind === "cloud" ? start.path || "" : "", on: destination ? Boolean(schedule.registered) : true, hour: schedule.hour ?? 3 };
  const folderInput = h("input", { class: "input mono", value: chosen.path, placeholder: "/Volumes/백업드라이브 또는 E:\\백업", spellcheck: "false", oninput: (event) => { chosen.path = event.target.value; } });
  const folderFields = h("div", { class: "subfields", style: { marginLeft: "0" }, hidden: chosen.kind !== "folder" },
    field("폴더", h("div", { class: "input-row" }, folderInput, button("폴더 고르기", { kind: "small", iconName: "folder", onClick: async () => {
      const folder = await pickFolder({ title: "백업할 폴더 고르기", start: folderInput.value.trim() });
      if (folder) { folderInput.value = folder; chosen.path = folder; }
    } })), "지금 연결돼 있는 폴더만 고를 수 있습니다. 드라이브를 빼면 다시 꽂을 때까지 연결 대기로 둡니다."));
  const cloudFields = h("div", { class: "subfields", style: { marginLeft: "0" }, hidden: chosen.kind !== "cloud" }, spinner());
  get("/api/backup/remotes").then((remotes) => {
    if (!remotes.installed) {
      clear(cloudFields, notice("warn", "이 컴퓨터에 rclone이 없습니다. rclone을 설치하고 터미널에서 ", h("span", { class: "mono" }, "rclone config"), "로 클라우드를 연결한 뒤 다시 여세요."));
      return;
    }
    if (!remotes.remotes?.length) {
      clear(cloudFields, notice("warn", "rclone에 연결된 클라우드가 없습니다. 터미널에서 ", h("span", { class: "mono" }, "rclone config"), "로 remote를 하나 만든 뒤 다시 여세요."));
      return;
    }
    if (!chosen.remote) chosen.remote = remotes.remotes[0];
    const select = h("select", { class: "select input mono" }, remotes.remotes.map((name) => h("option", { value: name, selected: chosen.remote === name ? true : null }, `${name}:`)));
    select.addEventListener("change", () => { chosen.remote = select.value; });
    clear(cloudFields,
      field("rclone remote", select),
      field("그 안의 폴더", h("input", { class: "input mono", value: chosen.cloudPath, placeholder: "비우면 맨 위", spellcheck: "false", oninput: (event) => { chosen.cloudPath = event.target.value; } }), "이 폴더 안에 대화 폴더를 만듭니다."));
  }).catch((error) => clear(cloudFields, errorNotice(error)));
  const pick = (kind) => () => {
    chosen.kind = kind;
    folderFields.hidden = kind !== "folder";
    cloudFields.hidden = kind !== "cloud";
  };
  const hour = h("select", { class: "select input mono", style: { width: "72px", height: "32px" }, "aria-label": "백업 시각" },
    Array.from({ length: 24 }, (_, value) => h("option", { value: String(value), selected: value === chosen.hour ? true : null }, pad(value))));
  hour.addEventListener("change", () => { chosen.hour = Number(hour.value); });
  const problem = h("div", {});
  win.body(
    h("div", { class: "label" }, "백업할 곳"),
    opts(
      opt({ name: "backup-where", value: "folder", checked: chosen.kind === "folder", title: "폴더에 백업", sub: "외장 드라이브나 NAS 폴더", extra: folderFields, onChange: pick("folder") }),
      opt({ name: "backup-where", value: "cloud", checked: chosen.kind === "cloud", title: "클라우드에 백업", sub: "rclone에 연결해 둔 클라우드(remote)", extra: cloudFields, onChange: pick("cloud") }),
      destination ? opt({ name: "backup-where", value: "off", checked: false, title: "백업하지 않기", sub: "이미 복사한 파일은 그대로 둡니다.", onChange: pick("off") }) : null),
    h("div", { class: "label" }, "자동 백업"),
    h("div", { class: "row2", style: { marginTop: "0" } },
      toggle(chosen.on, async (on) => { chosen.on = on; }, { label: "자동 백업" }), "매일", hour, `:${pad(schedule.minute ?? 0)}`,
      h("span", { class: "muted", style: { fontSize: "12.5px" } }, "컴퓨터가 꺼져 있었으면 켜진 뒤에")),
    problem);
  win.foot(null, [
    button("취소", { kind: "quiet", onClick: () => win.close() }),
    button("적용", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
      clear(problem);
      if (chosen.kind === "off") {
        await cli("/api/backup/schedule", { on: false });
        await cli("/api/backup/set", { kind: "off" });
      } else {
        const changed = chosen.kind !== destination?.kind
          || (chosen.kind === "folder" ? chosen.path.trim() !== (destination?.path || "") : chosen.remote !== (destination?.remote || "") || chosen.cloudPath.trim() !== (destination?.path || ""));
        if (chosen.kind === "folder" && !chosen.path.trim()) { clear(problem, notice("warn", "백업할 폴더를 고르세요.")); return; }
        if (chosen.kind === "cloud" && !chosen.remote) { clear(problem, notice("warn", "rclone remote를 고르세요.")); return; }
        if (changed) {
          await cli("/api/backup/set", chosen.kind === "folder"
            ? { kind: "folder", path: chosen.path.trim() }
            : { kind: "cloud", remote: chosen.remote, path: chosen.cloudPath.trim() });
        }
        if (chosen.on !== Boolean(schedule.registered) || chosen.hour !== (schedule.hour ?? 3)) {
          await cli("/api/backup/schedule", { on: chosen.on, hour: chosen.hour });
        }
      }
      win.close("ok");
      await onApplied();
      toast("적용했습니다.", "ok");
    }) }),
  ]);
  win.open();
}

export default {
  title: "백업",
  async mount(page) {
    const body = h("div", { class: "pad stack" });
    page.append(
      pageHead({ title: "백업", subtitle: "이 컴퓨터의 대화 원본을 폴더나 클라우드에 그대로 복사합니다." }),
      h("div", { class: "page-body" }, body),
    );
    let status = null;
    let poll = null;
    const stopPolling = () => { if (poll) clearTimeout(poll); poll = null; };

    /**
     * `after`: the last run's start before 지금 백업. The run starts in a process of its
     * own, so the first look can come before it says it is running, and a small backup
     * can be over by the next: until a run newer than that shows, look again a while.
     */
    async function refresh({ check = false, after, tries = 0 } = {}) {
      try {
        status = check ? await cli("/api/backup/status", { check: true }) : await get("/api/backup/status");
      } catch (error) {
        clear(body, errorNotice(error));
        return;
      }
      if (status.ok === false) { clear(body, notice("bad", status.error || "상태를 읽지 못했습니다.")); return; }
      draw();
      stopPolling();
      const waiting = after !== undefined && (status.lastRun?.startedAt || null) === after;
      if (status.state === "running") poll = setTimeout(() => refresh(), 4000);
      else if (waiting && tries < 15) poll = setTimeout(() => refresh({ after, tries: tries + 1 }), 2000);
    }

    function draw() {
      const run = status.lastRun;
      const schedule = status.schedule || {};
      const check = schedule.check || null;
      clear(body,
        alertBanner(status.alert),
        block({
          title: "백업",
          tag: stateTag(status),
          actions: [
            button("지금 백업", { disabled: !status.destination || status.state === "running", onClick: (event) => busy(event.currentTarget, async () => {
              const after = status.lastRun?.startedAt || null;
              const result = await cli("/api/backup/start", {});
              toast(result.started ? "백업을 시작했습니다" : "이미 백업하고 있습니다");
              await refresh(result.started ? { after } : {});
            }) }),
            button("수정", { onClick: () => openSettings(status, () => refresh({ check: true })) }),
          ],
        },
        kv("백업할 곳", where(status.destination)),
        kv("자동 백업", schedule.registered ? `매일 ${pad(schedule.hour ?? 3)}:${pad(schedule.minute ?? 0)}` : "꺼짐"),
        kv("마지막 백업", run
          ? [`${ago(run.finishedAt)} (${fullDate(run.finishedAt)})`, run.counts ? h("div", { class: "s" }, countsLine(run.counts)) : null]
          : "아직 없음"),
        kv("알림", ["백업이 실패하거나 48시간 넘게 성공하지 못하면 이 컴퓨터에 알림을 보냅니다.",
          schedule.registered && check && !check.registered ? h("div", { class: "s" }, "낮 확인이 아직 등록되지 않았습니다. 수정에서 자동 백업을 껐다가 다시 켜세요.") : null]),
        kv("device id", h("span", { class: "mono" }, status.device || ""))),
        status.state === "running" ? notice("", "백업하고 있습니다. 처음에는 오래 걸릴 수 있습니다.") : null,
        status.state === "waiting" ? notice("warn", h("b", {}, "연결 대기"), h("div", {}, reasonText(status.reachable?.ok === false ? status.reachable : run)), h("div", {}, "연결되면 다음 백업 때 이어서 복사합니다.")) : null,
        run && !run.ok && !run.waiting ? notice("bad", h("b", {}, "지난 백업에서 일부를 복사하지 못했습니다."),
          run.error ? h("div", {}, run.error) : null,
          run.errors?.length ? h("ul", {}, run.errors.slice(0, 5).map((item) => h("li", {}, h("span", { class: "mono" }, item.path), ` · ${item.error}`))) : null,
          h("div", {}, "다음 백업 때 다시 시도합니다.")) : null,
        h("details", { class: "fold" }, h("summary", {}, "무엇을 복사하나요"),
          h("ul", { class: "muted", style: { margin: "8px 0 0", paddingLeft: "20px", fontSize: "13.5px", lineHeight: "1.7" } },
            h("li", {}, "Claude Code·Codex의 대화 원본(.jsonl)을 바꾸지 않고 그대로 복사합니다. 대화를 시작한 날(한국 시간)의 ", h("span", { class: "mono" }, "대화/<agent>/YYYY/MM/DD/"), " 폴더에 둡니다."),
            h("li", {}, h("span", { class: "mono" }, "history.jsonl"), "과 Claude 메모리 노트도 복사합니다. subagent 대화와 tool 결과는 넣지 않습니다."),
            h("li", {}, "백업한 곳에서는 아무것도 지우지 않습니다. 같은 이름인데 내용이 다르면 둘 다 남깁니다."),
            h("li", {}, "백업할 곳에 닿지 않으면 연결 대기로 두고, 이 컴퓨터 디스크에는 아무것도 쓰지 않습니다."))),
        run ? details("지난 백업 결과", run) : null);
    }

    clear(body, spinner());
    await refresh();
    return { cleanup: stopPolling };
  },
};
