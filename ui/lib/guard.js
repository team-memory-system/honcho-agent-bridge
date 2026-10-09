// The Jev guard in the owner's words: what the bridge's reasons mean, how a
// verdict is labelled, and what a trial (가드 시험) comes to for the teammate. No
// DOM here, so the tests can load it.

/**
 * One of the bridge's reasons for a verdict, in a few words. `allowed` is how the
 * question or answer went: when Jev does not answer, the server's fail mode lets it
 * through or stops it. With `cause`, only why, for beside a tag that already says
 * what happened. A reason the screen does not know stays as it came.
 */
export function reasonText(reason, allowed, { cause = false } = {}) {
  const text = String(reason || "").trim();
  const said = (whole, why) => (cause ? why : whole);
  if (text === "out of scope") return "사적인 질문으로 판정";
  if (text.startsWith("That project is not open")) return "열지 않은 프로젝트";
  if (text === "query too long to judge") return said("너무 길어 판정하지 않고 거부", "너무 길어 판정하지 않음");
  if (text.startsWith("answer withheld")) return said("답에 민감한 내용이 있어 막음", "민감한 내용이 든 답으로 판정");
  if (text === "answer too long to judge") return said("답이 너무 길어 판정하지 않고 막음", "너무 길어 판정하지 않음");
  if (text.startsWith("answer not judged")) return said("답 판정 없이 통과 · 허브가 답 검사를 하지 않음", "허브가 답 검사를 하지 않음");
  if (text.startsWith("not judged")) return said("판정 없이 통과 · 팀에 Jev 키 없음", "팀에 Jev 키 없음");
  if (text.startsWith("jev unavailable for the answer")) {
    return said(allowed ? "답 판정 없이 통과 · Jev가 답하지 않음" : "Jev가 답을 판정하지 못해 막음", "Jev가 답하지 않음");
  }
  if (text.startsWith("jev unavailable")) return said(allowed ? "판정 없이 통과 · Jev가 답하지 않음" : "Jev가 답하지 않아 거부", "Jev가 답하지 않음");
  return text;
}

/**
 * Why a call in the audit log was refused, failed or went through without a
 * judgment, in a few words; null for a plain pass. A call let through can carry a
 * reason for its question and another for its answer, joined by "; ".
 */
export function callReason(row) {
  const error = String(row?.error || "").split("\n")[0].trim();
  if (!error) return null;
  if (row.status === "error") return error;
  const allowed = row.status !== "denied";
  return [...new Set(error.split("; ").map((part) => reasonText(part, allowed)))].join(" · ");
}

export const scoreText = (value) => Number(value).toFixed(2);

/** A call's scores as its row shows them: the question's, then the answer's. */
export function callScores(row) {
  return [
    row?.jev_score != null ? `Jev ${scoreText(row.jev_score)}` : "",
    row?.answer_score != null ? `답 ${scoreText(row.answer_score)}` : "",
  ].filter(Boolean).join(" · ");
}

/**
 * One step of a trial as a tag, [text, kind], or null for a step not taken. `part`
 * is "query", which is refused (거부), or "answer", which is held back (막음).
 */
export function verdictTag(view, part, gate = true) {
  if (!gate) return ["판정 꺼짐", "warn"];
  if (!view) return null;
  if (!view.allowed) return [part === "answer" ? "막음" : "거부", "bad"];
  if (view.unjudged) return ["판정 없이 통과", "warn"];
  return ["통과", "ok"];
}

/**
 * What a trial comes to for the teammate: { kind, title, text, message }, `kind` a
 * notice's. `message` is the one sentence a teammate gets in place of a refused
 * question or a withheld answer.
 */
export function trialOutcome(trial) {
  const off = trial?.gate === false;
  switch (trial?.outcome) {
    case "refused":
      return { kind: "bad", title: "질문에서 막힙니다.", text: "팀원은 아래 문구만 받습니다.", message: trial.message };
    case "withheld":
      return {
        kind: "bad",
        title: "답에서 막힙니다.",
        text: "팀원은 질문이 거부될 때와 같은 문구만 받아, 막힌 답이 있었는지도 알 수 없습니다.",
        message: trial.message,
      };
    case "no_answer":
      return { kind: "warn", title: "기억 서버가 답을 만들지 못했습니다.", text: "그 프로젝트에 아직 기억이 없거나, 기억 서버가 답하지 못했습니다." };
    case "passed":
      if (trial.answer == null) {
        return { kind: off ? "warn" : "ok", title: "질문은 통과합니다.", text: off ? "이 서버는 Jev 판정이 꺼져 있어 판정 없이 통과합니다." : "답은 만들지 않아 답 검사는 하지 않았습니다." };
      }
      if (off) return { kind: "warn", title: "팀원에게 이 답이 그대로 나갑니다.", text: "이 서버는 Jev 판정이 꺼져 있어 질문과 답 모두 판정 없이 오갑니다." };
      if (trial.answer_check?.unjudged) return { kind: "warn", title: "팀원에게 이 답이 그대로 나갑니다.", text: "답은 판정 없이 나갑니다." };
      return { kind: "ok", title: "팀원에게 이 답이 그대로 나갑니다.", text: "" };
    default:
      return { kind: "warn", title: "알 수 없는 결과입니다.", text: String(trial?.outcome ?? "") };
  }
}
