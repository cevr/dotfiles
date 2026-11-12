import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { baseName, buildName, buildVersion, FRESH_MS, isBuild, isFresh, PREVIOUS_ON_DISK, prunable, stagingName } from "./builds.ts"
import type { Build, Record } from "./record.ts"

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

const nothingRuns = Option.some<ReadonlyArray<string>>([])

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
    const running = Option.some([`${SHARE}/${buildName(V[0])}`, `${SHARE}/${buildName(V[2])} (deleted)`, "/usr/bin/zsh"])
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

  test("a build changed within ten minutes is fresh, by its newer time; an older one is not", () => {
    const now = 1_000_000_000
    expect(FRESH_MS).toBe(10 * 60 * 1000)
    expect([now, now - FRESH_MS + 1, now - FRESH_MS, now - FRESH_MS - 1].map((changed) => isFresh(changed, now))).toEqual([true, true, false, false])
  })

  test("a path's last component names the build, without Linux's unlinked mark", () => {
    expect(baseName("/a/b/opencode-1.2.3 (deleted)")).toBe("opencode-1.2.3")
  })
})
