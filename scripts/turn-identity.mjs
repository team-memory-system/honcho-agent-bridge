import crypto from "node:crypto";

// Which transcript turn a Honcho message came from. These hashes hold no message
// text (except the legacy one), so a change in how text is cleaned never makes an
// already-sent turn look new.

export function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function legacyTurnHash(sessionId, turn) {
  const identity = {
    session_id: sessionId,
    source_message_id: turn.source_message_id || null,
    line_index: turn.source_message_id ? null : turn.line_index,
    step_index: turn.source_message_id ? null : turn.step_index,
    role: turn.role,
    content: turn.content,
  };
  return digest(identity);
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SEGMENT_FILE = new RegExp(`^rollout-.+-(${UUID})_(${UUID})\\.jsonl$`, "i");

/**
 * Codex can write one thread across several files: rollout-<ts>-<A>.jsonl, then
 * continuation segments rollout-<ts>-<A>_<B>.jsonl (session_meta history_mode
 * "paginated"). Every file carries session id A and numbers its lines from 1.
 * Returns B when `transcriptPath` is such a segment of thread `originalSessionId`
 * (when given), otherwise null. Accepts paths written on Windows too.
 */
export function codexSegmentId(transcriptPath, originalSessionId = null) {
  const name = String(transcriptPath || "").split(/[\\/]/).pop();
  const match = name.match(SEGMENT_FILE);
  if (!match) return null;
  if (originalSessionId != null && match[1].toLowerCase() !== String(originalSessionId).toLowerCase()) return null;
  return match[2].toLowerCase();
}

function segmentTurnHash(sessionId, segmentId, turn) {
  return digest({
    version: 2,
    session_id: sessionId,
    segment_id: segmentId,
    line_index: turn.line_index ?? null,
    step_index: turn.step_index ?? null,
    role: turn.role,
  });
}

/**
 * Every hash that may already mark `turn` as sent; the first is the one a new
 * message records. A turn of a continuation segment (turn.segment_id) is told
 * apart by its segment: its bare line hash is not a candidate, because another
 * file of the same thread has the same line numbers.
 */
export function turnHashCandidates(sessionId, turn) {
  const candidates = [];
  if (turn.source_message_id) {
    candidates.push(digest({ version: 2, session_id: sessionId, source_message_id: turn.source_message_id, role: turn.role }));
  }
  if (turn.segment_id) {
    candidates.push(segmentTurnHash(sessionId, turn.segment_id, turn));
  } else if (turn.line_index != null || turn.step_index != null) {
    candidates.push(
      digest({
        version: 2,
        session_id: sessionId,
        line_index: turn.line_index ?? null,
        step_index: turn.step_index ?? null,
        role: turn.role,
      }),
    );
  }
  if (candidates.length === 0) {
    candidates.push(digest({ version: 2, session_id: sessionId, role: turn.role, content: turn.content }));
  }
  candidates.push(legacyTurnHash(sessionId, turn));
  return [...new Set(candidates)];
}

/**
 * The segment hashes of the turns Honcho already holds from segment `segmentId`.
 * Collectors before the segment identity stored those turns under the bare line
 * hash, which cannot tell the segment from the other files of its thread; each
 * stored message's codex_rollout_path can. A message without a rollout path is
 * counted as this segment's, so a turn is at worst left out, never sent twice.
 */
export function segmentHashesFromStoredMessages(sessionId, segmentId, messages) {
  const hashes = new Set();
  for (const message of messages || []) {
    const metadata = message?.metadata || {};
    const lineIndex = metadata.codex_line_index;
    const role = metadata.codex_role;
    if (lineIndex == null || !role) continue;
    const storedPath = metadata.codex_rollout_path;
    if (storedPath && codexSegmentId(storedPath) !== segmentId) continue;
    hashes.add(segmentTurnHash(sessionId, segmentId, { line_index: lineIndex, step_index: metadata.codex_step_index, role }));
  }
  return [...hashes];
}
