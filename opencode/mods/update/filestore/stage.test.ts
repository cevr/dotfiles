import { describe, expect, test } from "bun:test"
import { env, spawnSync } from "bun"
import { Effect, Option } from "effect"
import { buildName } from "../builds.ts"
import { parseRecord, promoted, proven, type Record, recordText, rolledBack } from "../record.ts"
import { Records } from "../service.ts"
import * as RecordFile from "./records.ts"
import { stageBuild, type Stage } from "./stage.ts"

const VERSION = "2.2.7-prime.abcdef12.d0f11e5a"

const sh = (script: string) => spawnSync(["/bin/sh", "-c", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })

/** The entries of `dir`, none when it does not exist. */
const entries = (dir: string): ReadonlyArray<string> =>
  sh(`ls '${dir}' 2>/dev/null`)
    .stdout.toString()
    .split("\n")
    .filter((line) => line !== "")

const exists = (path: string): boolean => sh(`test -e '${path}'`).exitCode === 0

/** Runs `body` on a scratch host (a built binary, an empty share directory, no record yet), removing it after. */
const onScratch = (body: (stage: Stage) => void) =>
  Effect.runSync(
    Effect.acquireUseRelease(
      Effect.sync(() => sh("mktemp -d -t update-stage").stdout.toString().trim()),
      (dir) =>
        Effect.sync(() => {
          sh(`mkdir -p '${dir}/build' && printf binary > '${dir}/build/opencode'`)
          body({ built: `${dir}/build/opencode`, share: `${dir}/share`, version: VERSION, record: `${dir}/state/opencode/installed.json`, launcher: `${dir}/bin/opencode`, resident: `${dir}/resident`, lock: `${dir}/state/builds.lock`, dotfiles: "d".repeat(40), fork: "f".repeat(40), pid: 71234 })
        }),
      (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
    ),
  )

describe("daily's stage of a build", () => {
  test("takes the builds lock exclusively before the copy reaches the share directory, and stages the build and its record under it", () =>
    onScratch((stage) => {
      const taken: Array<{ operation: number; share: ReadonlyArray<string> }> = []
      const flock = (_descriptor: number, operation: number) => {
        taken.push({ operation, share: entries(stage.share) })
        return 0
      }
      const binary = stageBuild(stage, flock)
      expect(taken).toEqual([{ operation: 2, share: [] }])
      expect(exists(stage.lock)).toBe(true)
      expect(binary).toBe(`${stage.share}/${buildName(VERSION)}`)
      expect(entries(stage.share)).toEqual([buildName(VERSION)])
      const record = parseRecord(sh(`cat '${stage.record}'`).stdout.toString())
      expect(Option.map(Option.flatMap(record, (each) => Option.fromNullishOr(each.staged)), (staged) => staged.version)).toEqual(Option.some(VERSION))
    }))

  test("a lock that does not take stages nothing", () =>
    onScratch((stage) => {
      expect(() => stageBuild(stage, () => -1)).toThrow()
      expect(entries(stage.share)).toEqual([])
      expect(exists(stage.record)).toBe(false)
    }))

  test("with libc's flock, on a free lock, it stages", () =>
    onScratch((stage) => {
      stageBuild(stage)
      expect(entries(stage.share)).toEqual([buildName(VERSION)])
    }))

  test("on a host of the old format (its record and builds name the fork alone), it stages beside them: the old builds stay superseded, a copy in flight is none", () =>
    onScratch((stage) => {
      const old = "2.2.7-prime.abcdef12"
      const record: Record = { version: old, command: [`${stage.share}/${buildName(old)}`], previous: ["2.2.6-prime.99999999"], dotfiles: "c".repeat(40), fork: "f".repeat(40) }
      sh(`mkdir -p '${stage.share}' '${stage.record.replace(/\/[^/]+$/, "")}' && printf old > '${stage.share}/${buildName(old)}' && printf older > '${stage.share}/opencode-2.2.6-prime.99999999' && printf copy > '${stage.share}/${buildName(old)}.4242'`)
      sh(`printf '%s' '${recordText(record)}' > '${stage.record}'`)
      const binary = stageBuild(stage)
      expect(binary).toBe(`${stage.share}/opencode-2.2.7-prime.abcdef12.d0f11e5a`)
      expect(sh(`cat '${stage.share}/${buildName(old)}'`).stdout.toString()).toBe("old")
      const staged = parseRecord(sh(`cat '${stage.record}'`).stdout.toString())
      expect(Option.map(staged, (each) => [each.version, each.previous, each.staged?.version])).toEqual(Option.some([old, ["2.2.6-prime.99999999"], VERSION]))
      expect(Option.map(Option.map(staged, promoted), (each) => [each.version, each.previous])).toEqual(Option.some([VERSION, ["2.2.6-prime.99999999", old]]))
    }))
})

const OLD = "2.2.7-prime.aaaaaaaa"
const NEW = "2.2.7-prime.aaaaaaaa.bbbbbbbb"

/**
 * A stand-in build: a TUI start replaces a running service of another version before it starts, as
 * the fork's client does for its own build (`mismatch: "replace"`, `service.ensure`), and `service
 * restart` restarts the service onto it. What each does goes to `$EVENTS`; the service's version is `$SERVICE`.
 */
const standIn = (version: string) => `#!/bin/sh
case "$1" in
service) echo ${version} > "$SERVICE"; echo "restart ${version}" >> "$EVENTS"; exit 0 ;;
api) exit 0 ;;
esac
running=$(cat "$SERVICE")
[ "$running" = ${version} ] || { echo "replaced $running with ${version}" >> "$EVENTS"; echo ${version} > "$SERVICE"; }
echo "tui ${version} $*" >> "$EVENTS"
`

describe("the launcher a stage and the handoff leave", () => {
  test("a TUI started while a build waits for its handoff runs the running build and leaves the shared service alone; the handoff moves it, a rollback moves it back", () =>
    Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.sync(() => sh("mktemp -d -t update-launcher").stdout.toString().trim()),
        (dir) => {
          const paths = { record: `${dir}/state/opencode/installed.json`, launcher: `${dir}/bin/opencode`, resident: `${dir}/resident` }
          const stage = (version: string): Stage => {
            expect(spawnSync(["/bin/sh", "-c", 'mkdir -p "$(dirname "$2")" && printf "%s" "$1" > "$2"', "sh", standIn(version), `${dir}/build/${version}`]).exitCode).toBe(0)
            return { ...paths, built: `${dir}/build/${version}`, share: `${dir}/share`, version, lock: `${dir}/state/builds.lock`, dotfiles: version.slice(-1).repeat(40), fork: version.slice(-1).repeat(40), pid: 71234 }
          }
          const launch = (...args: ReadonlyArray<string>) => expect(spawnSync([paths.launcher, ...args], { env: { ...env, SERVICE: `${dir}/service`, EVENTS: `${dir}/events` } }).exitCode).toBe(0)
          /** What happened since the last look, and the version the shared service runs. */
          const seen = () => [sh(`cat '${dir}/events' && : > '${dir}/events'`).stdout.toString().trim().split("\n"), sh(`cat '${dir}/service'`).stdout.toString().trim()]
          /** The handoff's record write, through the real file store. */
          const change = (next: (record: Record) => Option.Option<Record>) =>
            Records.use((file) => file.read.pipe(Effect.flatMap((read) => Effect.forEach(Option.toArray(Option.flatMap(read, next)), file.write, { discard: true }))))
          return Effect.gen(function* () {
            sh(`echo ${OLD} > '${dir}/service' && : > '${dir}/events'`)
            // The old build installed and proven: the service runs it.
            stageBuild(stage(OLD))
            yield* change((record) => Option.some(proven(promoted(record))))

            // The new build staged: a TUI starts on the old build, and the service it shares is not touched.
            stageBuild(stage(NEW))
            launch("--auto", "/w")
            expect(seen()).toEqual([[`tui ${OLD} --auto /w`], OLD])

            // The handoff installs it and restarts the service through the launcher; a TUI then runs it.
            yield* change((record) => Option.some(promoted(record)))
            launch("service", "restart")
            launch("--auto", "/w")
            expect(seen()).toEqual([[`restart ${NEW}`, `tui ${NEW} --auto /w`], NEW])

            // Its rollback restarts onto the good build, and the launcher goes back with it.
            yield* change(rolledBack)
            launch("service", "restart")
            launch("--auto", "/w")
            expect(seen()).toEqual([[`restart ${OLD}`, `tui ${OLD} --auto /w`], OLD])
          }).pipe(Effect.provide(RecordFile.layer(paths, 71234)))
        },
        (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
      ),
    ))
})
