import { describe, expect, test } from "bun:test"
import { spawnSync, write } from "bun"
import { Effect, Exit, Option } from "effect"
import { buildName } from "../builds.ts"
import type { Build, Record } from "../record.ts"
import { Builds } from "../service.ts"
import * as BuildsLayer from "./builds.ts"

/** Five builds, oldest first: v0 … v4. */
const V = Array.from({ length: 5 }, (_, at) => `2.2.7-prime.1000000${at}`)

/** A scratch host: a share directory, a `/proc` stand-in and a `ps` stand-in, all in `dir`. */
interface Scratch {
  readonly dir: string
  readonly share: string
  readonly proc: string
}

const sh = (argv: ReadonlyArray<string>) => spawnSync([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })

/**
 * The share directory holds every build (a few bytes each, `size` naming its length) and two entries
 * that are not builds; `/proc` holds this process's own link (unless `self` is false) and, for each of
 * `running`, a pid whose `exe` links to it, and one pid with no link to read.
 */
const scratch = (runs: (share: string) => ReadonlyArray<string>, self = true): Effect.Effect<Scratch> =>
  Effect.gen(function* () {
    const dir = sh(["mktemp", "-d", "-t", "update-builds"]).stdout.toString().trim()
    const share = `${dir}/share`
    const proc = `${dir}/proc`
    const running = runs(share)
    yield* Effect.forEach([...V.map(buildName), "pool-auth", "anthropic-auth"], (name) => Effect.promise(() => write(`${share}/${name}`, "x".repeat(10), { createPath: true })), { discard: true })
    sh(["mkdir", "-p", `${proc}/self`, `${proc}/4242`, ...running.map((_, at) => `${proc}/${100 + at}`)])
    if (self) sh(["ln", "-s", "/usr/bin/true", `${proc}/self/exe`])
    running.forEach((path, at) => void sh(["ln", "-s", path, `${proc}/${100 + at}/exe`]))
    return { dir, share, proc }
  })

const build = (version: string, share: string): Build => ({ version, command: [`${share}/${buildName(version)}`], dotfiles: "d".repeat(40), fork: "f".repeat(40) })

/** v4 installed, nothing staged, v3 good, v0 … v3 superseded; with `PREVIOUS_ON_DISK` 3, only v0 is old enough to go. */
const recordIn = (share: string): Record => ({ ...build(V[4], share), previous: V.slice(0, 4), good: build(V[3], share) })

/** The share directory's entries after the prune, sorted. */
const left = (share: string) => sh(["ls", share]).stdout.toString().trim().split("\n").sort()

/** Prunes the scratch host with `options` over it; answers how the prune ended and what is left, and removes the host. */
const pruneOn = (host: Scratch, options: Partial<BuildsLayer.Options>) =>
  Builds.use((builds) => builds.prune(recordIn(host.share))).pipe(
    Effect.provide(BuildsLayer.layer({ share: host.share, platform: "linux", proc: host.proc, ps: ["/bin/sh", "-c", "exit 1"], ...options })),
    Effect.exit,
    Effect.map((exit) => ({ exit, left: left(host.share) })),
    Effect.ensuring(Effect.sync(() => void sh(["rm", "-rf", host.dir]))),
  )

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

describe("pruning the share directory (scratch hosts)", () => {
  test("on Linux it deletes the builds no rule keeps, answering each with its size, and leaves every other entry", () =>
    run(
      Effect.gen(function* () {
        const host = yield* scratch(() => [])
        const { exit, left: after } = yield* pruneOn(host, {})
        expect(exit).toEqual(Exit.succeed([{ name: buildName(V[0]), bytes: 10 }]))
        expect(after).toEqual(["anthropic-auth", "pool-auth", ...V.slice(1).map(buildName)].sort())
      }),
    ))

  test("on Linux a build a process runs stays, read from its /proc link", () =>
    run(
      Effect.gen(function* () {
        const host = yield* scratch((share) => [`${share}/${buildName(V[0])}`])
        const { exit, left: after } = yield* pruneOn(host, {})
        expect(exit).toEqual(Exit.succeed([]))
        expect(after).toContain(buildName(V[0]))
      }),
    ))

  test("on Linux, when this process's own link does not read, it deletes nothing (fail closed)", () =>
    run(
      Effect.gen(function* () {
        const host = yield* scratch(() => [], false)
        const { exit, left: after } = yield* pruneOn(host, {})
        expect(Option.map(Exit.findErrorOption(exit), (failed) => failed.step)).toEqual(Option.some("read this process's executable"))
        expect(after).toContain(buildName(V[0]))
      }),
    ))

  test("elsewhere it reads what runs from ps: a build ps names stays", () =>
    run(
      Effect.gen(function* () {
        const host = yield* scratch(() => [])
        const ps = ["/bin/sh", "-c", `echo '${host.share}/${buildName(V[0])}'; echo /bin/zsh`]
        const { exit } = yield* pruneOn(host, { platform: "darwin", ps })
        expect(exit).toEqual(Exit.succeed([]))
      }),
    ))

  test("elsewhere, when ps fails, it deletes nothing (fail closed)", () =>
    run(
      Effect.gen(function* () {
        const host = yield* scratch(() => [])
        const { exit, left: after } = yield* pruneOn(host, { platform: "darwin", ps: ["/bin/sh", "-c", "echo /bin/zsh; exit 1"] })
        expect(Option.map(Exit.findErrorOption(exit), (failed) => failed.step)).toEqual(Option.some("list the running processes"))
        expect(after).toContain(buildName(V[0]))
      }),
    ))
})
