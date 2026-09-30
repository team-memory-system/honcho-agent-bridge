// 묻기: ask Honcho what it knows (it reads the memories and answers), or talk to
// one of the gateway's models directly. The thread lives on this page only.
import { gateway } from "../lib/api.js";
import { h, clear } from "../lib/dom.js";
import { icon } from "../lib/icons.js";
import { markdown } from "../lib/markdown.js";
import { isAssistant, isAutomation, speakerLabel } from "../lib/format.js";
import { api, app, go, me, savePrefs } from "../lib/state.js";
import { button, errorNotice, pageHead, segmented, spinner, tag } from "../lib/ui.js";

const DEPTHS = [
  ["minimal", "빠르게"],
  ["low", "가볍게"],
  ["medium", "보통"],
  ["high", "꼼꼼히"],
  ["max", "최대한"],
];

const STARTERS = {
  memory: [
    "지난주에 내가 무슨 작업을 했는지 정리해 줘",
    "내가 요즘 가장 신경 쓰는 문제가 뭐야?",
    "최근에 정한 결정과 그 이유를 알려 줘",
  ],
  model: [
    "이 문장을 더 짧게 다듬어 줘: ",
    "다음 코드가 무슨 일을 하는지 설명해 줘:\n",
  ],
};

function seconds(ms) {
  return ms ? `${(ms / 1000).toFixed(1)}초` : "";
}

export default {
  title: "묻기",
  async mount(page, params) {
    const state = {
      mode: app.prefs.askMode || "memory",
      about: params[0] === "peer" && params[1] ? params[1] : me(),
      session: params[0] === "session" && params[1] ? params[1] : "",
      depth: app.prefs.askDepth || "medium",
      views: [],
      model: app.prefs.askModel || "",
      peers: [],
      models: [],
      turns: [],
      sending: false,
    };

    const bar = h("div", { class: "ask-bar" });
    const thread = h("div", { class: "thread" });
    const inner = h("div", { class: "thread-inner" });
    thread.append(inner);
    const input = h("textarea", { class: "input", rows: "2", placeholder: "무엇이든 물어보세요. Enter로 보내고 Shift+Enter로 줄을 바꿉니다." });
    const send = button("보내기", { kind: "primary", iconName: "send" });
    const composer = h("div", { class: "composer" }, h("div", { class: "composer-inner" }, input, send));

    page.append(
      pageHead({ title: "묻기", subtitle: "쌓인 기억을 바탕으로 답하게 하거나, 모델에게 바로 묻습니다.", actions: [button("새로 시작", { kind: "quiet", onClick: () => { state.turns = []; drawThread(); input.focus(); } })] }),
      h("div", { class: "page-body ask" }, bar, thread, composer),
    );

    const [peers, report] = await Promise.allSettled([api().post("/peers/list?page=1&size=100", {}), gateway.status()]);
    // Cron jobs and subagents are peers too, but nobody asks about them.
    state.peers = peers.status === "fulfilled" ? (peers.value.items || []).map((peer) => peer.id).filter((id) => !isAutomation(id)) : [];
    state.models = report.status === "fulfilled" ? (report.value.models?.models || []).map((model) => model.id) : [];
    state.gatewayError = report.status === "rejected" ? report.reason : null;
    if (!state.model || !state.models.includes(state.model)) state.model = state.models[0] || "";
    if (!state.about && state.peers.length) state.about = state.peers.find((peer) => !isAssistant(peer)) || state.peers[0];

    function select(options, value, onChange, label) {
      const control = h("select", { class: "select", "aria-label": label },
        options.map(([key, text]) => h("option", { value: key, selected: key === value ? true : null }, text)));
      control.addEventListener("change", () => onChange(control.value));
      return control;
    }

    function drawBar() {
      const nodes = [segmented([["memory", "내 기억에 묻기"], ["model", "모델에게 바로 묻기"]], state.mode, (mode) => {
        state.mode = mode; savePrefs({ askMode: mode }); drawBar(); drawThread();
      })];
      if (state.mode === "memory") {
        const peerOptions = state.peers.map((peer) => [peer, peer === me() ? `나 (${peer})` : speakerLabel(peer, me())]);
        nodes.push(
          h("label", { class: "field" }, h("span", {}, "누구에 대해"), select(peerOptions, state.about, (value) => { state.about = value; state.views = state.views.filter((view) => view !== value); drawBar(); }, "누구에 대해")),
          h("label", { class: "field" }, h("span", {}, "깊이"), select(DEPTHS, state.depth, (value) => { state.depth = value; savePrefs({ askDepth: value }); }, "깊이")),
        );
        const others = state.peers.filter((peer) => peer !== state.about);
        if (others.length) {
          const chooser = h("details", { class: "views-picker" },
            h("summary", { class: "btn small" }, state.views.length ? `관점 ${state.views.length}개 합치기` : "여러 관점 합치기"),
            h("div", { class: "pop" },
              h("p", { class: "muted", style: { margin: "0 0 8px", fontSize: "12.5px" } }, "고른 사람·에이전트가 각자 아는 것을 모아 하나의 답으로 합칩니다."),
              others.map((peer) => {
                const box = h("input", { type: "checkbox", checked: state.views.includes(peer) ? true : null });
                box.addEventListener("change", () => {
                  state.views = box.checked ? [...state.views, peer] : state.views.filter((item) => item !== peer);
                  chooser.querySelector("summary").textContent = state.views.length ? `관점 ${state.views.length}개 합치기` : "여러 관점 합치기";
                });
                return h("label", {}, box, speakerLabel(peer, me()));
              }),
            ),
          );
          nodes.push(chooser);
        }
        if (state.session) {
          nodes.push(h("span", { class: "tag accent" }, "이 대화 안에서만", h("button", { class: "btn quiet small icon-only", type: "button", title: "범위 풀기", style: { height: "18px", width: "18px" }, onclick: () => { state.session = ""; drawBar(); } }, icon("close"))));
        }
      } else {
        nodes.push(state.models.length
          ? h("label", { class: "field" }, h("span", {}, "모델"), select(state.models.map((model) => [model, model]), state.model, (value) => { state.model = value; savePrefs({ askModel: value }); }, "모델"))
          : h("span", { class: "muted" }, state.gatewayError ? "구독 게이트웨이가 꺼져 있어 모델을 쓸 수 없습니다." : "쓸 수 있는 모델이 없습니다."),
        );
        if (!state.models.length) nodes.push(button("게이트웨이로", { kind: "small", onClick: () => go("models") }));
      }
      clear(bar, nodes);
    }

    function drawThread() {
      if (!state.turns.length) {
        const starters = STARTERS[state.mode];
        clear(inner, h("div", { class: "empty", style: { paddingTop: "40px" } },
          h("b", {}, state.mode === "memory" ? `${state.about === me() ? "나" : speakerLabel(state.about, me())}에 대해 Honcho가 아는 것을 물어보세요` : "모델에게 바로 물어보세요"),
          h("span", {}, state.mode === "memory"
            ? "Honcho가 모인 대화와 정리된 기억을 찾아 읽고 답합니다. 깊이를 올리면 더 오래 찾습니다."
            : "기억을 거치지 않고 구독 계정의 모델이 바로 답합니다. 이 화면을 닫으면 대화는 남지 않습니다."),
          h("div", { class: "suggestions" }, starters.map((text) => h("button", { type: "button", onclick: () => { input.value = text; input.focus(); } }, text))),
        ));
        return;
      }
      clear(inner, state.turns.map((turn) => h("div", { class: "turn" },
        h("div", { class: "q" }, turn.question),
        turn.pending ? h("div", { class: "muted", style: { display: "flex", gap: "8px", alignItems: "center" } }, spinner(), turn.pendingText || "찾아 읽는 중…")
          : turn.error ? errorNotice(turn.error)
            : markdown(turn.answer || "빈 답이 왔습니다."),
        turn.views?.length ? h("details", {}, h("summary", {}, `관점 ${turn.views.length}개 보기`),
          turn.views.map((view) => h("div", { class: "perspective" }, h("b", {}, speakerLabel(view.peer, me())), view.error ? h("p", { class: "muted" }, view.error) : markdown(view.answer)))) : null,
        turn.pending ? null : h("div", { class: "a-meta" }, turn.label ? tag(turn.label) : null, turn.elapsed ? h("span", {}, seconds(turn.elapsed)) : null),
      )));
      thread.scrollTop = thread.scrollHeight;
    }

    async function askMemory(turn) {
      const body = { query: turn.question, reasoning_level: state.depth, stream: false };
      if (state.session) body.session_id = state.session;
      const started = Date.now();
      if (!state.views.length) {
        const result = await api().post(`/peers/${encodeURIComponent(state.about)}/chat`, body);
        turn.answer = result.content;
      } else {
        turn.pendingText = `관점 ${state.views.length}개에서 찾는 중…`;
        drawThread();
        const results = await Promise.allSettled(state.views.map((peer) => api().post(`/peers/${encodeURIComponent(peer)}/chat`, { ...body, target: state.about })));
        turn.views = results.map((result, index) => ({ peer: state.views[index], answer: result.value?.content || "", error: result.status === "rejected" ? result.reason.message : "" }));
        const usable = turn.views.filter((view) => view.answer);
        if (!usable.length) throw new Error("모든 관점에서 답을 받지 못했습니다.");
        turn.pendingText = "하나의 답으로 합치는 중…";
        drawThread();
        const budget = Math.max(200, Math.floor(8000 / usable.length));
        const evidence = usable.map((view) => `[${view.peer}의 관점]\n${view.answer.slice(0, budget)}`).join("\n\n");
        const synthesis = `원래 질문: ${turn.question}\n\n아래는 여러 사람·에이전트가 ${state.about}에 대해 답한 내용이다. 겹치는 것은 합치고 다른 것은 구분해 하나의 직접적인 한국어 답으로 정리하라. 근거가 서로 다르면 그 점을 짧게 밝혀라.\n\n${evidence}`.slice(0, 9800);
        const result = await api().post(`/peers/${encodeURIComponent(state.about)}/chat`, { query: synthesis, reasoning_level: state.depth, stream: false });
        turn.answer = result.content;
      }
      turn.elapsed = Date.now() - started;
      turn.label = `${state.about === me() ? "나" : speakerLabel(state.about, me())}에 대한 기억 · ${DEPTHS.find(([key]) => key === state.depth)?.[1]}`;
    }

    async function askModel(turn) {
      if (!state.model) throw new Error("먼저 모델을 고르세요.");
      // The gateway's test call is one message long; earlier turns ride along in it.
      const history = state.turns.filter((item) => item !== turn && item.mode === "model" && item.answer)
        .slice(-6)
        .map((item) => `사용자: ${item.question}\n모델: ${item.answer}`)
        .join("\n\n");
      const prompt = history ? `${history}\n\n사용자: ${turn.question}` : turn.question;
      const result = await gateway.post("/chat", { model: state.model, prompt });
      if (!result.ok) throw new Error(result.error || "모델이 답하지 않았습니다.");
      turn.answer = result.reply;
      turn.elapsed = result.elapsedMs;
      turn.label = result.model || state.model;
    }

    async function submit() {
      const question = input.value.trim();
      if (!question || state.sending) return;
      if (state.mode === "memory" && !state.about) return;
      const turn = { question, mode: state.mode, pending: true };
      state.turns.push(turn);
      input.value = "";
      state.sending = true;
      send.disabled = true;
      drawThread();
      try {
        if (state.mode === "memory") await askMemory(turn); else await askModel(turn);
      } catch (error) {
        turn.error = error;
      } finally {
        turn.pending = false;
        state.sending = false;
        send.disabled = false;
        drawThread();
        input.focus();
      }
    }

    send.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });

    drawBar();
    drawThread();
    input.focus();
  },
};
