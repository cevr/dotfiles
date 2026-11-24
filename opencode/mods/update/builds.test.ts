import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { baseName, buildName, buildVersion, FRESH_MS, isBuild, isFresh, PREVIOUS_ON_DISK, prunable, type Running, stagingName } from "./builds.ts"
import { type Build, type Record, recordText } from "./record.ts"
import { buildOfTree, makingName, makingTree, namedBy, treeOf } from "./trees.ts"

const SHARE = "/home/u/.local/share/opencode-prime"
/** Eight builds, oldest first: v0 … v7. */
const V = Array.from({ length: 8 }, (_, at) => `2.2.7-prime.0000000${at}`)
const build = (version: string): Build => ({ version, command: [`${SHARE}/${buildName(version)}`], dotfiles: "d".repeat(40), fork: "f".repeat(40) })

/**
 * A host mid-update: v6 installed, v7 staged, v1 the last good build, v0 … v5 superseded (oldest
 * first), as `nextRecord` lists them.
 */
const RECORD: Record = { ...build(V[6]), previous: V.slice(0, 6), good: build(V[1]), staged: build(V[7]) }

/** The share directory: every build, and entries that are not builds. */
const NAMES = [...V.map(buildName), "pool-auth", "anthropic-auth", "handoff-claude-2026-11-05", "opencode", "opencode-latest"]

/** What runs: these executables, and these command lines. */
const runs = (executables: ReadonlyArray<string>, commands: ReadonlyArray<string> = []) => Option.some<Running>({ executables, commands })
const nothingRuns = runs([])

describe("which old builds a prune deletes", () => {
  test("keeps the installed (a), the staged (b), the newest previous three and the good build (c), and deletes only the older builds", () => {
    expect(PREVIOUS_ON_DISK).toBeLessThanOrEqual(3)
    expect(prunable(NAMES, RECORD, nothingRuns)).toEqual([buildName(V[0]), buildName(V[2])])
  })

  test("(a) the installed build stays, though nothing else names it", () => {
    const record: Record = { ...build(V[6]), previous: [] }
    expect(prunable([buildName(V[6]), buildName(V[0])], record, nothingRuns)).toEqual([buildName(V[0])])
  })

  test("(a) the file the installed command runs stays, whatever its version reads", () => {
    const record: Record = { ...build(V[6]), command: [`${SHARE}/${buildName(V[3])}`], previous: [] }
    expect(prunable([buildName(V[3])], record, nothingRuns)).toEqual([])
  })

  test("(b) the staged build stays, waiting for its restart", () => {
    const record: Record = { ...build(V[6]), previous: [], staged: build(V[7]) }
    expect(prunable([buildName(V[7])], record, nothingRuns)).toEqual([])
  })

  test("(c) the newest superseded builds stay, for the TUIs on them and a rollback; older ones go", () => {
    const record: Record = { ...build(V[6]), previous: V.slice(0, 6) }
    expect(prunable(V.slice(0, 6).map(buildName), record, nothingRuns)).toEqual(V.slice(0, 6 - PREVIOUS_ON_DISK).map(buildName))
  })

  test("(c) the good build stays, however far back it is", () => {
    const record: Record = { ...build(V[6]), previous: V.slice(0, 6), good: build(V[0]) }
    expect(prunable([buildName(V[0])], record, nothingRuns)).toEqual([])
  })

  test("(d) a build a process runs stays, even one the record no longer names, and one unlinked under it", () => {
    const record: Record = { ...build(V[6]), previous: [] }
    const running = runs([`${SHARE}/${buildName(V[0])}`, `${SHARE}/${buildName(V[2])} (deleted)`, "/usr/bin/zsh"])
    expect(prunable([buildName(V[0]), buildName(V[1]), buildName(V[2])], record, running)).toEqual([buildName(V[1])])
  })

  test("(d) when what runs does not read, nothing goes (fail closed)", () => {
    expect(prunable(NAMES, RECORD, Option.none())).toEqual([])
  })

  test("(e) only `opencode-<release>-prime.<8 hex>` entries are builds: the pool's auth, a loader, a handoff dir, the launcher's name and daily's copy in flight never go", () => {
    const names = ["pool-auth", "anthropic-auth", "handoff-claude-2026-11-05", "opencode", "opencode-latest", "opencode-2.2.7-prime.x.tmp", stagingName(V[7], 71234), "opencode-2.2.7-prime.0000000"]
    expect(names.map(isBuild)).toEqual(names.map(() => false))
    expect([buildName(V[0]), "opencode-2.3.0-beta.1-prime.abcdef12"].map(isBuild)).toEqual([true, true])
    expect(buildVersion(stagingName(V[7], 71234))).toEqual(Option.none())
    expect(prunable([stagingName(V[0], 71234)], { ...build(V[6]), previous: [] }, nothingRuns)).toEqual([])
    const record: Record = { ...build(V[6]), previous: [] }
    expect(prunable(["pool-auth", "anthropic-auth", "handoff-claude-2026-11-05", "opencode", "opencode-latest"], record, nothingRuns)).toEqual([])
  })

  test("a tree goes with its build, and stays with it", () => {
    const names = [...V.map(buildName), ...V.map((version) => treeOf(buildName(version)))]
    expect(prunable(names, RECORD, nothingRuns)).toEqual([buildName(V[0]), buildName(V[2]), treeOf(buildName(V[0])), treeOf(buildName(V[2]))])
  })

  test("a tree whose build is already gone goes too, unless the record keeps its version", () => {
    const record: Record = { ...build(V[6]), previous: [], good: build(V[1]) }
    expect(prunable([treeOf(buildName(V[0])), treeOf(buildName(V[1])), treeOf(buildName(V[6]))], record, nothingRuns)).toEqual([treeOf(buildName(V[0]))])
  })

  test("a tree a running process's command line names stays, though its build goes", () => {
    const record: Record = { ...build(V[6]), previous: [] }
    const tree = treeOf(buildName(V[0]))
    const running = runs([], [`/usr/bin/bun ${SHARE}/${tree}/opencode/cmd/wake/job.ts --id 3`, `/bin/zsh -c cd ${SHARE}/${treeOf(buildName(V[1]))}x`])
    expect(prunable([buildName(V[0]), tree, treeOf(buildName(V[1]))], record, running)).toEqual([buildName(V[0]), treeOf(buildName(V[1]))])
  })

  test("a command line names a tree only by a whole path part", () => {
    const tree = treeOf(buildName(V[0]))
    expect([`bun /s/${tree}/a.ts`, `/s/${tree}`, `cd /s/${tree} && x`, tree].map((command) => namedBy(tree, command))).toEqual([true, true, true, true])
    expect([`bun /s/${tree}x/a.ts`, `bun /s/x${tree}/a.ts`, `bun /s/${buildName(V[0])}/a.ts`].map((command) => namedBy(tree, command))).toEqual([false, false, false])
  })

  test("a tree in the making is no tree, and a prune under the lock takes it for a make that stopped; a near-miss name is neither", () => {
    const tree = treeOf(buildName(V[0]))
    expect(buildOfTree(makingName(tree, 4242))).toEqual(Option.none())
    expect(makingTree(makingName(tree, 4242))).toEqual(Option.some(tree))
    const record: Record = { ...build(V[0]), previous: [] }
    const near = [`${tree}.make-`, `${tree}.make-x`, ".plugins", `${buildName(V[0])}.plugin`, `opencode-latest${".plugins"}`, `${stagingName(V[0], 7)}.plugins`]
    expect(prunable([makingName(tree, 4242), tree, ...near], record, nothingRuns)).toEqual([makingName(tree, 4242)])
  })

  test("a build changed within ten minutes is fresh, by its newer time; an older one is not", () => {
    const now = 1_000_000_000
    expect(FRESH_MS).toBe(10 * 60 * 1000)
    expect([now, now - FRESH_MS + 1, now - FRESH_MS, now - FRESH_MS - 1].map((changed) => isFresh(changed, now))).toEqual([true, true, false, false])
  })

  test("a path's last component names the build, without Linux's unlinked mark", () => {
    expect(baseName("/a/b/opencode-1.2.3 (deleted)")).toBe("opencode-1.2.3")
  })
})

/** A small seeded generator (mulberry32), so a failing listing replays by its seed and run. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}


/**
 * What the generator made an entry as, which the test reads instead of the grammar under test: a build
 * (`of` its own name), a build's tree (`of` its build's name, whether or not that build is listed), a
 * tree in the making a stopped make left, or anything else.
 */
type Made = { readonly name: string; readonly kind: "build" | "tree" | "making" | "other"; readonly of: string }

/**
 * One generated host: a share directory listing builds of the old format (`…-prime.<fork 8>`) and the
 * new (`…-prime.<fork 8>.<dotfiles 8>`), the trees of some of them and of builds already gone, trees in
 * the making, copies in flight of either daily, the pool's logins, a handoff's directory and near-miss
 * names; a record over some of those builds (and some gone); the running processes' executables and
 * command lines, some through a tree.
 */
const host = (next: () => number) => {
  const pick = <A>(items: ReadonlyArray<A>): A => items[Math.floor(next() * items.length)]!
  /** `yes()` with chance `p`, else `no()`. */
  const chance = <A>(p: number, yes: () => A, no: () => A): A => {
    if (next() < p) return yes()
    return no()
  }
  const hex = (length: number) => Array.from({ length }, () => pick([..."0123456789abcdef"])).join("")
  const base = () => pick(["2.2.5", "2.2.7", "2.3.0-beta.1", "10.0.12"])
  const oldVersion = () => `${base()}-prime.${hex(8)}`
  const newVersion = () => `${base()}-prime.${hex(8)}.${hex(8)}`
  // A tree build (`pin.ts` `versionOf` with a tree): the new format and `.tree`.
  const treeVersion = () => `${newVersion()}.tree`
  const anyVersion = () => chance(0.3, oldVersion, () => chance(0.5, newVersion, treeVersion))
  const versions = Array.from({ length: 2 + Math.floor(next() * 10) }, anyVersion)
  // The record names builds on disk and builds already gone, of either format.
  const known = [...versions, ...Array.from({ length: 3 }, anyVersion)]
  const builds: ReadonlyArray<Made> = versions.map((version) => ({ name: buildName(version), kind: "build", of: buildName(version) }))
  // Trees: most of the listed builds' (only new-format builds have them, but a prune must not care), and some of builds gone.
  const trees: ReadonlyArray<Made> = known.flatMap((version): ReadonlyArray<Made> => chance(0.6, () => [{ name: treeOf(buildName(version)), kind: "tree", of: buildName(version) }], () => []))
  const other = (name: string): Made => ({ name, kind: "other", of: "" })
  const junk: ReadonlyArray<Made> = Array.from({ length: Math.floor(next() * 8) }, () =>
    pick([
      () => other(stagingName(pick(versions), 1 + Math.floor(next() * 99_999_999))),
      // An older daily's copy in flight: `<name>.<pid>`, a pid of at most seven digits.
      () => other(`${buildName(pick(versions))}.${1 + Math.floor(next() * 4_194_303)}`),
      () => other("pool-auth"),
      () => other("anthropic-auth"),
      () => other(`handoff-claude-2026-11-${10 + Math.floor(next() * 19)}`),
      () => other(pick(["opencode", "opencode-latest", "opencode-local", "current.plugins", ".plugins"])),
      () => other(`opencode-${base()}-prime.${hex(7)}`),
      () => other(`opencode-${base()}-prime.${hex(9)}`),
      () => other(`opencode-${base()}-prime.${hex(8)}.${hex(7)}`),
      () => other(`opencode-${base()}-prime.${hex(8)}.${hex(9)}`),
      () => other(`opencode-${base()}-prime.${hex(7).toUpperCase()}F`),
      () => other(`opencode-${base()}-prime.${hex(8)}.${hex(8)}.${hex(8)}`),
      // Near misses of a tree build's name: none is a build, nor its tree.
      () => other(`opencode-${newVersion()}.${pick(["tre", "treex", "tree.tree", "TREE", "trees"])}`),
      () => other(`opencode-${oldVersion()}.tree`),
      () => other(treeOf(`opencode-${newVersion()}.tre`)),
      () => other(`${buildName(pick(versions))}.tmp`),
      () => other(`${buildName(pick(versions))}.plugin`),
      () => other(`${treeOf(buildName(pick(versions)))}.old`),
      () => other(`${treeOf(stagingName(pick(versions), 1 + Math.floor(next() * 99_999)))}`),
      (): Made => ({ name: makingName(treeOf(buildName(pick(known))), 1 + Math.floor(next() * 4_194_303)), kind: "making", of: "" }),
    ])(),
  )
  const listing = [...builds, ...trees, ...junk].sort(() => next() - 0.5)
  const recorded = (version: string): Build => ({ version, command: [`${SHARE}/${buildName(version)}`], dotfiles: hex(40), fork: hex(40) })
  const installed = recorded(pick(known))
  const maybe = (p: number): Option.Option<Build> => chance(p, () => Option.some(recorded(pick(known))), Option.none<Build>)
  const [good, staged] = [maybe(0.6), maybe(0.4)]
  const plain: Record = {
    ...installed,
    // Now and then the installed command runs another file than its version names.
    command: chance(0.2, (): Build["command"] => [`${SHARE}/${buildName(pick(known))}`], () => installed.command),
    previous: known.filter(() => next() < 0.5),
  }
  const withGood = Option.match(good, { onNone: () => plain, onSome: (build): Record => ({ ...plain, good: build }) })
  const record = Option.match(staged, { onNone: () => withGood, onSome: (build): Record => ({ ...withGood, staged: build }) })
  const executables = [
    ...versions.filter(() => next() < 0.2).map((version) => `${SHARE}/${buildName(version)}${chance(0.3, () => " (deleted)", () => "")}`),
    ...chance(0.5, () => ["/usr/bin/zsh", "/bin/sh"], () => []),
  ]
  // A wake job or an image job runs a script inside a tree, which a command line names; others name none.
  const through = trees.flatMap((tree) => chance(0.15, () => [tree.name], () => []))
  const commands = [
    ...through.map((tree) => `/usr/local/bin/bun ${SHARE}/${tree}/opencode/cmd/${pick(["wake/job.ts", "wake/backstop.ts", "image/run.ts"])} ${hex(6)}`),
    ...chance(0.5, () => ["-zsh", `/bin/sh -c ls ${SHARE}`, `vim ${SHARE}/${treeOf(buildName(pick(known)))}x/notes`], () => []),
  ]
  return { listing, record, running: { executables, commands }, through: new Set(through) }
}

/** A path's last part. */
const lastPart = (path: string) => path.slice(path.lastIndexOf("/") + 1)

/** The version a build record names, and the file name it runs: what a prune keeps of it. */
const keptNames = (build: Pick<Build, "version" | "command">) => [buildName(build.version), lastPart(build.command[0])]

describe("acceptance: a prune over share directories of both build formats, with their trees", () => {
  const SEED = 20261119
  const RUNS = 400

  const stale = build("2.2.7-prime.11111111.22222222.tree")
  const live = build("2.2.7-prime.33333333.44444444.tree")
  const files = (each: Build) => [buildName(each.version), treeOf(buildName(each.version))]
  const prune = (record: Build) => prunable([...files(stale), ...files(live)], record, nothingRuns)
  const observesPrune = (removed: ReadonlyArray<string>) => expect(removed).toEqual(files(stale))
  const observesKept = (removed: ReadonlyArray<string>) => expect(removed.filter((name) => files(live).includes(name))).toEqual([])
  const installedOther = () => {
    const removed = prune(stale)
    expect(removed, "control setup: the other build is now unreferenced").toEqual(files(live))
    return removed
  }
  test("W: an unreferenced tree build and its tree go", () => {
    installedOther()
    observesPrune(prune(live))
  })
  test.failing("W: an unreferenced tree build and its tree go", () => observesPrune(installedOther()))
  test("W: a recorded tree build and its tree stay", () => {
    installedOther()
    observesKept(prune(live))
  })
  test.failing("W: a recorded tree build and its tree stay", () => observesKept(installedOther()))

  test(`over ${RUNS} generated hosts (seed ${SEED}), it names (a) builds and trees only, (b) never a kept or running one, (c) every other, of either format; a tree exactly when its build, never while a command line names it`, () => {
    const next = random(SEED)
    for (let run = 0; run < RUNS; run++) {
      const { listing, record, running, through } = host(next)
      const pruned = new Set(prunable(listing.map((made) => made.name), record, Option.some(running)))
      // What the record and the processes keep, read from the generator's own record, not from keptOf.
      const kept = new Set([
        ...keptNames(record),
        ...[Option.fromNullishOr(record.staged), Option.fromNullishOr(record.good)].flatMap((build) => Option.toArray(Option.map(build, keptNames))).flat(),
        ...Option.getOrElse(Option.fromNullishOr(record.previous), () => []).slice(-PREVIOUS_ON_DISK).map(buildName),
        ...running.executables.map((path) => lastPart(path.replace(/ \(deleted\)$/, ""))),
      ])
      const where = `seed ${SEED}, run ${run}: listing [${listing.map((made) => made.name).join(", ")}], executables [${running.executables.join(", ")}], commands [${running.commands.join(" | ")}], record ${recordText(record)}`
      const goes = {
        build: (made: Made) => !kept.has(made.of),
        tree: (made: Made) => !kept.has(made.of) && !through.has(made.name),
        making: () => true,
        other: () => false,
      } satisfies { readonly [K in Made["kind"]]: (made: Made) => boolean }
      for (const made of listing) {
        const shouldGo = goes[made.kind](made)
        expect(pruned.has(made.name), `${made.name} (${made.kind}, ${(shouldGo && "goes") || "stays"}) at ${where}`).toBe(shouldGo)
      }
      // A tree is named exactly when its build is, unless a command line holds it.
      for (const tree of listing.filter((made) => made.kind === "tree" && !through.has(made.name) && listing.some((each) => each.name === made.of))) {
        expect(pruned.has(tree.name), `${tree.name} against its build at ${where}`).toBe(pruned.has(tree.of))
      }
      // With what runs unread, nothing goes.
      expect(prunable(listing.map((made) => made.name), record, Option.none())).toEqual([])
    }
  })
})
