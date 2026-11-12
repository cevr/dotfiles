// The actual /pool panel, on fake external services and a real live subagent.
import { Deferred, Effect, Schedule, Stream } from "effect"
import { readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const theme = process.env.SCENARIO_THEME ?? "prime"
const now = Date.parse("2026-11-04T15:00:00Z")
const accounts = [
  { credentialID: "store:alpha", live: 1, load: 1, noRoom: false, reading: { at: now, windows: [{ name: "5h", utilization: 0.23, resetAt: now + 3600000 }, { name: "7d", utilization: 0.44, resetAt: now + 86400000 }] } },
  { credentialID: "store:beta", live: 0, load: 2, noRoom: true, hold: { kind: "usage-limit", until: now + 7200000, at: now }, reading: { at: now, windows: [{ name: "5h", utilization: 1, resetAt: now + 7200000 }, { name: "7d", utilization: 0.72, resetAt: now + 172800000 }] } },
]
const poolRpc = { id: "dotfiles-opencode.pool", methods: { status: { input: { type: "object" }, output: { type: "object" } }, session: { input: { type: "object", properties: { sessionID: { type: "string" }, providerID: { type: "string" } }, required: ["sessionID"] }, output: { type: "object" } } }, events: {} }
// The session method names store:alpha as the session's account, its windows
// resetting a fixed while after the call, so the sidebar's relative times hold.
const sessionQuery = `${out}/pool-session-query.json`
const stateFile = `${out}/pool-state`
writeFileSync(stateFile, "loading")
const fake = `export default {id: "fixture.pool", async setup(ctx) {
  await ctx.rpc.register(${JSON.stringify(poolRpc)}, {status: async () => {
    const state = ${JSON.stringify(stateFile)};
    while ((await Bun.file(state).text()) === "loading") await Bun.sleep(10);
    const value = await Bun.file(state).text();
    if (value === "error") throw new Error("scripted pool outage");
    return value === "empty" ? {} : (${JSON.stringify({ anthropic: { accounts } })});
  }, session: async (input) => {
    await Bun.write(${JSON.stringify(sessionQuery)}, JSON.stringify(input));
    const at = Date.now();
    return {account: {pool: "anthropic", credentialID: "store:alpha", label: "alpha", on: "placed", reading: {at, windows: [
      {name: "5h", utilization: 0.23, resetAt: at + 5400000},
      {name: "7d", utilization: 0.44, resetAt: at + 88200000},
    ]}}};
  }});
}}`

export default OpenCodeDriver.use({
  opencode: { dev: process.env.OPENCODE_DEV! },
  config: { plugins: [
    { package: `${root}/cmd/orchestrate`, options: { now: "2026-11-04T15:00:00Z", log: `${out}/agents.jsonl` } },
    { package: `${root}/cmd/status`, options: { log: `${out}/agents.jsonl`, statusScript: join(homedir(), ".claude/skills/orchestrate/scripts/status.ts") } },
  ] },
  tuiConfig: { animations: false, tabs: { mode: "off" }, theme: { name: theme, mode: process.env.SCENARIO_MODE === "light" ? "light" : "dark" }, plugins: [`${root}/cmd/prime`, `${root}/cmd/status`] },
  tui: { viewport: { cols: Number(process.env.SCENARIO_COLS ?? 144), rows: 60 } },
  project: { git: true, files: {
    ".opencode/plugins/fixture/package.json": JSON.stringify({ name: "fixture-pool", type: "module", exports: { "./server": "./server.ts" } }),
    ".opencode/plugins/fixture/server.ts": fake,
    ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"),
    "tmp/orchestrate/port/wake/log.md": "2026-11-04T15:00Z plan → implement r1 spec.md\n",
    "tmp/orchestrate/port/closed/log.md": "2026-11-04T15:01Z integration-check → merged abcdef1 r2 accept.log\n",
  } },
}, ({ ui, llm }) => Effect.gen(function* () {
  const child = yield* Deferred.make<void>()
  yield* llm.serve((request) => {
    const text = JSON.stringify(request)
    if (text.includes("You name conversations")) return Stream.make(Llm.text("Pool status"), Llm.finish())
    if (!text.includes("show-pool-fixture")) return Stream.fromEffect(Deferred.await(child)).pipe(Stream.drain, Stream.concat(Stream.make(Llm.text("agent done"), Llm.finish())))
    if (!text.includes("call_worker")) return Stream.make(Llm.toolCall({ index: 0, id: "call_worker", name: "subagent", input: { description: "implementor pane r1", prompt: "wait in fixture", agent: "worker", background: true } }), Llm.finish("tool-calls"))
    return Stream.make(Llm.text("Status fixture ready"), Llm.finish())
  })
  type Frame = { lines: readonly { spans: readonly { text: string }[] }[] }
  const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((s) => s.text).join("").trimEnd()).join("\n")
  const until = (ready: (frame: string) => boolean) => ui.capture().pipe(
    Effect.flatMap((frame) => ready(text(frame)) ? Effect.void : Effect.fail("pending")),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
    Effect.tapError(() => ui.capture().pipe(Effect.map((f) => writeFileSync(`${out}/pool-timeout.txt`, text(f))))),
  )
  yield* ui.submit("show-pool-fixture")
  yield* until((frame) => frame.includes("◆ 1 subagent") && frame.includes("Status fixture ready"))
  // The sidebar's Pool section: the session's account and its windows.
  yield* until((frame) => frame.includes("week 44%") && frame.includes("5h 23%"))
  writeFileSync(`${out}/pool-sidebar.txt`, text(yield* ui.capture()))
  console.log("screenshot:", yield* ui.screenshot("pool-sidebar"))
  yield* ui.submit("/pool")
  yield* until((frame) => frame.includes("Loading accounts…"))
  writeFileSync(`${out}/pool-loading.txt`, text(yield* ui.capture()))
  writeFileSync(stateFile, "normal")
  yield* until((frame) => frame.includes("store:beta") && frame.includes("wake · implement"))
  const frame = yield* ui.capture()
  writeFileSync(`${out}/pool.txt`, text(frame))
  console.log("screenshot:", yield* ui.screenshot("pool"))
  writeFileSync(stateFile, "error")
  yield* until((frame) => frame.includes("Pool unavailable; keeping last reading") && frame.includes("store:alpha"))
  writeFileSync(`${out}/pool-error.txt`, text(yield* ui.capture()))
  writeFileSync(stateFile, "empty")
  yield* until((frame) => frame.includes("No pool accounts.") && !frame.includes("store:alpha"))
  writeFileSync(`${out}/pool-empty.txt`, text(yield* ui.capture()))
  // The pane takes focus when it opens; Esc hands it back to the prompt.
  yield* ui.press("escape")
  yield* until((frame) => !frame.includes("Account pool"))
  yield* ui.type("typed-after-pool")
  yield* until((frame) => frame.includes("typed-after-pool"))
  writeFileSync(`${out}/pool-closed.txt`, text(yield* ui.capture()))
  yield* ui.press("u", { ctrl: true })
  // q closes it too.
  yield* ui.submit("/pool")
  yield* until((frame) => frame.includes("Account pool"))
  yield* ui.press("q")
  yield* until((frame) => !frame.includes("Account pool"))
  // From the prompt, a second /pool closes it.
  yield* ui.submit("/pool")
  yield* until((frame) => frame.includes("Account pool"))
  yield* ui.press("x", { ctrl: true })
  yield* ui.press("left")
  yield* ui.submit("/pool")
  yield* until((frame) => !frame.includes("Account pool"))
  yield* Deferred.succeed(child, undefined)
}))
