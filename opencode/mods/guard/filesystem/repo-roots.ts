// RepoRoots over the filesystem: a path is a repository's root when it holds
// a `.git` entry (a directory, or the file a worktree or submodule keeps). A
// missing path, or one under a file, is not; any other failure to look is
// RepoRootUnknown, so the guard refuses rather than guess.
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { RepoRootUnknown, RepoRoots } from "../service.ts"

const codeOf = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" ? cause.code : undefined

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/** The codes that mean "nothing there": the path, or a part of it, does not exist or is not a directory. */
const ABSENT: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"])

export const layer = Layer.succeed(
  RepoRoots,
  RepoRoots.of({
    isRoot: Effect.fn("RepoRoots.isRoot")(function* (path: string) {
      return yield* Effect.tryPromise({ try: () => stat(join(path, ".git")), catch: (cause) => cause }).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          ABSENT.has(codeOf(cause) ?? "") ? Effect.succeed(false) : Effect.fail(new RepoRootUnknown({ path, message: messageOf(cause) })),
        ),
      )
    }),
  }),
)
