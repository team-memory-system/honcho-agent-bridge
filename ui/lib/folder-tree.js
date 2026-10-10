// Folders as a tree by their path, for the projects step, where one computer can
// hold hundreds of conversation folders: a folder that holds others opens and
// closes, and its box ticks or clears every folder inside it. When conversations
// were held both in a folder and in folders inside it, the folder's own are a row
// of their own (이 폴더), so each can be picked apart. A folder's `tag` (백업
// 저장소에만) shows after its name, and on a folder all of whose folders have it.
import { h, clear } from "./dom.js";
import { number } from "./format.js";
import { icon } from "./icons.js";

const joined = (left, right, sep) => (left === "/" || left.endsWith(sep) ? `${left}${right}` : `${left}${sep}${right}`);

/**
 * `items` ({ path, display }, in the order to show them) as a tree of their display
 * paths: nodes `{ key, label, item, children, items }`, where `item` is the one whose
 * folder the node is, if any, and `items` every one at or under it. A folder that
 * only leads to one other is joined to it (`~/dev/app`, not `~` → `dev` → `app`).
 * Folders keep the order of the first item inside them.
 */
export function folderTree(items) {
  const roots = [];
  const below = new Map();
  const node = (key, label, sep) => {
    const made = { key, label, sep, item: null, children: [], items: [] };
    below.set(made, new Map());
    return made;
  };
  for (const item of items) {
    const display = String(item.display || item.path);
    const sep = display.includes("\\") && !display.includes("/") ? "\\" : "/";
    const parts = display.split(/[\\/]+/).filter(Boolean);
    const first = display.startsWith("/") ? "/" : parts.shift() || display;
    let at = roots.find((root) => root.key === first);
    if (!at) roots.push(at = node(first, first, sep));
    at.items.push(item);
    for (const part of parts) {
      let next = below.get(at).get(part);
      if (!next) {
        next = node(joined(at.key, part, sep), part, sep);
        below.get(at).set(part, next);
        at.children.push(next);
      }
      next.items.push(item);
      at = next;
    }
    at.item = item;
  }
  const tidy = (at) => {
    let { key, label, item, children } = at;
    while (!item && children.length === 1) {
      const [only] = children;
      label = joined(label, only.label, at.sep);
      ({ key, item, children } = only);
    }
    return { key, label, item, items: at.items, children: children.map(tidy) };
  };
  return roots.map(tidy);
}

/** The folders shown open the first time: the top of each tree. */
export function openAtFirst(items) {
  return new Set(folderTree(items).map((root) => root.key));
}

/**
 * The rows of `items` as a tree, with a box in each of `columns` ({ folders, label },
 * `folders` the Set of paths ticked) on every row. A folder that holds others ticks or
 * clears all of them, and shows – when only some are ticked. With `inline`, the one
 * column's box sits before the name. `open` holds the keys of the folders shown open;
 * the caller keeps it, so a step drawn again opens the same ones. `template` is the
 * rows' grid when it is not the stylesheet's. Returns `{ element, sync }`: `sync`
 * redraws the boxes after the sets changed elsewhere.
 */
export function treeRows(items, columns, { open = openAtFirst(items), onChange, inline = false, template } = {}) {
  const roots = folderTree(items);
  const element = h("div", { class: "pt-scroll" });
  let boxes = [];
  const sync = () => {
    for (const { box, list, folders } of boxes) {
      const ticked = list.filter((item) => folders.has(item.path)).length;
      box.checked = ticked > 0 && ticked === list.length;
      box.indeterminate = ticked > 0 && ticked < list.length;
    }
  };
  const box = (list, column, label) => {
    const input = h("input", { type: "checkbox", "aria-label": columns.length > 1 ? `${label} → ${column.label}` : label });
    input.addEventListener("change", () => {
      for (const item of list) {
        if (input.checked) column.folders.add(item.path); else column.folders.delete(item.path);
      }
      sync();
      onChange?.();
    });
    boxes.push({ box: input, list, folders: column.folders });
    return input;
  };
  const cells = (list, label) => (inline ? null : columns.map((column) => h("span", { class: "pr-c" }, box(list, column, label))));
  const count = (list) => h("span", { class: "c" }, `${number(list.reduce((sum, item) => sum + Number(item.count || 0), 0))}개`);
  // The tag every one of `list` has, if they share one.
  const tagOf = (list) => (list.length && list[0].tag && list.every((item) => item.tag === list[0].tag) ? h("span", { class: "tag new" }, list[0].tag) : null);

  // A folder no other sits in, or a folder's own conversations (`own`).
  const leaf = (item, label, depth, own = false) => {
    const name = own ? h("span", { class: "tl" }, h("span", { class: "own" }, "이 폴더"))
      : h("span", { class: "tl" }, h("b", {}, label), item.temp ? h("span", { class: "th" }, "임시 폴더") : null, tagOf([item]));
    const title = own ? `${item.display || item.path} (이 폴더)` : item.display || item.path;
    return h(inline ? "label" : "div", { class: inline ? "pr t" : "pr m t", style: template, title },
      h("span", { class: "tn", style: { paddingLeft: `${depth * 20}px` } }, h("span", { class: "tw" }), inline ? box([item], columns[0], title) : null, name),
      count([item]),
      cells([item], title));
  };

  const group = (node, depth) => {
    const shown = open.has(node.key);
    const label = node.key;
    const toggle = h("button", { type: "button", class: "tw", "aria-expanded": String(shown), "aria-label": `${label} ${shown ? "접기" : "펼치기"}`, dataset: { key: node.key } }, icon("chevron"));
    const name = h("span", { class: "tn", style: { paddingLeft: `${depth * 20}px` } },
      toggle,
      inline ? box(node.items, columns[0], label) : null,
      h("span", { class: "tl" }, h("b", {}, node.label), h("span", { class: "th" }, `폴더 ${number(node.items.length)}개`), tagOf(node.items)));
    name.addEventListener("click", (event) => {
      if (event.target.closest("input")) return;
      const focused = document.activeElement === toggle;
      if (shown) open.delete(node.key); else open.add(node.key);
      draw();
      if (focused) [...element.querySelectorAll("button.tw")].find((button) => button.dataset.key === node.key)?.focus();
    });
    return h("div", { class: inline ? "pr t grp" : "pr m t grp", style: template, title: label }, name, count(node.items), cells(node.items, label));
  };

  function draw() {
    boxes = [];
    const rows = [];
    const walk = (node, depth) => {
      if (!node.children.length) {
        rows.push(leaf(node.item, node.label, depth));
        return;
      }
      rows.push(group(node, depth));
      if (!open.has(node.key)) return;
      if (node.item) rows.push(leaf(node.item, node.label, depth + 1, true));
      for (const child of node.children) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);
    clear(element, rows);
    sync();
  }
  draw();
  return { element, sync };
}

/**
 * Folders to tick as a tree: `{ path, display, count, temp, tag }` each, `checked`
 * the paths ticked. The box in the header ticks or clears them all.
 */
export function folderTreeTable(items, checked, { open, onChange } = {}) {
  const all = h("input", { type: "checkbox", "aria-label": "모두 고르기" });
  const syncAll = () => {
    const ticked = items.filter((item) => checked.has(item.path)).length;
    all.checked = ticked > 0 && ticked === items.length;
    all.indeterminate = ticked > 0 && ticked < items.length;
  };
  const rows = treeRows(items, [{ folders: checked, label: "수집" }], {
    open,
    inline: true,
    onChange: () => {
      syncAll();
      onChange?.(checked);
    },
  });
  all.addEventListener("change", () => {
    for (const item of items) {
      if (all.checked) checked.add(item.path); else checked.delete(item.path);
    }
    rows.sync();
    syncAll();
    onChange?.(checked);
  });
  syncAll();
  return h("div", { class: "pt" },
    h("div", { class: "pr t h" }, h("span", { class: "tn" }, h("span", { class: "tw" }), all, h("span", {}, "폴더")), h("span", { class: "c" }, "대화")),
    rows.element);
}
