/**
 * What the two plain-Bun command checks share: a command's probes (`mods/update/trees.ts` `COMMANDS`) run as
 * `bun <root>/<path> <args>` with a scratch HOME and XDG directories, no `OPENCODE_DEV`, no service and no
 * network; the links of an install; and the composition-root layers it must hold. `tests/cli-tree.test.ts`
 * runs them on this checkout (the development path), `tests/cli-tree-installed.test.ts` on the installed tree
 * `TREE_OPENCODE` names, which it requires.
 *
 * @reads mods/update/trees.ts cmd/** mods/** scripts/daily.ts
 */
import * as BunServices from "@effect/platform-bun/BunServices"
import { Array as Arr, Effect, FileSystem, Option, Path, Stream } from "effect"
import { expect, it } from "effect-bun-test"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { type Command, COMMANDS, type Probe } from "../../mods/update/trees.ts"
import { hangGuard } from "../hang-guard.ts"

/** Whether `file` is `root` or under it. */
export const within = (root: string, file: string) => file === root || file.startsWith(`${root}/`)

/** This checkout's opencode/, real. */
export const checkoutRoot = Effect.gen(function* () {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  return yield* fs.realPath(yield* path.fromFileUrl(new URL("../..", import.meta.url)))
})

/** Every link in a `node_modules` under `dir` (scopes and Bun's `.bun` store included), with where it leads. */
export const moduleLinks = (dir: string, inModules: boolean, depth: number): Effect.Effect<ReadonlyArray<readonly [string, string]>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))
    const found = yield* Effect.forEach(names, (name) =>
      Effect.gen(function* () {
        const entry = path.join(dir, name)
        const link = yield* fs.readLink(entry).pipe(Effect.option)
        if (Option.isSome(link)) return Arr.of([entry, path.resolve(dir, link.value)] as const).filter(() => inModules)
        const isDir = yield* fs.stat(entry).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )
        const descend = isDir && depth < 9 && (name === "node_modules" || !inModules || name.startsWith("@") || name === ".bun" || dir.endsWith(".bun") || dir.endsWith("/node_modules"))
        if (!descend) return []
        return yield* moduleLinks(entry, inModules || name === "node_modules", depth + 1)
      }),
    )
    return found.flat()
  })

/** One probe's run, from `root`, in its own scratch `place` and process group, ended when it outlives 30 s. */
const runProbe = (root: string, command: Command, probe: Probe, place: string, input?: (path: string) => string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* Effect.forEach(["home", "config", "state", "data", "cache", "digest", "run"], (dir) => fs.makeDirectory(path.join(place, dir), { recursive: true }), { discard: true })
    const bun = process.execPath
    const child = yield* spawner.spawn(
      ChildProcess.make(bun, [input?.(command.path) ?? path.join(root, command.path), ...probe.args.map((arg) => arg.replaceAll("$SCRATCH", place))], {
        cwd: path.join(place, "run"),
        extendEnv: false,
        env: {
          PATH: `${path.dirname(bun)}:/usr/bin:/bin`,
          HOME: path.join(place, "home"),
          TMPDIR: path.join(place, "run"),
          XDG_CONFIG_HOME: path.join(place, "config"),
          XDG_STATE_HOME: path.join(place, "state"),
          XDG_DATA_HOME: path.join(place, "data"),
          XDG_CACHE_HOME: path.join(place, "cache"),
          NO_COLOR: "1",
        },
        stdin: "ignore",
        detached: true,
        forceKillAfter: "3 seconds",
        // fds 3 and 4: a kernel worker's responses and requests (mods/kernel/wire.ts); its requests end at once.
        additionalFds: { fd3: { type: "output" }, fd4: { type: "input", stream: Stream.empty } },
      }),
    )
    const said = yield* child.all.pipe(Stream.decodeText(), Stream.mkString)
    const code = yield* child.exitCode
    return { code: Number(code), said }
  }).pipe(Effect.scoped, Effect.timeout("30 seconds"))

/**
 * The checks on the opencode/ `rootOf` answers (it fails when there is none to check): the composition-root
 * layers on one effect, then each command's probes, one test per command.
 */
export const commandChecks = <E>(rootOf: Effect.Effect<string, E, FileSystem.FileSystem | Path.Path>, input?: (path: string) => string) => {
  it.live.layer(BunServices.layer)("the install holds what a command's composition root provides: BunServices' layer and Digest.layerWebCrypto, on one effect", () =>
    Effect.gen(function* () {
      const root = yield* rootOf
      const path = yield* Path.Path
      const at = (specifier: string) => Bun.resolveSync(specifier, path.join(root, "cmd"))
      const services = yield* Effect.promise(() => import(at("@effect/platform-bun/BunServices")))
      const crypto = yield* Effect.promise(() => import(at("effect/crypto")))
      const layers = yield* Effect.promise(() => import(at("effect/Layer")))
      expect([layers.isLayer(services.layer), layers.isLayer(crypto.Digest?.layerWebCrypto)]).toEqual([true, true])
      // One effect: the platform package's own `effect` is the root's.
      const fs = yield* FileSystem.FileSystem
      const effectDir = (from: string) => fs.realPath(path.dirname(Bun.resolveSync("effect/package.json", from)))
      const platform = yield* fs.realPath(path.dirname(at("@effect/platform-bun/BunServices")))
      expect(yield* effectDir(platform)).toBe(yield* effectDir(path.join(root, "cmd")))
    }),
  )

  for (const command of COMMANDS)
    it.live.layer(BunServices.layer)(
      `${command.path}: ${command.probes.length} probe(s)`,
      () =>
        Effect.gen(function* () {
          const root = yield* rootOf
          const fs = yield* FileSystem.FileSystem
          for (const probe of command.probes) {
            const place = yield* fs.makeTempDirectoryScoped({ prefix: "cli-tree-" }).pipe(Effect.flatMap((dir) => fs.realPath(dir)))
            const ran = yield* runProbe(root, command, probe, place, input)
            const label = `${command.path} ${probe.args.join(" ")}`
            expect([label, ran.code, ran.said.includes(probe.says.replaceAll("$SCRATCH", place))]).toEqual([label, probe.exit, true])
            expect([label, /Cannot find (module|package)|SyntaxError: Export named/.test(ran.said)]).toEqual([label, false])
          }
        }).pipe(Effect.scoped),
      hangGuard("installer"),
    )
}
