// The sidebar's Git section and the /git pane in real OpenCode, over a real
// checkout: `main` one commit ahead of `origin/main` (a bare remote beside
// it), `a.ts` changed and `b.ts` untracked. PATH starts with a scratch
// directory holding a stand-in `gh`, which names pull request #123 and logs
// each call, and a stand-in `hunk`, which logs its arguments and directory and
// exits, so Enter in the pane hands the terminal over and takes it back.
import { Effect, Schedule, Stream } from "effect"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { devNull } from "node:os"
import { join } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"
const theme = process.env.SCENARIO_THEME ?? "prime"
const bin = join(out, "bin")
mkdirSync(bin, { recursive: true })

const request = {
  number: 123,
  title: "Port git",
  url: "https://github.com/cevr/dotfiles/pull/123",
  state: "OPEN",
  isDraft: false,
  reviewDecision: "REVIEW_REQUIRED",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
}
const ghCalls = join(out, "gh-calls")
const hunkCalls = join(out, "hunk-calls")
const executable = (name: string, text: string) => {
  writeFileSync(join(bin, name), text)
  chmodSync(join(bin, name), 0o755)
}
executable("gh", `#!/bin/sh\nprintf '%s | %s\\n' "$PWD" "$*" >> '${ghCalls}'\nprintf '%s\\n' '${JSON.stringify(request)}'\n`)
executable("hunk", `#!/bin/sh\nprintf '%s | %s\\n' "$PWD" "$*" >> '${hunkCalls}'\n`)

/** git in `cwd` with no user or system config, as the driver commits the project. */
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.sync(() =>
    Bun.spawnSync(["git", "-c", "user.name=Scenario", "-c", "user.email=scenario@example.com", ...args], {
      cwd,
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" },
      stdout: "ignore",
      stderr: "pipe",
    }),
  ).pipe(Effect.flatMap((run) => (run.exitCode === 0 ? Effect.void : Effect.die(new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`)))))

export default OpenCodeDriver.use({
  opencode: { dev: process.env.OPENCODE_DEV!, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } },
  config: { plugins: [{ package: `${root}/cmd/git` }] },
  tuiConfig: { animations: false, tabs: { mode: "off" }, theme: { name: theme, mode: "dark" }, plugins: [`${root}/cmd/prime`, `${root}/cmd/git`] },
  tui: { viewport: { cols: Number(process.env.SCENARIO_COLS ?? 144), rows: 50 } },
  project: { git: true, files: {
    ".opencode/themes/prime.json": readFileSync(`${root}/themes/prime.json`, "utf8"),
    // The driver writes this after it commits the project; ignored, the totals are the scenario's own.
    ".gitignore": ".opencode/service-local.json\n",
    "a.ts": "one\ntwo\n",
  } },
}, ({ ui, llm, directory }) => Effect.gen(function* () {
  const remote = join(out, "remote.git")
  yield* git(out, "init", "-q", "--bare", "-b", "main", remote)
  yield* git(directory, "remote", "add", "origin", remote)
  yield* git(directory, "push", "-q", "-u", "origin", "main")
  writeFileSync(join(directory, "c.ts"), "local\n")
  yield* git(directory, "add", "c.ts")
  yield* git(directory, "commit", "-q", "-m", "local only")
  writeFileSync(join(directory, "a.ts"), "one\n2\nthree\nfour\n")
  writeFileSync(join(directory, "b.ts"), "x\ny\nz\n")

  yield* llm.serve((input) => {
    const text = JSON.stringify(input)
    if (text.includes("You name conversations")) return Stream.make(Llm.text("Git status"), Llm.finish())
    return Stream.make(Llm.text("Git fixture ready"), Llm.finish())
  })
  type Frame = { lines: readonly { spans: readonly { text: string }[] }[] }
  const text = (frame: Frame) => frame.lines.map((line) => line.spans.map((s) => s.text).join("").trimEnd()).join("\n")
  const until = (ready: (frame: string) => boolean) => ui.capture().pipe(
    Effect.flatMap((frame) => ready(text(frame)) ? Effect.void : Effect.fail("pending")),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
    Effect.tapError(() => ui.capture().pipe(Effect.map((f) => writeFileSync(`${out}/git-timeout.txt`, text(f))))),
  )
  yield* ui.submit("show-git-fixture")
  yield* until((frame) => frame.includes("Git fixture ready"))
  // The sidebar's Git section: the branch against its upstream, the totals and the pull request.
  yield* until((frame) => frame.includes("main · ↑1 origin/main") && frame.includes("#123 Port git"))
  writeFileSync(`${out}/git-sidebar.txt`, text(yield* ui.capture()))
  console.log("screenshot:", yield* ui.screenshot("git-sidebar"))

  // The /git pane lists the changed files; Enter hands the terminal to hunk for the first.
  yield* ui.submit("/git")
  yield* until((frame) => frame.includes("Changed files") && frame.includes("?  b.ts"))
  writeFileSync(`${out}/git-pane.txt`, text(yield* ui.capture()))
  console.log("screenshot:", yield* ui.screenshot("git-pane"))
  yield* ui.press("return")
  yield* Effect.sync(() => existsSync(hunkCalls)).pipe(
    Effect.flatMap((found) => (found ? Effect.void : Effect.fail("pending"))),
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
  )
  // The renderer resumes: the pane is drawn again.
  yield* until((frame) => frame.includes("Changed files") && frame.includes("▸ M  a.ts"))
  writeFileSync(`${out}/git-after-review.txt`, text(yield* ui.capture()))
  yield* ui.press("escape")
  yield* until((frame) => !frame.includes("Changed files"))
}))
