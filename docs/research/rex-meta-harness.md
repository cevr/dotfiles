# Rex as a meta harness driven by OpenCode

Research, 2026-11-15. No code changed. Evidence labels: **measured** (a command run today), **doc** (Rex docs `llms-full.txt`, cited by line), **source** (T3 Code at `ad9e87111`, 2026-11-09, `~/.cache/repo/pingdotgg/t3code`), **inferred**, **guess**.

## Summary

- **Rex has no browser, web, image or Markdown pane.** Its only user-facing block is a terminal. "A block is one application in a window. Today that means a terminal" (doc 966). The live servers offer four flavors: `terminal.shell`, `onboarding.onboarding`, `tunnel.dial`, `tunnel.listen` (measured, Mac and workbox). A made-up flavor fails with `block flavor not found` (measured).
- **Rex has no plugin system an agent can use to add a pane type.** Lua defines actions, key bindings and event handlers. It cannot render or register a block kind (doc 6945-6975). Executable "block plugins" exist (`--block-dir`, doc 3731) but their protocol is not documented, and whether the Mac app can draw a plugin's block is unknown.
- **What Rex does give us is enough for a first version:** a complete CLI and JSON API for sessions, tabs, splits and floating layers; the Kitty graphics protocol in every terminal (measured reply `OK`); a native status channel (OSC 7501) with state, progress, title and message; TCP forwards; and one event stream. All of it works the same over `ssh://bite-workbox`.
- **So a "browser pane", "simulator pane" and "showcase pane" in Rex are each a terminal pane that draws pictures.** A headless browser or `simctl` produces frames, and a small viewer draws them with Kitty graphics. This is T3 Code's server-browser design (headless Chrome on the host that owns the workspace, frames streamed to the client) with Rex's pty as the stream.
- **Recommendation:** no new OpenCode tool. Use the `rex` CLI through the existing skill, add one small viewer program (`rex-show`), and fix one real bug first: OpenCode tool shells carry the wrong `REX_SESSION`. First slice: a showcase pane with an image and a tally, proven from the workbox.

## 1. What Rex exposes

**Versions (measured).** Mac: `rex 0.1.0-preview.19`, API revision 14. Workbox: `0.0.1794757024-g23c764`, API revision 16. The Mac app (`Rex Beta 0.1.0 (1973)`) is a client of both servers: client `ab18cd` on the Mac server, client `029ad6` on the workbox server.

**Model (doc 958-973).** Session (a project) > window (a tab) > block (a pane) plus clients (the app). IDs are stable. Labels are free text.

**API surface (measured, `rex api list`).** 95 methods, 22 of them block methods (19 on the terminal):

| Group | Methods |
| --- | --- |
| Layout | `session.create`, `new_window`, `new_split`, `new_block`, `new_layer` (floating, `[x,y,w,h]` fractions), `move_block`, `swap_blocks`, `float_block`, `zoom_block`, `resize_pane`, `focus_*`, `set_*_label`, `view` |
| Terminal block | `format` (text, HTML or VT), `write`, `process`, `pwd`, `title`, `size`, `resize`, `set_theme`, `program_status`, `download_begin`, `upload_begin`, `list_dir` |
| Clients | `client.list`, `client.perform` (ask the app to run one of its actions), `client.set_script` |
| Other | `block_creator.list`, `data.connect` (ticket for a block's data stream), `hosts.*`, `server.tailscale.*`, `help.all` |

Every method has a JSON Schema (`rex api describe M --json`, doc 2370-2386). The CLI and Lua derive from it.

**Three ways to call it.**

1. CLI: `rex new|run|split|send|capture|wait|events|forward|api call`, with `--json` (doc 1032). Exit codes are stable (doc 1053-1062).
2. Lua script: `rex do file.lua` or `-e`. It runs **where the CLI runs**, not on the server (doc 1358). It has `rex.session.*`, `rex.call`, `rex.block.call`, `rex.on`/`rex.wait` for events, `rex.every`/`rex.after` timers, `rex.exec` for local commands, and `rex.server(label)` to call another host (doc 7236-7260). Measured: `rex.servers()` on the Mac returns `["bite-workbox"]`.
3. Config Lua (`init.lua`): `rex.action{}` defines a named action that runs in the server, has 30 seconds, and can be bound to a key or run with `rex do NAME` (doc 686-931). The Mac has no `~/.config/rex` yet (measured).

**What Lua cannot do.** No rendering, no pane type, no network listener, no HTTP. `rex.on` works in scripts only, not in the config file (doc 6966). So Lua is glue: layouts, reactions to events, running commands.

**Pane kinds.** Terminal only. The terminal is libghostty (binary strings) and answered a Kitty graphics query with `\x1b_Gi=31;OK` (measured in the probe session). So an image can be drawn in a pane. Whether the Mac app paints it well at size was not checked visually.

**Status channel: OSC 7501 (doc 2393-2712).** A program writes `OSC 7501 ; state=working:id=tally:progress=40:title=<b64>:msg=<b64> ST` to its terminal. Rex keeps up to 256 records per terminal, shows them in tab headers and the session picker, emits `terminal.program_status_changed`, and returns them from `program_status`. Measured: the probe wrote one record and the API returned `{"id":"tally","state":"working","progress":40,"app":"opencode","title":"rex-meta","msg":"2 of 5 slices done"}`. Only a program inside the terminal can set a record. No API sets one from outside.

**Events (doc 7403-7556).** `rex events --json` or `rex.on`: block and window lifecycle, `session_view_changed`, and per terminal `child_exited`, `pwd_changed`, `title_changed`, `bell`, `desktop_notification`, `progress_report`, `program_status_changed`.

**App control (doc 1149, 6349; skill guide).** `rex -C CLIENT do session.select session_id=…` switches what the Mac shows. It needs Remote Control in the app's settings. Measured: `rex -C ab18cd do session.refresh` returned `null` with no refusal, so Remote Control is on for the Mac server (inferred). This client offers no action that opens a URL or starts a forward (measured; `client.host.forward_port` is Bleeding Edge only and opens a dialog, doc 6046).

**Remote: ssh and Tailscale (doc 9882-10177).**

- `ssh://` runs the system `ssh` and reaches the remote user's personal server. Rex trusts the caller by transport: the SSH login is the identity. A connection "can do anything that server can" (doc 10084).
- Built-in Tailscale (`--tailscale`) makes the server its own tailnet device. On the Mac it is off: "HTTPS certificates are off for this tailnet" (measured, `rex whoami`). Workbox: disabled too.
- What crosses the wire: API calls, events and pty bytes. Blocks, their programs, config Lua and block plugins run on the **server**. `rex do` scripts and `rex forward` listeners run on the **CLI's machine**.
- Latency (measured): local `rex ls` 20 ms, local `rex split` 35 ms, `rex -S bite-workbox ls` 1.5 to 1.7 s per call, because each call opens a new ssh connection. A script or `rex events` holds one connection.
- Forwards (doc 2936-3033): `rex forward open PORT` listens on the CLI's machine and connects from the server, like `ssh -L`. `forward share` is `-R`. Each is a tunnel block that lives as long as the CLI process. A browser sends `Host: localhost`, so some sites break.

**The agent skill (measured, `rex __internal skill`, 23 KB).** `skills/rex/SKILL.md` is a 13-line stub that prints the guide from the installed CLI. It already covers splits, tabs, capture, send, wait, client actions and `-S` hosts. For OpenCode, Rex installs the skill but no session hook (doc 1217).

## 2. T3 Code: browser work and orchestration

**Rule:** "T3 Code keeps execution in the environment that owns the workspace" and clients control it over authenticated RPC (`docs/internals/overview.md:3`).

**Browser, two hosts behind one tool set.**

- Server browser: a pinned `chrome-headless-shell` on the environment server, driven with Playwright (`apps/server/src/preview/ServerBrowser.ts`, `PreviewBrowser.ts:24`). Frames go to clients over a WebSocket at `/api/preview-stream` with acks and a quality setting, and viewer input comes back (`ServerBrowserStream.ts:29-32`). It works over Tailscale and SSH because the browser sits next to the dev server, so no port is forwarded.
- Desktop browser: an Electron webview. Its debugger is relayed to the server so the same Playwright code drives it (`apps/desktop/src/preview/CdpRelay.ts:1`, `apps/server/src/preview/DesktopBrowserChannel.ts:2`).
- `PortScanner.ts` finds local dev servers to offer as previews. `SessionControl.ts:25,135` arbitrates control between the human and the agent: reads never queue, actions do.
- Agent tools (MCP, `apps/server/src/mcp/toolkits/preview/tools.ts`): `preview_open`, `navigate`, `snapshot`, `act`, `evaluate`, `wait_for`, `dialog`, `resize`, `set_appearance`, `status`, `recording_start/stop`.
- `html_preview` and `html_render` (`toolkits/html/tools.ts:31,79`): the agent writes HTML, the server renders it in headless Chrome, returns a PNG to check, then shows the page inline in the thread. This is T3's Sideshow.

**Devices (`docs/internals/devices.md`).** The server owns simulators. `expo-device-hub` (serve-sim) streams MJPEG or AVCC and `agent-device` drives. The hub binds loopback and a proxy allowlists routes. There are only four tools: `device_list`, `open`, `screenshot`, `close`. Driving goes through the `agent-device` CLI on PATH, and the how-to is returned by `device_open`, "not kept in an always-loaded prompt or skill".

**Orchestration (`docs/orchestration-v2/orchestrator-mcp-server.md:1-56`).** One app-owned MCP endpoint at `http://127.0.0.1:<port>/mcp`, with a per-session bearer credential scoped to environment, thread and provider. Tools create child threads on any provider, wait, poll and cancel (`task_status`, `task_cancel`). State is an event log with projections and an outbox (`overview.md:44-58`).

**What maps onto Rex.**

| T3 Code | On Rex |
| --- | --- |
| Browser runs on the workspace host; frames streamed | Same host runs headless Chrome; a viewer in a Rex pane draws frames with Kitty graphics; the pty is the stream |
| `html_preview` returns a PNG | Same PNG, drawn in the showcase pane |
| Device stream through a proxy | `simctl io screenshot` loop on the Mac, drawn in a pane of a Mac session |
| Few tools; the how-to arrives on open | Keep the skill short; the viewer prints its own usage |
| Human and agent share control | Not needed while the pane is view-only |
| MCP orchestration, event log | Does not map. Our orchestrate mod already owns this |
| Electron webview + CDP relay | Does not map. Rex has no web view. The owner's real Chrome through `browse` is our equivalent |

## 3. Sideshow, and hosting it in Rex

**Model (measured, `sideshow agent-howto`, `--help`).** A server on port 8228 holds sessions. A session holds posts (cards). A post is an ordered list of surfaces: `html` (sandboxed iframe), `markdown`, `mermaid`, `diff`, `terminal`, `image`, `trace`, `json`, `code`. Posts are versioned (`sideshow update`). The user comments in the viewer and the agent reads comments with `sideshow wait`. The server binds every interface (measured, `*:8228`), and `SIDESHOW_URL` points a remote CLI at it. `sideshow` is installed on the workbox too.

**Can Rex host it?**

- A web pane pointed at Sideshow: **no**. There is no web pane.
- A Lua plugin that renders it: **no**. Lua cannot render.
- A terminal pane that follows one Sideshow session: **yes, partly**. `markdown`, `terminal`, `diff`, `code` and `json` surfaces are text. `image` surfaces draw with Kitty graphics. `html` and `mermaid` need a headless-Chrome screenshot of the post, which is what T3's `html_preview` does. Comments would stay in the browser viewer, or be typed in the pane and sent with `sideshow comment` (guess: not built anywhere).
- The tally: **yes, natively**, with OSC 7501. Rex already shows it in tab headers and the session picker without any pane.

Sideshow in the browser stays the full showcase (owner note: auditions go on Sideshow). The Rex pane is a second, smaller view beside the agent.

## 4. Design options

**A fact that shapes every option (measured).** In this OpenCode session, working in `dotfiles`, the tool shell has `REX_SESSION=…8d8238`, which is the session labeled `manna - apps`. Tool shells inherit the OpenCode server's environment, not the pane of the TUI that owns the session (inferred). So "split beside me" lands in the wrong session today. `mods/herdr` solved the same mapping for herdr panes (`mods/herdr/report.ts:17-24`).

**(a) OpenCode plugin tool wrapping the `rex` CLI or API.** Typed calls and correct pane mapping. Cost: a new tool to maintain and one more schema in every prompt. Rex's own skill already teaches the CLI, and the API describes itself. Owner principle: the wrong tool is worse than no tool.

**(b) Rex Lua that agents call.** `rex.action` in `init.lua` gives named verbs such as `rex do showcase file=x.png`. It runs in the server with a 30-second limit, so it suits layout ("find or make the pane labeled showcase beside block B") and nothing long. It must be installed on both hosts.

**(c) Both.** Only needed if the pane mapping cannot be fixed without a tool.

**(d) Recommended: CLI plus one viewer program, no tool.** The agent calls `rex` through the skill. One program, `rex-show`, owns the pane: it finds or creates a split labeled `showcase` beside the agent's block, draws what it is given, and emits OSC 7501. OpenCode's only change is to hand each session the right `REX_SESSION` and `REX_BLOCK`.

**Where things run.**

| Need | OpenCode on the Mac | OpenCode on the workbox (app on the Mac over `ssh://bite-workbox`) |
| --- | --- | --- |
| Panes, splits, layers | `rex` to the local server, 20 to 35 ms | Same commands on the workbox's own server; the Mac app shows them. No `-S` |
| Tally (OSC 7501) | In-band in the pty | Same, nothing extra crosses |
| Showcase image in a pane | Kitty graphics | Same, bytes ride the pty over ssh. Large or frequent frames are a risk |
| Dev-server page as pictures | Headless Chrome on the Mac | Headless Chrome on the workbox, next to the server. No port to forward |
| Dev-server page in real Chrome (`browse`) | Direct | The port must reach the Mac: the tailnet name (`bite-cristian:PORT`, the server must bind beyond loopback), or `rex -S bite-workbox forward open PORT` **run on the Mac** |
| iOS simulator | `simctl` and `ios-simulator-skill` locally; frames in a pane | The simulator is on the Mac. The workbox needs a way to run a Mac command (below) |
| Switch what the app shows | `rex -C … do session.select` | `rex -C 029ad6 do session.select` on the workbox server |

**Workbox to Mac.** Rex gives the workbox no way to start something on the Mac. The app is only a client there, and it offers no open-URL or forward action. Three ways to close the gap:

1. A bridge script on the Mac: `rex -S bite-workbox do --all bridge.lua`. It runs on the Mac, hears workbox events over one ssh connection, and reacts with `rex.exec` (open a URL, start a forward, start a simulator mirror). The request can be an OSC 7501 record with a reserved id. This is the one good use of Lua here. Not tested.
2. Make the Mac a Rex host for the workbox: Remote Login on the Mac and `rex hosts add mac ssh://cvr@<mac tailnet name>` on the workbox, or built-in Tailscale once HTTPS certificates are on for the tailnet. Then `rex -S mac run -- …` from the workbox. This gives the workbox full control of the Mac account.
3. Skip Rex for this hop: plain Tailscale for ports, and plain `ssh` for commands.

## 5. Recommendation

**Design.** Rex is the window manager and the status bar. Pictures are the universal pane content. OpenCode drives it with the CLI it already knows. Sideshow stays the rich, commentable showcase in the browser.

**Slice 1 (one unit): a showcase pane with a tally, proven from the workbox.**

1. Fix the pane mapping: each OpenCode session's tool shell gets the `REX_SESSION` and `REX_BLOCK` of its own TUI pane, or none. This is a bug fix in an existing mod, in the shape `mods/herdr` already uses.
2. Add `rex-show` (one Bun script in dotfiles, on PATH on both hosts): `rex-show image FILE`, `rex-show md FILE`, `rex-show tally "2 of 5 done" --progress 40`. It reuses or creates the split labeled `showcase` beside `$REX_BLOCK`, draws with Kitty graphics, and emits OSC 7501.
3. Add six lines to a tracked skill that say when to use it.
4. Acceptance: from an OpenCode session on the workbox, `rex-show image x.png` puts a picture in a pane the Mac app shows, checked by eye once and by `rex block ls --json` (one block labeled `showcase` in the caller's session, none elsewhere). `rex block call … program_status` returns the tally record. A property test covers the find-or-create rule: any number of calls leaves exactly one showcase pane.

**Later slices.**

- 2: `rex-show url URL`: a headless-Chrome screenshot on the pane's host, refreshed on change. This covers dev servers and Sideshow posts (`html`, `mermaid`).
- 3: `rex-show sideshow SESSION`: follow a Sideshow session with `sideshow watch` and draw each new post.
- 4: Simulator mirror on the Mac (`simctl io booted screenshot` loop), then the workbox-to-Mac bridge from section 4.
- 5: A live browser pane: CDP screencast frames, then mouse reporting mapped to CDP input.
- 6: OpenCode's own state as OSC 7501 from the TUI, so every agent pane shows working, blocked or done in Rex's tab headers. `mods/herdr` does this for herdr today.

**Risks.**

- Kitty graphics over ssh at screencast rates may be slow or capped (the binary has an image size limit string). Slice 1 uses still images to find out cheaply.
- Rex is a preview. The two hosts already differ (API 14 and 16), and `rex resize` and `rex block new` are not implemented (skill guide). Pin nothing to undocumented behavior.
- Every `rex -S` call costs about 1.5 s. Keep cross-host work in one long-lived script.
- A Rex connection has full power over the server's account. Do not add `--allow-anonymous` listeners. Giving the workbox control of the Mac (option 2) widens what a workbox agent can reach.

**Not confirmed.**

- That the Mac app paints Kitty images correctly and at what size. Only the protocol reply was measured.
- The block plugin protocol and whether a plugin block can render in the app. If it can, a real web or image block becomes possible and slices 2 to 5 change. Ask in the Rex Beta Discord or its Community MCP (doc 10597).
- Whether the app can carry a tunnel block that an agent creates, so that a workbox agent could open a forward on the Mac.
- That Remote Control is on for the workbox server's view of the app. Only the Mac server was probed.
- The bridge script, and Remote Login on the Mac.
- How T3 picks the desktop or the server browser per tab. Not read.

**Probe record.** One scratch session `meta-probe` was made on the Mac (a split, a floating layer, a Kitty query, an OSC 7501 record) and removed. `rex ls` afterwards shows the owner's five sessions only. Nothing was created on the workbox. Scratch files are in `$TMPDIR/opencode/rex-meta/`.
