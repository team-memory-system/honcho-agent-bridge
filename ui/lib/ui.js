// Pieces every screen uses: the page header, notices, toasts, confirmations and
// buttons that show they are working.
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";

/**
 * The top of a screen. `back` ({ href, label }) leads to the menu a page sits in;
 * `subnav` ([href, label, current] each) switches between screens of one menu item.
 */
export function pageHead({ title, subtitle, actions = [], back, subnav }) {
  return h("header", { class: subnav ? "page-head has-subnav" : "page-head" },
    h("div", {},
      back ? h("a", { class: "back-link", href: back.href }, icon("back"), h("span", {}, back.label)) : null,
      h("h1", {}, title),
      subtitle ? h("p", {}, subtitle) : null),
    actions.length ? h("div", { class: "actions" }, actions) : null,
    subnav ? h("nav", { class: "subnav" }, subnav.map(([href, label, current]) => h("a", { href, "aria-current": current ? "page" : null }, label))) : null,
  );
}

export function section({ title, note, actions = [], id }, ...body) {
  return h("section", { class: "section", id },
    h("header", {}, h("h2", {}, title), actions.length ? h("div", { class: "actions" }, actions) : null),
    note ? h("p", { class: "section-note" }, note) : null,
    body,
  );
}

export function notice(kind, ...content) {
  const glyph = kind === "ok" ? "check" : kind === "bad" || kind === "warn" ? "warn" : "dot";
  return h("div", { class: `notice ${kind || ""}` }, icon(glyph), h("div", {}, content));
}

export function errorNotice(error, hint) {
  return notice(error?.unreachable ? "warn" : "bad", h("b", {}, error?.message || String(error)), hint ? h("div", {}, hint) : null);
}

export function empty(title, text, ...actions) {
  return h("div", { class: "empty" }, h("b", {}, title), text ? h("span", {}, text) : null, actions.length ? h("div", { class: "form-actions" }, actions) : null);
}

export function tag(text, kind = "") {
  return h("span", { class: `tag ${kind}` }, text);
}

export function statusTag(on, labels = ["실행 중", "멈춤"]) {
  return on ? tag(labels[0], "ok") : tag(labels[1]);
}

export function light(state) {
  return h("span", { class: `light ${state}` });
}

export function spinner() {
  return h("span", { class: "spinner", role: "presentation" });
}

export function button(label, { kind = "", iconName, onClick, title, type = "button", disabled } = {}) {
  return h("button", { class: `btn ${kind}`, type, title, disabled, onclick: onClick },
    iconName ? icon(iconName) : null, label ? h("span", {}, label) : null);
}

/**
 * Run an action from a button: it shows a spinner and cannot be pressed twice,
 * and a failure becomes a toast instead of disappearing.
 */
export async function busy(buttonElement, action, { done } = {}) {
  if (buttonElement?.disabled) return undefined;
  const original = buttonElement ? [...buttonElement.childNodes] : null;
  if (buttonElement) {
    buttonElement.disabled = true;
    clear(buttonElement, spinner(), original.find((node) => node.nodeName === "SPAN")?.cloneNode(true) || "");
  }
  try {
    const result = await action();
    if (done) toast(done);
    return result;
  } catch (error) {
    toast(error?.message || String(error), "bad");
    return undefined;
  } finally {
    if (buttonElement && buttonElement.isConnected) {
      buttonElement.disabled = false;
      clear(buttonElement, original);
    }
  }
}

export function toast(message, kind = "") {
  const box = document.getElementById("toasts");
  const node = h("div", { class: `toast ${kind}` }, message);
  box.append(node);
  setTimeout(() => node.remove(), kind === "bad" ? 7000 : 3500);
}

/** A yes/no question in a sheet. Resolves true only for the confirming button. */
export function confirmSheet({ title, text, confirm = "확인", danger = false, detail }) {
  return new Promise((resolve) => {
    const dialog = h("dialog", { class: "sheet" },
      h("div", { class: "sheet-body" }, h("h3", {}, title), text ? h("p", {}, text) : null, detail || null),
      h("div", { class: "sheet-foot" },
        button("취소", { onClick: () => dialog.close("cancel") }),
        button(confirm, { kind: danger ? "primary danger-fill" : "primary", onClick: () => dialog.close("ok") }),
      ),
    );
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok");
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/** A labelled switch that reports its state to a screen reader. */
export function toggle(checked, onChange, { label, disabled } = {}) {
  const control = h("button", {
    class: "switch",
    type: "button",
    role: "switch",
    "aria-checked": String(Boolean(checked)),
    "aria-label": label,
    disabled,
  });
  control.addEventListener("click", async () => {
    const next = control.getAttribute("aria-checked") !== "true";
    control.disabled = true;
    try {
      await onChange(next);
      control.setAttribute("aria-checked", String(next));
    } catch (error) {
      toast(error?.message || String(error), "bad");
    } finally {
      control.disabled = false;
    }
  });
  return control;
}

export function segmented(options, value, onChange) {
  const group = h("div", { class: "segmented", role: "group" });
  for (const [key, label] of options) {
    const choice = h("button", { type: "button", "aria-pressed": String(key === value) }, label);
    choice.addEventListener("click", () => {
      for (const other of group.children) other.setAttribute("aria-pressed", String(other === choice));
      onChange(key);
    });
    group.append(choice);
  }
  return group;
}

export function srcBadge(source) {
  const letter = { claude: "C", codex: "X", chatgpt: "G", agy: "A", hermes: "H" }[source] || (source || "?").slice(0, 1).toUpperCase();
  return h("span", { class: `src ${source || ""}`, "aria-hidden": "true" }, letter);
}

/** A hidden technical answer the user can open, for when something went wrong. */
export function details(summary, value) {
  return h("details", { class: "raw" }, h("summary", { class: "muted" }, summary),
    h("pre", { class: "log" }, typeof value === "string" ? value : JSON.stringify(value, null, 2)));
}
