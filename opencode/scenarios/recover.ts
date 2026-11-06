// A session whose directory is gone goes back where it was, with the recover
// TUI plugin (cmd/recover) loaded. A session "Stranded" is made through
// the API and moved into a fresh `rift` folder in the project; the folder is
// then removed, and the TUI opens the session from /sessions. The plugin moves
// it back to where the server made it and toasts where it went.
// Run: OPENCODE_DEV=<opencode checkout> SCENARIO_OUT=out bunx opencode-drive run scenarios/recover.ts
//
// It writes, under SCENARIO_OUT, `recover-moved.txt` (the frame with the
// toast), `recover-settled.txt` (the frame once the session sits where it
// was made again), `recover-locations.json` (where it was made, the rift, and the
// session's location after the move in and after the recovery) and
// `recover-timeout.txt` when a wait times out.
import { Effect, Schedule, Stream } from "effect"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Llm, OpenCodeDriver } from "opencode-drive"

const root = process.cwd()
const out = process.env.SCENARIO_OUT ?? "out"

type Frame = { lines: ReadonlyArray<{ spans: ReadonlyArray<{ text: string }> }> }
type Move = Parameters<OpenCodeDriver.Driver["opencode"]["session"]["move"]>[0]
type SessionID = Move["sessionID"]
const text = (frame: Frame) => frame.lines.map((l) => l.spans.map((s) => s.text).join("").trimEnd()).join("\n")

export default OpenCodeDriver.use(
  {
    opencode: { dev: process.env.OPENCODE_DEV! },
    config: { autoupdate: false, username: "Demo" },
    tuiConfig: { animations: false, tabs: { mode: "off" }, plugins: [`${root}/cmd/recover`] },
    tui: { viewport: { cols: 140, rows: 36 } },
    project: { git: true },
  },
  ({ ui, llm, opencode, directory }) =>
    Effect.gen(function* () {
      yield* llm.serve(() => Stream.make(Llm.text("Ready."), Llm.finish()))
      const until = (check: (frame: string) => boolean, name: string) =>
        ui.capture().pipe(
          Effect.map(text),
          Effect.flatMap((frame) => (check(frame) ? Effect.succeed(frame) : Effect.fail(frame))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 300 }),
          Effect.tapError((frame) => Effect.sync(() => writeFileSync(`${out}/recover-timeout.txt`, `${name}\n${frame}`))),
        )
      const locationOf = (sessionID: SessionID) => opencode.session.get({ sessionID }).pipe(Effect.map((session) => session.location.directory))
      const settled = (sessionID: SessionID, want: string) =>
        locationOf(sessionID).pipe(
          Effect.flatMap((at) => (at === want ? Effect.succeed(at) : Effect.fail(at))),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
        )

      const rift = join(directory, "rift")
      mkdirSync(rift)
      const session = yield* opencode.session.create({ title: "Stranded" })
      // Where the server made it: its own directory, since the API call names none.
      const born = yield* locationOf(session.id)
      yield* opencode.session.move({ sessionID: session.id, directory: rift as Move["directory"] })
      const movedIn = yield* settled(session.id, rift)
      rmSync(rift, { recursive: true, force: true })

      yield* ui.submit("/sessions")
      yield* until((frame) => frame.includes("all projects"), "sessions")
      // The list shows the TUI's own directory's sessions; the stranded one sits in the rift.
      if (!text(yield* ui.capture()).includes("Stranded")) yield* ui.press("a", { ctrl: true })
      yield* until((frame) => frame.includes("Stranded"), "all sessions")
      yield* ui.press("return")
      const recovered = yield* settled(session.id, born).pipe(Effect.catchCause(() => locationOf(session.id)))
      writeFileSync(`${out}/recover-locations.json`, JSON.stringify({ born, rift, movedIn, recovered }, null, 2))
      const moved = yield* until((frame) => frame.includes("no longer exists"), "toast")
      writeFileSync(`${out}/recover-moved.txt`, moved)
      // The transcript holds the move in and the move back, each once.
      const after = yield* until((frame) => frame.split("↳ Moved to").length - 1 === 2 && !frame.includes("Session location unavailable"), "settled")
      writeFileSync(`${out}/recover-settled.txt`, after)
    }),
)
