// A Rift's branch as git sees it (service.ts `Branches`): the branch HEAD
// names in the checkout at a land's path entry, `~/` read from home. A
// detached HEAD, no checkout there, or a git that does not answer is none.
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Branches } from "../service.ts"

/** How long one read may take. */
const TIMEOUT_MS = 5_000

/** `path` with a leading `~/` read from `home`. */
export const expand = (path: string, home: string = TuiDirs.dirs().home): string => (path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path)

/** The branch checked out at `path`; none when git gives none. */
export const branchAt = (path: string) =>
  Effect.tryPromise(async () => {
    const run = Bun.spawn(["git", "-C", expand(path), "symbolic-ref", "--quiet", "--short", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited])
    const branch = out.trim()
    return code === 0 && branch !== "" ? branch : undefined
  }).pipe(Effect.orElseSucceed(() => undefined), Effect.withSpan("Branches.of"))

export const layer = Layer.succeed(Branches, { of: branchAt })
