// Line icons, 16px, drawn for this app. One stroke weight, no fills.
import { svg } from "./dom.js";

const wrap = (body) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const PATHS = {
  memory: '<path d="M3 2.5h7.5L13 5v8.5H3z"/><path d="M10.5 2.5V5H13"/><path d="M5.5 8h5M5.5 10.5h3.5"/>',
  ask: '<path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z"/><path d="M6 6.5h4"/>',
  models: '<rect x="3" y="3" width="10" height="10" rx="1.5"/><path d="M6 6h4v4H6z"/><path d="M6 1.5V3M10 1.5V3M6 13v1.5M10 13v1.5M1.5 6H3M1.5 10H3M13 6h1.5M13 10h1.5"/>',
  connect: '<path d="M6.5 9.5l3-3"/><path d="M7.5 4.5l1-1a2.5 2.5 0 013.5 3.5l-1 1"/><path d="M8.5 11.5l-1 1A2.5 2.5 0 014 9l1-1"/>',
  server: '<rect x="2.5" y="2.5" width="11" height="4.5" rx="1"/><rect x="2.5" y="9" width="11" height="4.5" rx="1"/><path d="M5 4.75h.01M5 11.25h.01"/>',
  tools: '<path d="M3 4.5h5M11 4.5h2M3 11.5h2M8 11.5h5"/><circle cx="9.5" cy="4.5" r="1.5"/><circle cx="6.5" cy="11.5" r="1.5"/>',
  start: '<path d="M3 13.5V2.5"/><path d="M3 3h8.5l-1.5 2.5L11.5 8H3"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="M10.25 10.25L13.5 13.5"/>',
  refresh: '<path d="M13 7.5A5 5 0 104 11.5"/><path d="M13 3.5v4h-4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1"/><path d="M10.5 5.5v-3h-8v8h3"/>',
  check: '<path d="M3 8.5l3 3 7-7"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  up: '<path d="M8 12.5v-9M4.5 7L8 3.5 11.5 7"/>',
  down: '<path d="M8 3.5v9M4.5 9L8 12.5 11.5 9"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z"/>',
  arrow: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  back: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
  send: '<path d="M3 8h9.5M8.5 4l4 4-4 4"/>',
  upload: '<path d="M8 10.5V2.5M4.5 6L8 2.5 11.5 6"/><path d="M2.5 10.5v3h11v-3"/>',
  external: '<path d="M9 2.5h4.5V7"/><path d="M13.5 2.5L7.5 8.5"/><path d="M11.5 9.5v4h-9v-9h4"/>',
  person: '<circle cx="8" cy="5.5" r="2.75"/><path d="M2.75 13.5c.75-2.5 2.75-3.75 5.25-3.75s4.5 1.25 5.25 3.75"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1"/>',
  play: '<path d="M5 3.5v9l7.5-4.5z"/>',
  warn: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.5h.01"/>',
  dot: '<circle cx="8" cy="8" r="2.5"/>',
  quote: '<path d="M3.5 5.5h3.5v3.5c0 1.5-1 2.5-2.5 2.75M9 5.5h3.5v3.5c0 1.5-1 2.5-2.5 2.75"/>',
};

export function icon(name, className = "icon") {
  return svg(wrap(PATHS[name] || PATHS.dot), className);
}
