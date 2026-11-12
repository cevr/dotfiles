import { describe, expect, test } from "bun:test"
import { spawnSync, write } from "bun"
import { holdingIfFree } from "@dotfiles/opencode-rift/process/flock"
import { Effect, Exit, Option, Ref } from "effect"
import { buildName, FRESH_MS, stagingName } from "../builds.ts"
import type { Build, Record } from "../record.ts"
import { Builds } from "../service.ts"
import * as BuildsLayer from "./builds.ts"

/** Six builds, oldest first: v0 … v5; v5 is the one a concurrent stage brings. */
const V = Array.from({ length: 6 }, (_, at) => `2.2.7-prime.1000000${at}`)
const NEW = V[5]
/** A copy a crashed stage left behind: not a build, so it never goes. */
const LEFTOVER = stagingName(V[0], 4242)

/** A scratch host: a share directory, the builds lock, and a `/proc` stand-in, all in `dir`. */
interface Scratch {
  readonly dir: string
  readonly share: string
  readonly lock: string
  readonly proc: string
}

const sh = (argv: ReadonlyArray<string>) => spawnSync([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })

/**
 * The share directory holds builds v0 … v4 (ten bytes each), two entries that are not builds and a
 * leftover copy; `/proc` holds this process's own link (unless `self` is false) and, for each of
 * `running`, a pid whose `exe` links to it, and one pid with no link to read.
 */
const scratch = (runs: (share: string) => ReadonlyArray<string>, self = true): Effect.Effect<Scratch> =>
  Effect.gen(function* () {
    const dir = sh(["mktemp", "-d", "-t", "update-builds"]).stdout.toString().trim()
    const share = `${dir}/share`
    const proc = `${dir}/proc`
    const running = runs(share)
    yield* Effect.forEach([...V.slice(0, 5).map(buildName), "pool-auth", "anthropic-auth", LEFTOVER], (name) => Effect.promise(() => write(`${share}/${name}`, "x".repeat(10), { createPath: true })), {
      discard: true,
    })
    sh(["mkdir", "-p", `${proc}/self`, `${proc}/4242`, ...running.map((_, at) => `${proc}/${100 + at}`)])
    if (self) sh(["ln", "-s", "/usr/bin/true", `${proc}/self/exe`])
    running.forEach((path, at) => void sh(["ln", "-s", path, `${proc}/${100 + at}/exe`]))
    return { dir, share, lock: `${dir}/state/builds.lock`, proc }
  })

const build = (version: string, share: string): Build => ({ version, command: [`${share}/${buildName(version)}`], dotfiles: "d".repeat(40), fork: "f".repeat(40) })

/** v4 installed, nothing staged, v3 good, v0 … v3 superseded; with `PREVIOUS_ON_DISK` 3, only v0 is old enough to go. */
const recordIn = (share: string): Record => ({ ...build(V[4], share), previous: V.slice(0, 4), good: build(V[3], share) })

/** The share directory's entries now, sorted. */
const left = (share: string) => sh(["ls", share]).stdout.toString().trim().split("\n").sort()

/**
 * The layer over the scratch host. Its freshness window is off (`NO_FRESH`): every file here was just
 * written, and a file's ctime carries sub-millisecond parts the clock's milliseconds do not, so a
 * zero window would still keep some of them.
 */
const NO_FRESH = -60_000
const layerOn = (host: Scratch, options: Partial<BuildsLayer.Options>) =>
  BuildsLayer.layer({ share: host.share, lock: host.lock, lockWaitMs: 0, freshMs: NO_FRESH, platform: "linux", proc: host.proc, ps: ["/bin/sh", "-c", "exit 1"], ...options })

/**
 * Prunes the scratch host with `options` over it, the record read with `read` (by default, `recordIn`);
 * answers how the prune ended and what is left.
 */
const pruneOn = (host: Scratch, options: Partial<BuildsLayer.Options>, read: Effect.Effect<Option.Option<Record>> = Effect.succeed(Option.some(recordIn(host.share)))) =>
  Builds.use((builds) => builds.prune(read)).pipe(
    Effect.provide(layerOn(host, options)),
    Effect.exit,
    Effect.map((exit) => ({ exit, left: left(host.share) })),
  )

const removeHost = (host: Scratch) => Effect.sync(() => void sh(["rm", "-rf", host.dir]))

/** Runs `body` on a fresh scratch host, removing the host after. */
const onHost = <A>(runs: (share: string) => ReadonlyArray<string>, body: (host: Scratch) => Effect.Effect<A>, self = true) =>
  Effect.runPromise(Effect.acquireUseRelease(scratch(runs, self), body, removeHost))

/**
 * Daily's stage of v5, step by step as `scripts/daily.ts` runs it under the builds lock: the copy in
 * flight (`stagingName`), its rename to the build's name, and the staged record's write (here a Ref).
 */
const stageSteps = (host: Scratch, record: Ref.Ref<Record>) => ({
  copy: Effect.promise(() => write(`${host.share}/${stagingName(NEW, 71234)}`, "y".repeat(10))),
  rename: Effect.sync(() => sh(["mv", `${host.share}/${stagingName(NEW, 71234)}`, `${host.share}/${buildName(NEW)}`]).exitCode).pipe(
    Effect.flatMap((code) => Effect.when(Effect.die("the stage's copy was gone before its rename"), Effect.succeed(code !== 0))),
    Effect.asVoid,
  ),
  writeRecord: Ref.update(record, (current) => ({ ...current, staged: build(NEW, host.share) })),
})

/** The part of a stage that runs if the stage can take the builds lock now; a stage that cannot waits, so here it runs later. */
const ifLockFree = <A>(host: Scratch, part: Effect.Effect<A>) => holdingIfFree(host.lock, part).pipe(Effect.orDie)

describe("pruning the share directory (scratch hosts)", () => {
  test("on Linux it deletes the builds no rule keeps, answering each with its size, and leaves every other entry, a stage's leftover copy too", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const { exit, left: after } = yield* pruneOn(host, {})
          expect(exit).toEqual(Exit.succeed([{ name: buildName(V[0]), bytes: 10 }]))
          expect(after).toEqual(["anthropic-auth", "pool-auth", LEFTOVER, ...V.slice(1, 5).map(buildName)].sort())
        }),
    ))

  test("with no record it deletes nothing", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const { exit, left: after } = yield* pruneOn(host, {}, Effect.succeed(Option.none()))
          expect(exit).toEqual(Exit.succeed([]))
          expect(after).toContain(buildName(V[0]))
        }),
    ))

  test("a build changed within FRESH_MS stays, whatever the record says", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const { exit, left: after } = yield* pruneOn(host, { freshMs: FRESH_MS })
          expect(exit).toEqual(Exit.succeed([]))
          expect(after).toContain(buildName(V[0]))
        }),
    ))

  test("a build copied in with its source's old mtime stays while its ctime is fresh", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          sh(["touch", "-m", "-t", "202001010000", `${host.share}/${buildName(V[0])}`])
          const { exit, left: after } = yield* pruneOn(host, { freshMs: FRESH_MS })
          expect(exit).toEqual(Exit.succeed([]))
          expect(after).toContain(buildName(V[0]))
        }),
    ))

  test("on Linux a build a process runs stays, read from its /proc link", () =>
    onHost(
      (share) => [`${share}/${buildName(V[0])}`],
      (host) =>
        Effect.gen(function* () {
          const { exit, left: after } = yield* pruneOn(host, {})
          expect(exit).toEqual(Exit.succeed([]))
          expect(after).toContain(buildName(V[0]))
        }),
    ))

  test("on Linux, when this process's own link does not read, it deletes nothing (fail closed)", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const { exit, left: after } = yield* pruneOn(host, {})
          expect(Option.map(Exit.findErrorOption(exit), (failed) => failed.step)).toEqual(Option.some("read this process's executable"))
          expect(after).toContain(buildName(V[0]))
        }),
      false,
    ))

  test("elsewhere it reads what runs from ps: a build ps names stays", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const ps = ["/bin/sh", "-c", `echo '${host.share}/${buildName(V[0])}'; echo /bin/zsh`]
          const { exit } = yield* pruneOn(host, { platform: "darwin", ps })
          expect(exit).toEqual(Exit.succeed([]))
        }),
    ))

  test("elsewhere, when ps fails, it deletes nothing (fail closed)", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const { exit, left: after } = yield* pruneOn(host, { platform: "darwin", ps: ["/bin/sh", "-c", "echo /bin/zsh; exit 1"] })
          expect(Option.map(Exit.findErrorOption(exit), (failed) => failed.step)).toEqual(Option.some("list the running processes"))
          expect(after).toContain(buildName(V[0]))
        }),
    ))
})

describe("a prune and daily's stage, serialized on the builds lock", () => {
  test("while daily's stage holds the lock, a prune waits for it, then gives up deleting nothing", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const held = yield* holdingIfFree(host.lock, pruneOn(host, { lockWaitMs: 300 })).pipe(Effect.orDie)
          const { exit, left: after } = Option.getOrThrow(held)
          expect(Option.map(Exit.findErrorOption(exit), (failed) => failed.step)).toEqual(Option.some("take the builds lock"))
          expect(after).toContain(buildName(V[0]))
        }),
    ))

  test("a stage that would copy during the prune runs after it, and its copy is never taken (the in-flight copy)", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const record = yield* Ref.make(recordIn(host.share))
          const stage = stageSteps(host, record)
          // The stage starts its copy as the prune reads the record, if the lock lets it.
          const copied = yield* Ref.make(false)
          const read = ifLockFree(host, stage.copy.pipe(Effect.andThen(Ref.set(copied, true)))).pipe(Effect.andThen(Ref.get(record)), Effect.map(Option.some))
          const { exit } = yield* pruneOn(host, {}, read)
          expect(exit).toEqual(Exit.succeed([{ name: buildName(V[0]), bytes: 10 }]))
          // The stage goes on: the rest of its steps (or all of them, when it had to wait).
          yield* Effect.when(stage.copy, Ref.get(copied).pipe(Effect.map((done) => !done)))
          yield* stage.rename
          yield* stage.writeRecord
          expect(left(host.share)).toContain(buildName(NEW))
        }),
    ))

  test("a build renamed in after the prune read the record is never taken (the rename after the read)", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const record = yield* Ref.make(recordIn(host.share))
          const stage = stageSteps(host, record)
          yield* stage.copy
          // The prune reads the record, and then the stage renames its build in, if the lock lets it.
          const renamed = yield* Ref.make(false)
          const read = Ref.get(record).pipe(Effect.tap(() => ifLockFree(host, stage.rename.pipe(Effect.andThen(Ref.set(renamed, true))))), Effect.map(Option.some))
          const { exit } = yield* pruneOn(host, {}, read)
          expect(exit).toEqual(Exit.succeed([{ name: buildName(V[0]), bytes: 10 }]))
          yield* Effect.when(stage.rename, Ref.get(renamed).pipe(Effect.map((done) => !done)))
          yield* stage.writeRecord
          expect(left(host.share)).toContain(buildName(NEW))
        }),
    ))
})
