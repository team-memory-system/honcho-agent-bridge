const $ = (selector) => document.querySelector(selector);

function show(target, value) {
  const element = $(target);
  element.hidden = false;
  element.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return response.json();
}

function esc(value) {
  const element = document.createElement("div");
  element.textContent = String(value ?? "");
  return element.innerHTML;
}

function row(label, ok, detail) {
  return `<div class="status-row"><b>${esc(label)}</b><span class="${ok ? "ok" : "bad"}">${ok ? "준비됨" : "필요함"}</span><span class="muted">${esc(detail)}</span></div>`;
}

const CHECK_LABELS = {
  configuration: "설정 파일",
  runtime: "수집기 런타임",
  honcho: "Honcho 연결",
  hooks: "훅",
  "shared-bridge": "공유 브리지",
};

function checkDetail(check) {
  if (Array.isArray(check.missingFiles) && check.missingFiles.length) {
    return `빠진 파일 ${check.missingFiles.length}개`;
  }
  return check.state || check.path || "";
}

function statusRows(payload) {
  const detect = payload.detect || {};
  const doctor = payload.doctor || {};
  const rows = [];
  // A machine that only asks someone else's memory installs no hooks; listing them
  // as missing would tell that person something is broken when nothing is.
  const checkNames = new Set((doctor.checks || []).map((check) => check.name));
  const relayOnly = checkNames.has("shared-bridge") && !checkNames.has("runtime");
  for (const [provider, state] of Object.entries(detect.agents || {})) {
    rows.push(row(`${provider} 설치됨`, Boolean(state?.detected), state?.configPath || ""));
    if (relayOnly) continue;
    rows.push(row(`${provider} 훅`, Boolean(state?.hook?.installed ?? state?.plugin?.installed), state?.hook?.path || ""));
  }
  for (const check of doctor.checks || []) {
    rows.push(row(CHECK_LABELS[check.name] || check.name, Boolean(check.ok), checkDetail(check)));
  }
  if (!rows.length) rows.push('<p class="muted">상태를 읽지 못했습니다.</p>');
  return rows.join("");
}

async function loadStatus() {
  $("#status").innerHTML = '<p class="muted">확인 중…</p>';
  try {
    const payload = await api("/api/status");
    $("#status").innerHTML = statusRows(payload);
    show("#status-detail", payload);
  } catch (error) {
    $("#status").innerHTML = `<p class="muted">${error.message}</p>`;
  }
}

function setupBody(extra = {}) {
  const form = new FormData($("#setup-form"));
  const body = { ...extra };
  for (const [key, value] of form.entries()) if (String(value).trim()) body[key] = String(value).trim();
  return body;
}

$("#refresh").addEventListener("click", () => { loadStatus(); loadBridgeState(); });

// What went wrong, in the terms of what the person typed. The raw result stays
// underneath for whoever they ask for help.
function bridgeProblem(payload) {
  const text = [payload?.error, ...(payload?.issues || [])].filter(Boolean).join(" ");
  // What the form got wrong comes first: these messages mention the token too.
  if (/not a valid URL|--url is required/.test(text)) return "브리지 주소를 확인하세요.";
  if (/must use https/.test(text)) return "주소는 https로 시작해야 합니다.";
  if (/token is required/.test(text)) return "브리지 토큰을 넣으세요.";
  if (/both its ID and its secret/.test(text)) return "서비스 토큰은 ID와 비밀을 둘 다 넣어야 합니다.";
  if (/MCP bridge 401|Unauthorized/i.test(text)) return "브리지 토큰이 맞지 않습니다.";
  if (/MCP bridge 403|Forbidden/i.test(text)) return "Cloudflare가 막았습니다. 서비스 토큰 ID와 비밀을 확인하세요.";
  if (/timed out|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|MCP bridge 5\d\d/i.test(text)) {
    return "그 주소에서 브리지가 응답하지 않습니다. 주소를 확인하거나 기억 주인에게 브리지가 켜져 있는지 물어보세요.";
  }
  return "연결하지 못했습니다. 아래 내용을 기억 주인에게 보여 주세요.";
}

function bridgeSummary(payload) {
  if (!payload?.connected) return "연결 안 됨";
  const tools = payload.tools?.length ? ` · 쓸 수 있는 도구: ${payload.tools.join(", ")}` : "";
  return `연결됨 · ${payload.url}${tools}`;
}

async function loadBridgeState() {
  const payload = await api("/api/bridge/status");
  $("#bridge-state").textContent = bridgeSummary(payload);
}

$("#bridge-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = $("#bridge-form").elements;
  show("#bridge-result", "연결하고 확인하는 중… 최대 30초 걸립니다.");
  const payload = await api("/api/bridge/connect", {
    url: form.url.value.trim(),
    token: form.token.value,
    accessClientId: form.accessClientId.value,
    accessClientSecret: form.accessClientSecret.value,
  });
  if (payload.ok) {
    // Saved and proven; nothing on this page needs to keep holding them.
    for (const name of ["token", "accessClientId", "accessClientSecret"]) form[name].value = "";
    show("#bridge-result", `연결했습니다. 쓰는 에이전트를 다시 시작하면 도구가 보입니다.\n\n${JSON.stringify(payload, null, 2)}`);
  } else {
    show("#bridge-result", `${bridgeProblem(payload)} 저장하지 않았습니다.\n\n${JSON.stringify(payload, null, 2)}`);
  }
  $("#bridge-state").textContent = payload.ok ? bridgeSummary(payload) : $("#bridge-state").textContent;
  await loadStatus();
});

document.querySelector("[data-bridge='test']").addEventListener("click", async () => {
  show("#bridge-result", "확인 중… 최대 30초 걸립니다.");
  const payload = await api("/api/bridge/test", {});
  show("#bridge-result", `${payload.ok ? "잘 연결되어 있습니다." : bridgeProblem(payload)}\n\n${JSON.stringify(payload, null, 2)}`);
  $("#bridge-state").textContent = payload.connected ? bridgeSummary(payload) : "연결 안 됨";
});

document.querySelector("[data-bridge='disconnect']").addEventListener("click", async () => {
  const payload = await api("/api/bridge/disconnect", {});
  show("#bridge-result", `${payload.ok ? "연결을 끊었습니다. 쓰는 에이전트를 다시 시작하세요." : "끊지 못했습니다."}\n\n${JSON.stringify(payload, null, 2)}`);
  await loadBridgeState();
});

loadBridgeState().catch(() => { $("#bridge-state").textContent = "상태를 읽지 못했습니다."; });

$("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  show("#setup-result", "설치 중…");
  show("#setup-result", await api("/api/setup/apply", setupBody()));
  await loadStatus();
});

document.querySelector("[data-setup='plan']").addEventListener("click", async () => {
  show("#setup-result", "확인 중…");
  show("#setup-result", await api("/api/setup/plan", setupBody()));
});

for (const button of document.querySelectorAll("[data-server]")) {
  button.addEventListener("click", async () => {
    show("#server-result", `${button.textContent} 실행 중…`);
    show("#server-result", await api(`/api/server/${button.dataset.server}`, { profile: "personal" }));
  });
}

for (const button of document.querySelectorAll("[data-proxy]")) {
  button.addEventListener("click", async () => {
    show("#server-result", `${button.textContent} 실행 중…`);
    show("#server-result", await api(`/api/proxies/${button.dataset.proxy}`, {}));
  });
}

async function loadProxyConfig() {
  const payload = await api("/api/proxies/config");
  if (!payload.ok) { show("#server-result", payload); return; }
  $("#proxy-config").elements.llmProxyRoot.value = payload.llmProxyRoot || "";
  for (const name of ["codex", "claude", "router"]) {
    $("#proxy-config").elements[name].checked = Boolean(payload.proxies?.[name]?.enabled);
  }
}

$("#proxy-config").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = $("#proxy-config").elements;
  show("#server-result", "저장 중…");
  show("#server-result", await api("/api/proxies/config", {
    llmProxyRoot: form.llmProxyRoot.value.trim(),
    proxies: {
      codex: { enabled: form.codex.checked },
      claude: { enabled: form.claude.checked },
      router: { enabled: form.router.checked },
    },
  }));
});

loadProxyConfig().catch(() => {});

const fileInput = $("#chatgpt-file");
fileInput.addEventListener("change", () => {
  $("#chatgpt-import").disabled = !fileInput.files?.length;
  $("#chatgpt-progress").textContent = fileInput.files?.[0]
    ? `${fileInput.files[0].name} · ${(fileInput.files[0].size / 1_048_576).toFixed(1)} MB`
    : "";
});

$("#chatgpt-import").addEventListener("click", async () => {
  const file = fileInput.files?.[0];
  if (!file) return;
  $("#chatgpt-import").disabled = true;
  show("#chatgpt-result", "올리고 읽는 중… 대화가 많으면 몇 분 걸립니다.");
  try {
    // The file is the request body, so nothing has to hold it in memory twice.
    const response = await fetch("/api/import/chatgpt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: file,
    });
    show("#chatgpt-result", await response.json());
  } catch (error) {
    show("#chatgpt-result", String(error?.message || error));
  } finally {
    $("#chatgpt-import").disabled = false;
  }
});

loadStatus();
