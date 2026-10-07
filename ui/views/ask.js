// 묻기: ask Honcho what it knows (it reads the memories and answers), or talk to
// one of the gateway's models directly. The thread lives on this page only.
//
// The composer follows the shape of OpenClaw's chat composer (MIT): one rounded
// surface holding a lede row for the question's scope, an editor that grows with
// the draft, and a footer whose chips describe the next turn, ending in send.
import { gateway, post } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { screenTabs } from "../lib/tabs.js";
import { icon } from "../lib/icons.js";
import { markdown } from "../lib/markdown.js";
import { LEVEL_NOTES, REASONING_HINT, REASONING_LEVELS, askCopy, askRoute, mergeEvidence, oneLine, pickMessages, sessionCount, sessionTitle } from "../lib/ask.js";
import { isAssistant, isAutomation, relativeDay, speakerLabel } from "../lib/format.js";
import { api, app, go, me, savePrefs } from "../lib/state.js";
import { button, errorNotice, pageHead, segmented, spinner, srcBadge, tag } from "../lib/ui.js";

const SNIPPETS = 6;
const CONCLUSIONS_SHOWN = 5;

function seconds(ms) {
  return ms ? `${(ms / 1000).toFixed(1)}초` : "";
}

function memoryLink(sessionId, messageId) {
  return `#/memory/s/${encodeURIComponent(sessionId)}${messageId ? `/${encodeURIComponent(messageId)}` : ""}`;
}

export default {
  title: "묻기",
  async mount(page, params) {
    const route = askRoute(params);
    const state = {
      mode: route.mode || app.prefs.askMode || "memory",
      about: route.about || me(),
      session: route.session || "",
      sessionTitle: "",
      depth: REASONING_LEVELS.includes(app.prefs.askDepth) ? app.prefs.askDepth : "medium",
      views: [],
      model: route.model || app.prefs.askModel || "",
      wantedModel: route.model || "",
      peers: [],
      models: [],
      turns: [],
      loaded: false,
      sending: false,
    };
    let controller = null;

    const inner = h("div", { class: "thread-inner" });
    const thread = h("div", { class: "thread" }, inner);
    const lede = h("div", { class: "composer-lede" });
    const input = h("textarea", { class: "composer-text", rows: "1", "aria-label": "질문", enterkeyhint: "send", "aria-keyshortcuts": "Enter" });
    const lead = h("div", { class: "composer-lead" });
    const send = h("button", { class: "composer-send", type: "button" });
    const box = h("div", { class: "composer-box" },
      lede,
      h("div", { class: "composer-input" }, input),
      h("div", { class: "composer-foot" }, lead, h("div", { class: "composer-trail" }, send)),
    );
    const composer = h("div", { class: "composer" }, box);
    const body = h("div", { class: "page-body ask" }, thread, composer);

    const modeSwitch = segmented([["memory", "내 기억에 묻기"], ["model", "모델에게 바로 묻기"]], state.mode, (mode) => {
      state.mode = mode;
      savePrefs({ askMode: mode });
      if (/^#\/ask\/model\//.test(location.hash)) history.replaceState(null, "", "#/ask");
      drawComposer();
      drawThread();
      input.focus();
    });
    page.append(
      pageHead({ title: "기억", subtitle: "쌓인 기억을 바탕으로 답하게 하거나, 모델에게 바로 묻습니다.", subnav: screenTabs("ask"), actions: [
        modeSwitch,
        button("새로 시작", { kind: "quiet", onClick: () => { controller?.abort(); state.turns = []; drawThread(); input.focus(); } }),
      ] }),
      body,
    );

    // The thread scrolls under the floating composer, so it keeps room for it.
    const resize = new ResizeObserver(() => {
      const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
      body.style.setProperty("--composer-h", `${composer.offsetHeight}px`);
      if (nearBottom) thread.scrollTop = thread.scrollHeight;
    });
    resize.observe(composer);

    // ── Loading ───────────────────────────────────────────

    clear(inner, h("div", { class: "ask-empty" }, spinner()));
    drawComposer();

    const [peers, report, opening] = await Promise.allSettled([
      api().post("/peers/list?page=1&size=100", {}),
      gateway.status(),
      state.session ? api().post(`/sessions/${encodeURIComponent(state.session)}/messages/list?page=1&size=6`, {}) : Promise.resolve(null),
    ]);
    // Cron jobs and subagents are peers too, but nobody asks about them.
    state.peers = peers.status === "fulfilled" ? (peers.value.items || []).map((peer) => peer.id).filter((id) => !isAutomation(id)) : [];
    state.models = report.status === "fulfilled" ? (report.value.models?.models || []).map((model) => model.id) : [];
    state.gatewayError = report.status === "rejected" ? report.reason : null;
    state.sessionTitle = opening.status === "fulfilled" && opening.value ? sessionTitle(opening.value.items || []) : "";
    if (!state.model || !state.models.includes(state.model)) state.model = state.models[0] || "";
    if (!state.about && state.peers.length) state.about = state.peers.find((peer) => !isAssistant(peer)) || state.peers[0];
    state.loaded = true;

    // ── The composer ──────────────────────────────────────

    function copy() {
      return askCopy({ mode: state.mode, about: state.about, me: me(), session: state.session, model: state.model });
    }

    function aboutLabel(peer = state.about) {
      return peer === me() ? "나" : speakerLabel(peer, me());
    }

    /** A footer chip: what it shows is text; a native select over it does the choosing. */
    function selectChip({ iconName, term, label, title, value, options, onChange }) {
      const control = h("select", { class: "cchip-select", "aria-label": label, title },
        options.map(([key, text]) => h("option", { value: key, selected: key === value ? true : null }, text)));
      control.addEventListener("change", () => onChange(control.value));
      const shown = options.find(([key]) => key === value);
      return h("span", { class: "cchip", title },
        iconName ? icon(iconName) : null,
        term ? h("span", { class: "cchip-k" }, term) : null,
        h("span", { class: "cchip-v" }, shown ? shown[2] || shown[1] : value || "—"),
        icon("chevron", "icon chev"),
        control,
      );
    }

    function viewsChip() {
      const others = state.peers.filter((peer) => peer !== state.about);
      if (!others.length) return null;
      const label = () => (state.views.length ? `관점 ${state.views.length}개 합치기` : "관점 합치기");
      const text = h("span", { class: "cchip-v" }, label());
      const chooser = h("details", { class: "views-picker" },
        h("summary", { class: "cchip", title: "여러 사람·에이전트의 관점을 모아 하나의 답으로 합칩니다" }, icon("layers"), text, icon("chevron", "icon chev")),
        h("div", { class: "pop" },
          h("p", { class: "muted", style: { margin: "0 0 8px", fontSize: "12.5px" } }, "고른 사람·에이전트가 각자 아는 것을 모아 하나의 답으로 합칩니다."),
          others.map((peer) => {
            const check = h("input", { type: "checkbox", checked: state.views.includes(peer) ? true : null });
            check.addEventListener("change", () => {
              state.views = check.checked ? [...state.views, peer] : state.views.filter((item) => item !== peer);
              text.textContent = label();
              chooser.querySelector("summary").classList.toggle("on", state.views.length > 0);
            });
            return h("label", {}, check, speakerLabel(peer, me()));
          }),
        ),
      );
      chooser.querySelector("summary").classList.toggle("on", state.views.length > 0);
      return chooser;
    }

    function scopeCard() {
      const title = state.sessionTitle || (state.session.length > 32 ? `${state.session.slice(0, 30)}…` : state.session);
      return h("div", { class: "scope-card" },
        icon("memory"),
        h("div", { class: "scope-text" },
          h("b", {}, "이 대화 안에서만:"),
          h("a", { href: memoryLink(state.session), title: "기억 화면에서 이 대화 열기" }, title),
        ),
        h("button", { class: "scope-x", type: "button", title: "범위 풀기", "aria-label": "범위 풀기", onclick: () => {
          state.session = "";
          history.replaceState(null, "", "#/ask");
          drawComposer();
          drawThread();
          input.focus();
        } }, icon("close")),
      );
    }

    function drawComposer() {
      const ledeNodes = [];
      const chips = [];
      if (!state.loaded) {
        // Nothing to choose until the peers and models are in.
      } else if (state.mode === "memory") {
        if (state.session) ledeNodes.push(scopeCard());
        const peerOptions = state.peers.map((peer) => [peer, peer === me() ? `나 (${peer})` : speakerLabel(peer, me()), aboutLabel(peer)]);
        if (peerOptions.length) {
          chips.push(selectChip({ iconName: "person", label: "누구에 대해", title: "누구에 대해", value: state.about, options: peerOptions, onChange: (value) => {
            state.about = value;
            state.views = state.views.filter((view) => view !== value);
            drawComposer();
            drawThread();
          } }));
        }
        chips.push(selectChip({ iconName: "gauge", term: "reasoning_level", label: "reasoning_level", title: `reasoning_level: ${REASONING_HINT}`, value: state.depth,
          options: REASONING_LEVELS.map((level) => [level, level]),
          onChange: (value) => { state.depth = value; savePrefs({ askDepth: value }); drawComposer(); } }));
        chips.push(viewsChip());
        if (!state.peers.length) ledeNodes.push(h("div", { class: "composer-note" }, icon("warn"), "기억 서버에서 사람·에이전트 목록을 받지 못했습니다."));
      } else if (state.models.length) {
        if (state.wantedModel && !state.models.includes(state.wantedModel)) {
          ledeNodes.push(h("div", { class: "composer-note" }, icon("warn"), h("span", {}, "게이트웨이에 ", h("code", {}, state.wantedModel), " 모델이 없어 다른 모델을 골랐습니다.")));
        }
        chips.push(selectChip({ iconName: "models", label: "모델", title: "모델", value: state.model, options: state.models.map((model) => [model, model]), onChange: (value) => {
          state.model = value;
          state.wantedModel = "";
          savePrefs({ askModel: value });
          drawComposer();
          drawThread();
        } }));
      } else {
        ledeNodes.push(h("div", { class: "composer-note" },
          icon("warn"),
          h("span", {}, state.gatewayError ? "구독 게이트웨이가 꺼져 있어 모델을 쓸 수 없습니다." : "쓸 수 있는 모델이 없습니다."),
          button("구독 게이트웨이로", { kind: "small", onClick: () => go("models") })));
      }
      clear(lede, ledeNodes);
      clear(lead, chips);
      input.placeholder = state.loaded ? copy().placeholder : "불러오는 중…";
      updateSend();
    }

    function ready() {
      if (!state.loaded) return false;
      return state.mode === "memory" ? Boolean(state.about) : Boolean(state.model);
    }

    function updateSend() {
      send.classList.toggle("sending", state.sending);
      send.disabled = !state.sending && (!input.value.trim() || !ready());
      const label = state.sending ? "기다리지 않고 멈추기" : "보내기 (Enter) · 줄 바꿈은 Shift+Enter";
      send.title = label;
      send.setAttribute("aria-label", state.sending ? "멈추기" : "보내기");
      clear(send, icon(state.sending ? "stop" : "up"));
    }

    function fit() {
      input.style.height = "auto";
      input.style.height = `${input.scrollHeight}px`;
    }

    // ── The thread ────────────────────────────────────────

    function drawEmpty() {
      const words = copy();
      clear(inner, h("div", { class: "ask-empty" },
        h("b", {}, words.title),
        h("span", {}, words.text),
        h("div", { class: "suggestions" }, words.starters.map((text) => h("button", { type: "button", onclick: () => {
          input.value = text;
          fit();
          updateSend();
          input.focus();
          input.setSelectionRange(text.length, text.length);
        } }, text))),
      ));
    }

    function drawThread() {
      if (!state.loaded) return;
      if (!state.turns.length) {
        drawEmpty();
        return;
      }
      // A finished turn keeps its node, so an opened evidence list stays open.
      clear(inner, state.turns.map((turn) => {
        if (turn.pending || !turn.node) turn.node = renderTurn(turn);
        return turn.node;
      }));
      thread.scrollTop = thread.scrollHeight;
    }

    function renderTurn(turn) {
      const meta = [];
      if (!turn.pending && !turn.error && !turn.stopped) {
        if (turn.label) meta.push(tag(turn.label));
        if (turn.depth) meta.push(h("span", { class: "tag level-tag", title: `reasoning_level: ${REASONING_HINT}` }, `reasoning_level ${turn.depth}`));
        if (turn.scoped) meta.push(tag("이 대화 안에서만", "accent"));
        if (turn.elapsed) meta.push(h("span", {}, seconds(turn.elapsed)));
      }
      return h("div", { class: "turn" },
        h("div", { class: "q" }, turn.question),
        h("div", { class: "a" },
          turn.pending ? h("div", { class: "a-pending" }, spinner(), turn.pendingText || (turn.mode === "memory" ? "찾아 읽는 중…" : "답을 기다리는 중…"))
            : turn.error ? errorNotice(turn.error)
              : turn.stopped ? h("p", { class: "muted", style: { margin: 0 } }, "답을 기다리지 않고 멈췄습니다.")
                : markdown(turn.answer || "빈 답이 왔습니다."),
          turn.views?.length ? h("details", { class: "perspectives" }, h("summary", {}, `관점 ${turn.views.length}개 보기`),
            turn.views.map((view) => h("div", { class: "perspective" }, h("b", {}, speakerLabel(view.peer, me())), view.error ? h("p", { class: "muted" }, view.error) : markdown(view.answer)))) : null,
          !turn.pending && !turn.error && !turn.stopped ? evidenceBlock(turn) : null,
          meta.length ? h("div", { class: "a-meta" }, meta) : null,
        ),
      );
    }

    // ── What an answer was built from ─────────────────────

    function evidenceBlock(turn) {
      const evidence = turn.evidence;
      if (!evidence) return null;
      const { conclusions, messages } = evidence;
      if (!conclusions.length && !messages.length) {
        return h("div", { class: "evidence-none" }, "답하면서 읽은 기억이 없습니다.");
      }
      const parts = [
        conclusions.length ? `정리된 기억 ${conclusions.length}개` : null,
        messages.length ? `대화 ${sessionCount(messages)}곳의 메시지 ${messages.length}개` : null,
      ].filter(Boolean).join(" · ");
      const content = h("div", { class: "evidence-body" });
      const details = h("details", { class: "evidence" },
        h("summary", {}, icon("memory"), h("b", {}, "답하면서 읽은 기억"), h("span", { class: "evidence-count" }, parts), icon("chevron", "icon chev")),
        content,
      );
      details.addEventListener("toggle", () => { if (details.open) fillEvidence(evidence, content); });
      return details;
    }

    function fillEvidence(evidence, content) {
      if (content.dataset.filled) return;
      content.dataset.filled = "1";
      const nodes = [h("p", { class: "evidence-note" }, "Honcho가 답을 찾으며 읽은 것입니다. 모두가 답에 쓰인 것은 아닙니다.")];

      if (evidence.conclusions.length) {
        const list = h("ul", { class: "evidence-list" });
        const drawConclusions = (all) => {
          const shown = all ? evidence.conclusions : evidence.conclusions.slice(0, CONCLUSIONS_SHOWN);
          clear(list, shown.map((note) => h("li", {},
            h("span", { class: `lvl ${note.level || ""}`, title: LEVEL_NOTES[note.level] || "" }, note.level || "?"),
            h("span", { class: "evidence-text", title: note.content }, oneLine(note.content, 200)),
            note.session_id ? h("a", { class: "evidence-go", href: memoryLink(note.session_id), title: "이 기억이 나온 대화 열기" }, "대화") : null,
          )));
          const rest = evidence.conclusions.length - shown.length;
          if (rest > 0) list.append(h("li", { class: "evidence-more" }, button(`${rest}개 더 보기`, { kind: "small quiet", onClick: () => drawConclusions(true) })));
        };
        drawConclusions(false);
        nodes.push(h("div", { class: "evidence-h" }, `정리된 기억 ${evidence.conclusions.length}개`), list);
      }

      if (evidence.messages.length) {
        const picked = pickMessages(evidence.messages, SNIPPETS);
        const list = h("ul", { class: "evidence-list" }, picked.map((message) => {
          const snippet = h("span", { class: "em-text muted" }, "불러오는 중…");
          api().get(`/sessions/${encodeURIComponent(message.session_id)}/messages/${encodeURIComponent(message.id)}`)
            .then((full) => {
              snippet.textContent = oneLine(full?.content, 220) || "내용이 비어 있습니다.";
              snippet.classList.remove("muted");
            })
            .catch(() => { snippet.textContent = "내용을 불러오지 못했습니다."; });
          const source = message.session_id.split("-")[0];
          return h("li", {}, h("a", { class: "em", href: memoryLink(message.session_id, message.id), title: "기억 화면에서 이 메시지 열기" },
            h("span", { class: "em-head" }, srcBadge(source), h("b", {}, speakerLabel(message.peer_id, me())), h("span", {}, relativeDay(message.created_at))),
            snippet,
          ));
        }));
        const rest = evidence.messages.length - picked.length;
        nodes.push(
          h("div", { class: "evidence-h" }, `대화 ${sessionCount(evidence.messages)}곳에서 읽은 메시지 ${evidence.messages.length}개`),
          list,
          rest > 0 ? h("p", { class: "evidence-note" }, `대화마다 몇 개씩 골라 보여 줍니다. 나머지 ${rest}개는 각 대화에서 볼 수 있습니다.`) : null,
        );
      }
      clear(content, nodes);
    }

    // ── Asking ────────────────────────────────────────────

    async function askMemory(turn, signal) {
      // The chips may change while Honcho reads; the turn keeps what it was asked with.
      const { about, depth, session } = state;
      const views = [...state.views];
      const body = { query: turn.question, reasoning_level: depth, stream: false, include_evidence: true };
      if (session) body.session_id = session;
      const started = Date.now();
      const chat = (peer, payload) => api().post(`/peers/${encodeURIComponent(peer)}/chat`, payload, { signal });
      if (!views.length) {
        const result = await chat(about, body);
        turn.answer = result.content;
        turn.evidence = mergeEvidence([result.evidence]);
      } else {
        turn.pendingText = `관점 ${views.length}개에서 찾는 중…`;
        drawThread();
        const results = await Promise.allSettled(views.map((peer) => chat(peer, { ...body, target: about })));
        if (signal.aborted) throw new DOMException("멈춤", "AbortError");
        turn.views = results.map((result, index) => ({ peer: views[index], answer: result.value?.content || "", evidence: result.value?.evidence, error: result.status === "rejected" ? result.reason.message : "" }));
        const usable = turn.views.filter((view) => view.answer);
        if (!usable.length) throw new Error("모든 관점에서 답을 받지 못했습니다.");
        turn.pendingText = "하나의 답으로 합치는 중…";
        drawThread();
        const budget = Math.max(200, Math.floor(8000 / usable.length));
        const evidence = usable.map((view) => `[${view.peer}의 관점]\n${view.answer.slice(0, budget)}`).join("\n\n");
        const synthesis = `원래 질문: ${turn.question}\n\n아래는 여러 사람·에이전트가 ${about}에 대해 답한 내용이다. 겹치는 것은 합치고 다른 것은 구분해 하나의 직접적인 한국어 답으로 정리하라. 근거가 서로 다르면 그 점을 짧게 밝혀라.\n\n${evidence}`.slice(0, 9800);
        const result = await chat(about, { query: synthesis, reasoning_level: depth, stream: false, include_evidence: true });
        turn.answer = result.content;
        turn.evidence = mergeEvidence([...turn.views.map((view) => view.evidence), result.evidence]);
      }
      turn.elapsed = Date.now() - started;
      turn.label = `${aboutLabel(about)}에 대한 기억`;
      turn.depth = depth;
      turn.scoped = Boolean(session);
    }

    async function askModel(turn, signal) {
      const { model } = state;
      if (!model) throw new Error("먼저 모델을 고르세요.");
      // The gateway's test call is one message long; earlier turns ride along in it.
      const history = state.turns.filter((item) => item !== turn && item.mode === "model" && item.answer)
        .slice(-6)
        .map((item) => `사용자: ${item.question}\n모델: ${item.answer}`)
        .join("\n\n");
      const prompt = history ? `${history}\n\n사용자: ${turn.question}` : turn.question;
      const result = await post("/api/gw/api/chat", { model, prompt }, { signal });
      if (!result.ok) throw new Error(result.error || "모델이 답하지 않았습니다.");
      turn.answer = result.reply;
      turn.elapsed = result.elapsedMs;
      turn.label = result.model || model;
    }

    async function submit() {
      const question = input.value.trim();
      if (!question || state.sending || !ready()) return;
      const turn = { question, mode: state.mode, pending: true };
      state.turns.push(turn);
      input.value = "";
      fit();
      state.sending = true;
      composer.querySelector(".views-picker[open]")?.removeAttribute("open");
      controller = new AbortController();
      updateSend();
      drawThread();
      try {
        if (state.mode === "memory") await askMemory(turn, controller.signal); else await askModel(turn, controller.signal);
      } catch (error) {
        if (error?.name === "AbortError") turn.stopped = true; else turn.error = error;
      } finally {
        turn.pending = false;
        turn.node = null;
        state.sending = false;
        controller = null;
        updateSend();
        if (inner.isConnected) {
          drawThread();
          input.focus();
        }
      }
    }

    send.addEventListener("click", () => {
      if (state.sending) controller?.abort();
      else submit();
    });
    input.addEventListener("input", () => { fit(); updateSend(); });
    // Enter sends and Shift+Enter starts a new line. While a Korean syllable is
    // still being composed, Enter belongs to the IME; Safari reports that only
    // through keyCode 229, after compositionend has already fired.
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      submit();
    });
    // The views picker is a popover; a click elsewhere puts it away.
    const closePicker = (event) => {
      const open = composer.querySelector(".views-picker[open]");
      if (open && !open.contains(event.target)) open.open = false;
    };
    document.addEventListener("pointerdown", closePicker);
    // A click anywhere on the surface that is not a control goes to the editor.
    box.addEventListener("click", (event) => {
      if (event.target.matches(".composer-box, .composer-input, .composer-foot, .composer-lead, .composer-trail")) input.focus();
    });

    drawComposer();
    drawThread();
    input.focus();

    return {
      cleanup: () => {
        controller?.abort();
        resize.disconnect();
        document.removeEventListener("pointerdown", closePicker);
      },
    };
  },
};
