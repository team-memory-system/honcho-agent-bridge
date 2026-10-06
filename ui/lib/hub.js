// A menu item that holds several pages: #/<name> lists them with where each
// stands, and #/<name>/<page> opens one under a link back to the list. Two menu
// items hold several screens instead, switched by tabs under the title.
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { pageHead, tag } from "./ui.js";

/** The screens of a tabbed menu item; the first is the one the menu opens. */
export const TABS = {
  memory: [["memory", "찾기"], ["ask", "묻기"]],
  server: [["server", "기억 서버"], ["models", "모델"], ["share", "공유"]],
};

/** The tabs for a page header, with `current` marked. */
export function screenTabs(current) {
  const group = Object.values(TABS).find((screens) => screens.some(([name]) => name === current));
  return group.map(([name, label]) => [`#/${name}`, label, name === current]);
}

/**
 * Pages are { key, title, why, open(page, head), available?, state?, refine? }.
 * `open` draws the page under `head` ({ title, subtitle, back }); a page whose
 * `available()` is false is left off the list and its address shows the list.
 * `state()` gives the row's { label, kind, detail }, and `refine(update)` may call
 * `update` with a new one once something slower answers.
 */
export function hub({ name, title, subtitle, pages }) {
  const open = () => pages.filter((item) => !item.available || item.available());
  return {
    title,
    pages,
    available: open,
    async mount(frame, params) {
      const listed = open();
      const item = listed.find((entry) => entry.key === params[0]);
      if (params[0] && !item) history.replaceState(null, "", `#/${name}`);
      if (item) {
        const mounted = await item.open(frame, { title: item.title, subtitle: item.why, back: { href: `#/${name}`, label: title } });
        // Only a cleanup is passed on: the shell would hand a page's `update` the
        // list's own addresses too, and the list draws itself anew instead.
        return { cleanup: mounted?.cleanup || null };
      }
      const stateNodes = (state = {}) => [state.label ? tag(state.label, state.kind || "") : null, h("small", {}, state.detail || "")];
      const rows = listed.map((entry) => {
        const cell = h("div", { class: "task-state" }, stateNodes(entry.state?.()));
        entry.refine?.((state) => clear(cell, stateNodes(state)));
        return h("a", { class: "task", href: `#/${name}/${entry.key}` },
          h("div", { class: "task-main" }, h("b", {}, entry.title), h("span", { class: "why" }, entry.why)),
          cell,
          icon("arrow"),
        );
      });
      frame.append(
        pageHead({ title, subtitle }),
        h("div", { class: "page-body" }, h("div", { class: "pad" }, h("nav", { class: "tasks", "aria-label": title }, rows))),
      );
      return null;
    },
  };
}
