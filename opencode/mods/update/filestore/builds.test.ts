// @reads all
// @reads-reason subprocess reads at mods/update/filestore/builds.test.ts: expect(spawnSync(["/bin/sh", "-c", `printf changed > '${tree}/opencode/cmd/a/server.ts'`], { st
import { describe, expect, test } from "bun:test"
import { argv, env, spawnSync, write } from "bun"
import { holdingIfFree } from "@dotfiles/opencode-work/process/flock"
import { Effect, Exit, Option, Ref } from "effect"
import { buildName, FRESH_MS, isBuild, prunable, stagingName } from "../builds.ts"
import { buildOfTree, treeOf } from "../trees.ts"
import type { Build, Record } from "../record.ts"
import { Builds } from "../service.ts"
import * as BuildsLayer from "./builds.ts"
import * as TreesLayer from "./trees.ts"
import { gitInit } from "../../../tests/git-repo.ts"

/**
 * Six builds, oldest first: v0 … v5; v5 is the one a concurrent stage brings. v0 and v1 are of the
 * old format (the fork's commit alone), v2 … v5 of the new (the fork's, then the dotfiles'), as a host
 * has them after its first install of the new format.
 */
const V = [0, 1].map((at) => `2.2.7-prime.1000000${at}`).concat([2, 3, 4, 5].map((at) => `2.2.7-prime.10000001.d000000${at}`))
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
  BuildsLayer.layer({ share: host.share, lock: host.lock, lockWaitMs: 0, freshMs: NO_FRESH, platform: "linux", proc: host.proc, ps: ["/bin/sh", "-c", "exit 1"], psArgs: ["/bin/sh", "-c", "true"], ...options })

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

/** Removes the scratch host, a sealed tree in it too. */
const removeHost = (host: Pick<Scratch, "dir">) => Effect.sync(() => void sh(["/bin/sh", "-c", `chmod -R u+w '${host.dir}' && rm -rf '${host.dir}'`]))

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

/**
 * A sealed tree beside build `version` as a make leaves it (`filestore/trees.ts`): ten bytes of source
 * and ten in a package of its `node_modules`, every file and directory read-only but the `node_modules`.
 */
const plantTree = (share: string, version: string) => {
  const tree = `${share}/${treeOf(buildName(version))}`
  sh(["mkdir", "-p", `${tree}/opencode/cmd/wake`, `${tree}/opencode/node_modules/pkg`, `${tree}/config`])
  sh(["/bin/sh", "-c", `printf xxxxxxxxxx > '${tree}/opencode/cmd/wake/job.ts'; printf yyyyyyyyyy > '${tree}/opencode/node_modules/pkg/index.js'`])
  sh(["chmod", "a-w", `${tree}/opencode/cmd/wake/job.ts`, `${tree}/opencode/cmd/wake`, `${tree}/opencode/cmd`, `${tree}/config`, `${tree}/opencode`, tree])
  return tree
}

describe("pruning trees with their builds (scratch hosts)", () => {
  test("a sealed tree goes with its build, after it, answering every byte it held, its node_modules too; a kept build's tree stays", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          plantTree(host.share, V[0])
          plantTree(host.share, V[4])
          const { exit, left: after } = yield* pruneOn(host, {})
          const pruned = Exit.match(exit, { onFailure: () => [], onSuccess: (each) => each })
          expect(pruned.map((each) => each.name)).toEqual([buildName(V[0]), treeOf(buildName(V[0]))])
          expect(pruned.filter((each) => each.bytes >= 20).map((each) => each.name)).toEqual([treeOf(buildName(V[0]))])
          expect(after).not.toContain(treeOf(buildName(V[0])))
          expect(after).toContain(treeOf(buildName(V[4])))
        }),
    ))

  test("on Linux a tree a process's command line names stays, read from its /proc cmdline; its build goes", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const tree = plantTree(host.share, V[0])
          sh(["mkdir", "-p", `${host.proc}/300`])
          yield* Effect.promise(() => write(`${host.proc}/300/cmdline`, `/usr/bin/bun\0${tree}/opencode/cmd/wake/job.ts\0--id\0`))
          const { exit, left: after } = yield* pruneOn(host, {})
          expect(exit).toEqual(Exit.succeed([{ name: buildName(V[0]), bytes: 10 }]))
          expect(after).toContain(treeOf(buildName(V[0])))
        }),
    ))

  test("elsewhere a tree ps's command lines name stays; when they do not read, nothing goes (fail closed)", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          const tree = plantTree(host.share, V[0])
          const ps = ["/bin/sh", "-c", "echo /bin/zsh"]
          const named = yield* pruneOn(host, { platform: "darwin", ps, psArgs: ["/bin/sh", "-c", `echo '/usr/bin/bun ${tree}/opencode/cmd/wake/job.ts'`] })
          expect(named.exit).toEqual(Exit.succeed([{ name: buildName(V[0]), bytes: 10 }]))
          expect(named.left).toContain(treeOf(buildName(V[0])))
          const unread = yield* pruneOn(host, { platform: "darwin", ps, psArgs: ["/bin/sh", "-c", "exit 1"] })
          expect(Option.map(Exit.findErrorOption(unread.exit), (failed) => failed.step)).toEqual(Option.some("list the running processes"))
          expect(unread.left).toContain(treeOf(buildName(V[0])))
        }),
    ))

  test("a tree changed within FRESH_MS stays, whatever the record says", () =>
    onHost(
      () => [],
      (host) =>
        Effect.gen(function* () {
          plantTree(host.share, V[0])
          const { left: after } = yield* pruneOn(host, { freshMs: FRESH_MS })
          expect(after).toContain(treeOf(buildName(V[0])))
        }),
    ))
})

// Making a tree (`filestore/trees.ts`), here beside the prune that takes it away: the make runs on a
// scratch git repository with its own stand-in daily, under bun:test as every case of this file does.

const TREE_VERSION = "2.2.7-prime.f0f0f0f0.d0d0d0d0"

/** Runs `argv` in `cwd` and answers what it printed; a failure fails the case with its stderr. */
const ran = (argv: ReadonlyArray<string>, cwd: string) => {
  const done = spawnSync([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  expect({ argv, code: done.exitCode, err: done.stderr.toString().slice(-800) }).toMatchObject({ code: 0 })
  return done.stdout.toString()
}

/** `text`'s lines, the empty ones dropped. */
const linesOf = (text: string) => text.split("\n").filter((line) => line !== "")

/**
 * The stand-in for the commit's own `scripts/daily.ts --tree <dir> --at <place>`: one server entry for
 * `cmd/a` and both overlay files, as the real one writes them (scripts/daily.ts `writeTree`).
 */
const STAND_IN_DAILY = `import { mkdirSync, writeFileSync } from "node:fs"
const argv = process.argv
const dir = argv[argv.indexOf("--tree") + 1]
const at = argv[argv.indexOf("--at") + 1]
mkdirSync(dir + "/entries/server/a", { recursive: true })
mkdirSync(dir + "/config", { recursive: true })
writeFileSync(dir + "/entries/server/a/package.json", JSON.stringify({ name: "@dotfiles/opencode-entry-a", exports: { "./server": "./server.ts" } }))
writeFileSync(dir + "/entries/server/a/server.ts", 'export { default } from "../../../opencode/cmd/a/server.ts"\\n')
writeFileSync(dir + "/config/opencode.json", JSON.stringify({ plugins: [at + "/entries/server/a"] }))
writeFileSync(dir + "/config/cli.json", JSON.stringify({ plugins: [at + "/opencode/cmd/a"] }))
`

/** The scratch repository's files: a workspace of a mod and its `cmd/` package, which imports the mod, the host's `effect`, and `extra`. */
const repoFiles = (extra: string): ReadonlyArray<readonly [string, string]> => [
  [".gitignore", "node_modules\n"],
  ["opencode/package.json", `{ "name": "scratch", "private": true, "workspaces": ["mods/*", "cmd/*"] }\n`],
  ["opencode/mods/a/package.json", `{ "name": "@dotfiles/opencode-a", "private": true, "exports": { "./*": "./*.ts" } }\n`],
  ["opencode/mods/a/x.ts", "export const x = 1\n"],
  ["opencode/cmd/a/package.json", `{ "name": "@dotfiles/opencode-cmd-a", "private": true, "exports": { "./server": "./server.ts" }, "dependencies": { "@dotfiles/opencode-a": "workspace:*" } }\n`],
  ["opencode/cmd/a/server.ts", `import { x } from "@dotfiles/opencode-a/x"\nimport { Effect } from "effect"\n${extra}export default Effect.succeed(x)\n`],
  ["opencode/scripts/daily.ts", STAND_IN_DAILY],
  ["workbox/zshenv", "export SCRATCH=1\n"],
  ["workbox/bin/workrift", "#!/bin/sh\n"],
  ["README.md", "outside opencode/ and workbox/, so never in a tree\n"],
]

/** A scratch host for a make: a git repository with one commit of `repoFiles(extra)`, its lockfile made, an empty share directory, and the make's options. */
interface TreeHost {
  readonly dir: string
  readonly repo: string
  readonly commit: string
  readonly options: TreesLayer.Options
}

const treeHost = (extra: string): Effect.Effect<TreeHost> =>
  Effect.gen(function* () {
    const dir = ran(["realpath", ran(["mktemp", "-d", "-t", "update-trees"], "/").trim()], "/").trim()
    const repo = `${dir}/repo`
    yield* Effect.forEach(repoFiles(extra), ([path, text]) => Effect.promise(() => write(`${repo}/${path}`, text, { createPath: true })), { discard: true })
    const bun = Option.getOrElse(Option.fromNullishOr(argv.at(0)), () => "bun")
    ran([bun, "install"], `${repo}/opencode`)
    gitInit(repo, ["-q", "-b", "main"])
    ran(["git", "add", "-A"], repo)
    ran(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "scratch"], repo)
    ran(["mkdir", "-p", `${dir}/share`, `${dir}/home`], dir)
    const path = Option.getOrElse(Option.fromNullishOr(env.PATH), () => "/usr/bin:/bin")
    return { dir, repo, commit: ran(["git", "rev-parse", "HEAD"], repo).trim(), options: { share: `${dir}/share`, checkout: repo, bun, env: { PATH: path, HOME: `${dir}/home` }, pid: 4242, overlay: [] } }
  })

/** Runs `body` on a fresh scratch host for a make, removing it after. */
const onTreeHost = <A, E>(body: (host: TreeHost) => Effect.Effect<A, E>, extra = "") => Effect.runPromise(Effect.acquireUseRelease(treeHost(extra), body, removeHost))

/** Every file path under `root` but in a `node_modules`, sorted. */
const sourcesUnder = (root: string) =>
  linesOf(ran(["find", root, "-name", "node_modules", "-prune", "-o", "-type", "f", "-print"], root))
    .map((line) => line.slice(root.length + 1))
    .sort()

/** What a share directory holds that reads as a tree, and whether the build's binary would bind a tree's overlay. */
const treesIn = (share: string) => ({
  read: left(share).filter((name) => Option.isSome(Option.filter(buildOfTree(name), isBuild))),
  bound: spawnSync(["test", "-e", `${share}/${treeOf(buildName(TREE_VERSION))}/config`]).exitCode === 0,
})

describe("making a build's plugin tree (scratch repositories)", () => {
  test("the tree's opencode/ is the commit's, its links stay in it (or Bun's cache), nothing outside node_modules is writable, and a second make is a no-op", () =>
    onTreeHost((host) =>
      Effect.gen(function* () {
        const tree = yield* TreesLayer.make(host.options, TREE_VERSION, host.commit)
        expect(tree).toBe(`${host.options.share}/${treeOf(buildName(TREE_VERSION))}`)

        // The commit's opencode/, file for file and byte for byte, beside what the overlay added.
        const committed = linesOf(ran(["git", "ls-tree", "-r", "--name-only", "HEAD", "opencode"], host.repo))
          .map((path) => path.slice("opencode/".length))
          .sort()
        expect(sourcesUnder(`${tree}/opencode`)).toEqual(committed)
        for (const path of committed) expect(ran(["cat", `${tree}/opencode/${path}`], tree)).toBe(ran(["git", "show", `HEAD:opencode/${path}`], host.repo))
        // The commit's workbox/ too: the workbox's commands and shell files arrive from the build the host runs.
        const workbox = linesOf(ran(["git", "ls-tree", "-r", "--name-only", "HEAD", "workbox"], host.repo)).sort()
        expect(workbox).toEqual(["workbox/bin/workrift", "workbox/zshenv"])
        for (const path of workbox) expect(ran(["cat", `${tree}/${path}`], tree)).toBe(ran(["git", "show", `HEAD:${path}`], host.repo))
        expect(sourcesUnder(tree).filter((path) => !path.startsWith("opencode/"))).toEqual(["config/cli.json", "config/opencode.json", "entries/server/a/package.json", "entries/server/a/server.ts", ...workbox])
        expect(ran(["cat", `${tree}/config/opencode.json`], tree)).toBe(`{"plugins":["${tree}/entries/server/a"]}`)

        // Every link resolves inside the tree, or into Bun's cache.
        const links = linesOf(ran(["find", tree, "-type", "l"], tree))
        expect(links.length).toBeGreaterThan(0)
        const cache = `${Option.getOrElse(Option.fromNullishOr(env.HOME), () => "")}/.bun/install/cache/`
        const real = linesOf(ran(["realpath", ...links], tree))
        expect(real.filter((path) => !path.startsWith(`${tree}/`) && !path.startsWith(cache))).toEqual([])

        // Sealed: no file or directory outside node_modules keeps a write bit, and a write there is refused.
        expect(ran(["find", tree, "-name", "node_modules", "-prune", "-o", "-perm", "-u+w", "-print"], tree)).toBe("")
        expect(spawnSync(["/bin/sh", "-c", `printf changed > '${tree}/opencode/cmd/a/server.ts'`], { stderr: "pipe" }).exitCode).not.toBe(0)
        expect(spawnSync(["/bin/sh", "-c", `printf new > '${tree}/opencode/new.ts'`], { stderr: "pipe" }).exitCode).not.toBe(0)

        // A second make of the same version answers the same tree and touches nothing.
        const before = ran(["ls", "-laR", tree], tree)
        expect(yield* TreesLayer.make({ ...host.options, pid: 4343 }, TREE_VERSION, host.commit)).toBe(tree)
        expect(ran(["ls", "-laR", tree], tree)).toBe(before)
        expect(left(host.options.share)).toEqual([treeOf(buildName(TREE_VERSION))])
      }),
    ))

  test("a make stopped after any step leaves nothing that reads as a tree or that a binary binds, and a prune takes what it left", () =>
    onTreeHost((host) =>
      Effect.gen(function* () {
        const place = TreesLayer.placeOf(host.options.share, TREE_VERSION, host.options.pid)
        const all = TreesLayer.steps(host.options, place, host.commit)
        expect(all.map((step) => step.name)).toEqual(["archive", "install", "overlay", "check", "seal", "place"])
        const record: Record = { version: TREE_VERSION, command: [`${host.options.share}/${buildName(TREE_VERSION)}`], dotfiles: "d".repeat(40), fork: "f".repeat(40) }
        const making = place.making.slice(place.making.lastIndexOf("/") + 1)
        for (const step of all.slice(0, -1)) {
          yield* step.run
          expect({ step: step.name, ...treesIn(host.options.share) }).toEqual({ step: step.name, read: [], bound: false })
          expect({ step: step.name, pruned: prunable(left(host.options.share), record, Option.some({ executables: [], commands: [] })) }).toEqual({ step: step.name, pruned: [making] })
        }
        yield* Effect.forEach(all.slice(-1), (step) => step.run, { discard: true })
        expect(treesIn(host.options.share)).toEqual({ read: [treeOf(buildName(TREE_VERSION))], bound: true })
      }),
    ))

  test("a tree whose plugin imports what neither its host serves nor its install holds fails its check, naming it, and leaves nothing", () =>
    onTreeHost(
      (host) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(TreesLayer.make(host.options, TREE_VERSION, host.commit))
          const failure = Exit.findErrorOption(exit)
          expect(Option.map(failure, (failed) => failed.step)).toEqual(Option.some("check the tree"))
          expect(Option.map(failure, (failed) => failed.message.includes("cmd/a/server.ts (server): cmd/a/server.ts imports left-pad"))).toEqual(Option.some(true))
          expect(sh(["ls", "-A", host.options.share]).stdout.toString()).toBe("")
        }),
      `import "left-pad"\n`,
    ))
})
