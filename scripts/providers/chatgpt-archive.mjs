// Reading a ChatGPT export the way it arrives: the zip from the email, the folder
// it unpacks to, or one JSON file taken out of it.
//
// The export has changed shape over the years, and all of these are read:
//
//   - one conversations.json, an array of conversations (older exports);
//   - conversations-000.json, conversations-001.json, ... with no conversations.json,
//     each the same array shape, next to chat.html, user.json, file-*.dat assets and
//     other JSON files that are not conversations (2026 exports of larger accounts);
//   - an outer zip that holds the conversations as an inner zip
//     (".../Conversations_<id>-chatgpt-0001.zip", next to a "Files_..." zip of
//     attachments), or several "...-part-000N.zip" downloads in one folder;
//   - archives over 4 GiB written without ZIP64, whose recorded offsets wrap at 4 GiB.
//
// Conversations are read one at a time from a stream, so a shard of hundreds of MB
// never becomes one string in memory.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline, Readable } from "node:stream";
import { pipeline as pipelineAsync } from "node:stream/promises";
import zlib from "node:zlib";

const CONVERSATION_FILE = /^conversations(?:[-_]\d+)?\.json$/i;
const ZIP_FILE = /\.zip$/i;
// A deflated inner zip is copied out before it can be read, so only the ones that
// can hold conversations are; a stored one is read in place whatever its name.
const CONVERSATION_ARCHIVE = /conversation|chatgpt/i;
const MAX_NESTING = 2;
const MAX_FOLDER_DEPTH = 4;
const FOUR_GIB = 2 ** 32;

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_ZIP64_END = 0x06064b50;

function baseName(name) {
  return String(name).split(/[\\/]/).pop();
}

/** Whether an export member holds conversations: conversations.json or one of its numbered shards. */
export function isConversationFile(name) {
  return CONVERSATION_FILE.test(baseName(name));
}

// macOS adds "__MACOSX/._name" copies of every file when it zips a folder.
function isMacCopy(name) {
  return /(^|[\\/])__MACOSX[\\/]/.test(name) || baseName(name).startsWith("._");
}

function naturalOrder(left, right) {
  return left.localeCompare(right, "en", { numeric: true });
}

/** The conversations in a parsed JSON value: an array, `{ conversations: [...] }`, or one conversation. */
export function conversationsIn(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.conversations)) return payload.conversations;
    if (payload.mapping) return [payload];
  }
  return [];
}

function invalidJson(label, detail) {
  return new Error(`not a ChatGPT export (invalid JSON): ${label}: ${detail}`);
}

function parseItem(pieces, label, index) {
  const bytes = pieces.length === 1 ? pieces[0] : Buffer.concat(pieces);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw invalidJson(label, `item ${index + 1}: ${error.message}`);
  }
}

/**
 * The items of the JSON array a byte stream holds, parsed one at a time. Only the
 * bytes of the item being read are held. A stream that is not an array (the older
 * `{ conversations: [...] }` wrapper, or one conversation) is parsed whole.
 */
export async function* jsonArrayItems(chunks, label) {
  let mode = null;
  const whole = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pieces = [];
  let start = -1;
  let index = 0;
  let closed = false;
  let offset = 0;
  const BOM = [0xef, 0xbb, 0xbf];
  for await (const raw of chunks) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const chunkOffset = offset;
    offset += chunk.length;
    let i = 0;
    if (mode === null) {
      while (i < chunk.length) {
        const c = chunk[i];
        const at = chunkOffset + i;
        if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || (at < 3 && c === BOM[at])) i += 1;
        else break;
      }
      if (i >= chunk.length) continue;
      if (chunk[i] === 0x5b) {
        mode = "array";
        depth = 1;
        i += 1;
      } else {
        mode = "whole";
      }
    }
    if (mode === "whole") {
      whole.push(chunk.subarray(i));
      continue;
    }
    if (closed) continue;
    for (; i < chunk.length; i += 1) {
      const c = chunk[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 0x5c) escaped = true;
        else if (c === 0x22) inString = false;
        continue;
      }
      if (c === 0x22) {
        inString = true;
        if (depth === 1 && start < 0) start = i;
        continue;
      }
      if (c === 0x7b || c === 0x5b) {
        if (depth === 1 && start < 0) start = i;
        depth += 1;
        continue;
      }
      if (c === 0x7d || c === 0x5d) {
        depth -= 1;
        if (depth === 1) {
          pieces.push(chunk.subarray(start, i + 1));
          yield parseItem(pieces, label, index);
          index += 1;
          pieces = [];
          start = -1;
        } else if (depth === 0) {
          if (start >= 0) {
            pieces.push(chunk.subarray(start, i));
            yield parseItem(pieces, label, index);
            index += 1;
          }
          pieces = [];
          start = -1;
          closed = true;
          break;
        }
        continue;
      }
      if (depth !== 1) continue;
      if (c === 0x2c) {
        if (start >= 0) {
          pieces.push(chunk.subarray(start, i));
          yield parseItem(pieces, label, index);
          index += 1;
          pieces = [];
          start = -1;
        }
        continue;
      }
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
      if (start < 0) start = i;
    }
    if (start >= 0 && !closed) {
      pieces.push(chunk.subarray(start));
      start = 0;
    }
  }
  if (mode === null) throw invalidJson(label, "the file is empty");
  if (mode === "whole") {
    let payload;
    try {
      payload = JSON.parse(Buffer.concat(whole).toString("utf8"));
    } catch (error) {
      throw invalidJson(label, error.message);
    }
    yield* conversationsIn(payload);
    return;
  }
  if (!closed) throw invalidJson(label, "the file ends before its closing ] (an incomplete download?)");
}

/** A zip archive occupying [base, end) of a file, read with random access. */
class ZipArchive {
  constructor({ handle, filePath, base, end, label, owner }) {
    this.handle = handle;
    this.filePath = filePath;
    this.base = base;
    this.end = end;
    this.label = label;
    this.owner = owner;
    this.list = null;
  }

  static async open(filePath, label = filePath) {
    const handle = await fsp.open(filePath, "r");
    try {
      const { size } = await handle.stat();
      return new ZipArchive({ handle, filePath, base: 0, end: size, label, owner: true });
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async close() {
    if (this.owner) await this.handle.close();
  }

  async read(position, length) {
    const buffer = Buffer.alloc(Math.max(0, length));
    if (!length) return buffer;
    const { bytesRead } = await this.handle.read(buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  }

  async signatureAt(position, signature) {
    if (position < this.base || position + 4 > this.end) return false;
    const bytes = await this.read(position, 4);
    return bytes.length === 4 && bytes.readUInt32LE(0) === signature;
  }

  async findEnd() {
    const windowSize = Math.min(this.end - this.base, 22 + 0xffff + 64);
    const windowStart = this.end - windowSize;
    const tail = await this.read(windowStart, windowSize);
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) !== SIG_END) continue;
      if (i + 22 + tail.readUInt16LE(i + 20) > tail.length) continue;
      return { position: windowStart + i, record: tail.subarray(i, i + 22) };
    }
    throw new Error(`${this.label} is not a zip archive`);
  }

  async entries() {
    if (this.list) return this.list;
    const end = await this.findEnd();
    let count = end.record.readUInt16LE(10);
    let directorySize = end.record.readUInt32LE(12);
    let directoryOffset = end.record.readUInt32LE(16);
    let directoryEnd = end.position;
    if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      const locator = end.position - 20;
      if (await this.signatureAt(locator, SIG_ZIP64_LOCATOR)) {
        const recorded = this.base + Number((await this.read(locator, 20)).readBigUInt64LE(8));
        let position = recorded;
        if (!(await this.signatureAt(position, SIG_ZIP64_END))) position = locator - 56;
        if (await this.signatureAt(position, SIG_ZIP64_END)) {
          const record = await this.read(position, 56);
          count = Number(record.readBigUInt64LE(32));
          directorySize = Number(record.readBigUInt64LE(40));
          directoryOffset = Number(record.readBigUInt64LE(48));
          directoryEnd = position;
        }
      }
    }
    // The directory ends where the end records begin. Counting back from there
    // survives an archive over 4 GiB written without ZIP64, whose recorded
    // directory offset has wrapped.
    let directoryStart = directoryEnd - directorySize;
    if (directorySize && !(await this.signatureAt(directoryStart, SIG_CENTRAL))) {
      directoryStart = this.base + directoryOffset;
      if (!(await this.signatureAt(directoryStart, SIG_CENTRAL))) {
        throw new Error(`${this.label}: the zip's file list is damaged`);
      }
    }
    this.directoryStart = directoryStart;
    const directory = await this.read(directoryStart, directorySize);
    const list = [];
    // Walked by size, not by the recorded count, which wraps at 65,535 without ZIP64.
    for (let p = 0; p + 46 <= directory.length; ) {
      if (directory.readUInt32LE(p) !== SIG_CENTRAL) break;
      const flags = directory.readUInt16LE(p + 8);
      const method = directory.readUInt16LE(p + 10);
      let compressedSize = directory.readUInt32LE(p + 20);
      let size = directory.readUInt32LE(p + 24);
      const nameLength = directory.readUInt16LE(p + 28);
      const extraLength = directory.readUInt16LE(p + 30);
      const commentLength = directory.readUInt16LE(p + 32);
      let offset = directory.readUInt32LE(p + 42);
      const nameBytes = Buffer.from(directory.subarray(p + 46, p + 46 + nameLength));
      const extra = directory.subarray(p + 46 + nameLength, p + 46 + nameLength + extraLength);
      for (let e = 0; e + 4 <= extra.length; ) {
        const id = extra.readUInt16LE(e);
        const length = extra.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          const limit = Math.min(extra.length, e + 4 + length);
          if (size === 0xffffffff && q + 8 <= limit) { size = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (compressedSize === 0xffffffff && q + 8 <= limit) { compressedSize = Number(extra.readBigUInt64LE(q)); q += 8; }
          if (offset === 0xffffffff && q + 8 <= limit) { offset = Number(extra.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + length;
      }
      list.push({ name: nameBytes.toString("utf8"), nameBytes, flags, method, compressedSize, size, offset });
      p += 46 + nameLength + extraLength + commentLength;
    }
    if (count && !list.length) throw new Error(`${this.label}: the zip's file list is damaged`);
    this.list = list;
    return list;
  }

  /** Where an entry's data begins. Recorded offsets past 4 GiB may have wrapped. */
  async dataStart(entry) {
    for (let candidate = this.base + entry.offset; candidate < this.directoryStart; candidate += FOUR_GIB) {
      const header = await this.read(candidate, 30 + entry.nameBytes.length);
      if (header.length < 30 + entry.nameBytes.length || header.readUInt32LE(0) !== SIG_LOCAL) continue;
      const nameLength = header.readUInt16LE(26);
      if (nameLength !== entry.nameBytes.length || !header.subarray(30, 30 + nameLength).equals(entry.nameBytes)) continue;
      return candidate + 30 + nameLength + header.readUInt16LE(28);
    }
    throw new Error(`${this.label}: cannot find ${entry.name} inside the archive`);
  }

  /** The entry's uncompressed bytes, as a stream. */
  async open(entry) {
    if (entry.flags & 0x1) throw new Error(`${this.label}: ${entry.name} is encrypted`);
    if (entry.method !== 0 && entry.method !== 8) {
      throw new Error(`${this.label}: ${entry.name} uses compression method ${entry.method}, which is not supported`);
    }
    const start = await this.dataStart(entry);
    const raw = entry.compressedSize > 0
      ? fs.createReadStream(this.filePath, { start, end: start + entry.compressedSize - 1 })
      : Readable.from([]);
    if (entry.method === 0) return raw;
    return pipeline(raw, zlib.createInflateRaw(), () => {});
  }

  /** A zip stored (not compressed) inside this one, read in place. */
  async storedInner(entry) {
    const start = await this.dataStart(entry);
    // A member over 4 GiB in an archive without ZIP64 has a wrapped size too.
    for (let end = start + entry.compressedSize; end <= this.directoryStart; end += FOUR_GIB) {
      const inner = new ZipArchive({
        handle: this.handle,
        filePath: this.filePath,
        base: start,
        end,
        label: `${this.label}#${entry.name}`,
        owner: false,
      });
      try {
        await inner.entries();
        return inner;
      } catch {
        // try the next 4 GiB boundary
      }
    }
    throw new Error(`${this.label}#${entry.name} is not a readable zip archive`);
  }
}

async function startsWithZipSignature(filePath) {
  const handle = await fsp.open(filePath, "r");
  try {
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, 4, 0);
    if (bytesRead < 4) return false;
    const signature = bytes.readUInt32LE(0);
    return signature === SIG_LOCAL || signature === SIG_END;
  } finally {
    await handle.close();
  }
}

async function walkFolder(root) {
  const json = [];
  const zips = [];
  const pending = [{ directory: root, depth: 0 }];
  while (pending.length) {
    const { directory, depth } = pending.shift();
    let entries;
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "__MACOSX") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_FOLDER_DEPTH) pending.push({ directory: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        if (isConversationFile(entry.name)) json.push(full);
        else if (ZIP_FILE.test(entry.name)) zips.push(full);
      }
    }
  }
  return { json: json.sort(naturalOrder), zips: zips.sort(naturalOrder) };
}

/**
 * Every conversation in an export, one at a time, as `{ conversation, source }`;
 * `source` names the file (and the archive member) it came from. `report.files`
 * counts the conversations read from each file, and `report.skipped_archives`
 * names the archives that were not read and why.
 */
export async function* readConversations(inputPath, report = {}) {
  report.files ??= [];
  report.skipped_archives ??= [];
  const cleanup = [];
  let scratch = null;
  const scratchDirectory = async () => {
    if (!scratch) {
      scratch = await fsp.mkdtemp(path.join(os.tmpdir(), "honcho-chatgpt-export-"));
      cleanup.push(() => fsp.rm(scratch, { recursive: true, force: true }));
    }
    return scratch;
  };

  async function* fromJson(openStream, label) {
    const counted = { source: label, conversations: 0 };
    report.files.push(counted);
    for await (const item of jsonArrayItems(await openStream(), label)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      counted.conversations += 1;
      yield { conversation: item, source: label };
    }
  }

  async function* fromArchive(archive, depth) {
    const entries = (await archive.entries()).filter((entry) => !entry.name.endsWith("/") && !isMacCopy(entry.name));
    const shards = entries.filter((entry) => isConversationFile(entry.name)).sort((a, b) => naturalOrder(a.name, b.name));
    for (const entry of shards) {
      yield* fromJson(() => archive.open(entry), `${archive.label}#${entry.name}`);
    }
    const inner = entries.filter((entry) => ZIP_FILE.test(entry.name)).sort((a, b) => naturalOrder(a.name, b.name));
    for (const entry of inner) {
      const label = `${archive.label}#${entry.name}`;
      if (depth >= MAX_NESTING) {
        report.skipped_archives.push({ archive: label, reason: "nested too deep" });
        continue;
      }
      if (entry.method === 0) {
        yield* fromArchive(await archive.storedInner(entry), depth + 1);
        continue;
      }
      if (!CONVERSATION_ARCHIVE.test(baseName(entry.name))) {
        report.skipped_archives.push({ archive: label, reason: "attachments only, not conversations" });
        continue;
      }
      const target = path.join(await scratchDirectory(), `inner-${cleanup.length}.zip`);
      await pipelineAsync(await archive.open(entry), fs.createWriteStream(target, { mode: 0o600 }));
      const extracted = await ZipArchive.open(target, label);
      cleanup.push(() => extracted.close());
      yield* fromArchive(extracted, depth + 1);
    }
  }

  async function* fromZipFile(filePath) {
    const archive = await ZipArchive.open(filePath);
    cleanup.push(() => archive.close());
    yield* fromArchive(archive, 0);
  }

  try {
    const stat = await fsp.stat(inputPath);
    if (stat.isDirectory()) {
      const found = await walkFolder(inputPath);
      for (const file of found.json) yield* fromJson(() => fs.createReadStream(file), file);
      for (const file of found.zips) {
        // A folder can hold other zips; one that is not an export is named and passed over.
        let archive;
        try {
          archive = await ZipArchive.open(file);
          await archive.entries();
        } catch (error) {
          if (archive) await archive.close().catch(() => {});
          report.skipped_archives.push({ archive: file, reason: String(error?.message || error) });
          continue;
        }
        cleanup.push(() => archive.close());
        yield* fromArchive(archive, 0);
      }
    } else if (await startsWithZipSignature(inputPath)) {
      yield* fromZipFile(inputPath);
    } else {
      yield* fromJson(() => fs.createReadStream(inputPath), inputPath);
    }
  } finally {
    for (const step of cleanup.reverse()) await step().catch(() => {});
  }
}
