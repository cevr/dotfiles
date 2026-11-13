// The pool's lost-login alert, on real OpenCode with the real pool and status
// plugins and a fake token endpoint. The login store holds two Claude logins;
// alpha's token has expired. A fixture plugin asks the pool's own registered
// store source for alpha's token when the scenario writes a new value to its
// trigger file. First the endpoint refuses alpha's refresh token: the sidebar
// names alpha as signed out with its slot file and a toast says so. The store
// never trades a refused refresh token again, so alpha is signed in again (its
// slot file gets another login, its token expired too) and asked for again: the
// endpoint answers that login's refresh, and both go away.
import { Effect, Schedule, Stream } from "effect"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { fakeAccount, startFakeAnthropic, type FakeTokenAnswer } from "../tests/fake-anthropic.ts"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const HOUR = 3_600_000

// `again` is the login alpha is signed in to again: the endpoint refuses alpha's first refresh token, and answers the rest.
const accounts = { alpha: fakeAccount(), beta: fakeAccount(), again: fakeAccount() }
const answer = (account: string): FakeTokenAnswer => {
  if (account === "alpha") return { kind: "rejected" }
  return { kind: "rotate" }
}
const fake = startFakeAnthropic({ accounts, token: answer })

// The store's slot files, in its shape: alpha's token has expired, beta's is good.
const store = join(out, "store-auth")
const slots = join(store, ".slots/anthropic")
mkdirSync(slots, { recursive: true })
const login = (account: { access: string; refresh: string }, expires: number) =>
  JSON.stringify({ _tag: "Oauth", type: "oauth", ...account, expires, accountId: null, metadata: { owner: "store" } })
/** An expiry already past: the login's token must refresh before it serves. */
const expired = Date.now() - 1000
writeFileSync(join(slots, "alpha"), login(accounts.alpha, expired))
writeFileSync(join(slots, "beta"), login(accounts.beta, Date.now() + 8 * HOUR))

// Each new value in the trigger file asks for alpha's token once, through the
// credential registry the auth plugin reads; the outcome goes to `asked`.
const trigger = join(out, "lost-login-trigger")
const asked = join(out, "lost-login-asked")
writeFileSync(trigger, "")
const fixture = `export default {id: "fixture.lost-login", async setup() {
  let last = "";
  const loop = async () => {
    for (;;) {
      const value = await Bun.file(${JSON.stringify(trigger)}).text();
      if (value !== "" && value !== last) {
        last = value;
        const sources = globalThis[Symbol.for("opencode.credential-sources")]?.get("anthropic") ?? new Set();
        const source = [...sources].find((s) => s.owns("store:alpha"));
        const outcome = source === undefined ? "no source" : await source.resolve("store:alpha").then(() => "resolved", (e) => "failed: " + String(e?.kind ?? e?._tag ?? "error"));
        await Bun.write(${JSON.stringify(asked)}, value + " " + outcome);
      }
      await Bun.sleep(50);
    }
  };
  void loop();
}}`

export default OpenCodeDriver.use({
  opencode: { dev: process.env.OPENCODE_DEV! },
  config: { plugins: [
    { package: `${root}/cmd/pool`, options: { sweepMinutes: 0, sources: [{ kind: "store", dir: store, tokenURL: `${fake.url}/v1/oauth/token` }] } },
    { package: `${root}/cmd/status`, options: { log: `${out}/agents.jsonl` } },
  ] },
  tuiConfig: { animations: false, tabs: { mode: "off" }, plugins: [`${root}/cmd/status`] },
  tui: { viewport: { cols: 144, rows: 60 } },
  project: { git: true, files: {
    ".opencode/plugins/fixture/package.json": JSON.stringify({ name: "fixture-lost-login", type: "module", exports: { "./server": "./server.ts" } }),
    ".opencode/plugins/fixture/server.ts": fixture,
  } },
}, ({ ui, llm }) => Effect.gen(function* () {
  yield* llm.serve((request) =>
    JSON.stringify(request).includes("You name conversations")
      ? Stream.make(Llm.text("Lost login"), Llm.finish())
      : Stream.make(Llm.text("Session ready"), Llm.finish()),
  )
  type Frame = { lines: readonly { spans: readonly { text: string }[] }[] }
  const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((s) => s.text).join("").trimEnd()).join("\n")
  const until = (ready: (frame: string) => boolean) => ui.capture().pipe(
    Effect.flatMap((frame) => ready(text(frame)) ? Effect.void : Effect.fail("pending")),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
    Effect.tapError(() => ui.capture().pipe(Effect.map((f) => writeFileSync(`${out}/lost-login-timeout.txt`, text(f))))),
  )
  // A session, so the sidebar shows.
  yield* ui.submit("open a session")
  yield* until((frame) => frame.includes("Session ready"))
  // The endpoint refuses alpha's refresh token. The toast comes first; it
  // covers the top of the sidebar, so the section is read once it has gone.
  writeFileSync(trigger, "1")
  yield* until((frame) => frame.includes("Pool login alpha is signed out"))
  writeFileSync(`${out}/lost-login-toast.txt`, text(yield* ui.capture()))
  console.log("screenshot:", yield* ui.screenshot("lost-login-toast"))
  yield* until((frame) => frame.includes("alpha · signed out") && !frame.includes("Pool login alpha is signed out"))
  writeFileSync(`${out}/lost-login.txt`, text(yield* ui.capture()))
  console.log("screenshot:", yield* ui.screenshot("lost-login"))
  // Signed in again, then a refresh that succeeds: the alert clears, and the toast ends (it lasts 10 s).
  writeFileSync(join(slots, "alpha"), login(accounts.again, expired))
  writeFileSync(trigger, "2")
  yield* Effect.sync(() => readFileSync(asked, "utf8")).pipe(
    Effect.filterOrFail((said) => said === "2 resolved", (said) => `pending: the second ask says "${said}"`),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
  )
  if (fake.tokens("again").refresh === accounts.again.refresh) return yield* Effect.fail("the new login was served without its refresh")
  yield* until((frame) => !frame.includes("signed out") && !frame.includes("sign in again into"))
  writeFileSync(`${out}/lost-login-cleared.txt`, text(yield* ui.capture()))
  console.log("screenshot:", yield* ui.screenshot("lost-login-cleared"))
}).pipe(Effect.ensuring(Effect.promise(() => fake.stop()))))
