# From agent-browser to browse

Each agent-browser command or skill, its browse equivalent, and whether that equivalent ran live (browse 0.0.14, 2026-11-07, the workbox relay driving the Mac's Chrome, against example.com and a fixture page on the workbox). Use it to translate an older recipe; the browse code runs inside one `execute`.

| agent-browser | browse | Live |
| --- | --- | --- |
| `open <url>` | `await page.goto(url)` | yes |
| `snapshot -i`, `--delta` | `snapshot()`, `snapshot({ find, context })`, `snapshot({ diff: true })` | yes |
| `snapshot --json`, full tree | `ariaSnapshot()` | yes |
| `click @e3` | `await ref("e3").click()` | yes |
| `find role button click --name X --exact` | `page.getByRole("button", { name: "X", exact: true }).click()` | yes |
| `fill`, `type`, `press`, `keyboard type` | `locator.fill()`, `locator.pressSequentially()`, `page.keyboard.press()`, `page.keyboard.type()` | yes |
| `select`, `check`, `upload` | `selectOption()`, `check()`, `setInputFiles(files.path(...))` | yes |
| `hover`, `scrollintoview`, `drag` | `hover()`, `scrollIntoViewIfNeeded()`, `dragTo()` | hover yes; the rest no |
| `wait @e`, `--text`, `--url`, `--fn` | `locator.waitFor()`, `getByText().waitFor()`, `waitForURL()`, `waitForFunction()` | yes |
| `get text/html/attr/value/title/url/count` | `innerText()`, `innerHTML()`, `getAttribute()`, `inputValue()`, `page.title()`, `page.url()`, `count()` | yes |
| `eval` | `page.evaluate(fn)`; page globals need the 4th argument `false` | yes |
| `read <url>` (docs as markdown) | not a browser task: use the web fetch tool | n/a |
| `screenshot`, `--full`, `--annotate` | `page.screenshot({ fullPage })`, `screenshotWithLabels()` | yes |
| `screenshot --if-changed`, `--threshold` | `screenshotDiff({ baseline, threshold })` | no |
| `tab`, `tab new`, `tab close` | `context.pages()`, `context.newPage()`, `page.close()` | yes |
| popups, `click --new-tab` | `page.waitForEvent("popup")` | yes |
| `frame @e3` | `page.frameLocator(selector)` | yes |
| `dialog accept/dismiss` | `page.once("dialog", (d) => ...)` | yes |
| `--session <name>` | `browse session new <name>`, `--session <name>` | yes |
| `--restore`, `state save/load`, `--profile`, `--auto-connect` | not needed: the owner's Chrome keeps its logins | n/a |
| `auth save/login` (credential vault) | `browse secrets add` (owner only), then `secrets.type(locator, name)` | no (needs the owner) |
| 2FA "complete it in the window" | `handoff(message, { start })`, then verify the URL | no (needs the owner) |
| `--allowed-domains` | `session new --allow-origin`, `session allow` | yes |
| `cookies get` | `context.cookies()` (only the session's hosts) | yes |
| `cookies set`, `set credentials` | not supported; log in through the page or hand off | n/a |
| `--headers` | `page.setExtraHTTPHeaders()` (no credentials in source) | yes |
| `network route`, `--abort` | `page.route(glob, (r) => r.fulfill(...) / r.abort())` | fulfill yes |
| `network requests` | `page.on("request" / "response" / "requestfailed")` | yes |
| `network har start/stop` | `browse network start/stop --output x.har` (credentials redacted) | yes |
| `console`, `errors` | `pageConsole.start()`; the result's `logs` and aftermath counts | yes |
| `record start/stop` | `browse recording start/stop --mode cdp` | yes |
| (none) | `browse flight-recorder start`, `save-last` | yes |
| `set viewport`, `set media dark` | `page.setViewportSize()`, `page.emulateMedia({ colorScheme })` | yes (browser zoom scales it) |
| `--init-script` | `page.addInitScript(fn)` | yes |
| `webmcp list/invoke` | `webmcp.list()`, `webmcp.call(name, args)` | list yes |
| `a11y` | axe via `page.addScriptTag` + `axe.run()` | yes (CSP can block) |
| `vitals` | `performance` entries in `page.evaluate` | yes |
| `pdf` | `page.pdf()` + `files.write` | yes |
| downloads | fetch in the page + `files.write` | yes (Playwright downloads are refused) |
| `react tree/inspect/renders` | none | gap |
| `profiler`, tracing | none | gap |
| `connect <port>` (Electron, CDP apps) | none | gap: agent-browser |
| `--provider`, Vercel Sandbox, AgentCore | none | gap: agent-browser |
| `--headed` / headless, separate profiles in parallel | none: one visible Chrome, one profile | gap: agent-browser |
| `--args --mute-audio` | none: tabs play through the owner's Chrome | gap: agent-browser |
| dashboard, streaming | the owner watches the real tab; `browse journal` lists what ran | yes |

| agent-browser skill | browse |
| --- | --- |
| core | SKILL.md |
| dogfood | [dogfood.md](dogfood.md) |
| derive-client | [derive-client.md](derive-client.md) |
| slack | [slack.md](slack.md) (Slack web; the desktop app is Electron, agent-browser's) |
| protected-vercel-deployments | go to the URL in the owner's Chrome; a `vercel.com/login` redirect is a handoff to log in. An OIDC or bypass header stays on agent-browser, since a token cannot enter execute source |
| webmcp-gen | `addInitScript` + `webmcp.list/call`; the artifact layout is in `agent-browser skills get webmcp-gen` |
| electron, vercel-sandbox, agentcore | agent-browser |
