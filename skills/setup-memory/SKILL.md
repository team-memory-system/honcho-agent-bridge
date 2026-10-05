---
name: setup-memory
description: Connect to someone else's shared memory, or install, update, or diagnose the bundled self-hosted personal-memory runtime for Codex and Claude Code. Use when the user asks to set up memory, connect to a teammate's or colleague's memory, connect coding agents to Honcho, choose which detected agents receive hooks, inspect an installation plan, repair hooks, or run a memory health check.
disable-model-invocation: true
---

# Setup Memory

Use the deterministic CLI bundled at `<plugin-root>/scripts/cli.mjs`. Resolve `<plugin-root>` as the directory two levels above this `SKILL.md`. Never reconstruct its mutations manually when the CLI supports them.

Speak to the user in the language they wrote in: progress notes, questions, warnings and summaries alike (Korean for a Korean request). This file and the CLI's JSON are in English; translate what you pass on and never switch to English mid-setup.

The Team Memory app is the one screen the user works in. Whenever they have to do something in a browser (log in to a subscription, enter a teammate's connection details, look at the server), open the app with `node <plugin-root>/scripts/cli.mjs ui open --screen <name>` and give its returned `url` as text too. Screens: `start` (시작하기), `server` (서버, with 공유), `models` (게이트웨이), `connect` (대화 보내기), `connect/share` (팀원 기억 연결). Do not send them to the gateway's own page at 11450.

## Fixed lines

Say these lines exactly as written whenever their moment comes, in Korean for a Korean user (keep the meaning, not a paraphrase, in another language). Fill in only the `<...>` parts. Do not add commentary, recaps or tips around them; between them, say nothing but a CLI error translated into the user's language. Structured questions use the question text and options given here.

| When | Say |
|---|---|
| Start | 팀 메모리 설치를 시작합니다. 먼저 이 컴퓨터에서 쓸 기능을 고르세요. 여러 개를 같이 골라도 됩니다. |
| Feature question | Question "이 컴퓨터에서 쓸 기능을 고르세요." with the three options in "First: which features" |
| Prerequisites all present | 필요한 프로그램이 모두 있습니다. |
| A required program missing | <프로그램>이 없습니다. 공식 설치 방법(<install.command 또는 install.url>)으로 설치할까요? |
| Server plan confirmation | Question "서버를 이렇게 설치합니다. 진행할까요?" whose text lists, one line each and only those in the plan: Docker Desktop 설치 (첫 실행 때 약관 동의와 Mac 암호 필요) / Ollama와 임베딩 모델(Qwen3-Embedding 4B, 약 2.5GB) 받기 / 구독 게이트웨이 설치 (로그인하면 자동으로 켜짐) / 기억 서버 설치 (주소 <apiUrl>), then the Docker license warning: 회사 직원이 250명 이상이거나 매출이 1천만 달러 이상이면 Docker 유료 구독이 필요합니다. Options "진행", "취소" |
| Before prepare, when it installs Docker | 곧 Docker Desktop 창이 뜹니다. 약관에 동의(Accept)하고, 추천 설정(Use recommended settings)을 고른 뒤 Mac 암호를 넣어 주세요. 로그인이나 설문은 건너뛰어도 됩니다. 끝나면 제가 이어서 진행합니다. |
| Before prepare otherwise | 서버를 준비합니다. 몇 분 걸릴 수 있습니다. |
| `docker-first-run` | Docker Desktop 첫 실행이 아직 끝나지 않았습니다. Docker 창에서 약관 동의, 추천 설정, Mac 암호까지 마친 뒤 "했어"라고 말해 주세요. |
| `gateway-login` | 구독 계정 로그인이 필요합니다. 방금 연 팀 메모리 앱의 게이트웨이 화면(<url>)에서 "Codex 추가"나 "Claude 추가"를 누르고 브라우저 로그인을 마치세요. 끝나면 "했어"라고 말해 주세요. 비밀번호나 토큰은 채팅에 붙여 넣지 마세요. |
| Server started and verified | 기억 서버가 켜졌습니다. 기억은 팀 메모리 앱(<ui open의 url>)에서 볼 수 있습니다. |
| Agents question | Question "어느 에이전트의 대화를 보낼까요?" Options "찾은 에이전트 모두 (<이름들>)", "지금 쓰는 <이름>만", "직접 고르기" |
| Peer ID question (only when none is configured) | 기억에서 나를 가리킬 이름을 정해 주세요. 영문 소문자와 밑줄로 씁니다. 예: user_hong |
| Server elsewhere | 기억 서버의 주소를 알려 주세요. 서버 토큰은 채팅에 쓰지 말고, 제가 알려 드리는 명령을 터미널에서 직접 실행하세요. |
| Setup plan confirmation | Question "대화 보내기를 이렇게 설정합니다. 진행할까요?" whose text lists the files from `operations`. Options "진행", "취소" |
| `approve-hook` | Codex를 새로 열면 훅 승인 창이 뜹니다. "Syncing codex conversation to personal memory"만 승인하세요. 승인하기 전에는 Codex 대화가 모이지 않습니다. |
| `reload-plugins` | 이미 열려 있는 Claude Code 창에서는 `/reload-plugins`를 입력하세요. |
| Chat connection | 팀원에게 받은 팀 주소를 방금 연 앱 화면(<url>)에 붙여 넣고 "Claude Code·Codex에 연결"을 누르세요. 끝나면 "했어"라고 말해 주세요. |
| Chat login | 로그인이 한 번 필요합니다. Claude Code에서는 `/mcp`를 입력하고 <team-이름>을 골라 Authenticate를 누르세요. Codex는 앱 화면의 "Codex 로그인"을 누르세요. 브라우저가 열리면 팀에 등록된 Google 계정으로 로그인하세요. 끝나면 "했어"라고 말해 주세요. |
| Chat connected | 팀원 기억에 연결했습니다. 에이전트는 <team-이름> 서버의 chat 도구로 물을 수 있습니다. |
| Share with Cloudflare (the team's owner) | 방금 연 앱의 서버 → 공유 화면(<url>)에서 "Cloudflare로 공유 켜기"를 고르고, Cloudflare API token과 내 Google 이메일을 넣어 주세요. token은 채팅에 붙여 넣지 마세요. 끝나면 "했어"라고 말해 주세요. |
| Share with an invite (a teammate) | 방금 연 앱의 서버 → 공유 화면(<url>)에서 "초대 코드로 공유 켜기"를 고르고, 팀 관리자에게 받은 초대 코드를 넣어 주세요. 초대 코드는 채팅에 붙여 넣지 마세요. 끝나면 "했어"라고 말해 주세요. |
| Before adding a teammate | 지금은 등록한 사람이 내 기억 전체에 chat으로 물을 수 있습니다 (프로젝트별 제한은 아직 없음). |
| Stopped on an error | <단계>에서 멈췄습니다. <오류를 사용자의 말로 옮긴 것> |
| Done | 설치가 끝났습니다. 켠 기능: <기능들>. 필요하면 나중에 팀 메모리 앱에서 더 켤 수 있습니다: <켠 기능에 해당하는 것만: 공유(서버 화면) / 회사 서버에도 보내기, ChatGPT 기록 가져오기(대화 보내기 화면)>. 문제가 생기면 `/memory-doctor`를 입력하세요. |

Use the detected default data directory without asking; ask about it only when the user brings it up.

## First: which features

Ask one question before anything else: which of these three features this computer should have. They are independent and combine; ask it as a multi-select. Use these labels and descriptions as written, in the user's language (Korean shown). Do not rename them, do not present them as mutually exclusive paths, do not add options (no "plugin only", "later" or "skip"; the question tool already lets the user answer otherwise), and never name a particular computer in them. Present the three neutrally: do not recommend, discourage or presume any of them, do not say what people "usually" pick or how many servers a person has, and never describe the user's setup from examples in this file or the docs; anything you add beyond the labels below is noise. Prefer the host's structured question tool. Skip the question when the request already says which.

- **서버 설치** — 이 컴퓨터에 기억 서버를 설치합니다. 내 다른 컴퓨터의 대화도 이 서버로 모을 수 있습니다. → "Own memory workflow" below, step 1 (the server).
- **대화 보내기** — 이 컴퓨터의 Claude Code·Codex 대화를 내 기억 서버로 보내고, 에이전트가 내 기억을 꺼내 쓰게 합니다. 서버가 이 컴퓨터에 있으면 그리로, 다른 컴퓨터에 있으면 그 주소와 서버 토큰으로 보냅니다. → "Own memory workflow" below, steps 2–10, with "Own server on another computer" when the server is elsewhere.
- **팀원 기억에 묻기** — 에이전트가 팀원이 열어 준 기억에 질문합니다. 팀원에게 받은 팀 주소와, 팀에 등록된 내 Google 계정이 필요합니다. → "Asking someone else's memory" below.

With 서버 설치 but not 대화 보내기, install and start the server and skip the hooks. With 대화 보내기 but not 서버 설치, never install a server here; ask for the address of the server they already have. Do them in this order: server, then sync, then chat.

Opening the server to the user's other computers and teammates (공유), sending some folders to a company server as well, and importing past ChatGPT conversations are not features of this question. Do not ask about them or set them up during the first setup; the "Done" line names them once. Set one up only when the user asks for it: opening the server in "Own server on another computer", a company server in "Also sending some folders to another server", a ChatGPT import on the app's `connect/import` screen. The one exception: 대화 보내기 to a server on another computer needs that server opened first, as "Own server on another computer" describes.

## Then: required software, before anything else

Once the features are chosen, check the software they need and get it installed first. Do not start the plugin's setup, `server plan` or `teammates connect` while something required is missing.

1. Node.js 18 or later must exist before the plugin's CLI can run. Check it with the shell (`node --version`). If it is missing, install it from nodejs.org (the LTS installer), or with `brew install node` when Homebrew is already there (macOS), or with `winget install --id OpenJS.NodeJS.LTS -e` (Windows).
2. Then run `node <plugin-root>/scripts/cli.mjs prereqs --features <chosen,features>`. It reports each item as `required` or `app-installs`, with its `install.command`/`install.url`: Node.js and git for every feature, and Docker and Ollama for 서버 설치. Nothing from Cloudflare is installed on any computer.
   - git missing: offer the reported official command, as its own confirmation. Never pipe a downloaded script into a shell. Rerun `prereqs` after.
   - `app-installs` (Docker Desktop and Ollama for 서버 설치): nothing to do now; `server prepare` installs them.
3. The app's 시작하기 screen shows the same check as its first step.

## Asking someone else's memory

A teammate's shared memory is a remote MCP server at `https://<host>/mcp`. The user needs the team's 팀 주소, one `<name> https://<host>/mcp` line per server, which the team's owner copies from 서버 → 공유 ("팀 주소 복사") and which holds no secret. They also need a Google account whose email the owner has put on the team list. Nothing from Cloudflare is installed on this computer.

1. Run `node <plugin-root>/scripts/cli.mjs ui open --screen connect/share`. It starts the local Team Memory app if it is not already running, opens it on the 팀원 기억 연결 screen, and returns its `url`. Give the user that address as text as well, in case no browser window appeared.
2. Say the "Chat connection" line. The screen adds each server to Claude Code and Codex as `team-<name>`. If the user pastes the 팀 주소 into chat instead, that is fine: run `node <plugin-root>/scripts/cli.mjs teammates connect <name> <address>` for each line. A client reported as `missing` is not installed here; say so, and the other one is still connected.
3. Say the "Chat login" line. Claude Code logs in from `/mcp` (choose `team-<name>`, then Authenticate); a Claude Code session that was open before the connection may need a restart before `team-<name>` shows there. Codex logs in with the screen's "Codex 로그인", or with `codex mcp login team-<name>` in the user's own terminal. The browser goes to Google through Cloudflare Access. An email that is not on the team list is refused there, and only the team's owner can add it.
4. When the user says it is done, run `node <plugin-root>/scripts/cli.mjs teammates connected` and report, per server, whether Claude Code and Codex have it. Then say the "Chat connected" line.

This path installs no hooks, needs no local Honcho server, and stores no token: each client keeps its own login. `teammates disconnect <name>` takes a server out of both clients. On a computer that also syncs its own conversations, the agent keeps its own recall tools for the user's own memory, and the teammate's memory is the separate `team-<name>` server's `chat`. `bridge disconnect` only removes the shared-bridge settings that 0.3.28 and before saved.

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
3. If the plan warns that the address "is behind Cloudflare Access and refused this computer", that server's Access application covers its API. A server shared through "Cloudflare로 공유 켜기" (or `--cloudflare`, or an invite) lets `/v3` through to the gate token, so sharing it that way fixes this. Otherwise the user sets both `HONCHO_CF_ACCESS_CLIENT_ID` and `HONCHO_CF_ACCESS_CLIENT_SECRET` (an Access service token) in their own terminal and runs `setup apply` there, the same way as the API token.
4. Continue with `doctor` and `nextSteps` as above.

To make that possible for a personal server on the other computer, share it there first (서버 → 공유). Sharing needs a domain on the team owner's Cloudflare account; never Tailscale, WARP or Mesh. Ask one question: does the user run the team's Cloudflare account, or did the owner give them an invite code?

**The team's owner (the Cloudflare account and domain):**

1. Once, in the Cloudflare dashboard, the user sets up Zero Trust with Google as a login method and makes an API token with Account → Cloudflare Tunnel → Edit, Account → Access: Apps and Policies → Edit, Account → Access: Organizations, Identity Providers, and Groups → Read, and Zone → DNS → Edit and Zone → Zone → Read on the domain.
2. Run `node <plugin-root>/scripts/cli.mjs ui open --screen server` and say the "Share with Cloudflare" line. The terminal equivalent, in the user's own terminal, is `CLOUDFLARE_API_TOKEN=... node <plugin-root>/scripts/cli.mjs server share enable --cloudflare --email <their Google email>`, with `--zone` when the token sees several zones and `--name` for a first label other than `memory`. Never ask for the API token in chat or pass it as an option; the CLI refuses it. The app keeps it for the teammate commands.
3. Report `publicUrl` and `cloudflare.changes`. `publicUrl` is the address for the other computers.
4. When the user asks to add someone, say the "Before adding a teammate" line, then add them on the same screen (팀원 더하기), or run `node <plugin-root>/scripts/cli.mjs teammates add <email>`; an email is not a secret. For a teammate who will share their own memory too, the screen's "이 사람도 자기 기억을 공유" shows an invite code once. In a terminal, `teammates add <email> --share <name> --invite-out <file>` writes it to a file only the user can read. The invite holds a tunnel token: the user passes it to the teammate over a private channel, never through chat, and you never read or print that file. `teammates remove <email>` takes someone off the list, and `teammates unshare <name>` removes a teammate's server. Teammates who only ask get the 팀 주소: "팀 주소 복사", or `addressText` from `teammates list`.

**A teammate with an invite code:** run `ui open --screen server` and say the "Share with an invite" line. The terminal equivalent, in the user's own terminal, is `node <plugin-root>/scripts/cli.mjs server share join --invite-file <file>`, or with the code in `HONCHO_SHARE_INVITE`. No Cloudflare account or API token is needed.

**A tunnel the user already made**, only when they ask for it: `HONCHO_TUNNEL_TOKEN=... node <plugin-root>/scripts/cli.mjs server share enable --public-url https://<hostname>` in their own terminal, with the tunnel's public hostname pointing at `http://gate:8010`. The Access setup is then theirs, and `/mcp` stays closed until `HONCHO_ACCESS_TEAM_DOMAIN` and `HONCHO_ACCESS_AUD` are set.

**Then, either way:**

1. `server share status --check` reports `publicCheck.state`: `ok`; `access`, where Cloudflare Access stopped `/health` (an Access application made by hand without the `/v3` bypass); `token`, a wrong gate token; or `unreachable`, the tunnel or the gate being down. `mcp.missing` names what `/mcp` still needs.
2. The gate token is the `HONCHO_API_TOKEN` for setup on the other computer. The user copies it from the app's server screen ("서버 token 복사"), or runs `server share token` in their own terminal; do not run that command yourself, since its output is the secret. `server share disable` turns sharing off, keeps both tokens and leaves Cloudflare as it is; `server share rotate` replaces the gate token.

## Also sending some folders to another server

When the user wants the conversations from certain folders to also reach another Honcho (usually the company's), add a target. Their own server still receives everything.

1. Ask for the server address, the folders, and the workspace id there. The user sets `HONCHO_TARGET_API_TOKEN` (and, when Cloudflare Access covers that server's API, `HONCHO_TARGET_CF_ACCESS_CLIENT_ID`/`_SECRET`) in their own terminal and runs `node <plugin-root>/scripts/cli.mjs target add <id> --url <https://…> --folders <a,b> [--workspace <id>]` there. Never ask for these in chat or pass them as options; the CLI refuses them.
2. `target add` checks the server first. Report its `warnings` (a folder that does not exist yet) and its `note`: past conversations are not sent until the user asks for `target backfill <id> --since YYYY-MM-DD`. Run a backfill only when the user asks.
3. `target test <id>` and `doctor` (check `target-<id>`) diagnose it; `target set <id> --folders … | --enabled false` changes or pauses it; `target remove <id>` removes it.

Only Codex and Claude Code sessions whose first working directory is inside a target folder are sent there; ChatGPT imports never are. Recall (the MCP tools) reads the user's own server only.

## Safety

- Preserve unrelated hooks and settings. The CLI removes only entries bearing its managed markers and creates timestamped backups before rewriting existing files.
- Never display API tokens, bearer tokens, or secret environment values.
- Never put the gateway's router key on a command line or in chat. `server prepare` writes it into the installed private `.env`, and no result prints it. The opt-in live verification reads it there inside the process, sends it only to this machine's router, discards the completion response body, and reports only success/model.
- The sharing this version supports is asking teammates' memories (`teammates connect`), opening this computer's memory to the user's other computers and the team (서버 → 공유), and sending chosen folders to a target the user adds explicitly. Do not add teammates, targets, folders or backfills the user did not ask for, and do not add cross-device synchronization.
- Never ask for, read or print a Cloudflare API token, a tunnel token or an invite code. The user types them into the app or sets them in their own terminal.
- Do not claim Honcho was installed when `server start`, `server status`, or `doctor` reports it unreachable. For `personal`, success also requires the gateway's router answering (`host.gateway.router.ok`), healthy Ollama, and the Qwen alias resident.
- Use the same profile for the complete lifecycle. `server status --profile personal` covers Docker, the gateway and Ollama; `server stop --profile personal` stops the containers and the Ollama supervisor while preserving configuration and Docker volumes. The gateway keeps running: it has its own lifecycle, and `node <app-directory>/runtime/subscription-gateway/gateway/cli.mjs uninstall` is what removes it.
- `server stop` preserves Docker volumes. Never run `docker compose down -v` or otherwise delete memory data.
- Do not rerun `apply` with guessed identity values. Ask for the missing peer ID.

## Backup and restore

- Distinguish automatic installation rollback from a durable memory backup. Setup can restore the managed runtime, configuration, and host hook files after a failed apply, but that is not a database backup.
- Before machine migration or destructive repair, require a consistent PostgreSQL dump or offline `pgdata` volume copy and a protected copy of the Honcho Agent Bridge application-data directory. That directory contains the private server `.env`, `config.json`, MCP tool settings, and pending collector spool/state. Include Redis only when in-flight Deriver work must survive; PostgreSQL is the authoritative long-term memory store.
- Do not include the gateway (its source or its logins), Ollama model blobs, plugin caches, or hooks in a portable backup. On the destination computer, install the platform prerequisites, restore the database and private Honcho Agent Bridge files, rerun `server prepare --profile personal` (the user logs in at the gateway screen when it asks), `server start --profile personal`, and `setup apply`. Prepare replaces the restored router key with the new gateway's. Missing Qwen models are recreated by the personal lifecycle.
- Treat backups containing `.env` or `config.json` as secrets and require encrypted storage. Do not state that a backup exists unless its database and application-data contents were actually verified.
