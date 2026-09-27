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
  for (const [provider, state] of Object.entries(detect.agents || {})) {
    rows.push(row(`${provider} 설치됨`, Boolean(state?.detected), state?.configPath || ""));
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

$("#refresh").addEventListener("click", loadStatus);

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
