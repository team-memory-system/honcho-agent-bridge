// Two menu items hold several screens, switched by tabs under the page title.

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
