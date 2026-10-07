// The bell at the top right of every page: what waits for this person to press,
// and only that, such as a request to approve. Each kind of thing registers a
// source; the bell asks them all, shows how many there are, and lists them.
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";

const sources = new Set();
let redraw = null;

/** `load()` resolves to the rows waiting now, each a list item with its own buttons. */
export function bellSource(load) {
  sources.add(load);
  redraw?.();
  return () => {
    sources.delete(load);
    redraw?.();
  };
}

/** Asks every source again, after something was pressed or changed. */
export function refreshBell() {
  return redraw?.();
}

export function mountBell(container) {
  const count = h("b", { hidden: true });
  const bell = h("button", { class: "bell", type: "button", title: "알림", "aria-label": "알림", "aria-expanded": "false" }, icon("bell"), count);
  const pop = h("div", { class: "bell-pop", role: "dialog", "aria-label": "알림", hidden: true });
  let rows = [];
  const draw = () => {
    count.hidden = !rows.length;
    count.textContent = String(rows.length);
    bell.setAttribute("aria-label", rows.length ? `알림 ${rows.length}개` : "알림");
    clear(pop, h("div", { class: "bell-pop-h" }, "알림"), rows.length ? rows : h("div", { class: "list-empty" }, "알림이 없습니다."));
  };
  const show = (open) => {
    pop.hidden = !open;
    bell.setAttribute("aria-expanded", String(open));
  };
  redraw = async () => {
    const lists = await Promise.all([...sources].map((load) => Promise.resolve().then(load).catch(() => [])));
    rows = lists.flat().filter(Boolean);
    draw();
  };
  bell.addEventListener("click", () => {
    const open = pop.hidden;
    show(open);
    if (open) redraw();
  });
  document.addEventListener("click", (event) => {
    if (!pop.hidden && !pop.contains(event.target) && !bell.contains(event.target)) show(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !pop.hidden) show(false);
  });
  container.append(bell, pop);
  draw();
  return { refresh: () => redraw() };
}
