// The parts the screens are built from, as the design canvas draws them: blocks of
// settings, lists, rows to pick from, windows with steps, progress, things to do
// and folders to tick. Their styles are in styles.css under "The parts the screens
// are built from".
import { h, clear } from "./dom.js";
import { button } from "./ui.js";

let lastId = 0;
const nextId = (prefix) => `${prefix}-${++lastId}`;

/** A block of settings: its title, a tag, buttons on the right, then its rows (kv). */
export function block({ title, tag, actions = [] }, ...rows) {
  return h("section", { class: "blk" },
    h("div", { class: "blk-h" }, h("h2", {}, title), tag || null, h("span", { class: "sp" }), actions),
    rows);
}

/** One row of a block: what it is, its value, and a button or tag at the end. */
export function kv(label, value, end) {
  return h("div", { class: "kv" },
    h("span", { class: "k" }, label),
    h("span", { class: "v" }, value),
    end ? h("span", { class: "end" }, end) : null);
}

/** A titled list of rows (listItem); `empty` says what an empty list means. */
export function list({ title, actions = [], empty = "없습니다." }, rows) {
  return h("section", {},
    title ? h("div", { class: "sec-h" }, h("h2", {}, title), h("span", { class: "sp" }), actions) : null,
    h("div", { class: "list" }, rows.length ? rows : h("div", { class: "list-empty" }, empty)));
}

export function listItem({ title, tags = [], sub, end = [], fresh = false }) {
  const ends = [end].flat().filter(Boolean);
  return h("div", { class: fresh ? "list-item fresh" : "list-item" },
    h("div", { class: "v" }, h("div", { class: "t" }, title, tags), sub ? h("div", { class: "s" }, sub) : null),
    ends.length ? h("div", { class: "end" }, ends) : null);
}

/** Rows to pick from, in one box. */
export function opts(...rows) {
  return h("div", { class: "opts" }, rows);
}

/**
 * One row to pick: a radio button (one of several with the same `name`) or a check
 * box. Its title and the line under it pick it; `extra` (the choice's own fields)
 * and `end` (a tag or a button) do not.
 */
export function opt({ type = "radio", name, value, checked = false, disabled = false, title, sub, end, extra, onChange }) {
  const id = nextId("opt");
  const input = h("input", { type, id, name, value, checked, disabled });
  const row = h("div", { class: `opt${disabled ? " dis" : ""}` },
    input,
    h("div", { class: "ob" },
      h("label", { class: "ot", for: id }, title),
      sub ? h("label", { class: "os", for: id }, sub) : null,
      extra || null),
    end ? h("div", { class: "oe" }, end) : null);
  if (type === "radio") {
    row.classList.toggle("sel", Boolean(checked));
    // A radio that turns off says nothing, so every row of the group is looked at.
    input.addEventListener("change", () => {
      for (const other of document.getElementsByName(name)) other.closest(".opt")?.classList.toggle("sel", other.checked);
    });
  }
  input.addEventListener("change", () => onChange?.(input.checked, input));
  row.input = input;
  return row;
}

/** A field in a window: its label above, the input, and a hint under it. */
export function field(label, input, hint) {
  return h("label", { class: "fld" }, h("span", {}, label), input, hint ? h("div", { class: "hint" }, hint) : null);
}

/** − n + for a count, from `min` to `max`. */
export function counter(value, { min = 1, max = 9, label, onChange } = {}) {
  let current = value;
  const shown = h("b", {}, String(current));
  const step = (delta) => {
    const next = Math.min(max, Math.max(min, current + delta));
    if (next === current) return;
    current = next;
    shown.textContent = String(current);
    onChange?.(current);
  };
  return h("span", { class: "cnt", role: "group", "aria-label": label },
    h("button", { type: "button", "aria-label": "하나 줄이기", onclick: () => step(-1) }, "−"),
    shown,
    h("button", { type: "button", "aria-label": "하나 늘리기", onclick: () => step(1) }, "+"));
}

/**
 * The steps of a window. `at` is the step on, or "done" once they all are. With
 * `onPick`, every step but the one on opens when pressed (editing a setup).
 */
export function stepper(labels, at, { onPick } = {}) {
  const parts = [];
  labels.forEach((label, index) => {
    if (index) parts.push(h("span", { class: "line" }));
    const on = index === at;
    const done = at === "done" || (typeof at === "number" && index < at);
    const cls = `st${on ? " on" : done ? " done" : ""}`;
    const content = [h("span", { class: "n" }, done ? "✓" : String(index + 1)), h("span", { class: "lbl" }, label)];
    parts.push(onPick && !on
      ? h("button", { type: "button", class: cls, onclick: () => onPick(index) }, content)
      : h("span", { class: cls, "aria-current": on ? "step" : null }, content));
  });
  return h("div", { class: "stepper" }, parts);
}

/**
 * A window over the page (a <dialog>). `title` names the job in small letters
 * above its steps ("팀 메모리 시작하기"), or with `big` is the window's own heading.
 * Escape and ✕ close it unless it is `locked`. `onClose` hears how it closed.
 */
export function modal({ title, big = false, small = false, locked = false, onClose } = {}) {
  const dialog = h("dialog", { class: small ? "modal sm" : "modal", "aria-label": title });
  const heading = h("span", { class: "mt" }, title);
  let steps = h("div", { hidden: true });
  const body = h("div", { class: "m-body" });
  const foot = h("div", { class: "m-foot" });
  dialog.append(
    h("div", { class: big ? "m-head big" : "m-head" }, heading,
      locked ? null : button("", { kind: "quiet icon-only small x", iconName: "close", title: "닫기", onClick: () => dialog.close("cancel") })),
    steps, body, foot);
  dialog.addEventListener("cancel", (event) => { if (locked) event.preventDefault(); });
  dialog.addEventListener("close", () => {
    onClose?.(dialog.returnValue);
    dialog.remove();
  });
  const win = {
    dialog,
    title(text) { heading.textContent = text; return win; },
    steps(node) {
      const next = node || h("div", { hidden: true });
      steps.replaceWith(next);
      steps = next;
      return win;
    },
    body(...nodes) { clear(body, ...nodes); body.scrollTop = 0; return win; },
    foot(left, right) { clear(foot, left || null, h("span", { class: "sp" }), right || null); return win; },
    open() { document.body.append(dialog); dialog.showModal(); return win; },
    close(value = "") { if (dialog.open) dialog.close(value); },
  };
  return win;
}

/**
 * A yes/no window. Resolves true only for the confirming button; `danger` paints it
 * red for something that cannot be taken back.
 */
export function confirmWindow({ title, text, confirm = "확인", danger = false }) {
  return new Promise((resolve) => {
    let answer = false;
    const win = modal({ title, big: true, small: true, onClose: () => resolve(answer) });
    win.body(text ? h("p", { class: "lead", style: { marginTop: "4px" } }, text) : null);
    win.foot(null, [
      button("취소", { kind: "quiet", onClick: () => win.close() }),
      button(confirm, { kind: danger ? "primary danger-fill" : "primary", onClick: () => { answer = true; win.close("ok"); } }),
    ]);
    win.open();
  });
}

/**
 * What a job is doing, one row per step: `{ label }` starts a group, and
 * `{ state: "ok" | "run" | "wait" | "bad", title, sub, end }` is a step.
 */
export function progressList(rows) {
  return h("div", { class: "prog" }, rows.map((row) => (row.label !== undefined
    ? h("div", { class: "pgl" }, row.label)
    : h("div", { class: `pg ${row.state}` },
      h("span", { class: `ic ${row.state}` }, row.state === "ok" ? "✓" : row.state === "bad" ? "!" : ""),
      h("div", { class: "pb" }, h("div", { class: "pgt" }, row.title), row.sub ? h("div", { class: "pgs" }, row.sub) : null),
      row.end || null))));
}

/** Numbered things to do: `{ title, text }` each. */
export function todoList(items) {
  return h("ol", { class: "todo" }, items.map(({ title, text }) => h("li", {}, h("div", {}, h("b", {}, title), text))));
}

/**
 * Folders to tick: `{ path, name, count }` each, `checked` the paths ticked. The box
 * in the header ticks or clears them all; `fresh` paths are marked as newly ticked.
 */
export function folderTable(folders, checked, { onChange, fresh = new Set(), freshTag, scroll = false } = {}) {
  const boxes = [];
  const all = h("input", { type: "checkbox", "aria-label": "모두 고르기" });
  const sync = () => {
    const ticked = boxes.filter((box) => box.checked).length;
    all.checked = ticked > 0 && ticked === boxes.length;
    all.indeterminate = ticked > 0 && ticked < boxes.length;
  };
  const rows = folders.map((folder) => {
    const box = h("input", { type: "checkbox", value: folder.path, checked: checked.has(folder.path), "aria-label": folder.name });
    box.addEventListener("change", () => {
      if (box.checked) checked.add(folder.path); else checked.delete(folder.path);
      sync();
      onChange?.(checked);
    });
    boxes.push(box);
    return h("label", { class: fresh.has(folder.path) ? "pr fresh" : "pr" }, box,
      h("span", { class: "pn" }, h("b", {}, folder.name), fresh.has(folder.path) && freshTag ? [" ", freshTag] : null, h("small", {}, folder.display || folder.path)),
      h("span", { class: "c" }, `${folder.count}개`));
  });
  all.addEventListener("change", () => {
    for (const box of boxes) {
      box.checked = all.checked;
      if (all.checked) checked.add(box.value); else checked.delete(box.value);
    }
    sync();
    onChange?.(checked);
  });
  sync();
  return h("div", { class: "pt" },
    h("div", { class: "pr h" }, all, h("span", {}, "폴더"), h("span", { class: "c" }, "대화")),
    scroll ? h("div", { class: "pt-scroll" }, rows) : rows);
}
