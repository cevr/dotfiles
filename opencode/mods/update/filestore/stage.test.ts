import { describe, expect, test } from "bun:test"
import { argv, env, spawnSync } from "bun"
import { Effect, Layer, Option, Schema } from "effect"
import { gitInit } from "../../../tests/git-repo.ts"
import { buildName } from "../builds.ts"
import { EXIT_CODES, handoff } from "../model.ts"
import * as HandoffMarkFile from "../process/mark.ts"
import { alreadyLine, configPaths, installByHand, notInstalledLine, settingsFor, treeOptions } from "../process/install.ts"
import { goodOf, parseRecord, promoted, proven, type Record, recordText, rolledBack } from "../record.ts"
import { Builder, Builds, Configs, Records, Service, Source, UpdateFailed } from "../service.ts"
import { buildsLock, files } from "../settings.ts"
import { treeOf } from "../trees.ts"
import * as BuildsFile from "./builds.ts"
import * as ConfigFile from "./configs.ts"
import { oursOf, type Paths as ConfigPaths } from "./configs.ts"
import * as LogFile from "./log.ts"
import * as NoticeFile from "./notice.ts"
import * as RecordFile from "./records.ts"
import * as RejectionFile from "./rejections.ts"
import { makeAndStage, stageBuild, type Stage, treesLayer } from "./stage.ts"

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

/** Runs `body` against the real file-backed configs over a scratch config directory, removing it after. */
const onConfigs = <E>(body: (paths: ConfigPaths, text: (path: string) => string) => Effect.Effect<void, E, Configs>) =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.sync(() => sh("mktemp -d -t update-configs").stdout.toString().trim()),
      (dir) => {
        const paths: ConfigPaths = { server: `${dir}/opencode.json`, under: "/h/dotfiles/opencode", owned: oursOf("/h/dotfiles", "/h/.local/share/opencode-prime") }
        return body(paths, (path) => sh(`cat '${path}'`).stdout.toString()).pipe(Effect.provide(ConfigFile.layer(paths)))
      },
      (dir) => Effect.sync(() => void spawnSync(["rm", "-rf", dir])),
    ),
  )

/** Writes `text` at `path`, through the shell. */
const put = (path: string, text: string) => expect(spawnSync(["/bin/sh", "-c", 'printf "%s" "$1" > "$2"', "sh", text, path]).exitCode).toBe(0)

describe("the handoff's read of the server config, on files (R2)", () => {
  test("names the file and the checkout's opencode/ when it lists an entry of ours, none when it lists only foreign ones or is absent, fails when it does not read; it never writes the file", () =>
    onConfigs((paths, text) =>
      Effect.gen(function* () {
        const configs = yield* Configs
        expect(yield* configs.ours).toEqual(Option.none())
        expect(exists(paths.server)).toBe(false)
        const listing = `{\n  "model": "anthropic/x",\n  "plugins": ["/mine/plugin", { "package": "/h/dotfiles/opencode/cmd/pool", "options": {} }]\n}\n`
        put(paths.server, listing)
        expect(yield* configs.ours).toEqual(Option.some({ file: paths.server, under: "/h/dotfiles/opencode" }))
        expect(text(paths.server)).toBe(listing)
        const foreign = `{ "plugins": ["/mine/plugin", "/elsewhere/dotfiles/opencode/cmd/pool"] }\n`
        put(paths.server, foreign)
        expect(yield* configs.ours).toEqual(Option.none())
        const broken = `{ // a comment\n "plugins": [] }\n`
        put(paths.server, broken)
        expect(yield* Effect.flip(configs.ours)).toMatchObject({ step: "read the server config" })
        expect(text(paths.server)).toBe(broken)
      }),
    ))
})

/** The stand-in for a commit's own `scripts/daily.ts --tree <dir>`: both overlay files with no plugin, as the real one writes them for a checkout of none. */
const OVERLAY_DAILY = `import { mkdirSync, writeFileSync } from "node:fs"
const dir = process.argv[process.argv.indexOf("--tree") + 1]
mkdirSync(dir + "/config", { recursive: true })
writeFileSync(dir + "/config/opencode.json", JSON.stringify({ plugins: [] }))
writeFileSync(dir + "/config/cli.json", JSON.stringify({ plugins: [] }))
`

/** daily's settings writer, loaded at run time: daily runs on the root package's Effect, this test on the update's. */
interface Daily {
  readonly writeSettings: (home: string) => void
}
/** Held in a binding, so the typecheck of this package leaves the root package's file alone. */
const DAILY = "../../../scripts/daily.ts"

/** A record write as one effect: `record (good)` once it names its installed build good. */
const recordEffect = (next: Record) =>
  Option.match(Option.filter(goodOf(next), (good) => good.version === next.version), { onNone: () => "record", onSome: () => "record (good)" })

/** Runs `argv` in `cwd`, failing the case on a non-zero exit; answers what it printed. */
const ran = (argv: ReadonlyArray<string>, cwd: string) => {
  const done = spawnSync([...argv], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  expect({ argv, code: done.exitCode, err: done.stderr.toString().slice(-800) }).toMatchObject({ code: 0 })
  return done.stdout.toString()
}

describe("daily by hand on a from-scratch host", () => {
  test("A2: no build, no record, no config: the checkout's HEAD installs as a tree build through the real handoff, the server config gets what no tree carries and no plugin entry, cli.json the Prime theme and the window scope it lacks, and a second run writes nothing", () =>
    Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.sync(() => ran(["realpath", ran(["mktemp", "-d", "-t", "update-by-hand"], "/").trim()], "/").trim()),
        (dir) =>
          Effect.gen(function* () {
            const daily: Daily = yield* Effect.promise(() => import(DAILY))
            const bun = Option.getOrElse(Option.fromNullishOr(argv.at(0)), () => "bun")
            const path = Option.getOrElse(Option.fromNullishOr(env.PATH), () => "/usr/bin:/bin")
            const home = `${dir}/home`
            const repo = `${dir}/dotfiles`
            // The live checkout: one commit of opencode/, then an edit that is not committed.
            ran(["mkdir", "-p", `${repo}/opencode/scripts`, `${dir}/build`, home], dir)
            put(`${repo}/opencode/package.json`, `{ "name": "scratch", "private": true }\n`)
            put(`${repo}/opencode/scripts/daily.ts`, OVERLAY_DAILY)
            put(`${repo}/opencode/x.txt`, "committed\n")
            ran([bun, "install"], `${repo}/opencode`)
            gitInit(repo, ["-q", "-b", "main"])
            ran(["git", "add", "-A"], repo)
            ran(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "scratch"], repo)
            const commit = ran(["git", "rev-parse", "HEAD"], repo).trim()
            put(`${repo}/opencode/x.txt`, "edited, not committed\n")
            put(`${dir}/build/opencode`, "stand-in binary")

            const settings = settingsFor({ host: "scratch-host", home, state: `${home}/.local/state`, checkout: repo, fork: `${dir}/fork`, bun, resident: `${home}/.local/state/opencode-prime/resident`, launcher: `${home}/.local/bin/opencode` })
            const version = `2.3.0-prime.f0f0f0f0.${commit.slice(0, 8)}.tree`
            const trees = treeOptions(settings, { PATH: path, HOME: home }, home, 4242)
            const share = trees.share
            const effects: Array<string> = []
            const lines: Array<string> = []
            const staged: Array<string> = []

            /** The handoff's systems: the real file stores and trees over the scratch host, the model's fake service and commands. */
            const seams = Layer.mergeAll(
              Layer.effect(
                Records,
                Effect.gen(function* () {
                  const real = yield* Records
                  return Records.of({ read: real.read, write: (next) => real.write(next).pipe(Effect.tap(() => Effect.sync(() => void effects.push(recordEffect(next))))) })
                }),
              ).pipe(Layer.provide(RecordFile.layer(settings, 4242))),
              Layer.effect(
                Builds,
                Effect.gen(function* () {
                  const real = yield* Builds
                  return Builds.of({ ...real, prune: (read) => real.prune(read).pipe(Effect.tap(() => Effect.sync(() => void effects.push("prune")))) })
                }),
              ).pipe(Layer.provide(BuildsFile.layer(BuildsFile.optionsOf(share, buildsLock(home), process.platform)))),
              ConfigFile.layer(configPaths(settings, home)),
              treesLayer(trees),
              RejectionFile.layer(files(settings).rejected),
              NoticeFile.layer(settings.notice),
              LogFile.layer(files(settings).log, settings.host),
              HandoffMarkFile.layer(files(settings).mark, 4242),
              Layer.succeed(
                Service,
                Service.of({
                  restart: Effect.sync(() => void effects.push("restart")),
                  read: Effect.succeed({ configured: [], listed: [], accounts: Option.some(1), providers: [], logins: [], placement: Option.none() }),
                  logins: Effect.succeed([]),
                }),
              ),
              Layer.succeed(
                Source,
                Source.of({
                  verified: Effect.die("a handoff reads no target"),
                  fetch: () => Effect.die("a handoff fetches nothing"),
                  commands: Effect.sync(() => void effects.push("commands")),
                }),
              ),
              Layer.succeed(
                Builder,
                Builder.of({
                  version: () => Effect.die("a handoff builds nothing"),
                  stage: () => Effect.die("a handoff builds nothing"),
                }),
              ),
            )

            const byHand = () =>
              installByHand({
                checkout: repo,
                commit,
                version,
                trees,
                record: settings.record,
                stage: (tree) =>
                  Effect.runPromise(
                    Effect.sync(() => {
                      effects.push(...["make tree"].filter(() => exists(`${tree}/config/opencode.json`)), "stage")
                      stageBuild({ built: `${dir}/build/opencode`, share, version, record: settings.record, launcher: settings.launcher, resident: settings.resident, lock: buildsLock(home), dotfiles: commit, fork: "f0f0f0f0".repeat(5), pid: 4242 })
                      staged.push(...Option.toArray(Option.flatMap(parseRecord(sh(`cat '${settings.record}'`).stdout.toString()), (record) => Option.fromNullishOr(record.staged))).map((each) => each.version))
                    }),
                  ),
                settings: () => {
                  daily.writeSettings(home)
                  effects.push("settings")
                },
                handoff: () => {
                  effects.push("handoff", "|")
                  return Effect.runPromise(handoff("daily by hand").pipe(Effect.map((outcome) => EXIT_CODES[outcome]), Effect.provide(seams)))
                },
                log: (line) => void lines.push(line),
              })

            expect(yield* Effect.promise(byHand)).toBe(0)
            expect(effects).toEqual(["make tree", "stage", "settings", "handoff", "|", "record", "restart", "record (good)", "prune", "commands"])
            expect(lines).toEqual([notInstalledLine(commit, 1)])
            // One build, a tree build, with its tree, installed and proven; the link names its tree.
            const tree = `${share}/${treeOf(buildName(version))}`
            expect(entries(share).filter((name) => name.startsWith("opencode-"))).toEqual([buildName(version), treeOf(buildName(version))])
            expect(staged).toEqual([version])
            expect(Option.map(parseRecord(sh(`cat '${settings.record}'`).stdout.toString()), (record) => ({ version: record.version, good: Option.map(goodOf(record), (good) => good.version), staged: Option.isSome(Option.fromNullishOr(record.staged)) }))).toEqual(Option.some({ version, good: Option.some(version), staged: false }))
            expect(sh(`readlink '${share}/current.plugins'`).stdout.toString().trim()).toBe(treeOf(buildName(version)))
            // The tree holds the commit's file, never the edit.
            expect(sh(`cat '${tree}/opencode/x.txt'`).stdout.toString()).toBe("committed\n")
            // What no tree carries, and no plugin entry of any kind: the role models are the tree's (scripts/daily.ts
            // `treeSettings`); the theme's name and the tab scope are the owner's, set only where cli.json has none.
            const [server = "", cli = ""] = settings.config
            const json = (file: string) => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(sh(`cat '${file}'`).stdout.toString())
            expect(json(server)).toEqual({ autoupdate: false })
            expect(json(cli)).toEqual({ theme: { name: "prime" }, tabs: { scope: "window" } })
            const written = [server, cli, `${home}/.config/opencode/themes/prime.json`, `${settings.resident}/opencode.json`]

            // A second run with no new commit writes nothing.
            // Each dated far back first: a write would date it now.
            for (const file of written) expect(sh(`touch -t 200001010000 '${file}'`).exitCode).toBe(0)
            const stamps = () => written.map((file) => sh(`cat '${file}' && date -r '${file}' +%s`).stdout.toString())
            const before = stamps()
            const treeFiles = () => sh(`cd '${tree}' && find . -type f | sort | xargs cat`).stdout.toString()
            const whole = treeFiles()
            effects.length = 0
            lines.length = 0
            // M1: the installed and proven commit, by hand again: nothing built, staged or restarted, and it says so.
            expect(yield* Effect.promise(byHand)).toBe(0)
            expect(stamps()).toEqual(before)
            expect(effects).toEqual(["settings"])
            expect(lines).toEqual([notInstalledLine(commit, 1), alreadyLine(version)])
            // M1: a stage of that version that fails, over the tree that stands: the tree is not its own, so it stays whole.
            const killed = () => Effect.runPromise(Effect.fail(new UpdateFailed({ step: "build the fork", message: "the compile was killed" })))
            const failed = yield* Effect.exit(Effect.tryPromise(() => makeAndStage(trees, version, commit, killed)))
            expect(String(failed)).toContain("the compile was killed")
            expect(treeFiles()).toBe(whole)
            expect(exists(`${share}/current.plugins/config/opencode.json`)).toBe(true)
          }),
        (dir) => Effect.sync(() => void spawnSync(["/bin/sh", "-c", 'chmod -R u+w "$1" && rm -rf "$1"', "sh", dir])),
      ),
    ), 60_000)
})
