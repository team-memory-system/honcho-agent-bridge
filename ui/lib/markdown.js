// Enough Markdown to read an agent's answer: paragraphs, headings, lists, quotes,
// code, tables, bold, inline code and links. It builds DOM nodes and never parses
// HTML, so whatever a transcript contains is shown as text.
import { h } from "./dom.js";

function inline(text) {
  const nodes = [];
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1]) nodes.push(h("code", {}, match[1].slice(1, -1)));
    else if (match[2]) nodes.push(h("strong", {}, match[2].slice(2, -2)));
    else if (match[3]) nodes.push(h("a", { href: match[4], target: "_blank", rel: "noreferrer noopener" }, match[3].slice(1, match[3].indexOf("]"))));
    else if (match[5]) nodes.push(h("a", { href: match[5], target: "_blank", rel: "noreferrer noopener" }, match[5]));
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function withBreaks(lines) {
  const nodes = [];
  lines.forEach((line, index) => {
    if (index) nodes.push(h("br"));
    nodes.push(...inline(line));
  });
  return nodes;
}

const isTableRow = (line) => /^\s*\|.*\|\s*$/.test(line);
const isDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const cells = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());

export function markdown(source, { maxChars = 60_000 } = {}) {
  const text = String(source || "").slice(0, maxChars).replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const root = h("div", { class: "prose" });
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)/.exec(line);
    if (fence) {
      const body = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++]);
      index += 1;
      root.append(h("pre", {}, h("code", fence[2] ? { "data-lang": fence[2] } : {}, body.join("\n"))));
      continue;
    }
    if (!line.trim()) { index += 1; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      root.append(h(`h${Math.min(6, heading[1].length + 2)}`, {}, inline(heading[2])));
      index += 1;
      continue;
    }
    if (isTableRow(line) && index + 1 < lines.length && isDivider(lines[index + 1])) {
      const head = cells(line);
      index += 2;
      const rows = [];
      while (index < lines.length && isTableRow(lines[index])) rows.push(cells(lines[index++]));
      root.append(h("div", { class: "table-scroll" }, h("table", {},
        h("thead", {}, h("tr", {}, head.map((cell) => h("th", {}, inline(cell))))),
        h("tbody", {}, rows.map((row) => h("tr", {}, row.map((cell) => h("td", {}, inline(cell)))))),
      )));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quoted.push(lines[index++].replace(/^\s*>\s?/, ""));
      root.append(h("blockquote", {}, withBreaks(quoted)));
      continue;
    }
    const bullet = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]);
      const list = h(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (!item) {
          // A wrapped continuation line belongs to the item above it.
          if (lines[index].trim() && /^\s{2,}/.test(lines[index]) && list.lastChild) {
            list.lastChild.append(h("br"), ...inline(lines[index].trim()));
            index += 1;
            continue;
          }
          break;
        }
        const entry = h("li", {}, inline(item[3]));
        if (item[1].length >= 2) entry.classList.add("nested");
        list.append(entry);
        index += 1;
      }
      root.append(list);
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !/^\s*(```|~~~|#{1,4}\s|>|[-*•]\s|\d+[.)]\s)/.test(lines[index])
      && !(isTableRow(lines[index]) && isDivider(lines[index + 1] || ""))
    ) paragraph.push(lines[index++]);
    root.append(h("p", {}, withBreaks(paragraph)));
  }
  if (String(source || "").length > maxChars) root.append(h("p", { class: "muted" }, "… 너무 길어서 여기까지만 보여 줍니다."));
  return root;
}
