// Choosing a folder of the computer this app runs on, inside the page: a browser
// does not hand a page the path of a folder picked in the system's own window, and
// this works the same when the app is opened from another computer. The folders
// come from /api/app/folders (scripts/folders.mjs).
import { get } from "./api.js";
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { button, spinner } from "./ui.js";

const REASONS = {
  "not-absolute": "전체 경로가 아닙니다.",
  missing: "폴더를 찾을 수 없습니다. 드라이브가 연결돼 있는지 확인하세요.",
  "not-directory": "폴더가 아닙니다.",
  unreadable: "이 폴더를 읽을 수 없습니다. 권한을 확인하세요.",
};

function rootLabel(root) {
  if (root.kind === "home") return "홈";
  return root.name || root.path;
}

/** Opens the picker at `start` (or the home folder). Resolves the chosen path, or null. */
export function pickFolder({ title = "폴더 고르기", start = "", confirm = "이 폴더 고르기" } = {}) {
  return new Promise((resolve) => {
    let current = null;
    const roots = h("div", { class: "picker-roots" });
    const where = h("div", { class: "picker-path" });
    const list = h("div", { class: "picker-list", role: "listbox", "aria-label": "폴더" });
    const choose = button(confirm, { kind: "primary", onClick: () => dialog.close("ok") });
    const dialog = h("dialog", { class: "sheet folder-picker" },
      h("div", { class: "sheet-body" }, h("h3", {}, title), roots, where, list),
      h("div", { class: "sheet-foot" }, button("취소", { onClick: () => dialog.close("cancel") }), choose),
    );

    async function open(path, { fallback = false } = {}) {
      choose.disabled = true;
      clear(list, h("div", { class: "picker-empty" }, spinner()));
      let result;
      try {
        result = await get(`/api/app/folders?${new URLSearchParams(path ? { path } : {})}`);
      } catch (error) {
        clear(list, h("div", { class: "picker-empty" }, error.message));
        return;
      }
      if (!result.ok) {
        // A start folder on a drive that is gone opens the home folder instead.
        if (fallback) return open("");
        clear(list, h("div", { class: "picker-empty" }, REASONS[result.reason] || result.error || "열 수 없습니다."));
        return;
      }
      current = result.path;
      choose.disabled = false;
      clear(roots, (result.roots || []).map((root) => h("button", {
        type: "button",
        class: `picker-root${current === root.path ? " on" : ""}`,
        onclick: () => open(root.path),
      }, rootLabel(root))));
      clear(where,
        result.parent ? button("", { kind: "small icon-only quiet", iconName: "up", title: "위 폴더", onClick: () => open(result.parent) }) : null,
        h("code", { class: "mono" }, result.path));
      clear(list,
        result.folders.length
          ? result.folders.map((folder) => h("button", { type: "button", class: "picker-item", onclick: () => open(folder.path) }, icon("folder"), h("span", {}, folder.name)))
          : h("div", { class: "picker-empty" }, "안에 폴더가 없습니다."),
        result.truncated ? h("div", { class: "picker-empty" }, "폴더가 많아 앞의 1000개만 보입니다.") : null,
      );
      list.scrollTop = 0;
    }

    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok" ? current : null);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    open(start, { fallback: Boolean(start) });
  });
}
