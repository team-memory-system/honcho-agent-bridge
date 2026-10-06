// 백업: where this computer's conversation originals are copied (a folder or a cloud
// through rclone), whether it reaches it now, and how the last run went. Each action
// is the same `cli.mjs backup` command a terminal would run (scripts/backup.mjs).
import { cli, get } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { pickFolder } from "../lib/folders.js";
import { ago, fullDate, number } from "../lib/format.js";
import { button, busy, details, errorNotice, notice, pageHead, section, spinner, tag, toast, toggle } from "../lib/ui.js";

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
  if (status.state === "off") return tag("꺼짐");
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

/** While a problem lasts: the same words as the notification this computer shows. */
function alertBanner(alert) {
  if (!alert?.problem || !alert.message) return null;
  return h("div", { style: { marginBottom: "16px" } }, notice("bad",
    h("b", {}, alert.message.title),
    h("div", {}, alert.message.lines?.[0] || ""),
    h("div", {}, `${alert.since ? `${fullDate(alert.since)}부터 이어지고 있어요. ` : ""}원인을 해결하고 지금 백업을 누르세요. 백업이 한 번 성공하면 알림이 멈춰요.`),
    alert.lastNotifiedAt ? h("div", { class: "muted" }, `마지막 알림 ${ago(alert.lastNotifiedAt)}`) : null,
  ));
}

export default {
  title: "백업",
  async mount(page) {
    const body = h("div", { class: "pad" });
    page.append(
      pageHead({ title: "백업", subtitle: "이 컴퓨터의 대화 원본을 폴더나 클라우드에 그대로 복사합니다." }),
      h("div", { class: "page-body" }, body),
    );
    const summary = h("div", { style: { marginBottom: "28px" } }, h("div", { class: "empty" }, spinner()));
    const where = h("div", {});
    clear(body,
      summary,
      section({ title: "백업할 곳", note: "한 곳을 고릅니다. 여러 컴퓨터가 같은 곳을 써도 됩니다." }, where),
      section({ title: "무엇을 복사하나요" },
        h("ul", { class: "muted", style: { margin: "0", paddingLeft: "20px", fontSize: "13.5px", lineHeight: "1.7" } },
          h("li", {}, "Claude Code·Codex의 대화 원본(.jsonl)을 바꾸지 않고 그대로 복사합니다. 대화를 시작한 날(한국 시간)의 ", h("code", { class: "mono" }, "대화/<agent>/YYYY/MM/DD/"), " 폴더에 둡니다."),
          h("li", {}, h("code", { class: "mono" }, "history.jsonl"), "과 Claude 메모리 노트도 복사합니다. subagent 대화와 tool 결과는 넣지 않습니다."),
          h("li", {}, "보관(archive)한 Codex 대화는 ", h("code", { class: "mono" }, "codex/_아카이브/"), "에 둡니다."),
          h("li", {}, "백업한 곳에서는 아무것도 지우지 않습니다. 같은 이름인데 내용이 다르면 둘 다 남기고, 이 컴퓨터 것은 device id를 붙인 이름으로 둡니다."),
          h("li", {}, "백업할 곳에 닿지 않으면 연결 대기로 두고, 이 컴퓨터 디스크에는 아무것도 쓰지 않습니다."),
        ),
      ),
    );

    let status = null;
    let poll = null;
    const stopPolling = () => { if (poll) clearTimeout(poll); poll = null; };

    async function refresh({ check = false } = {}) {
      try {
        status = check ? await cli("/api/backup/status", { check: true }) : await get("/api/backup/status");
      } catch (error) {
        clear(summary, errorNotice(error));
        return;
      }
      if (status.ok === false) { clear(summary, notice("bad", status.error || "상태를 읽지 못했습니다.")); return; }
      drawSummary();
      stopPolling();
      if (status.state === "running") poll = setTimeout(() => refresh(), 4000);
    }

    function drawSummary() {
      const run = status.lastRun;
      const schedule = status.schedule || {};
      const minute = pad(schedule.minute ?? 0);
      const when = `매일 ${pad(schedule.hour ?? 3)}:${minute}`;
      // The hour is the person's; the minute comes from the device id, so computers
      // backing up to one place do not start together.
      const hour = h("select", { class: "select hour-select", "aria-label": "백업 시각", disabled: !status.destination },
        Array.from({ length: 24 }, (_, value) => h("option", { value: String(value), selected: value === (schedule.hour ?? 3) ? true : null }, pad(value))));
      hour.addEventListener("change", async () => {
        const next = Number(hour.value);
        hour.disabled = true;
        try {
          const result = await cli("/api/backup/schedule", { on: Boolean(schedule.registered), hour: next });
          status.schedule = result.schedule || { ...schedule, hour: next };
          toast(schedule.registered ? `매일 ${pad(next)}:${minute}에 백업합니다` : "백업 시각을 바꿨습니다");
        } catch (error) {
          toast(error.message, "bad");
        }
        drawSummary();
      });
      const check = schedule.check || null;
      clear(summary, alertBanner(status.alert), h("div", { class: "panel summary" },
        h("div", { class: "summary-head" },
          stateTag(status),
          h("b", {}, status.destination ? "이렇게 백업하고 있습니다" : "백업할 곳을 아직 고르지 않았습니다"),
          button("지금 백업", { kind: "primary small", disabled: !status.destination || status.state === "running", onClick: (event) => busy(event.currentTarget, async () => {
            const result = await cli("/api/backup/start", {});
            toast(result.started ? "백업을 시작했습니다" : "이미 백업하고 있습니다");
            await refresh();
          }) }),
        ),
        h("dl", { class: "facts" },
          h("dt", {}, "백업할 곳"), h("dd", {}, status.destination
            ? [status.destination.kind === "cloud" ? "클라우드 · " : "폴더 · ", h("code", { class: "mono" }, status.destination.label)]
            : "없음"),
          h("dt", {}, "마지막 백업"), h("dd", {}, run
            ? `${ago(run.finishedAt)} (${fullDate(run.finishedAt)})${run.counts ? ` · ${countsLine(run.counts)}` : ""}`
            : "아직 없음"),
          h("dt", {}, "자동 백업"), h("dd", {},
            toggle(Boolean(schedule.registered), async (on) => {
              const result = await cli("/api/backup/schedule", { on });
              status.schedule = result.schedule || status.schedule;
              toast(on ? `${when}에 백업합니다` : "자동 백업을 껐습니다");
              // The 알림 line follows whether the daytime check is registered now.
              drawSummary();
            }, { label: "자동 백업", disabled: !status.destination }),
            h("span", { class: "backup-when" }, "매일", hour, `:${minute}`),
            h("span", { class: "muted" }, "컴퓨터가 꺼져 있었으면 켜진 뒤에"),
          ),
          h("dt", {}, "알림"), h("dd", {},
            "백업이 실패하거나 48시간 넘게 성공하지 못하면 이 컴퓨터에 알림을 보냅니다.",
            schedule.registered && check && !check.registered
              ? h("div", { class: "muted" }, "낮 확인이 아직 등록되지 않았습니다. 자동 백업을 껐다가 다시 켜세요.")
              : check?.registered
                ? h("span", { class: "muted" }, ` 문제가 이어지면 매일 ${pad(check.hour ?? 10)}:${pad(check.minute ?? 0)}에 다시 알립니다.`)
                : null,
          ),
          h("dt", {}, "device id"), h("dd", {}, h("code", { class: "mono" }, status.device || "")),
        ),
        h("div", { class: "form-actions" },
          status.destination ? button("연결 확인", { kind: "small", onClick: (event) => busy(event.currentTarget, () => refresh({ check: true })) }) : null,
        ),
        status.state === "running" ? notice("", spinner(), " 백업하고 있습니다. 처음에는 오래 걸릴 수 있습니다.") : null,
        status.state === "waiting" ? notice("warn", h("b", {}, "연결 대기"), h("div", {}, reasonText(status.reachable?.ok === false ? status.reachable : run)), h("div", {}, "연결되면 다음 백업 때 이어서 복사합니다.")) : null,
        run && !run.ok && !run.waiting ? notice("bad", h("b", {}, "지난 백업에서 일부를 복사하지 못했습니다."),
          run.error ? h("div", {}, run.error) : null,
          run.errors?.length ? h("ul", {}, run.errors.slice(0, 5).map((item) => h("li", {}, h("code", { class: "mono" }, item.path), ` · ${item.error}`))) : null,
          h("div", {}, "다음 백업 때 다시 시도합니다.")) : null,
        run ? details("지난 백업 결과", run) : null,
      ));
    }

    function drawWhere(mode = status?.destination?.kind || "") {
      const cards = [
        ["folder", "폴더에 백업", "외장 드라이브, NAS, 이 컴퓨터의 폴더. 그 안에 대화 폴더를 만듭니다."],
        ["cloud", "클라우드에 백업", "rclone에 연결해 둔 클라우드(remote). 그 안에 대화 폴더를 만듭니다."],
      ];
      const form = h("div", {});
      clear(where,
        h("div", { class: "choices two" }, cards.map(([key, title, text]) => h("button", {
          type: "button",
          class: `choice${key === mode ? " picked" : ""}`,
          onclick: () => drawWhere(key),
        }, h("b", {}, title), h("span", {}, text)))),
        form,
        status?.destination ? h("div", { class: "form-actions" }, button("백업 끄기", { kind: "small quiet danger", onClick: (event) => busy(event.currentTarget, async () => {
          await cli("/api/backup/schedule", { on: false });
          await cli("/api/backup/set", { kind: "off" });
          await refresh();
          drawWhere("");
        }, { done: "백업을 껐습니다. 이미 복사한 파일은 그대로 있습니다." }) })) : null,
      );
      if (mode === "folder") folderForm(form);
      if (mode === "cloud") cloudForm(form);
    }

    function folderForm(container) {
      const current = status?.destination?.kind === "folder" ? status.destination.path : "";
      const input = h("input", { class: "input", value: current, placeholder: "/Volumes/백업드라이브 또는 E:\\백업", spellcheck: "false" });
      const choose = button("폴더 고르기", { iconName: "folder", onClick: async () => {
        const folder = await pickFolder({ title: "백업할 폴더 고르기", start: input.value.trim() });
        if (folder) input.value = folder;
      } });
      clear(container, h("div", { class: "panel" },
        h("div", { class: "field wide" }, h("span", {}, "폴더"), h("div", { class: "input-row" }, input, choose),
          h("small", {}, "지금 연결돼 있는 폴더만 고를 수 있습니다. 드라이브를 빼면 다시 꽂을 때까지 연결 대기로 둡니다.")),
        h("div", { class: "form-actions" }, button("이 폴더로 정하기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
          await cli("/api/backup/set", { kind: "folder", path: input.value.trim() });
          await refresh({ check: true });
          drawWhere("folder");
        }, { done: "백업할 곳을 정했습니다" }) })),
      ));
    }

    async function cloudForm(container) {
      clear(container, h("div", { class: "empty" }, spinner()));
      let remotes;
      try { remotes = await get("/api/backup/remotes"); } catch (error) { clear(container, errorNotice(error)); return; }
      if (!remotes.installed) {
        clear(container, notice("warn", h("b", {}, "이 컴퓨터에 rclone이 없습니다."), h("div", {}, "rclone을 설치하고 터미널에서 ", h("code", { class: "mono" }, "rclone config"), "로 클라우드를 연결한 뒤 다시 여세요.")));
        return;
      }
      if (!remotes.remotes?.length) {
        clear(container, notice("warn", h("b", {}, "rclone에 연결된 클라우드가 없습니다."), h("div", {}, "터미널에서 ", h("code", { class: "mono" }, "rclone config"), "로 remote를 하나 만든 뒤 다시 여세요.")));
        return;
      }
      const current = status?.destination?.kind === "cloud" ? status.destination : null;
      const select = h("select", { class: "select" }, remotes.remotes.map((name) => h("option", { value: name, selected: current?.remote === name ? "selected" : null }, `${name}:`)));
      const folder = h("input", { class: "input", value: current?.path || "", placeholder: "비우면 맨 위", spellcheck: "false" });
      clear(container, h("div", { class: "panel" },
        h("div", { class: "form-grid" },
          h("label", { class: "field" }, h("span", {}, "rclone remote"), select),
          h("label", { class: "field" }, h("span", {}, "그 안의 폴더"), folder, h("small", {}, "이 폴더 안에 대화 폴더를 만듭니다.")),
        ),
        h("div", { class: "form-actions" }, button("이 클라우드로 정하기", { kind: "primary", onClick: (event) => busy(event.currentTarget, async () => {
          await cli("/api/backup/set", { kind: "cloud", remote: select.value, path: folder.value.trim() });
          await refresh({ check: true });
          drawWhere("cloud");
        }, { done: "백업할 곳을 정했습니다" }) })),
      ));
    }

    await refresh();
    drawWhere();
    return { cleanup: stopPolling };
  },
};

