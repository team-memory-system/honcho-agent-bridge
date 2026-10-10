---
name: setup-memory
description: Connect to someone else's shared memory, or install, update, or diagnose the bundled self-hosted personal-memory runtime for Codex and Claude Code. Use when the user asks to set up memory, connect to a teammate's or colleague's memory, connect coding agents to Honcho, choose which detected agents receive hooks, inspect an installation plan, repair hooks, or run a memory health check.
disable-model-invocation: true
---

# Setup Memory

Use the deterministic CLI bundled at `<plugin-root>/scripts/cli.mjs`. Resolve `<plugin-root>` as the directory two levels above this `SKILL.md`. Never reconstruct its mutations manually when the CLI supports them.

Speak to the user in the language they wrote in: progress notes, questions, warnings and summaries alike (Korean for a Korean request). This file and the CLI's JSON are in English; translate what you pass on and never switch to English mid-setup.

The Team Memory app is the one screen the user works in. Whenever they have to do something in a browser (log in to a subscription, enter a teammate's connection details, look at the server), open the app with `node <plugin-root>/scripts/cli.mjs ui open --screen <name>` and give its returned `url` as text too. Screens: `dashboard` (대시보드), `start` (the first setup window; `start?team=<팀 주소>` opens it at the team's Google login), `server` (서버 → 기억 서버), `models` (서버 → 모델), `computer/collect` (기억 설정 with the 대화 수집 window open: the server, agents, project folders and other servers), `computer/past` (기억 설정 with the 대화 수집 window open at 지난 대화: a backup store and ChatGPT export files to bring in, put in the order the conversations started), `share` (서버 → 공유: the server's address and the computers that write to it), `admin` (관리자: the team's roster and 팀 주소, for the team's admins), `team` (팀: teammates' memories and who may ask mine), `backup` (백업). Older names (`computer/targets`, `computer/import`, `team/share`, `team/memories`) still open the screen they moved to. Do not send them to the gateway's own page at 11450.

## Fixed lines

Say these lines exactly as written whenever their moment comes, in Korean for a Korean user (keep the meaning, not a paraphrase, in another language). Fill in only the `<...>` parts. Do not add commentary, recaps or tips around them; between them, say nothing but a CLI error translated into the user's language. That includes what a command showed or what you run next (such as "detect showed configured: false, so open the start screen"): the user reads every line you write, and a line about the commands, above all in English, is one they cannot act on. Structured questions use the question text and options given here.

| When | Say |
|---|---|
| Start | 팀 메모리 설치를 시작합니다. |
| Server question | Question "기억 서버를 어디에 둘까요?" with the two options in "First: where the memory server is" |
| Prerequisites all present | 필요한 프로그램이 모두 있습니다. |
| A required program missing | <프로그램>이 없습니다. 공식 설치 방법(<install.command 또는 install.url>)으로 설치할까요? |
| Server plan confirmation | Question "서버를 이렇게 설치합니다. 진행할까요?" whose text lists, one line each and only those in the plan: Docker Desktop 설치 (첫 실행 때 약관 동의와 Mac 암호 필요) / Ollama와 임베딩 모델(Qwen3-Embedding 4B, 약 2.5GB) 받기 / 구독 게이트웨이 설치 (로그인하면 자동으로 켜짐) / 기억 서버 설치 (주소 <apiUrl>), then the Docker license warning: 회사 직원이 250명 이상이거나 매출이 1천만 달러 이상이면 Docker 유료 구독이 필요합니다. Options "진행", "취소" |
| Before prepare, when it installs Docker | 곧 Docker Desktop 창이 뜹니다. 약관에 동의(Accept)하고, 추천 설정(Use recommended settings)을 고른 뒤 Mac 암호를 넣어 주세요. 로그인과 설문은 건너뛰세요. 끝나면 제가 이어서 진행합니다. |
| Before prepare otherwise | 서버를 준비합니다. 몇 분 걸릴 수 있습니다. |
| `docker-first-run` | Docker Desktop 첫 실행이 아직 끝나지 않았습니다. Docker 창에서 약관 동의, 추천 설정, Mac 암호까지 마친 뒤 "했어"라고 말해 주세요. |
| `gateway-login`, before first setup | 방금 연 앱(<url>)의 처음 설정을 적용까지 진행하세요. 팀 없이 쓰면 "혼자 쓰기", 팀을 만드는 관리자면 "새 팀 만들기", 관리자에게 팀 주소를 받았으면 "팀에 들어가기"를 고릅니다. 서버 단계에서는 "이 컴퓨터에 새로 만들기"를 고르고, 모델 단계에서 고른 구독 계정은 적용할 때 브라우저에서 로그인합니다. 끝나면 "했어"라고 말해 주세요. |
| `gateway-login`, already set up | 방금 연 서버 → 모델 화면(<url>)에서 "계정 더하기"를 누르고 ChatGPT나 Claude를 골라 브라우저 로그인을 마치세요. 끝나면 "했어"라고 말해 주세요. |
| Server started and verified | 기억 서버가 켜졌습니다. 팀 메모리 앱: <ui open의 url> |
| Agents question | Question "어느 에이전트의 대화를 보낼까요?" Options "찾은 에이전트 모두 (<이름들>)", "지금 쓰는 <이름>만", "직접 고르기" |
| Peer ID question (only when none is configured) | 기억에서 나를 가리킬 이름을 정해 주세요. 영문 소문자와 밑줄로 쓰고, 내 다른 컴퓨터와 같은 이름을 씁니다. 예: user_hong |
| Server elsewhere | 방금 연 대화 수집 창(<url>)의 서버 단계에서 다른 컴퓨터의 내 서버를 고르고, 서버 주소와 서버 token을 넣은 뒤 적용까지 진행하세요. token은 채팅에 붙여 넣지 마세요. 끝나면 "했어"라고 말해 주세요. |
| Setup plan confirmation | Question "대화 수집을 이렇게 설정합니다. 진행할까요?" whose text lists the files from `operations`. Options "진행", "취소" |
| `approve-hook` | Codex를 새로 열면 훅 승인 창이 뜹니다. "Syncing codex conversation to personal memory"만 승인하세요. |
| `reload-plugins` | 이미 열려 있는 Claude Code 창에서는 `/reload-plugins`를 입력하세요. |
| `install-plugin` | <Codex 또는 Claude Code> 플러그인: 터미널에서 아래 명령을 차례로 실행하세요. <그 단계의 `commands`를 한 줄에 하나씩> |
| Join a team | 방금 연 앱(<url>)의 처음 설정에서 "팀에 들어가기"를 누르고, 관리자에게 받은 팀 주소를 넣은 뒤 브라우저에서 Google 로그인을 마치세요. 끝나면 "했어"라고 말해 주세요. |
| Chat request | 방금 연 팀 화면(<url>)에서 물을 팀원 줄의 "chat 요청"을 누르세요. 그 팀원이 승인하면 오른쪽 위 종에 알림이 뜹니다. 그 알림에서 "연결"을 누르세요. 끝나면 "했어"라고 말해 주세요. |
| Chat login | Claude Code에서는 `/mcp`를 입력하고 <team-이름>을 골라 Authenticate를 누르세요. Codex는 앱 화면의 "Codex 로그인"을 누르세요. 브라우저가 열리면 팀에 등록된 Google 계정으로 로그인하세요. 끝나면 "했어"라고 말해 주세요. |
| Chat connected | 팀원 기억에 연결했습니다. 에이전트는 <team-이름> 서버의 chat 도구로 물을 수 있습니다. |
| Make a team (the admin) | 방금 연 앱(<url>)의 처음 설정에서 "새 팀 만들기"를 고르고, 팀 이름과 Cloudflare API token, 내 Google 이메일을 넣어 주세요. token은 채팅에 붙여 넣지 마세요. 끝나면 "했어"라고 말해 주세요. |
| Before adding a teammate | 더한 사람은 팀 주소로 로그인해 팀원 명단과 서버 주소를 봅니다. 기억에 묻거나 회사 서버에 쌓는 것은 각 서버 주인이 승인해야 열립니다. |
| Stopped on an error | <단계>에서 멈췄습니다. <오류를 사용자의 말로 옮긴 것> |
| Done | 설치가 끝났습니다. 팀원 기억은 팀 메모리 앱의 팀 메뉴에서, 다른 서버에도 쌓기는 기억 설정 → 대화 수집 → 수정에서, 백업해 둔 대화나 ChatGPT 기록은 기억 설정 → 지난 대화의 더 가져오기에서 넣으세요. 승인할 것과 연결할 것은 오른쪽 위 종에 뜹니다. 문제가 생기면 `/memory-doctor`를 입력하세요. |

Use the detected default data directory without asking; ask about it only when the user brings it up.

## First: where the memory server is

Ask one question before anything else: where this computer's memory server is. Ask it as a single choice, with the host's structured question tool when there is one, using these two labels and descriptions as written, in the user's language (Korean shown). Skip it when the request already says which.

- **이 컴퓨터에 기억 서버 만들기** — Codex나 Claude 구독이 필요합니다. Docker와 Ollama는 앱이 설치합니다. 팀을 만드는 관리자도 이것을 고릅니다. → "Own memory workflow" below: the server (step 1), then the hooks (steps 2–10). On a computer not set up yet, the app's first setup window takes over at the subscription login and does the rest, team included.
- **다른 컴퓨터의 기억 서버에 연결하기** — 팀이 있으면 같은 Google 계정으로 로그인하면 됩니다. 팀 없이 쓰면 서버를 둔 컴퓨터의 서버 → 공유에서 주소와 서버 token을 받아 두세요. → "Own server on another computer" below: this computer gets the collector only.

Only the user knows which of their computers should hold the server, so present the two neutrally: no recommendation, no "most people", nothing about their setup taken from the examples in this file or the docs (those are other people's computers), and no computer named. Offer only these two. The question tool already lets the user answer otherwise, and anything added beyond the labels is noise.

Asking a teammate's memory (팀 → 팀원 기억) works on any computer with the plugin, whichever option was chosen, so it waits until the user asks for it, at first setup or later, and then follows "Asking someone else's memory". The same goes for opening the server to the user's other computers and teammates (서버 → 공유 and 관리자, in "Own server on another computer"), sending some projects' conversations to another server as well (대화 수집's 함께 쌓을 서버, "Also sending some folders to another server") and bringing in more past conversations, from a backup store or a ChatGPT export (the app's `computer/past` window); the "Done" line names them once. The one exception is the second option: it needs the server on the other computer shared first, as "Own server on another computer" describes.

## Then: required software, before anything else

Once the user has chosen, check the software that choice needs and get it installed first. Do not start the plugin's setup or `server plan` while something required is missing.

1. Node.js 18 or later must exist before the plugin's CLI can run. Check it with the shell (`node --version`). If it is missing, install it from nodejs.org (the LTS installer), or with `brew install node` when Homebrew is already there (macOS), or with `winget install --id OpenJS.NodeJS.LTS -e` (Windows).
2. Then run `node <plugin-root>/scripts/cli.mjs prereqs --features server,sync` for a server on this computer, or `--features sync` for one on another computer. It reports each item as `required` or `app-installs`, with its `install.command`/`install.url`: Node.js and git for both, and Docker and Ollama for a server here.
   - git missing: offer the reported official command, as its own confirmation. Never pipe a downloaded script into a shell. Rerun `prereqs` after.
   - `app-installs` (Docker Desktop and Ollama, for a server here): nothing to do now; `server prepare` installs them.
3. The app's first setup window does the same when it installs: its 적용 중 list stops at Docker Desktop's first run and says what to do there.

## Asking someone else's memory

Use this whenever the user asks to connect a teammate's memory, at first setup or any time after; it needs only the plugin on this computer.

A teammate's memory is a remote MCP server at `https://<host>/mcp`. The user needs to be in the team: the 팀 주소 (`team.<domain>`, no secret in it) from the team's admin, and a Google account whose email the admin put on the roster. Nothing opens without the teammate's approval, and the teammate chooses the projects their memory answers from.

1. When this computer has not joined the team yet, run `node <plugin-root>/scripts/cli.mjs ui open --screen start` and say the "Join a team" line. The window logs in with Google; an email not on the roster gets a screen saying so, and only the admin can add it. Its 팀원 step sends chat requests to the members ticked there.
2. Otherwise run `node <plugin-root>/scripts/cli.mjs ui open --screen team` and say the "Chat request" line. Give the returned `url` as text as well, in case no browser window appeared.
3. Once the teammate approves, the bell's "연결" adds the server to Claude Code and Codex as `team-<name>`. Then say the "Chat login" line. Claude Code logs in from `/mcp` (choose `team-<name>`, then Authenticate); a Claude Code session that was open before the connection may need a restart before `team-<name>` shows there. Codex logs in with the screen's "Codex 로그인", which opens the login in a new tab of the browser the app runs in: tell the user to log in there with the Google account they joined the team with, not another account the browser offers. In the user's own terminal it is `codex mcp login --no-browser team-<name>`, opening the address it prints in the browser signed in to that account (a Codex without `--no-browser` takes `codex mcp login team-<name>` and opens the default browser itself). Connecting opens no browser, and it lets Codex call that server's `chat` without asking, so a Codex set to `approval_policy = "never"` can use it.
4. When the user says it is done, run `node <plugin-root>/scripts/cli.mjs teammates connected` and report, per server, whether Claude Code and Codex have it. Then say the "Chat connected" line.

The other way round, a teammate's request for this user's memory arrives at the bell: its 승인 asks which of this computer's projects to open, and 팀 → 내 기억을 여는 팀원 → 수정 changes or closes it later. Each client keeps its own login. `teammates disconnect <name>` takes a server out of both clients. On a computer that also syncs its own conversations, the agent keeps its own recall tools for the user's own memory, and the teammate's memory is the separate `team-<name>` server's `chat`. `bridge disconnect` only removes the shared-bridge settings that 0.3.28 and before saved.

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
   - Before running prepare when the plan has `install-docker-desktop`, tell the user in its own short message what is about to happen and what to do, because prepare then waits up to three minutes for Docker's engine and you cannot speak while it runs: say the "Before prepare, when it installs Docker" line (adapt it for Windows: the administrator prompt, then the same window). When prepare comes back with `docker-first-run`, say plainly which of those steps is left and rerun prepare once they say it is done.
   - After confirmation, run `node <plugin-root>/scripts/cli.mjs server prepare --profile <profile>`. For `personal`, this fetches the gateway into the app directory, runs the gateway's install (its dependencies, its autostart, its screen at `http://127.0.0.1:11450`), asks the gateway for its router address and key, writes them with the chosen chat model into the installed private `.env`, and prepares the Qwen3-Embedding base model (4B for a new install) with its 8192-token alias. For `portable`, if it reports `missingSecretFields`, tell the user which fields to fill in the returned installed `.env` path. Never ask the user to paste their values into chat.
   - For `personal`, model access comes from a login in the gateway's own screen. `codex login` and `~/.codex/auth.json` play no part, and the gateway keeps its logins apart from the user's own CLI logins. When `server prepare` returns `ready: false` with `nextAction.kind: "gateway-login"`, run `node <plugin-root>/scripts/cli.mjs ui open --screen <nextAction.appScreen>` right after it, with no line in between: prepare has already picked the screen from whether this computer is set up yet, so there is nothing to tell the user before the line that follows. Never ask for a password, token or key in chat.
     - `start` (not set up yet, `configured: false` in the `detect` above): the app shows its first setup window over every screen until setup is done, so 서버 → 모델 cannot be reached. That window does the rest itself: the subscription login, prepare again, start, the agents, the project folders, a new team or joining one, and apply. Give the `url` it returns as text too, and say the "`gateway-login`, before first setup" line. When the user says it is done, run `detect`. Once `configured` is true and `honcho.health` is ok, run `doctor`, report any failed check, and say the "Done" line: the window already did everything else in this workflow (the rest of step 1 and steps 2–9), so do not run prepare, start, the agents question, the plan or apply again, and do not repeat the `approve-hook` and `reload-plugins` lines, which the window's last screen lists. When `configured` is still false, ask what the window's 적용 중 list stopped at.
     - `models` (already set up: a repair or an update): it opens the app's 서버 → 모델 screen and returns its `url`; give the user that address as text too. Say the "`gateway-login`, already set up" line: they press "계정 더하기" there, choose ChatGPT or Claude, and finish the browser login; the window connects the account by itself once the browser login finishes. When they say it is done, run `server prepare --profile personal` again.
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
   - Explain every `warning`.
   - An `install-plugin` operation means apply puts this plugin into that host with the host's own CLI, from the source this plugin came from. The user runs nothing for it. A plugin that is installed but turned off stays off, and its warning says so.
7. Obtain confirmation before changing host settings. Replace `plan` with `apply` using the same options.
8. Run `node <plugin-root>/scripts/cli.mjs doctor` and report any failed check.
9. Tell the user every entry of `nextSteps` from the apply result, in their words. Collection is not finished without them:
   - `install-plugin`: setup could not install the plugin into that host. The CLI was missing, or its install failed; the reason is in `plugins[].error`. Say the `install-plugin` line with the step's `commands`. Then run `doctor` again after the user says they ran them.
   - `approve-hook` (Codex): Codex shows the new Stop hook for approval when a session starts, or in `/hooks`. Approve only "Syncing codex conversation to personal memory". Nothing from Codex is collected before that. After setup installed the Codex plugin, the same new session also loads its skills and recall MCP server.
   - `reload-plugins` (Claude Code): sessions that were already open need `/reload-plugins` or a restart; new sessions need nothing. Earlier turns of those sessions are sent with their next turn.
10. The memory-changing MCP tools (writes and deletes) start turned off; recall does not need them. Mention it only if the user asks for a tool that is missing.

## Own server on another computer

For a user whose own Honcho already runs on another of their computers, this computer gets only the collector.

**In a team** (the server was made through the team): run `node <plugin-root>/scripts/cli.mjs ui open --screen start` and say the "Join a team" line. After the Google login with the same account, the server step shows the user's server as 찾음; the window registers this computer with that server and sets up the collector there. Nothing is typed but the 팀 주소. The computers that write to a server are listed, and can be cut off one by one, on that server's 서버 → 공유.

**Without a team**, the user sets it up in the app's 대화 수집 window, so the server token goes from them straight into the app and never through chat:

1. Install the plugin as usual. Skip `server ...` entirely.
2. Run `node <plugin-root>/scripts/cli.mjs ui open --screen computer/collect` and say the "Server elsewhere" line. The window takes the address and the server token, then the agents and the project folders, checks the server, and runs the same `setup apply`. Its result lists what to do in Codex and Claude Code, so do not repeat the `approve-hook` and `reload-plugins` lines.
3. When the user says it is done, run `node <plugin-root>/scripts/cli.mjs doctor` and report any failed check. When the screen refused the server instead:
   - It says the server does not accept the token: the token is wrong or was replaced. The user copies it again on the server computer (서버 → 공유 → "서버 token 복사").
   - It says Cloudflare Access blocked this computer: an Access application covers that server's API. Sharing the server from 서버 → 공유 ("팀 만들기" or "초대 코드로 열기") lets `/v3` through to the gate token. For Access made by hand, the user puts that server's Access service token into the screen's "Cloudflare Access 서비스 토큰".
4. Only when the user asks for the terminal: they set `HONCHO_API_TOKEN` (and for Access made by hand `HONCHO_CF_ACCESS_CLIENT_ID` and `HONCHO_CF_ACCESS_CLIENT_SECRET`) in their own terminal and run `node <plugin-root>/scripts/cli.mjs setup apply --agents <…> --user-peer <id> --honcho-url <address>` there. These values are secrets, so they stay out of chat and off any command line you run.

## A team

A team needs one admin with a domain on their Cloudflare account. Once, in the Cloudflare dashboard, the admin sets up Zero Trust with Google as a login method and makes an API token with Account → Cloudflare Tunnel → Edit, Account → Access: Apps and Policies → Edit, Account → Access: Organizations, Identity Providers, and Groups → Read, Account → Workers → Admin, and Zone → DNS → Edit, Zone → Zone → Read and Zone → Workers Routes → Edit on the domain.

1. Run `node <plugin-root>/scripts/cli.mjs ui open --screen start` and say the "Make a team (the admin)" line. The window deploys the team's hub at `team.<domain>`, logs the admin in with Google and goes on with the admin's own server, which becomes the team's company server. The terminal equivalent of the first part, in the user's own terminal, is `CLOUDFLARE_API_TOKEN=... node <plugin-root>/scripts/cli.mjs team make --name '<team name>' --email <their Google email>`, with `--zone` when the token sees several zones. The API token can change the team's whole Cloudflare setup, so it stays out of chat and off command lines (the CLI refuses it as an option).
2. When the user asks to add someone, say the "Before adding a teammate" line, then add them on 관리자 (`ui open --screen admin`, 팀원 더하기); an email is not a secret. The admin sends them the 팀 주소 ("복사" on 관리자). 팀에서 빼기 takes someone off the roster and removes their server's address.
3. Everyone else joins with the "Join a team" line. A member who makes a server on their computer gets its address from the team; nobody handles a tunnel token or an invite code.

`team status` says who this computer is signed in as, without any token.

### Sharing without a team

Outside a team, a personal server on the other computer is shared from its 서버 → 공유: "팀 만들기" there is the older way with the owner's API token and one gate token for every other computer, and "초대 코드로 열기" takes an invite an owner made with `teammates add <email> --share <name> --invite-out <file>`. Use these only when the user asks for them; a team is the way for anything new.

**A tunnel the user already made**, only when they ask for it: `HONCHO_TUNNEL_TOKEN=... node <plugin-root>/scripts/cli.mjs server share enable --public-url https://<hostname>` in their own terminal, with the tunnel's public hostname pointing at `http://gate:8010`. The Access setup is then theirs, and `/mcp` stays closed until `HONCHO_ACCESS_TEAM_DOMAIN` and `HONCHO_ACCESS_AUD` are set.

**Then, either way:**

1. `server share status --check` reports `publicCheck.state`: `ok`; `access`, where Cloudflare Access stopped `/health` (an Access application made by hand without the `/v3` bypass); `token`, a wrong gate token; or `unreachable`, the tunnel or the gate being down. `mcp.missing` names what `/mcp` still needs.
2. The gate token is the `HONCHO_API_TOKEN` for setup on the other computer. The user copies it from the app's 서버 → 공유 screen ("서버 token 복사"), or runs `server share token` in their own terminal; do not run that command yourself, since its output is the secret. `server share disable` turns sharing off, keeps both tokens and leaves Cloudflare as it is; `server share rotate` replaces the gate token.

## Also sending some folders to another server

When the user wants the conversations from certain folders to also reach another Honcho (usually the company's), add a target. Their own server still receives every folder it takes.

1. In a team, the company server is one tick: open the app's 대화 수집 window (`node <plugin-root>/scripts/cli.mjs ui open --screen computer/collect`), tick 함께 쌓을 서버 → 회사 in its 서버 step and that server's folders in the 프로젝트 step's column. 적용 asks the company server's owner; once they approve, the app starts sending those folders, past conversations included, by itself. A teammate can only add their own conversations there and cannot read anyone's.
2. For any other server, open the same window and give its `url` as text too. The user ticks 다른 서버 더하기 in its 서버 step, types the server's address and token there, which keeps the token out of this chat, and ticks that server's folders in the 프로젝트 step's column for it; 적용 sends those folders' past conversations too. In a terminal instead, the user sets `HONCHO_TARGET_API_TOKEN` (and, when Cloudflare Access covers that server's API, `HONCHO_TARGET_CF_ACCESS_CLIENT_ID`/`_SECRET`) and runs `node <plugin-root>/scripts/cli.mjs target add <id> --url <https://…> --folders <a,b> [--workspace <id>]`. Never ask for these in chat or pass them as options; the CLI refuses them.
3. `target add` checks the server first. Report its `warnings` (a folder that does not exist yet) and its `note`: past conversations are not sent until the user asks for `target backfill <id> --since YYYY-MM-DD`. Run a backfill only when the user asks.
4. `target test <id>` and `doctor` (check `target-<id>`) diagnose it; `target set <id> --folders … | --enabled false` changes or pauses it; `target remove <id>` removes it.

Only Codex and Claude Code sessions whose first working directory is inside a target folder are sent there; ChatGPT imports never are. Recall (the MCP tools) reads the user's own server only.

## Safety

- Preserve unrelated hooks and settings. The CLI removes only entries bearing its managed markers and creates timestamped backups before rewriting existing files.
- Never display API tokens, bearer tokens, or secret environment values.
- Never put the gateway's router key on a command line or in chat. `server prepare` writes it into the installed private `.env`, and no result prints it. The opt-in live verification reads it there inside the process, sends it only to this machine's router, discards the completion response body, and reports only success/model.
- The sharing this version supports is a team (its roster, requests and approvals, each server's own permissions), asking teammates' memories (`teammates connect`), opening this computer's memory to the user's other computers and to teammates the user approves, and sending chosen folders to a target the user adds explicitly. Do not add teammates, approve requests, open projects, add targets, folders or backfills the user did not ask for, and do not add cross-device synchronization.
- A Cloudflare API token can change the team's whole Cloudflare setup, and a tunnel token or an invite code lets a computer serve a team address, so these stay between the user and the app: the user types them into the app or sets them in their own terminal, and you neither ask for them nor read or print them. The team login and the device keys live in the app's `team-auth.json`; never read or print it.
- Do not claim Honcho was installed when `server start`, `server status`, or `doctor` reports it unreachable. For `personal`, success also requires the gateway's router answering (`host.gateway.router.ok`), healthy Ollama, and the Qwen alias resident.
- Use the same profile for the complete lifecycle. `server status --profile personal` covers Docker, the gateway and Ollama; `server stop --profile personal` stops the containers and the Ollama supervisor while preserving configuration and Docker volumes. The gateway keeps running: it has its own lifecycle, and `node <app-directory>/runtime/subscription-gateway/gateway/cli.mjs uninstall` is what removes it.
- `server stop` preserves Docker volumes. Never run `docker compose down -v` or otherwise delete memory data.
- Do not rerun `apply` with guessed identity values. Ask for the missing peer ID.

## Backup and restore

- Distinguish automatic installation rollback from a durable memory backup. Setup can restore the managed runtime, configuration, and host hook files after a failed apply, but that is not a database backup.
- Before machine migration or destructive repair, require a consistent PostgreSQL dump or offline `pgdata` volume copy and a protected copy of the Honcho Agent Bridge application-data directory. That directory contains the private server `.env`, `config.json`, MCP tool settings, and pending collector spool/state. Include Redis only when in-flight Deriver work must survive; PostgreSQL is the authoritative long-term memory store.
- Do not include the gateway (its source or its logins), Ollama model blobs, plugin caches, or hooks in a portable backup. On the destination computer, install the platform prerequisites, restore the database and private Honcho Agent Bridge files, rerun `server prepare --profile personal` (the user logs in at the gateway screen when it asks), `server start --profile personal`, and `setup apply`. Prepare replaces the restored router key with the new gateway's. Missing Qwen models are recreated by the personal lifecycle.
- Treat backups containing `.env` or `config.json` as secrets and require encrypted storage. Do not state that a backup exists unless its database and application-data contents were actually verified.
