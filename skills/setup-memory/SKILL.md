---
name: setup-memory
description: Connect to someone else's shared memory, or install, update, or diagnose the bundled self-hosted personal-memory runtime for Codex and Claude Code. Use when the user asks to set up memory, connect to a teammate's or colleague's memory, connect coding agents to Honcho, choose which detected agents receive hooks, inspect an installation plan, repair hooks, or run a memory health check.
disable-model-invocation: true
---

# Setup Memory

Use the deterministic CLI bundled at `<plugin-root>/scripts/cli.mjs`. Resolve `<plugin-root>` as the directory two levels above this `SKILL.md`. Never reconstruct its mutations manually when the CLI supports them.

Speak to the user in the language they wrote in: progress notes, questions, warnings and summaries alike (Korean for a Korean request). This file and the CLI's JSON are in English; translate what you pass on and never switch to English mid-setup.

The Team Memory app is the one screen the user works in. Whenever they have to do something in a browser (log in to a subscription, enter a teammate's connection details, look at the server), open the app with `node <plugin-root>/scripts/cli.mjs ui open --screen <name>` and give its returned `url` as text too. Screens: `start` (시작하기), `server` (서버), `models` (게이트웨이), `connect` (대화 동기화), `connect/share` (다른 사람 기억에 묻기). Do not send them to the gateway's own page at 11450.

## Fixed lines

Say these lines exactly as written whenever their moment comes, in Korean for a Korean user (keep the meaning, not a paraphrase, in another language). Fill in only the `<...>` parts. Do not add commentary, recaps or tips around them; between them, say nothing but a CLI error translated into the user's language. Structured questions use the question text and options given here.

| When | Say |
|---|---|
| Start | 팀 메모리 설치를 시작합니다. 먼저 이 컴퓨터에서 쓸 기능을 고르세요. 여러 개를 같이 골라도 됩니다. |
| Feature question | Question "이 컴퓨터에서 쓸 기능을 고르세요." with the three options in "First: which features" |
| Prerequisites all present | 필요한 프로그램이 모두 있습니다. |
| A required program missing | <프로그램>이 없습니다. 공식 설치 방법(<install.command 또는 install.url>)으로 설치할까요? |
| WARP install | Cloudflare WARP를 설치합니다. 다른 컴퓨터의 기억 서버와 팀원 기억에 닿게 해 주는 프로그램입니다. |
| WARP install, before running it | 곧 암호 창이 뜹니다. Mac 암호를 넣으면 WARP가 설치됩니다(Windows는 허용 창에서 예). |
| WARP installer open (`warp-installer`, the fallback) | WARP 설치 창을 열었습니다. 계속 → 설치를 누르고 Mac 암호를 넣어 주세요. 처음 화면에서 1.1.1.1과 Cloudflare One 중에 고르라고 하면 Cloudflare One을 고르고 팀 이름 <team>을 넣으세요. 끝나면 "했어"라고 말해 주세요. |
| WARP install cancelled | 설치를 취소했습니다. 다시 하려면 "다시"라고 말해 주세요. |
| WARP team join | WARP를 같이 쓰는 Cloudflare 계정에 등록합니다. 그 계정의 팀 이름(로그인 주소 `<이름>.cloudflareaccess.com`의 앞부분)을 알려 주세요. 모르면 계정을 만든 사람에게 받고, 내 이메일을 기기 등록 허용 목록에 넣어 달라고 하세요. 계정을 직접 만들었다면 그 이름을 쓰면 됩니다. |
| WARP login | 브라우저에 팀 로그인 창이 열렸습니다. 팀이 정한 방법(보통 이메일로 받은 코드)으로 로그인해 주세요. 끝나면 "했어"라고 말해 주세요. |
| WARP login failed ("Enrollment request is invalid" or another error page) | 로그인이 끝나지 않았습니다. 제가 로그인 창을 새로 띄우겠습니다. 이번 창에서 바로 로그인해 주세요. (then run `warp-cli registration new <team>` again; if it fails twice, the email is probably not allowed in the team's device enrollment rules — tell the user to ask whoever runs the Cloudflare account to allow it) |
| Server plan confirmation | Question "서버를 이렇게 설치합니다. 진행할까요?" whose text lists, one line each and only those in the plan: Docker Desktop 설치 (첫 실행 때 약관 동의와 Mac 암호 필요) / Ollama와 임베딩 모델(Qwen3-Embedding 4B, 약 2.5GB) 받기 / 구독 게이트웨이 설치 (로그인하면 자동으로 켜짐) / 기억 서버 설치 (주소 <apiUrl>), then the Docker license warning: 회사 직원이 250명 이상이거나 매출이 1천만 달러 이상이면 Docker 유료 구독이 필요합니다. Options "진행", "취소" |
| Before prepare, when it installs Docker | 곧 Docker Desktop 창이 뜹니다. 약관에 동의(Accept)하고, 추천 설정(Use recommended settings)을 고른 뒤 Mac 암호를 넣어 주세요. 로그인이나 설문은 건너뛰어도 됩니다. 끝나면 제가 이어서 진행합니다. |
| Before prepare otherwise | 서버를 준비합니다. 몇 분 걸릴 수 있습니다. |
| `docker-first-run` | Docker Desktop 첫 실행이 아직 끝나지 않았습니다. Docker 창에서 약관 동의, 추천 설정, Mac 암호까지 마친 뒤 "했어"라고 말해 주세요. |
| `gateway-login` | 구독 계정 로그인이 필요합니다. 방금 연 팀 메모리 앱의 게이트웨이 화면(<url>)에서 "Codex 추가"나 "Claude 추가"를 누르고 브라우저 로그인을 마치세요. 끝나면 "했어"라고 말해 주세요. 비밀번호나 토큰은 채팅에 붙여 넣지 마세요. |
| Server started and verified | 기억 서버가 켜졌습니다. 기억은 팀 메모리 앱(<ui open의 url>)에서 볼 수 있습니다. |
| Agents question | Question "어느 에이전트의 대화를 보낼까요?" Options "찾은 에이전트 모두 (<이름들>)", "지금 쓰는 <이름>만", "직접 고르기" |
| Peer ID question (only when none is configured) | 기억에서 나를 가리킬 이름을 정해 주세요. 영문 소문자와 밑줄로 씁니다. 예: user_hong |
| Server elsewhere | 기억 서버의 주소를 알려 주세요. 서버 토큰은 채팅에 쓰지 말고, 제가 알려 드리는 명령을 터미널에서 직접 실행하세요. |
| Setup plan confirmation | Question "대화 동기화를 이렇게 설정합니다. 진행할까요?" whose text lists the files from `operations`. Options "진행", "취소" |
| `approve-hook` | Codex를 새로 열면 훅 승인 창이 뜹니다. "Syncing codex conversation to personal memory"만 승인하세요. 승인하기 전에는 Codex 대화가 모이지 않습니다. |
| `reload-plugins` | 이미 열려 있는 Claude Code 창에서는 `/reload-plugins`를 입력하세요. |
| Chat connection | 팀원에게 받은 주소와 토큰을 방금 연 앱 화면(<url>)에 넣고 "연결"을 누르세요. 채팅에는 붙여 넣지 마세요. 끝나면 "했어"라고 말해 주세요. |
| Chat connected | 팀원 기억에 연결했습니다. 에이전트를 다시 시작하면 <chat 또는 shared_chat> 도구로 물을 수 있습니다. |
| Stopped on an error | <단계>에서 멈췄습니다. <오류를 사용자의 말로 옮긴 것> |
| Done | 설치가 끝났습니다. 켠 기능: <기능들>. 문제가 생기면 `/memory-doctor`를 입력하세요. |

Use the detected default data directory without asking; ask about it only when the user brings it up.

## First: which features

Ask one question before anything else: which of these three features this computer should have. They are independent and combine; ask it as a multi-select. Use these labels and descriptions as written, in the user's language (Korean shown). Do not rename them, do not present them as mutually exclusive paths, do not add options (no "plugin only", "later" or "skip"; the question tool already lets the user answer otherwise), and never name a particular computer in them. Present the three neutrally: do not recommend, discourage or presume any of them, do not say what people "usually" pick or how many servers a person has, and never describe the user's setup from examples in this file or the docs; anything you add beyond the labels below is noise. Prefer the host's structured question tool. Skip the question when the request already says which.

- **서버 설치** — 이 컴퓨터에 기억 서버를 설치합니다. 다른 컴퓨터의 대화도 이 서버로 받을 수 있습니다. → "Own memory workflow" below, step 1 (the server).
- **대화 동기화** — 이 컴퓨터의 Claude Code·Codex 대화를 기억 서버로 보냅니다. 서버가 이 컴퓨터에 있으면 그리로, 다른 컴퓨터에 있으면 그 주소와 서버 토큰으로 보냅니다. → "Own memory workflow" below, steps 2–10, with "Own server on another computer" when the server is elsewhere.
- **다른 사람 기억에 묻기 (chat)** — 팀원이 공유한 기억에 질문합니다. 팀원에게 받은 연결 정보가 필요합니다. → "Asking someone else's memory" below.

With 서버 설치 but not 대화 동기화, install and start the server and skip the hooks. With 대화 동기화 but not 서버 설치, never install a server here; ask for the address of the server they already have. Do them in this order: server, then sync, then chat.

Sending some folders to a company server as well is not a fourth feature; offer it after 대화 동기화 is set up, only if the user asks (see "Also sending some folders to another server").

## Then: required software, before anything else

Once the features are chosen, check the software they need and get it installed first. Do not start the plugin's setup, `server plan` or `bridge connect` while something required is missing.

1. Node.js 18 or later must exist before the plugin's CLI can run. Check it with the shell (`node --version`). If it is missing, install it from nodejs.org (the LTS installer), or with `brew install node` when Homebrew is already there (macOS), or with `winget install --id OpenJS.NodeJS.LTS -e` (Windows).
2. Then run `node <plugin-root>/scripts/cli.mjs prereqs --features <chosen,features>`. It reports each item as `required` or `app-installs`, with its `install.command`/`install.url`. Cloudflare WARP is required for every feature: every computer joins the team's WARP, and that is what lets it reach the servers and teammates' memories behind Cloudflare Access.
   - git missing: offer the reported official command, as its own confirmation. Never pipe a downloaded script into a shell. Rerun `prereqs` after.
   - WARP missing: do not explain it; install it. First say the "WARP team join" line and get the team name (never guess it). Then say the "WARP install" and "WARP install, before running it" lines and run `node <plugin-root>/scripts/cli.mjs prereqs install warp --team <team>`. The team goes into the same install, so WARP never shows its "1.1.1.1 or Cloudflare One" choice. It downloads Cloudflare's signed installer, checks the signature and asks for the password in the system's own dialog, then installs silently. `nextAction.kind: "warp-team-login"` means WARP is installed and opens the team login in the browser by itself: say the "WARP login" line (if no browser window appears, run `warp-cli registration new <team>`); `cancelled: true` gets the "WARP install cancelled" line; `nextAction.kind: "warp-installer"` (no password dialog was possible, so the installer window was opened) gets the "WARP installer open" line and a rerun of `prereqs` once the user says it is done. If macOS asks to allow a VPN configuration when WARP first starts, the user allows it.
   - WARP installed but not in a team (or already installed before this setup): say the "WARP team join" line. With the team name, run `warp-cli registration new <team>` (it opens a browser login) and say the "WARP login" line; when the user says it is done, run `warp-cli connect`. Never guess the team name. Rerun `prereqs`; it reports the team it is connected to.
   - `app-installs` (Docker Desktop and Ollama for 서버 설치): nothing to do now; `server prepare` installs them.
   - Never bring up Cloudflare service tokens. They are an advanced fallback for a computer that cannot run WARP, and only when the user asks for that.
3. The app's 시작하기 screen shows the same check as its first step.

## Asking someone else's memory

The teammate who shares their memory gives the user two values: an address and a token. WARP (connected to the team, from the step above) gets this computer past Cloudflare Access. The user enters them in the Team Memory app, not in chat.

1. Run `node <plugin-root>/scripts/cli.mjs ui open --screen connect/share`. It starts the local Team Memory app if it is not already running, opens it on that screen, and returns its `url`. Give the user that address as text as well, in case no browser window appeared.
2. Say the "Chat connection" line. The screen has the address and token fields; the service-token fields sit under "고급: WARP 없이 연결" and stay closed. The screen saves the values only after it has reached the bridge with them, and shows the tools the bridge offers (normally just `chat`).
3. Never ask the user to paste these values into chat, and never pass them on a command line. The terminal equivalent is `bridge connect --url <address>` with the token in `HONCHO_MCP_BEARER_TOKEN` (and, without WARP only, `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`), set by the user in their own shell.
4. When the user says it is done, run `node <plugin-root>/scripts/cli.mjs bridge test` and report `connected`, `url` and `tools`. On failure, report the `error` without guessing at values.
5. Tell the user to restart the agent host so its tool list reloads: Claude Code may use `/reload-plugins`; Codex should start a new session.

This path installs no hooks and needs no local Honcho server. `bridge disconnect` removes the saved values.

On a computer that also syncs its own conversations, `bridge connect` adds to what the agent has rather than replacing it. After the restart the agent keeps its own recall tools (`search`, `chat`, `get_peer_context` and the rest) for the user's own memory, and asks the teammate's memory with `shared_chat` (each shared tool is the bridge's tool with `shared_` in front). `bridge test` still reports the bridge's own names (`chat`). If the bridge is unreachable, the user's own tools keep working and only `shared_*` calls fail.

## Own memory workflow

1. Run `node <plugin-root>/scripts/cli.mjs detect` and inspect the JSON.
   - If a configured Honcho server is already healthy, offer to connect to it and do not replace it.
   - If `honcho.managedByThisInstall` is `false`, something else answers at that address (on one test machine it was an SSH tunnel to another computer's Honcho). Do not treat it as the user's server: ask whether it is theirs. To install a server here anyway, go ahead; `server prepare` picks free ports and never touches that program.
   - If Honcho is unreachable, determine which bundled profile is available. `personal` requires `server/env.personal.example`, `server/host-profile.personal.json` and `server/gateway-source.json`; otherwise use `portable`.
   - Recommend `personal` when it is bundled. Explain that it runs the Docker Honcho stack, the subscription gateway (which turns the user's own Codex and/or Claude subscription into the one router every chat model uses), and Ollama with Qwen3-Embedding 4B (1536 dimensions, 8192-token context) for embeddings. An existing install that already uses the 8B alias keeps it, because its stored vectors were made by 8B. Offer `portable` when the user wants a generic external OpenAI-compatible setup without host services.
   - Run `node <plugin-root>/scripts/cli.mjs server plan --profile <profile>` and show its exact `operations` and `warnings` before any mutation. A closed Docker Desktop is a warning, not a stop: `server prepare` starts it (`start-docker-desktop`) and waits for its engine. A busy 8001 or 4173 is also a warning: the plan's `apiUrl` and `dashboardUrl` show the ports (the dashboard port is only the API the app relays; never send the user there) the new server will use instead. Never delete or replace Docker volumes. For `personal`, point out `gateway-install`: the gateway's own install registers the gateway's own per-user autostart (launchd, the Windows Run key, or systemd), so the user is agreeing to that too.
   - On Windows, Docker Desktop runs on its WSL 2 backend and needs hardware virtualization enabled. The server plan automatically checks Docker CLI/Compose and engine health and whether git can fetch the gateway; personal preparation installs the gateway (its own install brings its npm dependencies) and checks Ollama CLI/API and the base/alias/context. It does not independently enable WSL beyond what Docker's installer does, or preflight every port. When Docker reports an incomplete WSL setup or reboot requirement, stop and tell the user to finish it, reboot if requested, and rerun detection and the plan.
   - For `personal` on macOS or Windows, a missing Docker Desktop or Ollama is not an issue: the plan starts with `install-docker-desktop` and/or `install-ollama` (each with its `url` and `destination`) and warns that Docker Desktop is free for personal use, education, non-commercial open source and small businesses (fewer than 250 employees and less than $10 million revenue) while larger companies and government entities need a paid Docker subscription. Show that warning and get the user's confirmation for it. Tell them what they will be asked: on Windows, the administrator prompt (UAC) for Docker's installer; on both, Docker's first-run window (accept its terms, recommended settings, and on macOS their password). Ollama is downloaded into the app directory, checked against the release's `sha256sum.txt`, and needs nothing from them. Then handle prepare's `nextAction`: `docker-first-run` means finish Docker's window and run prepare again; `restart-required` means restart Windows and run prepare again; `docker-install-approval` means the prompt was declined and prepare should run again with Yes chosen. A non-admin macOS account cannot write `/Applications`; prepare says so, and an administrator has to install Docker Desktop.
   - If git is missing (or Docker for `portable`), offer to install the missing prerequisite with the detected OS's official package manager or vendor installer. Treat this as a separate, explicit confirmation because it installs system software. Verify the publisher/source, avoid piping a downloaded script directly into a shell, and rerun `detect` and `server plan` after installation. On Windows, complete any requested WSL feature enablement and reboot before continuing. If an official unattended path is unavailable, open or provide the official installer and guide the user through it rather than silently substituting an unofficial package.
   - Before running prepare when the plan has `install-docker-desktop`, tell the user in its own short message what is about to happen and what to do, because prepare then waits up to three minutes for Docker's engine and you cannot speak while it runs: "곧 Docker Desktop 창이 뜹니다. 약관에 동의(Accept)하고, 추천 설정(Use recommended settings)을 고른 뒤 Mac 암호를 넣어 주세요. 로그인이나 설문은 건너뛰어도 됩니다. 끝나면 제가 이어서 진행합니다." (adapt for Windows: the administrator prompt, then the same window). When prepare comes back with `docker-first-run`, say plainly which of those steps is left and rerun prepare once they say it is done.
   - After confirmation, run `node <plugin-root>/scripts/cli.mjs server prepare --profile <profile>`. For `personal`, this fetches the gateway into the app directory, runs the gateway's install (its dependencies, its autostart, its screen at `http://127.0.0.1:11450`), asks the gateway for its router address and key, writes them with the chosen chat model into the installed private `.env`, and prepares the Qwen3-Embedding base model (4B for a new install) with its 8192-token alias. For `portable`, if it reports `missingSecretFields`, tell the user which fields to fill in the returned installed `.env` path. Never ask the user to paste their values into chat.
   - For `personal`, model access comes from a login in the gateway's own screen. `codex login` and `~/.codex/auth.json` play no part, and the gateway keeps its logins apart from the user's own CLI logins. When `server prepare` returns `ready: false` with `nextAction.kind: "gateway-login"`, run `node <plugin-root>/scripts/cli.mjs ui open --screen models`, which opens the app's 게이트웨이 screen and returns its `url`; give the user that address as text too. Ask them to press "Codex 추가" or "Claude 추가" there and finish the browser login; the screen connects the account by itself once the browser login finishes. When they say it is done, run `server prepare --profile personal` again. Never ask for a password, token or key in chat.
   - A ready personal prepare reports `chatModel` and `chatModelSource`: `override` for `--model`, `kept` for the model the installed `.env` already uses while the gateway still offers it, `default` for the first of `gpt-6-luna`, `gpt-5.6-luna`, `gpt-5.5`, `claude-haiku-4-5`, `claude-sonnet-5-5` that the gateway offers, otherwise the first model it lists that is not an embedding model. When the gateway offers no chat model at all, prepare returns `ready: false` with the same `gateway-login` next action and the reason in `gateway.reason`; the fix is again a Codex or Claude login in the gateway screen. The choice sticks: later prepares and `server start` keep it without being given `--model` again. If the user wants another one from `gateway.models`, rerun prepare with `--model <id>`.
   - Once `server prepare` reports `ready: true`, run `node <plugin-root>/scripts/cli.mjs server start --profile <profile>`. Its `apiUrl` is the server's address; use `apiUrl` as `--honcho-url` below (setup also defaults to it). With `personal`, this starts the Ollama supervisor and waits for the gateway's router before Compose. Require `server status --profile personal`, `server verify --profile personal`, and Honcho health to pass before continuing. Default verification makes no model call; use `--live-completion` only after the user explicitly asks for or confirms a real completion through the router.
   - After a reboot everything comes back by itself: the gateway through its own autostart, the host supervisor (which keeps the embedding model resident and restarts an Ollama the app downloaded) through the `team-memory-system.host` login item that `host start`/`server start` registers, and the server containers with Docker. If `host status` shows the supervisor down anyway, run `node <plugin-root>/scripts/cli.mjs host start --profile personal` or press 켜기 on the app's 서버 screen. `host start` runs the gateway's install as well and, with no login, returns the same `gateway-login` next action. When `server/gateway-source.json` changed, prepare and `host start` first uninstall the old gateway copy (its logins stay), replace it, and install the new one. If that swap fails, the old copy is put back and installed again; report the returned `error` as it is, and say whether `gateway.source.restored` is true.
2. Ask which detected agents to configure before planning.
   - Prefer the host's native structured question tool when available (`request_user_input` in supported Codex modes or `AskUserQuestion` in Claude Code).
   - Offer all detected agents as the recommended choice, the current agent only, and manual selection.
   - If no structured question tool exists, ask one concise question using the host's permitted interaction style.
3. Use the detected OS application-data location. Only when the user asks for another place, pass it as `--data-dir`.
4. Ask for a user peer ID only when none is already configured. Default the workspace to `memory`. Leave out `--honcho-url` for a server installed here: setup uses the installed server's port. Pass it for a server elsewhere. Use `--codex-root` only when the Codex session directory is nonstandard. If the portable profile needs an API key, have the user place it in the installed private `server/.env`; never request that they paste a secret into chat or pass it as a command-line argument. The personal profile gets its router key from the gateway and writes it into the installed private `.env` itself; the user never handles it.
5. Run the plan without mutation:

```sh
node <plugin-root>/scripts/cli.mjs setup plan \
  --agents codex,claude \
  --user-peer <peer-id> \
  --workspace memory \
  --honcho-url http://127.0.0.1:8001 \
  --data-dir <selected-data-directory>
```

6. Summarize the exact files and agents from `operations`. Do not apply when `ready` is false.
   - Explain every `warning`. Selecting a host without its Honcho Agent Bridge plugin installed and enabled can prepare shared configuration, but that host will not receive the bundled skills, MCP server, or Claude hook.
7. Obtain confirmation before changing host settings. Replace `plan` with `apply` using the same options.
8. Run `node <plugin-root>/scripts/cli.mjs doctor` and report any failed check.
9. Tell the user every entry of `nextSteps` from the apply result, in their words. Collection is not finished without them:
   - `approve-hook` (Codex): Codex shows the new Stop hook for approval when a session starts, or in `/hooks`. Approve only "Syncing codex conversation to personal memory". Nothing from Codex is collected before that.
   - `reload-plugins` (Claude Code): sessions that were already open need `/reload-plugins` or a restart; new sessions need nothing. Earlier turns of those sessions are sent with their next turn.
10. The memory-changing MCP tools (writes and deletes) start turned off; recall does not need them. Mention it only if the user asks for a tool that is missing.

## Own server on another computer

For a user whose own Honcho already runs on another of their computers (reachable from this one), install only the collector here:

1. Install the plugin as usual. Skip `server ...` entirely.
2. Run `setup plan` with `--honcho-url <that server's address>`. If the plan warns that the address requires an API token, ask the user to set `HONCHO_API_TOKEN` in their own terminal and run `setup apply` there themselves, for example `HONCHO_API_TOKEN=... node <plugin-root>/scripts/cli.mjs setup apply ...`. Never ask for the token in chat or put it on a command line you run.
3. If the plan warns that the address "is behind Cloudflare Access and refused this computer", the default fix is for the user to connect Cloudflare WARP with the team account and run `setup plan` again. On a machine without WARP, the user sets both `HONCHO_CF_ACCESS_CLIENT_ID` and `HONCHO_CF_ACCESS_CLIENT_SECRET` (an Access service token) in their own terminal and runs `setup apply` there, the same way as the API token. These are not the `CF_ACCESS_CLIENT_*` values `bridge connect` takes.
4. Continue with `doctor` and `nextSteps` as above.

To make that possible for a personal server on the other computer, share it there first. Ask one question: does the person running the server have a domain on Cloudflare? Without one, use Mesh; with one, either works, and the public address is the established way. Never Tailscale.

**Without a domain (Mesh).** Every computer involved must be enrolled in the same Cloudflare One account.
1. The account owner turns on "Allow all Cloudflare One traffic to reach enrolled devices" once (Networking → Mesh in the Cloudflare One dashboard). This has no API, so the user does it. An agent with the Cloudflare plugin can do the rest, with the user's go-ahead: `PATCH /accounts/{id}/devices/settings` `{use_zt_virtual_ip, gateway_proxy_enabled, gateway_udp_proxy_enabled: true}`, and `100.96.0.0/12` in the split-tunnel Include list (read the list, add the entry, write it back) or out of the Exclude list.
2. On the server's computer run `node <plugin-root>/scripts/cli.mjs server share enable --mesh`. On Windows it asks once for approval to add the firewall rule. Report `mesh.address` and translate every `mesh.problems` entry. `local-only` from `--check` is normal on macOS.
3. On the other computer, `setup apply --honcho-url <mesh.address>` with the gate token in `HONCHO_API_TOKEN`, as below. If `setup plan` warns about WARP or the split tunnel there, that computer's WARP needs fixing, not the server.
4. If `server share status` reports `address-changed`, every other computer needs the new address.

**With a domain (public address, Cloudflare Tunnel plus Access):**

1. The person running the server creates a tunnel in the Cloudflare Zero Trust dashboard (Networks → Tunnels → Create a tunnel → Cloudflared), sets its public hostname's service to `http://localhost:<gate port>` (`server share status` shows the port), and puts an Access application with a WARP-group or email policy on that hostname. For a team, an admin can do this and hand over only the tunnel token.
2. On the server's computer the user runs `HONCHO_TUNNEL_TOKEN=... node <plugin-root>/scripts/cli.mjs server share enable --public-url https://<hostname>` in their own terminal. Never ask for the tunnel token in chat or pass it as an option; the CLI refuses a token option. The app's server screen does the same with the token kept off the command line.
3. `server share status --check` reports `publicCheck.state`: `access` means Cloudflare Access did not let this device in (check the WARP group or the policy), `token` a wrong gate token, `unreachable` the tunnel or the gate being down.
4. The gate token is the `HONCHO_API_TOKEN` for setup on the other computer. The user copies it from the app's server screen, or runs `server share token` in their own terminal; do not run that command yourself, since its output is the secret. `server share disable` turns sharing off and keeps both tokens; `server share rotate` replaces the gate token.

## Also sending some folders to another server

When the user wants the conversations from certain folders to also reach another Honcho (usually the company's), add a target. Their own server still receives everything.

1. Ask for the server address, the folders, and the workspace id there. The user sets `HONCHO_TARGET_API_TOKEN` (and, without WARP behind Cloudflare Access, `HONCHO_TARGET_CF_ACCESS_CLIENT_ID`/`_SECRET`) in their own terminal and runs `node <plugin-root>/scripts/cli.mjs target add <id> --url <https://…> --folders <a,b> [--workspace <id>]` there. Never ask for these in chat or pass them as options; the CLI refuses them.
2. `target add` checks the server first. Report its `warnings` (a folder that does not exist yet) and its `note`: past conversations are not sent until the user asks for `target backfill <id> --since YYYY-MM-DD`. Run a backfill only when the user asks.
3. `target test <id>` and `doctor` (check `target-<id>`) diagnose it; `target set <id> --folders … | --enabled false` changes or pauses it; `target remove <id>` removes it.

Only Codex and Claude Code sessions whose first working directory is inside a target folder are sent there; ChatGPT imports never are. Recall (the MCP tools) reads the user's own server only.

## Safety

- Preserve unrelated hooks and settings. The CLI removes only entries bearing its managed markers and creates timestamped backups before rewriting existing files.
- Never display API tokens, bearer tokens, or secret environment values.
- Never put the gateway's router key on a command line or in chat. `server prepare` writes it into the installed private `.env`, and no result prints it. The opt-in live verification reads it there inside the process, sends it only to this machine's router, discards the completion response body, and reports only success/model.
- The sharing this version supports is connecting to someone else's shared bridge and sending chosen folders to a target the user adds explicitly. Do not add targets, folders or backfills the user did not ask for, and do not add cross-device synchronization.
- Do not claim Honcho was installed when `server start`, `server status`, or `doctor` reports it unreachable. For `personal`, success also requires the gateway's router answering (`host.gateway.router.ok`), healthy Ollama, and the Qwen alias resident.
- Use the same profile for the complete lifecycle. `server status --profile personal` covers Docker, the gateway and Ollama; `server stop --profile personal` stops the containers and the Ollama supervisor while preserving configuration and Docker volumes. The gateway keeps running: it has its own lifecycle, and `node <app-directory>/runtime/subscription-gateway/gateway/cli.mjs uninstall` is what removes it.
- `server stop` preserves Docker volumes. Never run `docker compose down -v` or otherwise delete memory data.
- Do not rerun `apply` with guessed identity values. Ask for the missing peer ID.

## Backup and restore

- Distinguish automatic installation rollback from a durable memory backup. Setup can restore the managed runtime, configuration, and host hook files after a failed apply, but that is not a database backup.
- Before machine migration or destructive repair, require a consistent PostgreSQL dump or offline `pgdata` volume copy and a protected copy of the Honcho Agent Bridge application-data directory. That directory contains the private server `.env`, `config.json`, MCP tool settings, and pending collector spool/state. Include Redis only when in-flight Deriver work must survive; PostgreSQL is the authoritative long-term memory store.
- Do not include the gateway (its source or its logins), Ollama model blobs, plugin caches, or hooks in a portable backup. On the destination computer, install the platform prerequisites, restore the database and private Honcho Agent Bridge files, rerun `server prepare --profile personal` (the user logs in at the gateway screen when it asks), `server start --profile personal`, and `setup apply`. Prepare replaces the restored router key with the new gateway's. Missing Qwen models are recreated by the personal lifecycle.
- Treat backups containing `.env` or `config.json` as secrets and require encrypted storage. Do not state that a backup exists unless its database and application-data contents were actually verified.
