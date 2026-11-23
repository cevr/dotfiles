// @reads all
// @reads-reason nonliteral subprocess arguments at tests/cli-tree-installed.test.ts: const ran = spawnSync(["/bin/cat", externalInput(file)], { stdout: "pipe", stderr: "pipe" })
// accept: deep (3.0 s alone on a quiet host: it runs every plain-Bun command's probes from a whole installed tree)
// accept: off until TREE_OPENCODE is set (it checks the no-links tree the production tree maker made, which only the deep gate makes)
/**
 * The plain-Bun commands (`mods/update/trees.ts` `COMMANDS`) run from an installed tree: `TREE_OPENCODE=<tree>/opencode`
 * names a tree with no links (one the production tree maker made, or a copy of it, never the share directory's own
 * files). There no `node_modules` link may lead outside the tree, so a command that runs there runs on the tree's
 * install alone. It also reads the tree's import graph (`cli-tree/graph.ts`, the one `scripts/runtime-imports.test.ts`
 * reads the checkout with): every process's imports resolve there exactly, its servers reach no platform
 * implementation, and it installs the checkout's one Effect. The tree is required: with `TREE_OPENCODE` unset, empty, missing, without an install, or naming
 * this checkout, every test here fails, saying so; it never passes on another root. The acceptance runner owes the
 * file `off until enabled`, by name, in a run that has no tree (the marker above); the deep gate sets the variable.
 *
 */
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { Glob, spawnSync } from "bun"
import { unresolvedImports } from "../mods/update/filestore/trees.ts"
import { COMMANDS, hostProvided, SEEDS } from "../mods/update/trees.ts"
import * as Graph from "./cli-tree/graph.ts"
import { checkoutRoot, commandChecks, moduleLinks, within } from "./cli-tree/run.ts"
import { externalInput, matchingInput } from "./read-path.ts"

/** Why the named installed tree cannot be checked. */
class NoTree extends Schema.TaggedError<NoTree>()("NoTree", { message: Schema.String }) {}

/**
 * A file's text, read by `cat`: the tree is sealed (read-only), and Bun's `mmap` opens a file for writing, so it
 * refuses every source there. A file that does not read fails the check, naming it.
 */
const readSealed = (file: string) => {
  const ran = spawnSync(["/bin/cat", externalInput(file)], { stdout: "pipe", stderr: "pipe" })
  return Option.getOrThrowWith(
    Option.map(
      Option.liftPredicate(ran, (each) => each.exitCode === 0),
      (each) => each.stdout.toString(),
    ),
    () => new NoTree({ message: `cannot read ${file} in the tree: ${ran.stderr.toString()}` }),
  )
}
const graph = Graph.graphOf(readSealed)

/** The installed tree's opencode/, real; a failure naming why when there is none to check. */
const installedRoot = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const given = yield* Config.option(Config.String("TREE_OPENCODE")).pipe(Effect.orElseSucceed(() => Option.none<string>()))
  if (Option.isNone(given) || given.value.trim() === "")
    return yield* new NoTree({ message: "no installed tree given: set TREE_OPENCODE=<tree>/opencode, a no-links tree the production tree maker made" })
  const root = yield* fs.realPath(given.value).pipe(Effect.mapError(() => new NoTree({ message: `no installed tree at TREE_OPENCODE=${given.value}` })))
  if (root === (yield* checkoutRoot)) return yield* new NoTree({ message: `TREE_OPENCODE=${given.value} names this checkout, not an installed tree` })
  const install = yield* fs.stat(path.join(root, "node_modules")).pipe(Effect.option)
  if (Option.isNone(install) || install.value.type !== "Directory")
    return yield* new NoTree({ message: `TREE_OPENCODE=${given.value} holds no install (no node_modules directory): not an installed tree` })
  return root
})

describe("each plain-Bun command runs from the installed tree TREE_OPENCODE names (required)", () => {
  it.live.layer(BunServices.layer)("the tree is an install with no links: no node_modules link leads outside it", () =>
    Effect.gen(function* () {
      const root = yield* installedRoot
      const links = yield* moduleLinks(root, false, 0)
      expect(links.filter(([, to]) => !within(root, to))).toEqual([])
    }),
  )

  it.live.layer(BunServices.layer)("every process's imports resolve in the tree exactly, its servers reach no platform implementation, and it installs the checkout's one Effect", () =>
    Effect.gen(function* () {
      const at = externalInput(yield* installedRoot)
      expect(unresolvedImports(at)).toEqual([])
      // Exactly: every bare import a process reaches, that its host does not serve, resolves from its importer in this tree, subpath and all
      // (React's JSX runtime is this walk's TSX transform's, not the TUI's: its Solid transform imports OpenTUI's, which it serves).
      const unresolved = SEEDS.flatMap(({ glob, host }) =>
        [...new Glob(glob).scanSync({ cwd: at })]
          .filter((seed) => !/\.(test|bench)\.tsx?$/.test(seed))
          .flatMap((seed) =>
            graph.reachOf(seed, at)
              .entries()
              .filter(([target]) => !target.startsWith("/") && !Graph.builtinModule(target) && !hostProvided(host, target) && !/^react(\/|$)/.test(target))
              .filter(([target, importer]) => !Graph.resolvesFrom(target, `${at}/${importer}`))
              .map(([target, importer]) => `${seed} (${host}): ${importer} imports ${target}, which does not resolve in the tree`)
              .toArray(),
          ),
      )
      expect(unresolved).toEqual([])
      const servers = [...new Glob("cmd/*/server.ts").scanSync({ cwd: at })].sort()
      expect(servers).toContain("cmd/orchestrate/server.ts")
      expect(servers.flatMap((seed) => graph.breaches(seed, Graph.PLATFORM_IMPL, at))).toEqual([])
      // The tree installs the checkout's Effect: the same pins, one copy of each.
      const checkout = yield* checkoutRoot
      const fs = yield* FileSystem.FileSystem
      const manifest = yield* fs.readFileString(matchingInput("package.json"))
      const checkoutGraph = Graph.graphOf(() => manifest)
      expect(graph.pinsAt(at)).toEqual(Graph.expectedPins(Graph.pinIn(checkoutGraph.manifestAt(checkout), "effect")))
      // Each plain-Bun command loads from the tree alone, and one copy of effect, its platform layer's included.
      const leaving = COMMANDS.flatMap(({ path: seed }) =>
        graph.bareOf(seed, at)
          .filter(([target, importer]) => !Option.exists(graph.packageDirFrom(Graph.packageOf(target), `${at}/${importer}`.replace(/\/[^/]*$/, "")), (dir) => Graph.within(at, dir)))
          .map(([target, importer]) => `${seed}: ${importer} imports ${target} from outside the tree`),
      )
      expect(leaving).toEqual([])
      const copies = COMMANDS.flatMap(({ path: seed }) => {
        const dirs = [...new Set([...graph.effectsOf(seed, at).keys()].map((key) => key.split(" -> ")[1]))]
        return [`${seed}: ${dirs.join(", ")}`].filter(() => dirs.length !== 1)
      })
      expect(copies).toEqual([])
    }),
    120_000,
  )

  commandChecks(installedRoot)
})
