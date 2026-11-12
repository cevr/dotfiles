import { describe, expect, test } from "bun:test"
import { spawnSync, write } from "bun"
import { Effect, Option } from "effect"
import { readText } from "../filestore/files.ts"
import { Placement, scopeName } from "../placement.ts"
import { Placer } from "../service.ts"
import * as ProcessPlacement from "./placement.ts"

const PID = 4242
const MANAGER = "/user.slice/user-1000.slice/user@1000.service"
const HERDR = `${MANAGER}/app.slice/herdr-bite.service`
const SCOPED = `${MANAGER}/app.slice/${scopeName(PID)}`

/** What the stand-in for `busctl` does in `dir`: log the call, then move the process (rewrite its cgroup file) or refuse. */
const calls = {
  move: (dir: string) => ["/bin/sh", "-c", `echo call >>'${dir}/calls'; printf '0::%s\\n' '${SCOPED}' >'${dir}/cgroup'`],
  // As the user manager does: it answers once the start is queued, and moves the process just after.
  moveLater: (dir: string) => ["/bin/sh", "-c", `echo call >>'${dir}/calls'; (sleep 0.3; printf '0::%s\\n' '${SCOPED}' >'${dir}/cgroup') &`],
  refuse: (dir: string) => ["/bin/sh", "-c", `echo call >>'${dir}/calls'; echo 'Access denied' >&2; exit 1`],
}

/** The background service's `/proc/<pid>/cmdline`, and a throwaway server's. */
const SERVICE = ["/home/u/.local/share/opencode-prime/opencode-2.2.7-prime.abc", "serve", "--service", ""].join("\0")
const THROWAWAY = ["/home/u/.local/share/opencode-prime/opencode-2.2.7-prime.abc", "serve", "--port", "0", ""].join("\0")

/**
 * `body` with the real Placer over a scratch `/proc/<pid>` whose cgroup is `cgroup` and whose command
 * line is the background service's unless `cmdline` says otherwise, on Linux unless `platform` does:
 * the placement it answers and the calls made.
 */
const onHost = (cgroup: string, call: (dir: string) => ReadonlyArray<string>, body: Effect.Effect<Placement, never, Placer>, platform = "linux", cmdline = SERVICE) =>
  Effect.acquireUseRelease(
    Effect.sync(() => spawnSync(["mktemp", "-d", "-t", "update-placement"]).stdout.toString().trim()),
    (dir) =>
      Effect.all([Effect.promise(() => write(`${dir}/cgroup`, `0::${cgroup}\n`)), Effect.promise(() => write(`${dir}/cmdline`, cmdline))]).pipe(
        Effect.andThen(body),
        Effect.provide(ProcessPlacement.layer({ pid: PID, platform, proc: dir, argv: call(dir) })),
        Effect.flatMap((placement) =>
          readText(`${dir}/calls`).pipe(Effect.map((text) => ({ placement, calls: Option.getOrElse(text, () => "").split("\n").filter((line) => line !== "").length }))),
        ),
      ),
    (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
  )

/** One case: its effect, run. */
const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

const place = Placer.use((placer) => placer.place)
const observe = Placer.use((placer) => placer.observe)
const placed = Placement.cases.Placed.make({ unit: scopeName(PID) })

describe("the service places itself", () => {
  test("outside its scope it asks the user manager once, and then runs in opencode-service-<pid>.scope", () =>
    run(onHost(HERDR, calls.move, place).pipe(Effect.map((answer) => expect(answer).toEqual({ placement: placed, calls: 1 })))))

  test("a move the user manager makes just after its answer is waited for", () =>
    run(onHost(HERDR, calls.moveLater, place).pipe(Effect.map((answer) => expect(answer).toEqual({ placement: placed, calls: 1 })))))

  test("already in its scope it asks nothing", () =>
    run(onHost(SCOPED, calls.refuse, place).pipe(Effect.map((answer) => expect(answer).toEqual({ placement: placed, calls: 0 })))))

  test("a refusal leaves it unplaced, saying where it runs and what the user manager said", () =>
    run(
      onHost(HERDR, calls.refuse, place).pipe(
        Effect.map((answer) => expect(answer).toEqual({ placement: Placement.cases.Unplaced.make({ cgroup: HERDR, cause: "Access denied" }), calls: 1 })),
      ),
    ))

  test("off Linux, or in a server that is not the background service, nothing is placed or asked", () =>
    run(
      Effect.all([onHost(HERDR, calls.move, place, "darwin"), onHost(HERDR, calls.move, place, "linux", THROWAWAY)]).pipe(
        Effect.map((answers) =>
          expect(answers).toEqual([
            { placement: Placement.cases.Unmanaged.make({ reason: "darwin has no user systemd" }), calls: 0 },
            { placement: Placement.cases.Unmanaged.make({ reason: "this server is not the background service" }), calls: 0 },
          ]),
        ),
      ),
    ))

  test("reading where it runs asks nothing", () =>
    run(
      onHost(HERDR, calls.move, observe).pipe(
        Effect.map((answer) => expect(answer).toEqual({ placement: Placement.cases.Unplaced.make({ cgroup: HERDR, cause: "it was not placed" }), calls: 0 })),
      ),
    ))
})
