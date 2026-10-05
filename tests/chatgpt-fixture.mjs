// A made-up ChatGPT export in the 2026 layout, a zip writer to pack it, and a
// fake Honcho that remembers what it was sent. No real conversation text.
import http from "node:http";
import zlib from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zip64Extra(values) {
  const extra = Buffer.alloc(4 + values.length * 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(values.length * 8, 2);
  values.forEach((value, index) => extra.writeBigUInt64LE(BigInt(value), 4 + index * 8));
  return extra;
}

/** A zip of `entries` ({ name, data, method: 0 stored | 8 deflated }), optionally in ZIP64 form. */
export function makeZip(entries, { zip64 = false } = {}) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const method = entry.method ?? 8;
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const localExtra = zip64 ? zip64Extra([data.length, body.length]) : Buffer.alloc(0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(zip64 ? 45 : 20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(zip64 ? 0xffffffff : body.length, 18);
    local.writeUInt32LE(zip64 ? 0xffffffff : data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(localExtra.length, 28);
    parts.push(local, name, localExtra, body);

    const centralExtra = zip64 ? zip64Extra([data.length, body.length, offset]) : Buffer.alloc(0);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(zip64 ? 45 : 20, 4);
    record.writeUInt16LE(zip64 ? 45 : 20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    record.writeUInt32LE(zip64 ? 0xffffffff : data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(centralExtra.length, 30);
    record.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    central.push(record, name, centralExtra);
    offset += local.length + name.length + localExtra.length + body.length;
  }
  const directory = Buffer.concat(central);
  const tail = [];
  if (zip64) {
    const record = Buffer.alloc(56);
    record.writeUInt32LE(0x06064b50, 0);
    record.writeBigUInt64LE(44n, 4);
    record.writeUInt16LE(45, 12);
    record.writeUInt16LE(45, 14);
    record.writeBigUInt64LE(BigInt(entries.length), 24);
    record.writeBigUInt64LE(BigInt(entries.length), 32);
    record.writeBigUInt64LE(BigInt(directory.length), 40);
    record.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + directory.length), 8);
    locator.writeUInt32LE(1, 16);
    tail.push(record, locator);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  end.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  end.writeUInt32LE(zip64 ? 0xffffffff : directory.length, 12);
  end.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  tail.push(end);
  return Buffer.concat([...parts, directory, ...tail]);
}

const T = (iso) => Date.parse(iso) / 1000;

function node(id, parent, message) {
  return { id, parent, children: [], message };
}

function msg(id, role, createTime, content, extra = {}) {
  return { id, author: { role, name: extra.name ?? null, metadata: {} }, create_time: createTime, update_time: null, content, status: "finished_successfully", end_turn: null, weight: 1, metadata: extra.metadata ?? {}, recipient: extra.recipient ?? "all", channel: null };
}

const text = (...parts) => ({ content_type: "text", parts });

function conversation(id, title, created, updated, currentNode, nodes, extra = {}) {
  const mapping = {};
  for (const entry of nodes) mapping[entry.id] = entry;
  for (const entry of nodes) if (entry.parent && mapping[entry.parent]) mapping[entry.parent].children.push(entry.id);
  return {
    title,
    create_time: created,
    update_time: updated,
    mapping,
    moderation_results: [],
    current_node: currentNode,
    plugin_ids: null,
    conversation_id: id,
    conversation_template_id: null,
    gizmo_id: null,
    is_archived: true,
    safe_urls: [],
    default_model_slug: "gpt-4o",
    conversation_origin: null,
    is_do_not_remember: null,
    id,
    ...extra,
  };
}

const LONG_ANSWER = Array.from({ length: 800 }, (_, index) => `Line ${index + 1} of a made-up very long answer.`).join("\n");

// A: an answer regenerated once and a question edited once; a hidden context
// node, a system node, reasoning nodes, a message with no time, web citations.
function conversationA({ continued = false } = {}) {
  const base = T("2024-01-10T09:00:00Z");
  const nodes = [
    node("a-root", null, null),
    node("a-sys", "a-root", msg("a-sys", "system", null, text(""), { metadata: { is_visually_hidden_from_conversation: true } })),
    node("a-ctx", "a-sys", msg("a-ctx", "user", null, { content_type: "user_editable_context", user_profile: "made-up profile", user_instructions: "made-up instructions" }, { metadata: { is_visually_hidden_from_conversation: true } })),
    node("a-u1", "a-ctx", msg("a-u1", "user", base, text("How do I keep a sourdough starter alive?"))),
    node("a-a1", "a-u1", msg("a-a1", "assistant", base + 10, text("REGENERATED-AWAY answer"))),
    node("a-a2", "a-u1", msg("a-a2", "assistant", base + 20.25, text("Feed it flour and water every day."))),
    node("a-u2old", "a-a2", msg("a-u2old", "user", base + 30, text("EDITED-AWAY question"))),
    node("a-a3old", "a-u2old", msg("a-a3old", "assistant", base + 31, text("Answer to the EDITED-AWAY question"))),
    node("a-u2", "a-a2", msg("a-u2", "user", null, text("Which flour works best?"))),
    node("a-th", "a-u2", msg("a-th", "assistant", base + 41, { content_type: "thoughts", thoughts: [{ summary: "made-up", content: "made-up thinking" }] }, { metadata: { is_visually_hidden_from_conversation: false } })),
    node("a-rr", "a-th", msg("a-rr", "assistant", base + 42, { content_type: "reasoning_recap", content: "Thought for 3 seconds" })),
    node("a-a4", "a-rr", msg("a-a4", "assistant", base + 43, text(
      "Use whole wheat citeturn0search0turn0news2. entity[\"organization\",\"Example Mills\",\"made-up miller\"] sells it 【3†source】.",
    ))),
  ];
  let current = "a-a4";
  if (continued) {
    nodes.push(
      node("a-u5", "a-a4", msg("a-u5", "user", T("2024-02-01T08:00:00Z"), text("And how warm should it be?"))),
      node("a-a5", "a-u5", msg("a-a5", "assistant", T("2024-02-01T08:00:05Z"), text("Around room temperature."))),
    );
    current = "a-a5";
  }
  return conversation("conv-a-0000-4000-8000-000000000001", "Sourdough", base, continued ? T("2024-02-01T08:00:05Z") : base + 43, current, nodes);
}

// B: tools, uploads, voice and the memory tool.
function conversationB() {
  const base = T("2025-03-02T12:00:00Z");
  const image = { content_type: "image_asset_pointer", asset_pointer: "sediment://file_000000000000made0up", size_bytes: 1, width: 1, height: 1 };
  const nodes = [
    node("b-root", null, null),
    node("b-ci", "b-root", msg("b-ci", "user", base - 1, text("made-up custom instructions"), { metadata: { is_user_system_message: true } })),
    node("b-u1", "b-ci", msg("b-u1", "user", base, { content_type: "multimodal_text", parts: [image, "What plant is this?"] }, { metadata: { attachments: [{ id: "file_000000000000made0up", name: "plant.jpg", mime_type: "image/jpeg" }] } })),
    node("b-code", "b-u1", msg("b-code", "assistant", base + 1, { content_type: "code", language: "python", text: "print('made up')" }, { recipient: "python" })),
    node("b-exec", "b-code", msg("b-exec", "tool", base + 2, { content_type: "execution_output", text: "made up" }, { name: "python" })),
    node("b-a2", "b-exec", msg("b-a2", "assistant", base + 3, text("It looks like a monstera."))),
    node("b-u2", "b-a2", msg("b-u2", "user", base + 4, { content_type: "multimodal_text", parts: [image] })),
    node("b-bio", "b-u2", msg("b-bio", "assistant", base + 5, text("The user keeps a monstera."), { recipient: "bio" })),
    node("b-bio-ok", "b-bio", msg("b-bio-ok", "tool", base + 6, text("Model set context updated."), { name: "bio" })),
    node("b-a4", "b-bio-ok", msg("b-a4", "assistant", base + 7, text("Noted."))),
    node("b-u3", "b-a4", msg("b-u3", "user", base + 8, { content_type: "multimodal_text", parts: [
      { content_type: "audio_transcription", text: "Remind me to water it", direction: "in" },
      { content_type: "audio_asset_pointer", asset_pointer: "sediment://file_000000000000made0up2" },
    ] })),
    node("b-a5", "b-u3", msg("b-a5", "assistant", base + 9, { content_type: "multimodal_text", parts: [
      { content_type: "audio_transcription", text: "Sure, once a week.", direction: "out" },
      { content_type: "audio_asset_pointer", asset_pointer: "sediment://file_000000000000made0up3" },
    ] })),
    node("b-search", "b-a5", msg("b-search", "assistant", base + 10, { content_type: "code", language: "unknown", text: "{\"search_query\":[{\"q\":\"made up\"}]}" }, { recipient: "web.run" })),
    node("b-browse", "b-search", msg("b-browse", "tool", base + 11, { content_type: "tether_browsing_display", result: "made up", summary: "" }, { name: "web.run" })),
    node("b-quote", "b-browse", msg("b-quote", "tool", base + 12, { content_type: "tether_quote", url: "https://example.invalid", domain: "example.invalid", text: "made up", title: "made up" }, { name: "web.run" })),
    node("b-err", "b-quote", msg("b-err", "tool", base + 13, { content_type: "system_error", name: "made up", text: "made up" }, { name: "web.run" })),
  ];
  return conversation("conv-b-0000-4000-8000-000000000002", "Plant", base - 1, base + 13, "b-err", nodes, { default_model_slug: "gpt-5" });
}

function simple(id, title, iso, user, assistant, extra = {}) {
  const base = T(iso);
  return conversation(id, title, base, base + 5, `${id}-a`, [
    node(`${id}-root`, null, null),
    node(`${id}-u`, `${id}-root`, msg(`${id}-u`, "user", base, text(user))),
    node(`${id}-a`, `${id}-u`, msg(`${id}-a`, "assistant", base + 5, text(assistant))),
  ], extra);
}

export function fixtureConversations() {
  const c = simple("conv-c-0000-4000-8000-000000000003", "Long", "2023-08-15T10:00:00Z", "Write me something long.", LONG_ANSWER);
  const d = simple("conv-d-0000-4000-8000-000000000004", "Private", "2025-06-01T10:00:00Z", "A question the user asked not to remember.", "An answer.", { is_do_not_remember: true, default_model_slug: "gpt-5-thinking" });
  const e = conversation("conv-e-0000-4000-8000-000000000005", "Empty", T("2025-07-01T10:00:00Z"), T("2025-07-01T10:00:00Z"), "e-sys", [
    node("e-root", null, null),
    node("e-sys", "e-root", msg("e-sys", "system", null, text(""), { metadata: { is_visually_hidden_from_conversation: true } })),
  ]);
  const g = simple("conv-g-0000-4000-8000-000000000007", "No leaf", "2023-12-01T10:00:00Z", "A question in a chat without current_node.", "Its answer.");
  delete g.current_node;
  // An older copy of A: fewer messages and an earlier update time.
  const aOld = conversationA();
  aOld.update_time = T("2024-01-10T09:00:20Z");
  aOld.current_node = "a-a2";
  return { a: conversationA(), aOld, b: conversationB(), c, d, e, g };
}

/** The export as the 2026 zip lays it out: shards, newest first, beside files that are not conversations. */
export function fixtureEntries({ continued = false } = {}) {
  const all = fixtureConversations();
  const a = continued ? conversationA({ continued: true }) : all.a;
  const shards = [[all.b, a, all.d, all.e], [all.c, all.g, all.aOld]];
  if (continued) {
    shards.push([simple("conv-h-0000-4000-8000-000000000008", "Newer", "2026-09-20T10:00:00Z", "A conversation from after the first export.", "A newer answer.")]);
  }
  return [
    { name: "chat.html", data: "<html>made up</html>" },
    { name: "user.json", data: JSON.stringify({ id: "user-made-up", email: "someone@example.invalid" }) },
    { name: "shared_conversations.json", data: JSON.stringify([{ id: "share-1", conversation_id: all.b.conversation_id, title: "Plant" }]) },
    { name: "conversation_asset_file_names.json", data: JSON.stringify({ "file_000000000000made0up": "plant.jpg" }) },
    { name: "export_manifest.json", data: JSON.stringify({ files: ["conversations-000.json", "conversations-001.json"] }) },
    { name: "file_000000000000made0up.dat", data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]), method: 0 },
    ...shards.map((shard, index) => ({ name: `conversations-${String(index).padStart(3, "0")}.json`, data: JSON.stringify(shard) })),
    { name: "__MACOSX/._conversations-000.json", data: Buffer.from([0, 5, 22, 7, 0, 2]) },
  ];
}

export function fixtureZip(options = {}) {
  return makeZip(fixtureEntries(options), options);
}

/** A fake Honcho v3 that stores what it is sent and lists it back, recording every request. */
export function startFakeHoncho() {
  const requests = [];
  const store = new Map();
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: request.method, url: request.url, headers: request.headers, body });
    const url = new URL(request.url, "http://127.0.0.1");
    const match = url.pathname.match(/^\/v3\/workspaces\/([^/]+)\/sessions(?:\/([^/]+)\/messages(\/list)?)?$/);
    response.setHeader("Content-Type", "application/json");
    if (!match) {
      response.statusCode = 404;
      return response.end(JSON.stringify({ detail: "not found" }));
    }
    const [, workspace, session, list] = match;
    if (!session) return response.end(JSON.stringify({ id: body?.id, workspace_id: workspace, metadata: body?.metadata || {} }));
    const key = `${decodeURIComponent(workspace)}/${decodeURIComponent(session)}`;
    const stored = store.get(key) || [];
    if (list) {
      const page = Number(url.searchParams.get("page") || 1);
      const size = Number(url.searchParams.get("size") || 50);
      return response.end(JSON.stringify({ items: stored.slice((page - 1) * size, page * size), total: stored.length, page, size }));
    }
    const created = body.messages.map((message, index) => ({ id: `${key}#${stored.length + index}`, ...message }));
    stored.push(...created);
    store.set(key, stored);
    return response.end(JSON.stringify(created));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests, store, url: `http://127.0.0.1:${server.address().port}` })));
}
