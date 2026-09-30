// Every request the page makes goes to this app's own server, which relays it to
// Honcho, the dashboard or the gateway. Errors come back as one shape.

export class ApiError extends Error {
  constructor(message, { status = 0, unreachable = false, payload = null } = {}) {
    super(message);
    this.status = status;
    this.unreachable = unreachable;
    this.payload = payload;
  }
}

function messageFrom(payload, status) {
  if (!payload) return `HTTP ${status}`;
  if (typeof payload === "string") return payload.slice(0, 300);
  const detail = payload.detail;
  if (Array.isArray(detail)) return detail.map((entry) => entry.msg || String(entry)).join(", ");
  if (typeof detail === "string" && !payload.unreachable) return detail;
  if (payload.error) return String(payload.error);
  if (Array.isArray(payload.issues) && payload.issues.length) return payload.issues.join(" · ");
  return `HTTP ${status}`;
}

export async function request(path, { method = "GET", body, signal } = {}) {
  const init = { method, headers: { accept: "application/json" }, signal };
  if (body !== undefined || (method !== "GET" && method !== "HEAD")) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body ?? {});
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError("이 앱의 서버에 연결할 수 없습니다. 창을 닫았다가 다시 열어 주세요.", { unreachable: true });
  }
  const type = response.headers.get("content-type") || "";
  const payload = type.includes("json") ? await response.json().catch(() => null) : await response.text();
  if (!response.ok) {
    throw new ApiError(messageFrom(payload, response.status), {
      status: response.status,
      unreachable: Boolean(payload?.unreachable),
      payload,
    });
  }
  return payload;
}

export const get = (path, options) => request(path, { ...options, method: "GET" });
export const post = (path, body, options) => request(path, { ...options, method: "POST", body });

/** Honcho's API, under the workspace the page is looking at. */
export function honcho(workspace) {
  const base = `/api/honcho/v3/workspaces/${encodeURIComponent(workspace)}`;
  return {
    get: (path, options) => get(`${base}${path}`, options),
    post: (path, body = {}, options) => post(`${base}${path}`, body, options),
    del: (path) => request(`${base}${path}`, { method: "DELETE" }),
  };
}

/** The gateway's own API, relayed. */
export const gateway = {
  status: (options) => get("/api/gw/api/status", options),
  post: (path, body = {}) => post(`/api/gw/api${path}`, body),
};

/** The CLI-backed routes return { ok:false, error } with HTTP 200. */
export async function cli(path, body = {}) {
  const result = await post(path, body);
  if (result && result.ok === false) {
    throw new ApiError(messageFrom(result, 200), { payload: result });
  }
  return result;
}
