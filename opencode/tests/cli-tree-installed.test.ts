// accept: deep (3.0 s alone on a quiet host: it runs every plain-Bun command's probes from a whole installed tree)
// accept: off until TREE_OPENCODE is set (it checks the no-links tree the production tree maker made, which only the deep gate makes)
/**
 * The plain-Bun commands (`mods/update/trees.ts` `COMMANDS`) run from an installed tree: `TREE_OPENCODE=<tree>/opencode`
 * names a tree with no links (one the production tree maker made, or a copy of it, never the share directory's own
 * files). There no `node_modules` link may lead outside the tree, so a command that runs there runs on the tree's
 * install alone. The tree is required: with `TREE_OPENCODE` unset, empty, missing, without an install, or naming
 * this checkout, every test here fails, saying so; it never passes on another root. The acceptance runner owes the
 * file `off until enabled`, by name, in a run that has no tree (the marker above); the deep gate sets the variable.
 *
 * @reads mods/update/trees.ts cmd/** mods/** scripts/daily.ts
 */
import * as BunServices from "@effect/platform-bun/BunServices"
import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"
import { describe, expect, it } from "effect-bun-test"
import { checkoutRoot, commandChecks, moduleLinks, within } from "./cli-tree/run.ts"

/** Why the named installed tree cannot be checked. */
class NoTree extends Schema.TaggedError<NoTree>()("NoTree", { message: Schema.String }) {}

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

  commandChecks(installedRoot)
})
