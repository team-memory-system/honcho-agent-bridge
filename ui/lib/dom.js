// A small element builder. Text always goes in as text, never as markup, so a
// memory that contains HTML is shown as what it is.

export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") element.className = value;
    else if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") element.addEventListener(key.slice(2), value);
    else if (key === "style" && typeof value === "object") Object.assign(element.style, value);
    else if (value === true) element.setAttribute(key, "");
    else element.setAttribute(key, String(value));
  }
  append(element, children);
  return element;
}

export function append(parent, children) {
  for (const child of children.flat(Infinity)) {
    if (child === undefined || child === null || child === false) continue;
    parent.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return parent;
}

export function clear(element, ...children) {
  element.replaceChildren();
  return append(element, children);
}

export const $ = (selector, root = document) => root.querySelector(selector);

export function svg(markup, className = "icon") {
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  const node = template.content.firstElementChild;
  node.setAttribute("class", className);
  node.setAttribute("aria-hidden", "true");
  return node;
}

/** Copy to the clipboard, with a fallback for pages the browser treats as insecure. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h("textarea", { style: { position: "fixed", opacity: "0" } }, text);
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

export function debounce(fn, wait = 250) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}
