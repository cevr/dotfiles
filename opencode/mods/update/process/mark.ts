import { spawnSync } from "bun"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { publishText, readPublished, removePublished } from "../filestore/files.ts"
import { HandoffMark } from "../service.ts"
import { Running } from "../update.ts"

const RunningJson = Schema.fromJsonString(Running)
const decode = Schema.decodeUnknownOption(RunningJson)
const encode = Schema.encodeSync(RunningJson)

/** Whether process `pid` lives: `ps -p` answers 0 only for a process it lists. It sends no signal. */
const alive = (pid: number): Effect.Effect<boolean> =>
  Effect.try(() => spawnSync(["ps", "-p", String(pid), "-o", "pid="], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exitCode === 0).pipe(
    Effect.orElseSucceed(() => false),
  )

/**
 * The handoff's mark in its file, `<update state>/handoff.json`, for the process `pid` (the
 * handoff's own, from its composition root). A refused mark prevents the handoff.
 */
export const layer = (path: string, pid: number) => {
  const read = readPublished("read the running handoff", path).pipe(Effect.map((text) => Option.flatMap(text, decode)))
  return Layer.succeed(
    HandoffMark,
    HandoffMark.of({
      hold: Clock.currentTimeMillis.pipe(Effect.flatMap((at) => publishText("mark the running handoff", path, "owner-only", encode({ pid, at })))),
      release: removePublished("release the running handoff", path, (text) => Option.exists(decode(text), (each) => each.pid === pid)),
      read,
      alive,
    }),
  )
}
