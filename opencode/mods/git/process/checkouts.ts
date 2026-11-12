// Checkouts read through git, every read read-only: `--no-optional-locks`
// keeps `git status` from writing the index it refreshes, and
// `diff.autoRefreshIndex=false` keeps `git diff` from writing it (and running
// `post-index-change`), so a read never takes `index.lock` from the agent's
// own `git commit`. `--no-ext-diff --no-textconv` keep the repository's config
// from choosing a program to run.
//
// A read finds the checkout (`git rev-parse`), reads its status (`git status
// --porcelain=v2 --branch -z --untracked-files=all`), counts its tracked
// changes against its base (`git diff --numstat -z`), both finding renames
// whatever the user's config says, then counts the lines
// of up to UNTRACKED_READ_FILES untracked files of at most
// UNTRACKED_READ_BYTES each.
import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { Effect, Layer, Option } from "effect"
import { baseOf, type ChangedFile, type LineCounts, lineCount, parseNumstat, parseStatus, withLines } from "../checkout.ts"
import { Checkouts, CheckoutUnreadable } from "../service.ts"

/** How long one git command may run. */
export const TIMEOUT_MS = 5_000
/** An untracked file larger than this counts as a file with no lines. */
export const UNTRACKED_READ_BYTES = 512 * 1024
/** At most this many untracked files are read for lines; the rest count as files with no lines. */
export const UNTRACKED_READ_FILES = 200

const READ_ONLY = ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false"]

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))
const firstLine = (text: string) => text.trim().split("\n")[0] ?? ""

type Env = Readonly<Record<string, string | undefined>>

/**
 * One git command in `cwd`, answered with its output. None: git cannot run
 * there (no git on PATH, or the directory is gone), or `cwd` is in no
 * repository. A git that times out or exits non-zero fails with its first line.
 */
const git = (env: Env, cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    const spawned = yield* Effect.try({
      try: () =>
        Bun.spawn(["git", ...READ_ONLY, ...args], {
          cwd,
          env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          signal,
        }),
      catch: (cause) => cause,
    }).pipe(Effect.option)
    if (Option.isNone(spawned)) return Option.none<string>()
    const run = spawned.value
    const [stdout, stderr, code] = yield* Effect.tryPromise({
      try: () => Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]),
      catch: (cause) => new CheckoutUnreadable({ message: `git ${args[0] ?? ""}: ${messageOf(cause)}` }),
    })
    if (signal.aborted) return yield* new CheckoutUnreadable({ message: `git ${args[0] ?? ""} timed out` })
    if (code === 0) return Option.some(stdout)
    if (stderr.includes("not a git repository")) return Option.none<string>()
    return yield* new CheckoutUnreadable({ message: `git ${args[0] ?? ""}: ${firstLine(stderr)}` })
  })

/** Lines of an untracked file: none when it is binary, too large, or unreadable. */
const untrackedLines = (file: string) =>
  Effect.tryPromise(async (): Promise<LineCounts | undefined> => {
    const info = await stat(file)
    if (!info.isFile() || info.size > UNTRACKED_READ_BYTES) return undefined
    const text = await readFile(file, "utf8")
    return text.includes("\0") ? undefined : { added: lineCount(text), deleted: 0 }
  }).pipe(Effect.orElseSucceed(() => undefined))

/** The checkouts git reads, with `env` (PATH and the rest) as git's environment. */
export const layer = (env: Env = process.env) =>
  Layer.succeed(
    Checkouts,
    Checkouts.of({
      read: Effect.fn("Checkouts.read")(function* (directory: string) {
        const found = yield* git(env, directory, ["rev-parse", "--show-toplevel", "--show-object-format"])
        if (Option.isNone(found)) return Option.none()
        const [root = "", format = ""] = found.value.trim().split("\n")
        if (root.length === 0) return Option.none()
        const status = yield* git(env, directory, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--find-renames"])
        if (Option.isNone(status)) return Option.none()
        const { head, entries } = parseStatus(status.value)
        const base = baseOf(head, format)
        const counts = entries.some((entry) => entry.status !== "?")
          ? parseNumstat(
              Option.getOrElse(yield* git(env, directory, ["diff", "--numstat", "-z", "--find-renames", "--no-ext-diff", "--no-textconv", "--no-relative", base]), () => ""),
            )
          : new Map<string, LineCounts | undefined>()
        let untracked = 0
        const files = yield* Effect.forEach(
          entries,
          (entry): Effect.Effect<ChangedFile> => {
            if (entry.status !== "?") return Effect.succeed(withLines(entry, counts.get(entry.path)))
            untracked += 1
            if (untracked > UNTRACKED_READ_FILES) return Effect.succeed(withLines(entry, undefined))
            return untrackedLines(join(root, entry.path)).pipe(Effect.map((lines) => withLines(entry, lines)))
          },
          { concurrency: 8 },
        )
        return Option.some({ root, base, head, files })
      }),
    }),
  )
