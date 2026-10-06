// Loads every board in out/project at its canvas size and reports content that
// spills past the board or gets clipped inside a box: node check.mjs [shotdir]
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const PROJECT = path.join(DIR, "out/project");
const PORT = 9335;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shotDir = process.argv[2];
if (shotDir) await mkdir(shotDir, { recursive: true });
const canvas = JSON.parse(await readFile(path.join(PROJECT, "canvas.json"), "utf8"));

async function connect() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome did not answer");
}
function session(socket) {
  let id = 0;
  const waiting = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
  });
  return (method, params = {}) => new Promise((resolve, reject) => {
    id += 1; waiting.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
}

const probe = (w, h) => `(async () => {
  await document.fonts.ready;
  const W = ${w}, H = ${h}, out = [], clip = [], spill = [];
  const label = (el) => {
    const text = (el.innerText || el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 40);
    return el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "") + (text ? " “" + text + "”" : "");
  };
  for (const el of document.querySelectorAll("x-dc *")) {
    if (["STYLE", "LINK", "SCRIPT", "HELMET"].includes(el.tagName) || el.closest("helmet")) continue;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    if (r.right > W + 1 || r.bottom > H + 1) out.push(label(el) + " → " + Math.round(r.right) + "×" + Math.round(r.bottom));
    const cs = getComputedStyle(el);
    if (cs.display === "inline") continue;
    const hidden = /hidden|clip|auto|scroll/.test(cs.overflowX + cs.overflowY);
    if (hidden && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) clip.push(label(el) + " (" + el.scrollWidth + "/" + el.clientWidth + " × " + el.scrollHeight + "/" + el.clientHeight + ")");
    else if (!hidden && el.children.length === 0 && el.scrollWidth > el.clientWidth + 2) spill.push(label(el) + " (" + el.scrollWidth + "/" + el.clientWidth + ")");
  }
  const doc = document.documentElement;
  return JSON.stringify({ page: [doc.scrollWidth, doc.scrollHeight], out: out.slice(0, 6), outN: out.length, clip: clip.slice(0, 6), spill: spill.slice(0, 6) });
})()`;

const profile = await mkdtemp(path.join(os.tmpdir(), "screens-check-"));
const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let bad = 0;
try {
  const socket = new WebSocket(await connect());
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  const send = session(socket);
  await send("Page.enable");
  await send("Runtime.enable");
  for (const name of canvas.order) {
    const { w, h } = canvas.boards[name];
    await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: `file://${path.join(PROJECT, name)}` });
    await sleep(900);
    const { result } = await send("Runtime.evaluate", { expression: probe(w, h), awaitPromise: true, returnByValue: true });
    const found = JSON.parse(result.value);
    const problem = found.page[0] > w || found.page[1] > h || found.outN || found.clip.length || found.spill.length;
    if (problem) {
      bad += 1;
      console.log(`✗ ${name} (${w}×${h}) page ${found.page.join("×")}`);
      for (const line of found.out) console.log("   out  ", line);
      if (found.outN > found.out.length) console.log(`   out   …${found.outN - found.out.length} more`);
      for (const line of found.clip) console.log("   clip ", line);
      for (const line of found.spill) console.log("   spill", line);
    }
    if (shotDir) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(shotDir, name.replace(".dc.html", ".png")), Buffer.from(data, "base64"));
    }
  }
  console.log(`${canvas.order.length} boards checked, ${bad} with problems`);
  socket.close();
} finally {
  chrome.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true });
}
