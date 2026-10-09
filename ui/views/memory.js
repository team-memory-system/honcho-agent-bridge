// 기억: every conversation that was collected, what Honcho concluded from them,
// and the people and agents in them. A list on the left, the thing itself on the
// right, and one search box that looks through all of it.
import { get } from "../lib/api.js";
import { h, clear, copyText, debounce } from "../lib/dom.js";
import { screenTabs } from "../lib/tabs.js";
import { icon } from "../lib/icons.js";
import { markdown } from "../lib/markdown.js";
import { SOURCE_FILTERS, cardLine, fullDate, isAssistant, number, peerKind, relativeDay, sourceLabel, speakerLabel, time } from "../lib/format.js";
import { api, app, go, me, workspace } from "../lib/state.js";
import { button, busy, confirmSheet, empty, errorNotice, pageHead, spinner, srcBadge, tag, toast } from "../lib/ui.js";

const PAGE = 30;
const MESSAGES_PAGE = 60;

function highlight(text, query) {
  const value = String(text || "");
  const needle = query.trim();
  if (!needle) return value;
  const at = value.toLowerCase().indexOf(needle.toLowerCase());
  if (at < 0) return value;
  const start = Math.max(0, at - 40);
  return [start ? "…" : "", value.slice(start, at), h("mark", {}, value.slice(at, at + needle.length)), value.slice(at + needle.length, at + needle.length + 160)];
}

/** Markdown marks read as noise in a one-line preview. */
function oneLine(text, length = 140) {
  const line = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*|__|`|^#+\s*|\|?\s*:?-{3,}:?\s*/gm, "")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
}

export default {
  title: "기억",
  async mount(page, params) {
    const state = {
      tab: params[0] === "notes" ? "notes" : params[0] === "people" ? "people" : "talks",
      source: "",
      query: "",
      searching: false,
      sessions: [], sessionTotal: null, sessionPage: 0, sessionPages: 1,
      hits: [],
      notes: [], notesPage: 0, notesPages: 1, notesTotal: null, notesAbout: "",
      peers: [],
      selected: null,
      loading: false,
      titles: new Map(),
    };

    const subtitle = h("p", {});
    const head = pageHead({ title: "기억", actions: [button("", { kind: "quiet icon-only", iconName: "refresh", title: "새로 고침", onClick: () => reload() })], subnav: screenTabs("memory") });
    head.querySelector("div").append(subtitle);

    const search = h("input", { id: "memory-search", class: "input", type: "search", placeholder: "대화와 기억에서 찾기 (Enter)", "aria-label": "기억에서 찾기" });
    const tabs = h("div", { class: "tabs", role: "tablist" });
    const filters = h("div", { class: "chips" });
    const scroll = h("div", { class: "list-scroll" });
    const foot = h("div", { class: "list-foot" });
    const reader = h("div", { class: "reader" });
    const split = h("div", { class: "page-body split memory" },
      h("div", { class: "list-pane" },
        h("div", { class: "list-tools" }, h("div", { class: "searchbox" }, icon("search"), search, h("kbd", {}, "/")), filters),
        tabs,
        scroll,
        foot,
      ),
      reader,
    );
    page.append(head, split);

    const keyHandler = (event) => {
      if (event.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) {
        event.preventDefault();
        search.focus();
      }
    };
    document.addEventListener("keydown", keyHandler);

    // ── Tabs and filters ──────────────────────────────────

    function drawTabs() {
      clear(tabs, [["talks", "대화"], ["notes", "정리된 기억"], ["people", "사람·에이전트"]].map(([key, label]) => h("button", {
        role: "tab",
        type: "button",
        "aria-selected": String(state.tab === key),
        onclick: () => { if (state.tab !== key) { state.tab = key; state.selected = null; drawTabs(); drawFilters(); reload(); drawReader(); } },
      }, label)));
    }

    function drawFilters() {
      if (state.tab === "talks") {
        clear(filters, SOURCE_FILTERS.map(([key, label]) => h("button", {
          class: "chip",
          type: "button",
          "aria-pressed": String(state.source === key),
          onclick: () => { state.source = key; drawFilters(); reload(); },
        }, label)));
      } else if (state.tab === "notes") {
        const choice = h("select", { class: "select", "aria-label": "누구에 관한 기억", style: { height: "28px", width: "auto" } },
          h("option", { value: "" }, "모든 사람·에이전트"),
          state.peers.map((peer) => h("option", { value: peer.id, selected: peer.id === state.notesAbout ? true : null }, speakerLabel(peer.id, me()) === "나" ? `나 (${peer.id})` : speakerLabel(peer.id, me()))),
        );
        choice.addEventListener("change", () => { state.notesAbout = choice.value; reload(); });
        clear(filters, h("label", { class: "field", style: { flexDirection: "row", alignItems: "center", gap: "8px" } }, h("span", {}, "대상"), choice));
      } else {
        clear(filters);
      }
    }

    // ── Loading lists ─────────────────────────────────────

    let generation = 0;

    async function reload() {
      generation += 1;
      state.sessions = []; state.sessionPage = 0; state.sessionPages = 1;
      state.notes = []; state.notesPage = 0; state.notesPages = 1;
      state.hits = [];
      state.searching = Boolean(state.query.trim());
      clear(scroll, h("div", { class: "empty", style: { padding: "20px 16px" } }, spinner(),
        state.searching && state.tab !== "people" ? h("span", {}, "뜻이 비슷한 대화를 찾는 중입니다. 몇 초 걸립니다.") : null));
      foot.textContent = state.searching ? "찾는 중…" : "";
      if (!state.peers.length) await loadPeers();
      if (state.tab === "talks") {
        if (state.searching) await searchMessages(generation); else await moreSessions(generation);
      } else if (state.tab === "notes") {
        await moreNotes(generation);
      } else {
        drawList();
      }
      drawSubtitle();
    }

    async function loadPeers() {
      try {
        const result = await api().post("/peers/list?page=1&size=100", {});
        const order = { me: 0, person: 1, agent: 2, automation: 3 };
        state.peers = (result.items || []).sort((a, b) => order[peerKind(a.id, me())] - order[peerKind(b.id, me())] || a.id.localeCompare(b.id));
      } catch (error) {
        state.peers = [];
        if (!state.error) state.error = error;
      }
      drawFilters();
    }

    async function moreSessions(ticket = generation) {
      if (state.loading || state.sessionPage >= state.sessionPages) return;
      state.loading = true;
      try {
        const params = new URLSearchParams({ workspace: workspace(), page: String(state.sessionPage + 1), size: String(PAGE) });
        if (state.source) params.set("source", state.source);
        const result = await get(`/api/app/sessions?${params}`);
        if (ticket !== generation) return;
        state.sessionPage = result.page;
        state.sessionPages = result.pages;
        state.sessionTotal = result.total;
        state.sessions.push(...result.items);
        for (const item of result.items) if (item.title) state.titles.set(item.id, item);
        state.error = null;
      } catch (error) {
        if (ticket === generation) state.error = error;
      } finally {
        state.loading = false;
      }
      if (ticket === generation) drawList();
    }

    async function searchMessages(ticket) {
      try {
        const result = await api().post("/search", { query: state.query.trim(), limit: 50 });
        if (ticket !== generation) return;
        state.hits = Array.isArray(result) ? result : result.items || [];
        state.error = null;
      } catch (error) {
        state.error = error;
      }
      drawList();
    }

    async function moreNotes(ticket = generation) {
      if (state.loading) return;
      const query = state.query.trim();
      if (query) {
        const about = state.notesAbout || me();
        if (!about) { state.error = new Error("누구의 기억에서 찾을지 대상을 고르세요."); drawList(); return; }
        state.loading = true;
        try {
          const result = await api().post("/conclusions/query", { query, top_k: 40, filters: { observer: about, observed: about } });
          if (ticket !== generation) return;
          state.notes = Array.isArray(result) ? result : result.items || [];
          state.notesPages = 1; state.notesPage = 1; state.notesTotal = state.notes.length;
          state.error = null;
        } catch (error) {
          state.error = error;
        } finally {
          state.loading = false;
        }
        drawList();
        return;
      }
      if (state.notesPage >= state.notesPages) return;
      state.loading = true;
      try {
        const body = state.notesAbout ? { filters: { observed_id: state.notesAbout } } : {};
        const result = await api().post(`/conclusions/list?page=${state.notesPage + 1}&size=${PAGE}`, body);
        if (ticket !== generation) return;
        state.notesPage = result.page; state.notesPages = result.pages; state.notesTotal = result.total;
        state.notes.push(...(result.items || []));
        state.error = null;
      } catch (error) {
        if (ticket === generation) state.error = error;
      } finally {
        state.loading = false;
      }
      if (ticket === generation) drawList();
    }

    function drawSubtitle() {
      const parts = [];
      if (state.sessionTotal !== null) parts.push(`대화 ${number(state.sessionTotal)}개`);
      if (state.notesTotal !== null && !state.query) parts.push(`정리된 기억 ${number(state.notesTotal)}개`);
      const queue = app.status.honcho.queue;
      const pending = queue ? (queue.pending_work_units || 0) + (queue.in_progress_work_units || 0) : 0;
      if (pending) parts.push(`정리 기다리는 중 ${number(pending)}건`);
      subtitle.textContent = parts.join(" · ") || "모인 대화와 거기서 정리된 기억";
    }

    // ── Drawing the list ──────────────────────────────────

    function isCurrent(kind, id) {
      return state.selected?.kind === kind && state.selected?.id === id ? "true" : null;
    }

    function sessionItem(item) {
      return h("button", { class: "item", type: "button", "aria-current": isCurrent("session", item.id), onclick: () => openSession(item.id) },
        h("div", { class: "top" }, h("div", { class: "t" }, item.title || "제목 없는 대화"), h("span", { class: "when" }, relativeDay(item.startedAt))),
        item.preview ? h("div", { class: "p" }, item.preview) : null,
        h("div", { class: "m" }, srcBadge(item.source), sourceLabel(item.source), item.project ? [h("span", { class: "sep" }), item.project] : null),
      );
    }

    function hitItem(hit) {
      const known = state.titles.get(hit.session_id);
      return h("button", { class: "item", type: "button", "aria-current": isCurrent("session", hit.session_id) && state.selected?.target === hit.id ? "true" : null, onclick: () => openSession(hit.session_id, hit.id) },
        h("div", { class: "top" }, h("div", { class: "t" }, known?.title || speakerLabel(hit.peer_id, me())), h("span", { class: "when" }, relativeDay(hit.created_at))),
        h("div", { class: "p snippet" }, highlight(oneLine(hit.content, 400), state.query)),
        h("div", { class: "m" }, srcBadge(hit.metadata?.source || hit.session_id.split("-")[0]), speakerLabel(hit.peer_id, me()), h("span", { class: "sep" }), "대화 속 한 줄"),
      );
    }

    function noteItem(note) {
      return h("button", { class: "item", type: "button", "aria-current": isCurrent("note", note.id), onclick: () => openNote(note) },
        h("div", { class: "top" }, h("div", { class: "t", style: { fontWeight: "450" } }, oneLine(note.content, 220)), h("span", { class: "when" }, relativeDay(note.created_at))),
        h("div", { class: "m" }, speakerLabel(note.observed_id, me()), note.observer_id !== note.observed_id ? [h("span", { class: "sep" }), `${speakerLabel(note.observer_id, me())}의 관점`] : null, note.level === "deductive" ? [h("span", { class: "sep" }), "추론"] : null),
      );
    }

    function peerItem(peer) {
      return h("button", { class: "item", type: "button", "aria-current": isCurrent("peer", peer.id), onclick: () => openPeer(peer.id) },
        h("div", { class: "top" }, h("div", { class: "t" }, speakerLabel(peer.id, me()) === "나" ? "나" : speakerLabel(peer.id, me())), peer.id === me() ? tag("나", "accent") : null),
        h("div", { class: "m mono" }, peer.id),
      );
    }

    function drawList() {
      const nodes = [];
      if (state.error) nodes.push(h("div", { style: { padding: "14px 16px" } }, errorNotice(state.error, state.error.unreachable ? "서버 화면에서 기억 서버 상태를 확인하세요." : null)));
      if (state.tab === "talks" && state.searching) {
        nodes.push(state.hits.map(hitItem));
        if (!state.hits.length && !state.error) nodes.push(h("div", { style: { padding: "0 16px" } }, empty("찾은 대화가 없습니다", "다른 말로 찾아보거나, 정리된 기억 탭에서 찾아보세요.")));
        foot.textContent = `“${state.query.trim()}” 대화 속 ${number(state.hits.length)}곳`;
      } else if (state.tab === "talks") {
        nodes.push(state.sessions.map(sessionItem));
        if (!state.sessions.length && !state.error && !state.loading) nodes.push(h("div", { style: { padding: "0 16px" } }, empty("아직 모인 대화가 없습니다", "기억 설정 → 대화 수집에서 켜세요.", button("대화 수집 설정", { onClick: () => go("computer/collect") }))));
        if (state.sessionPage < state.sessionPages) nodes.push(h("div", { class: "more-messages" }, state.loading ? spinner() : button("더 보기", { kind: "small", onClick: () => moreSessions() })));
        foot.textContent = state.sessionTotal === null ? "" : `${number(state.sessionTotal)}개 중 ${number(state.sessions.length)}개 · 최근 순`;
      } else if (state.tab === "notes") {
        nodes.push(state.notes.map(noteItem));
        if (!state.notes.length && !state.error && !state.loading) nodes.push(h("div", { style: { padding: "0 16px" } }, empty(state.query ? "찾은 기억이 없습니다" : "정리된 기억이 없습니다", "대화가 모이면 Honcho가 사실과 추론을 정리해 여기에 둡니다.")));
        if (!state.query && state.notesPage < state.notesPages) nodes.push(h("div", { class: "more-messages" }, state.loading ? spinner() : button("더 보기", { kind: "small", onClick: () => moreNotes() })));
        foot.textContent = state.query ? `“${state.query.trim()}”와 가까운 기억 ${number(state.notes.length)}개` : state.notesTotal === null ? "" : `${number(state.notesTotal)}개 중 ${number(state.notes.length)}개 · 최근 순`;
      } else {
        const query = state.query.trim().toLowerCase();
        const people = state.peers.filter((peer) => !query || peer.id.toLowerCase().includes(query) || speakerLabel(peer.id, me()).toLowerCase().includes(query));
        const groups = [["me", null], ["person", "사람"], ["agent", "에이전트"], ["automation", "자동 작업"]];
        for (const [kind, label] of groups) {
          const members = people.filter((peer) => peerKind(peer.id, me()) === kind);
          if (!members.length) continue;
          if (kind === "automation") {
            const box = h("details", { class: "group", open: query || state.selected?.kind === "peer" && peerKind(state.selected.id, me()) === "automation" ? true : null },
              h("summary", { class: "group-label" }, `${label} ${members.length}`, h("small", {}, "예약 작업·하위 에이전트가 남긴 기록")),
              members.map(peerItem));
            nodes.push(box);
          } else {
            if (label) nodes.push(h("div", { class: "group-label" }, `${label} ${members.length}`));
            nodes.push(members.map(peerItem));
          }
        }
        foot.textContent = `${number(people.length)}명`;
      }
      clear(scroll, nodes);
    }

    scroll.addEventListener("scroll", () => {
      if (scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 200) return;
      if (state.tab === "talks" && !state.searching) moreSessions();
      if (state.tab === "notes" && !state.query) moreNotes();
    });

    // Honcho searches by meaning and takes several seconds, so conversations and
    // notes are searched on Enter; the people list filters as you type.
    const filterPeople = debounce(() => { state.query = search.value; drawList(); }, 150);
    search.addEventListener("input", () => {
      if (state.tab === "people") return filterPeople();
      if (!search.value.trim() && state.query) { state.query = ""; reload(); }
    });
    search.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.isComposing && state.tab !== "people") { state.query = search.value; reload(); }
      if (event.key === "Escape") { search.value = ""; state.query = ""; reload(); }
    });

    // ── The reader ────────────────────────────────────────

    let readerTicket = 0;

    function drawReader() {
      split.classList.toggle("reading", Boolean(state.selected));
      if (state.selected) return;
      const recent = state.sessions[0];
      clear(reader, h("div", { class: "reader-inner" },
        empty(
          state.tab === "people" ? "사람이나 에이전트를 고르세요" : state.tab === "notes" ? "정리된 기억을 고르세요" : "대화를 고르세요",
          state.tab === "people" ? "Honcho가 그 사람에 대해 정리한 카드와 이해를 보여 줍니다." : state.tab === "notes" ? "그 기억이 나온 대화로 바로 갈 수 있습니다." : "왼쪽 목록에서 대화를 고르면 원문을 처음부터 끝까지 읽을 수 있습니다.",
          recent && state.tab === "talks" ? button("가장 최근 대화 열기", { onClick: () => openSession(recent.id) }) : null,
        ),
      ));
    }

    function backButton() {
      return h("button", { class: "btn quiet small mobile-only", type: "button", onclick: () => { state.selected = null; drawList(); drawReader(); history.replaceState(null, "", `#/memory${state.tab === "talks" ? "" : `/${state.tab}`}`); } }, icon("back"), "목록");
    }

    async function openSession(id, target = null) {
      state.selected = { kind: "session", id, target };
      history.replaceState(null, "", `#/memory/s/${encodeURIComponent(id)}${target ? `/${encodeURIComponent(target)}` : ""}`);
      drawList();
      drawReader();
      const ticket = ++readerTicket;
      const known = state.titles.get(id) || state.sessions.find((item) => item.id === id);
      const messagesBox = h("div", {});
      const moreBox = h("div", { class: "more-messages" });
      const countText = h("span", {});
      const title = h("h2", {}, known?.title || "대화");
      const meta = h("div", { class: "meta" });
      const actions = h("div", { class: "actions" });
      clear(reader, h("div", { class: "reader-inner" },
        backButton(),
        h("div", { class: "reader-head" }, title, meta, actions),
        messagesBox,
        moreBox,
      ));
      clear(messagesBox, h("div", { class: "empty" }, spinner()));

      let session = null;
      try {
        const listing = await api().post("/sessions/list?page=1&size=1", { filters: { id } });
        session = (listing.items || [])[0] || null;
      } catch {}
      const metadata = session?.metadata || {};
      const source = metadata.source || known?.source || id.split("-")[0];
      clear(meta,
        h("span", { style: { display: "inline-flex", gap: "6px", alignItems: "center" } }, srcBadge(source), sourceLabel(source)),
        metadata.cwd || known?.project ? h("span", {}, metadata.cwd || known.project) : null,
        session?.created_at ? h("span", {}, fullDate(session.created_at)) : null,
        countText,
      );

      const all = [];
      let pageNo = 0;
      let pages = 1;
      let total = 0;
      const load = async () => {
        const result = await api().post(`/sessions/${encodeURIComponent(id)}/messages/list?page=${pageNo + 1}&size=${MESSAGES_PAGE}`, {});
        if (ticket !== readerTicket) return false;
        pageNo = result.page; pages = result.pages; total = result.total;
        all.push(...(result.items || []));
        return true;
      };
      try {
        if (!(await load())) return;
        // A search hit opens where it was said.
        while (target && !all.some((message) => message.id === target) && pageNo < pages && pageNo < 40) {
          if (!(await load())) return;
        }
      } catch (error) {
        clear(messagesBox, errorNotice(error));
        return;
      }
      if (!known?.title) {
        const opening = all.find((message) => message.metadata?.direct_user) || all[0];
        if (opening) title.textContent = oneLine(opening.content, 90);
      }
      countText.textContent = `메시지 ${number(total)}개`;
      clear(actions,
        button("이 대화에 대해 묻기", { kind: "small", iconName: "ask", onClick: () => go(`ask/session/${encodeURIComponent(id)}`) }),
        button("원문 복사", { kind: "small quiet", iconName: "copy", onClick: async () => {
          const text = all.map((message) => `${speakerLabel(message.peer_id, me())}: ${message.content}`).join("\n\n");
          toast((await copyText(text)) ? `메시지 ${all.length}개를 복사했습니다` : "복사하지 못했습니다", "");
        } }),
        h("button", { class: "btn small quiet mono", type: "button", title: "대화 ID 복사", onclick: async () => { await copyText(id); toast("대화 ID를 복사했습니다"); } }, id.length > 28 ? `${id.slice(0, 26)}…` : id),
      );

      const drawMessages = () => {
        clear(messagesBox, all.map((message) => {
          const mine = message.peer_id === me() || message.metadata?.direct_user;
          return h("article", { class: `msg ${mine ? "me" : ""} ${message.id === target ? "target" : ""}`, id: `m-${message.id}` },
            h("div", { class: "msg-head" }, h("b", {}, speakerLabel(message.peer_id, me())), h("span", {}, time(message.created_at))),
            markdown(message.content),
          );
        }));
        clear(moreBox, pageNo < pages
          ? button(`이어서 보기 (${number(total - all.length)}개 남음)`, { kind: "small", onClick: async (event) => {
            await busy(event.currentTarget, async () => { if (await load()) drawMessages(); });
          } })
          : total > MESSAGES_PAGE ? h("span", { class: "muted" }, "대화 끝") : null);
      };
      drawMessages();
      if (target) document.getElementById(`m-${target}`)?.scrollIntoView({ block: "center" });
      else reader.scrollTop = 0;
    }

    function openNote(note) {
      state.selected = { kind: "note", id: note.id };
      drawList();
      drawReader();
      clear(reader, h("div", { class: "reader-inner" },
        backButton(),
        h("div", { class: "reader-head" },
          h("h2", {}, "정리된 기억"),
          h("div", { class: "meta" },
            h("span", {}, `${speakerLabel(note.observed_id, me())}에 대해`),
            note.observer_id !== note.observed_id ? h("span", {}, `${speakerLabel(note.observer_id, me())}가 본 것`) : null,
            h("span", {}, note.level === "deductive" ? "추론한 것" : note.level === "inductive" ? "패턴에서 짐작한 것" : "대화에 나온 사실"),
            h("span", {}, fullDate(note.created_at)),
          ),
        ),
        h("div", { class: "prose", style: { fontSize: "16px", padding: "14px 0 18px" } }, note.content),
        h("div", { class: "form-actions" },
          note.session_id ? button("이 기억이 나온 대화 열기", { iconName: "memory", onClick: () => { state.tab = "talks"; drawTabs(); drawFilters(); openSession(note.session_id); } }) : null,
          button("이 기억 지우기", { kind: "danger", iconName: "trash", onClick: async (event) => {
            const ok = await confirmSheet({ title: "이 기억을 지울까요?", text: "Honcho에서 이 정리 한 건을 영구히 지웁니다. 원래 대화는 남습니다. 틀린 내용일 때만 지우세요.", confirm: "지우기", danger: true });
            if (!ok) return;
            await busy(event.currentTarget, async () => {
              await api().del(`/conclusions/${encodeURIComponent(note.id)}`);
              state.notes = state.notes.filter((item) => item.id !== note.id);
              state.selected = null;
              drawList();
              drawReader();
            }, { done: "기억을 지웠습니다" });
          } }),
        ),
      ));
    }

    async function openPeer(id) {
      state.selected = { kind: "peer", id };
      drawList();
      drawReader();
      const ticket = ++readerTicket;
      const cardBox = h("div", {}, spinner());
      const understanding = h("div", {});
      const recentBox = h("div", {}, spinner());
      const label = speakerLabel(id, me());
      clear(reader, h("div", { class: "reader-inner" },
        backButton(),
        h("div", { class: "reader-head" },
          h("h2", {}, label === "나" ? `나 · ${id}` : label),
          h("div", { class: "meta" }, h("span", { class: "mono" }, id), id === me() ? tag("나", "accent") : isAssistant(id) ? tag("에이전트") : tag("사람")),
          h("div", { class: "actions" }, button(label === "나" ? "나에 대해 묻기" : `${label}에 대해 묻기`, { kind: "small", iconName: "ask", onClick: () => go(`ask/peer/${encodeURIComponent(id)}`) })),
        ),
        h("section", { class: "section", style: { marginTop: "18px" } }, h("header", {}, h("h2", {}, "카드"), h("p", {}, "Honcho가 정리한 핵심 사실")), cardBox),
        h("section", { class: "section" }, h("header", {}, h("h2", {}, "Honcho가 이해한 모습"), h("p", {}, "쌓인 기억을 바탕으로 쓴 글")), understanding),
        h("section", { class: "section" }, h("header", {}, h("h2", {}, "최근에 정리된 기억")), recentBox),
      ));
      clear(understanding, button("불러오기", { kind: "small", onClick: async (event) => {
        await busy(event.currentTarget, async () => {
          const result = await api().post(`/peers/${encodeURIComponent(id)}/representation`, {});
          if (ticket !== readerTicket) return;
          clear(understanding, result.representation ? markdown(result.representation) : h("p", { class: "muted" }, "아직 쓸 만큼 쌓이지 않았습니다."));
        });
      } }));
      const [card, recent] = await Promise.allSettled([
        api().get(`/peers/${encodeURIComponent(id)}/card`),
        api().post(`/conclusions/list?page=1&size=12`, { filters: { observed_id: id } }),
      ]);
      if (ticket !== readerTicket) return;
      const lines = card.status === "fulfilled" ? card.value.peer_card || [] : [];
      clear(cardBox, card.status === "rejected"
        ? errorNotice(card.reason)
        : lines.length ? h("ul", { class: "card-list" }, lines.map((line) => {
          const { kind, text } = cardLine(line);
          return h("li", { class: "card-line" }, kind ? h("span", { class: "card-kind" }, kind) : null, h("span", {}, text));
        })) : h("p", { class: "muted" }, "아직 카드가 없습니다."));
      const notes = recent.status === "fulfilled" ? recent.value.items || [] : [];
      clear(recentBox, notes.length
        ? h("ul", { class: "card-list" }, notes.map((note) => h("li", {}, h("div", {}, note.content), h("small", { class: "muted" }, relativeDay(note.created_at)))))
        : h("p", { class: "muted" }, recent.status === "rejected" ? recent.reason.message : "없습니다."));
    }

    // ── Start ─────────────────────────────────────────────

    drawTabs();
    drawFilters();
    drawReader();
    await reload();
    // `#/memory/s/<session>/<message>` opens a conversation where that message was said.
    if (params[0] === "s" && params[1]) openSession(params[1], params[2] || null);
    if (params[0] === "peer" && params[1]) { state.tab = "people"; drawTabs(); drawFilters(); drawList(); openPeer(params[1]); }

    return {
      cleanup: () => document.removeEventListener("keydown", keyHandler),
      update: (next) => {
        const target = next[2] || null;
        if (next[0] === "s" && next[1] && (state.selected?.id !== next[1] || (state.selected?.target || null) !== target)) openSession(next[1], target);
      },
    };
  },
};
