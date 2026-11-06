// The real `ps`: a `sleep` this test starts is listed with its whole command
// line, and a `ps` that fails is ProcessesUnreadable.
import { afterAll, expect, test } from "bun:test"
import { Effect } from "effect"
import { processesLaws } from "../laws.ts"
import { Processes, ProcessesUnreadable } from "../service.ts"
import * as PsProcesses from "./processes.ts"

const sleeper = Bun.spawn(["sleep", "41.5"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" })
afterAll(() => sleeper.kill())

processesLaws("ps Processes", PsProcesses.layer(), { pid: sleeper.pid, args: "sleep 41.5" })

test("a ps that cannot run is ProcessesUnreadable", async () => {
  const error = await Effect.runPromise(
    Effect.flip(
      Effect.gen(function* () {
        return yield* (yield* Processes).list()
      }).pipe(Effect.provide(PsProcesses.layer("/nonexistent/ps-probe-x"))),
    ),
  )
  expect(error).toBeInstanceOf(ProcessesUnreadable)
})

test("a ps line is its PID and the rest of the line, spaces kept", () => {
  expect([...PsProcesses.parseColumn("  12 /bin/zsh -c echo  hi\n  3 launchd\nbad line\n")]).toEqual([
    [12, "/bin/zsh -c echo  hi"],
    [3, "launchd"],
  ])
})
