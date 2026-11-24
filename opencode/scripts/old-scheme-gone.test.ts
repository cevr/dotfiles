// The guard that the update's old install scheme (the checkout that moves, the global plugin entries,
// their migration) stays gone from every run-time path and from the docs (plugin-trees U6).
// @reads mods/update/** cmd/update/** scripts/daily.ts README.md AGENTS.md .claude/skills/verify-opencode/SKILL.md
import * as BunServices from "@effect/platform-bun/BunServices"
import { Effect, FileSystem, Path, PlatformError } from "effect"
import { describe, expect, it } from "effect-bun-test"

/** The dotfiles root, from this file's URL (opencode/scripts). */
const root = Effect.gen(function* () {
  const path = yield* Path.Path
  return yield* path.fromFileUrl(new URL("../..", import.meta.url))
})

/** Every file under `dir` (from the dotfiles root), `node_modules` aside; none when `dir` is missing. */
const under = (dir: string): Effect.Effect<ReadonlyArray<string>, PlatformError.PlatformError | PlatformError.BadArgument, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const at = path.join(yield* root, dir)
    if (!(yield* fs.exists(at))) return []
    const found = yield* Effect.forEach(yield* fs.readDirectory(at), (name) =>
      Effect.gen(function* () {
        const entry = `${dir}/${name}`
        if (name === "node_modules") return []
        const info = yield* fs.stat(path.join(yield* root, entry))
        if (info.type === "Directory") return yield* under(entry)
        return [entry]
      }),
    )
    return found.flat()
  })

const isTest = (path: string): boolean => /\.(test|bench)\.tsx?$/.test(path) || path.endsWith(".golden.ts")

/** The update's own sources under `dir`, its tests aside. */
const sources = (dir: string) => Effect.map(under(dir), (files) => files.filter((path) => path.endsWith(".ts") && !isTest(path)))

/** What a process of the update runs: the update's own sources, daily, the handoff and the host's command scripts. */
const RUNTIME = Effect.map(Effect.all([sources("opencode/mods/update"), sources("opencode/cmd/update")]), ([mods, cmd]) => [
  ...mods,
  ...cmd,
  "opencode/scripts/daily.ts",
  "local-bin.sh",
  "workbox/install-bin.sh",
  "workbox/bin/apply-agent-settings",
])

/** The docs that describe the update. */
const DOCS = ["opencode/README.md", "opencode/AGENTS.md", "opencode/.claude/skills/verify-opencode/SKILL.md", "opencode/mods/update/package.json"]

/** A name of the old scheme, and where it may not appear. */
const GONE: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp; readonly docs: boolean }> = [
  { name: "daily --configure", pattern: /--configure\b/, docs: true },
  { name: "Builder.configure / configureCommand", pattern: /\bconfigureCommand\b|\bbuilder\.configure\b|\bconfigure: daily\(/, docs: false },
  { name: "the old stage command", pattern: /\bstageCommand\b(?<!treeStageCommand)/, docs: false },
  { name: "Builder.binds / ADJACENT_CONFIG", pattern: /\bADJACENT_CONFIG\b|\bbinds\b\s*[:(]/, docs: false },
  { name: "Source.advance / reinstall / head", pattern: /\bsource\.(advance|reinstall|head)\b|\breadonly (advance|reinstall):|\breadonly head: Effect\.Effect<string, UpdateFailed>/, docs: false },
  { name: "the checkout's move", pattern: /\bCheckoutStuck\b|\bmoveOnto\b|\bmoveBack\b|\bmoveForward\b|\buntrackedAhead\b|\bKEPT\b|sync-conflict/, docs: false },
  { name: "settings.mode", pattern: /\bmodeOf\b|\bSYNCTHING_FOLLOWERS\b|\bmode: Schema\b|\b(settings|options|checkout)\.mode\b/, docs: false },
  // Read any other way: by index, or destructured (`{ mode }`, `{ host, mode }`); a `{ mode: 0o600 }` file mode is none.
  { name: "settings.mode, read by index or destructured", pattern: /\[\s*["'`]mode["'`]\s*\]|\{\s*(?:[\w$]+\s*,\s*)*mode\s*(?:,\s*[\w$]+\s*)*\}/, docs: false },
  // A removed name, imported (the import alone breaks no other rule until the name is called).
  { name: "a removed name, imported", pattern: /\bimport\b[^;]*\{[^}]*\b(advance|reinstall|oldFormat|oldRunning|KEPT|kept|keptOf|modeOf|withTree|stripped|tuiOursOf|tuiKeptOf|lateStrip|migrate)\b[^}]*\}/, docs: false },
  { name: "the old format's hold", pattern: /\boldFormat\b/, docs: false },
  { name: "the dotfiles' advance", pattern: /advances? the (dotfiles|checkout)/i, docs: true },
  { name: "the Syncthing follower", pattern: /Syncthing follower/i, docs: true },
  { name: "the old scheme", pattern: /\bold scheme\b|\binstallOld\b|\btreeScheme\b|\bNO_TREES\b|\bcheckoutProgram\b/, docs: true },
  { name: "the migration", pattern: /\bconfigs\.(keep|restore|strip|stripTui|tuiOurs)\b|\breadonly (keep|restore|strip|stripTui|tuiOurs):|\blateStrip\b|\boldRunning\b|first tree install/, docs: true },
  { name: "the reinstall rung", pattern: /"reinstalled"|\bRecovery\.Reinstall\b|\bReinstall: \{\}|reinstall rung/, docs: true },
  { name: "the plain (no-tree) version", pattern: /\bwithTree\b/, docs: false },
  { name: "link-fork at run time", pattern: /link-fork|linkFork/, docs: false },
  { name: "rex-show linked to the checkout", pattern: /\$dotfiles_dir\/opencode\/cmd\/rex\/show\.ts|\$dotfiles_dir\/opencode\/\$1/, docs: false },
]

/** daily's one use of link-fork that stays: the upstream merge's checks, which are tests of the checkout. */
const ALLOWED: ReadonlyArray<{ readonly file: string; readonly name: string; readonly line: RegExp }> = [{ file: "opencode/scripts/daily.ts", name: "link-fork at run time", line: /upstream|merge/i }]

/** Each line of `files` that names a gone thing (only those of the docs' kind when `docs`), as `file:line: name`. */
const hits = (files: ReadonlyArray<string>, docs: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const at = yield* root
    const found = yield* Effect.forEach(files, (file) =>
      Effect.gen(function* () {
        if (!(yield* fs.exists(path.join(at, file)))) return []
        return (yield* fs.readFileString(path.join(at, file)))
          .split("\n")
          .flatMap((line, index) =>
            GONE.flatMap((gone) =>
              [gone]
                .values()
                .filter((each) => (!docs || each.docs) && each.pattern.test(line))
                .filter((each) => !ALLOWED.some((allowed) => allowed.file === file && allowed.name === each.name && allowed.line.test(line)))
                .map((each) => `${file}:${index + 1}: ${each.name}`)
                .toArray(),
            ),
          )
      }),
    )
    return found.flat()
  })

/** A settings text the 51fc7c9f updater wrote, with its `mode`: U6's handoff starts on such a text. */
const OLDER_SETTINGS = `{"host":"h","checkout":"/c","mode":"reset","fork":"/f","bun":"/b","launcher":"/l","resident":"/r","record":"/i","config":["/o","/cli.json"],"notice":"/n","state":"/s"}`

describe("the old scheme is gone", () => {

  it.live.layer(BunServices.layer)("no run-time source of the update, daily or the host's command scripts names it", () =>
    Effect.gen(function* () {
      expect(yield* hits(yield* RUNTIME, false)).toEqual([])
    }),
  )

  it.live.layer(BunServices.layer)("no doc of the update describes it", () =>
    Effect.gen(function* () {
      expect(yield* hits(DOCS, true)).toEqual([])
    }),
  )

  it.live.layer(BunServices.layer)("its files are deleted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const at = yield* root
      const gone = ["opencode/mods/update/process/advance.test.ts", "opencode/scripts/daily-configure.golden.ts"]
      expect(yield* Effect.filter(gone, (file) => fs.exists(path.join(at, file)))).toEqual([])
    }),
  )

  it.live.layer(BunServices.layer)("the update's settings carry no mode, and a settings text an older build wrote (with one) still reads", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const at = yield* root
      // The update's own module and its own Effect, the copy its Schema values belong to.
      const { Settings, SettingsJson } = yield* Effect.promise(() => import(path.join(at, "opencode/mods/update/settings.ts")))
      const { Schema } = yield* Effect.promise(() => import(Bun.resolveSync("effect", path.join(at, "opencode/mods/update"))))
      expect(Object.keys(Settings.fields)).not.toContain("mode")
      expect(Schema.decodeUnknownSync(SettingsJson)(OLDER_SETTINGS)).not.toHaveProperty("mode")
      expect(Schema.decodeUnknownSync(SettingsJson)(OLDER_SETTINGS)).toHaveProperty("checkout", "/c")
    }),
  )
})
