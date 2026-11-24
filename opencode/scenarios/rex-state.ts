// One turn in which a scripted model runs a shell command, typed into a real
// OpenCode TUI that runs in a real terminal (a pty from Bun.spawn's
// `terminal`), with the Rex mod's TUI plugin (cmd/rex) loaded and the TUI
// told it runs in a Rex pane (TERM_PROGRAM=rex, a made-up REX_SESSION and
// REX_BLOCK: never a real pane). The driver provides the isolated server, its
// configuration and the scripted model; the TUI is an ordinary client of
// them (the driver's `environment`), outside the driver's control, so its
// exit is the scenario's own. The scenario keeps every byte the TUI writes
// and reads the OSC 7501 program status reports out of them, as a fake Rex:
// it waits for the working record naming the command, then the idle one,
// then stops the TUI with SIGTERM, as a supervisor would, and waits for it to
// exit and for the clearing report. Last it prints every report the terminal
// received, in order, as JSON after `rex heard: ` (tests/rex-state.test.ts
// reads it), and writes the bytes to REX_STATE_LOG when set.
// Run: OPENCODE_DEV=<opencode checkout> bunx opencode-drive run scenarios/rex-state.ts
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Console, Effect, Option, Schedule, Stream } from "effect"
import { Llm, OpenCodeDriver } from "opencode-drive"
import { elapsedForReport } from "../tests/hang-guard.ts"

const ASK = "Run the slow check."
const COMMAND = "sleep 2 && echo checked"
const DONE = "The check passed."

const { env } = process
const { OPENCODE_DEV = "" } = env
const log = Option.fromUndefinedOr(env.REX_STATE_LOG)

/** One program status report as the terminal received it: its fields, the base64 ones decoded. */
type Heard = Readonly<Record<string, string>>

const OSC = new RegExp(String.raw`\u001b\]7501;([^\u0007\u001b]*)(?:\u0007|\u001b\\)`, "g")
const PAIR = /^([^=]*)(?:=(.*))?$/
const ENCODED = new Set(["title", "msg", "message"])

/** Every byte the TUI wrote to its terminal, as text. */
let written = ""
const decoder = new TextDecoder()

/** One `name=value` field of a report, a base64 value decoded. */
const pairOf = (pair: string): readonly [string, string] => {
  const [, name = "", value = ""] = PAIR.exec(pair) ?? []
  const decoded = Option.match(Option.liftPredicate(name, (key) => ENCODED.has(key)), {
    onNone: () => value,
    onSome: () => Buffer.from(value, "base64").toString("utf8"),
  })
  return [name, decoded]
}

/** Every OSC 7501 report the TUI wrote so far, in order. */
const heard = (): ReadonlyArray<Heard> => [...written.matchAll(OSC)].map((match) => Object.fromEntries((match[1] ?? "").split(":").map(pairOf)))

/** The fork's TUI as the driver starts it for a development checkout. */
const tuiCommand = () => {
  const solid = join(OPENCODE_DEV, "packages", "tui", "node_modules", "@opentui", "solid", "scripts", "preload.js")
  return [process.execPath, "--conditions=browser", `--preload=${solid}`, join(OPENCODE_DEV, "packages", "cli", "src", "index.ts")]
}

/** Polls `check` every 50 ms for up to `seconds`, failing with `what` when it never holds. */
const until = (check: () => boolean, what: string, seconds: number) =>
  Effect.sync(check).pipe(
    Effect.filterOrFail(Boolean, () => what),
    Effect.retry({ schedule: Schedule.spaced("50 millis"), times: seconds * 20 }),
  )

export default OpenCodeDriver.use(
  {
    opencode: { dev: OPENCODE_DEV },
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: { animations: false, tabs: { mode: "off" }, plugins: [`${process.cwd()}/cmd/rex`] },
    tui: { viewport: { cols: 100, rows: 30 } },
    project: { git: true },
  },
  ({ llm, directory, environment }) =>
    Effect.gen(function* () {
      yield* llm.serve((req) => {
        const s = JSON.stringify(req)
        if (s.includes("You name conversations")) return Stream.make(Llm.text("rex check"), Llm.finish())
        if (s.includes("call_check")) return Stream.make(Llm.text(DONE), Llm.finish())
        return Stream.make(Llm.toolCall({ index: 0, id: "call_check", name: "shell", input: { command: COMMAND } }), Llm.finish("tool-calls"))
      })
      let exited = false
      const tui = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.spawn(tuiCommand(), {
            cwd: directory,
            onExit: () => {
              exited = true
            },
            env: { ...env, ...environment, TERM: "xterm-256color", TERM_PROGRAM: "rex", REX_SESSION: "session:rex-state-test", REX_BLOCK: "block:rex-state-test" },
            terminal: {
              cols: 100,
              rows: 30,
              data: (_terminal, data) => {
                written += decoder.decode(data, { stream: true })
              },
            },
          }),
        ),
        // The scenario's own child: killed when the scenario ends early, a no-op once it exited.
        (child) =>
          Effect.sync(() => {
            if (!exited) child.kill("SIGKILL")
            child.terminal?.close()
          }),
      )
      yield* until(() => heard().some((report) => report.state === "idle"), "the TUI never reported idle", 60)
      // Type the prompt as a user would, until the composer shows it (keys sent before it has the focus are lost).
      yield* Effect.sync(() => tui.terminal?.write(ASK)).pipe(
        Effect.andThen(until(() => written.includes(ASK), "the composer never showed the prompt", 2)),
        Effect.retry({ times: 10 }),
      )
      yield* Effect.sync(() => tui.terminal?.write("\r"))
      yield* until(
        () => heard().some((report) => report.state === "working" && report.msg === `shell: ${COMMAND}`),
        "Rex never heard the command at work",
        30,
      )
      yield* until(() => {
        const reports = heard()
        const working = reports.findIndex((report) => report.state === "working")
        return reports.slice(working).some((report) => report.state === "idle" && report.title === "rex check")
      }, "Rex never heard the session idle after the turn", 30)
      const elapsed = elapsedForReport()
      yield* Effect.sync(() => tui.kill("SIGTERM"))
      yield* until(() => exited, "the TUI did not exit within 15 s of its SIGTERM", 15)
      yield* Console.log(`the TUI exited ${elapsed()} after SIGTERM`)
      // Bytes still in the pty when it exited.
      yield* until(() => heard().at(-1)?.state === "clear", "Rex never heard the record cleared after the TUI's SIGTERM", 2)
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.suspend(() => {
          Option.map(log, (path) => writeFileSync(path, written))
          return Console.log(`rex heard: ${JSON.stringify(heard())}`)
        }),
      ),
    ),
)
