// Committed work and who is on it, read at the call (service.ts `WorkGit`). Each head is read in the base with the
// lanes' object stores borrowed read-only (`GIT_ALTERNATE_OBJECT_DIRECTORIES`): a lane's commits are seen without a
// fetch and without a write in the lane. A head's place against the default branch is one `git log --cherry-mark`
// of the symmetric range, kept per (default tip, head): a status over hundreds of lanes reads only the heads that
// moved. The working directories come from one process listing (`lsof` on macOS, `/proc` on Linux).
import { file, readableStreamToText, spawn } from "bun"
import { Array as Arr, Effect, Layer, Match, Option } from "effect"
import { type HeadSeen, OnMain } from "../lost.ts"
import { WorkGit, type Wanted } from "../service.ts"

/** A finished command's exit code and output; none when it does not start. */
const run = (argv: ReadonlyArray<string>): Effect.Effect<Option.Option<{ readonly code: number; readonly text: string }>> =>
  Effect.try(() => spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" })).pipe(
    Effect.flatMap((child) => Effect.all({ code: Effect.tryPromise(() => child.exited), text: Effect.tryPromise(() => readableStreamToText(child.stdout)) }, { concurrency: 2 })),
    Effect.map(Option.some),
    Effect.orElseSucceed(() => Option.none()),
  )

/** A command's output when it exits 0. */
const output = (argv: ReadonlyArray<string>) =>
  run(argv).pipe(Effect.map((ran) => Option.map(Option.filter(ran, (each) => each.code === 0), (each) => each.text)))

/** A path's last write (epoch ms); none when it is not there. */
const mtimeOf = (path: string): Effect.Effect<Option.Option<number>> =>
  Effect.tryPromise(() => file(path).stat()).pipe(
    Effect.map((stat) => Option.some(stat.mtimeMs)),
    Effect.orElseSucceed(() => Option.none()),
  )

/** A path without a trailing slash. */
const bare = (path: string): string => path.replace(/\/+$/, "")

/** Whether `path` is `dir` or inside it. */
const within = (path: string, dir: string): boolean => path === dir || path.startsWith(`${dir}/`)

/** The object stores of `lanes` that exist, for git to borrow, as `GIT_ALTERNATE_OBJECT_DIRECTORIES` lists them. */
const storesOf = (lanes: ReadonlyArray<string>) =>
  Effect.forEach(lanes, (lane) => Effect.map(mtimeOf(`${bare(lane)}/.git/objects`), (found) => Option.as(found, `${bare(lane)}/.git/objects`)), { concurrency: 16 }).pipe(
    Effect.map((found) => found.flatMap(Option.toArray).join(":")),
  )

/** git in `repo` with `stores` borrowed (through `env`, so the rest of the environment is this process's). */
const gitWith = (stores: string, repo: string, args: ReadonlyArray<string>) => output(["env", `GIT_ALTERNATE_OBJECT_DIRECTORIES=${stores}`, "git", "-C", repo, ...args])

/** `git log --cherry-mark` lines (`<mark>\t<hash>\t<subject>`) as a head's place: none listed is on it, all `=` patch-equivalent. */
export const onMainOf = (text: string): OnMain => {
  const lines = text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [mark = "", sha = "", ...subject] = line.split("\t")
      return { mark, sha, subject: subject.join("\t") }
    })
  const missing = lines.filter((line) => line.mark !== "=")
  if (lines.length === 0) return OnMain.cases.Landed.make({})
  return Arr.match(missing, {
    onEmpty: () => OnMain.cases.Equivalent.make({}),
    onNonEmpty: (absent) =>
      OnMain.cases.Absent.make({ missing: absent.map((line) => line.sha), own: lines.map((line) => line.sha), subject: Arr.headNonEmpty(absent).subject }),
  })
}

/** The lines of a command's output that pass `keep`, each mapped; none when it did not run. */
const linesOf = (ran: Option.Option<string>, read: (line: string) => Option.Option<string>): ReadonlyArray<string> =>
  Option.match(ran, { onNone: () => [], onSome: (text) => text.split("\n").flatMap((line) => Option.toArray(read(line))) })

/**
 * The working directories of this user's processes now: `lsof`'s `n<path>` lines (macOS, and Linux where it is
 * installed), else each `/proc/<pid>/cwd` link's target by one `find` (Linux).
 */
const cwds: Effect.Effect<ReadonlyArray<string>> = Effect.gen(function* () {
  const listed = linesOf(yield* output(["lsof", "-w", "-a", "-d", "cwd", "-F", "n"]), (line) => Option.liftPredicate(line.slice(1), () => line.startsWith("n/")))
  if (listed.length > 0) return listed
  return linesOf(yield* run(["find", "/proc", "-mindepth", "2", "-maxdepth", "2", "-name", "cwd", "-printf", "%l\\n"]).pipe(Effect.map(Option.map((ran) => ran.text))), (line) =>
    Option.liftPredicate(line, () => line.startsWith("/")),
  )
})

/** Heads kept per default tip; dropped whole past this many, so it never grows without bound. */
const KEPT = 4_096

export const layer = Layer.sync(WorkGit, () => {
  // A head on main, or patch-equivalent there, stays so as main moves on: kept by the head alone. One whose own
  // commits are absent is kept per main tip, so a land reads it again.
  const kept = new Map<string, HeadSeen>()
  const keyOf = (tip: string, head: string, seen: HeadSeen) => Match.value(OnMain.guards.Absent(seen.onMain)).pipe(
    Match.when(true, () => `${tip}\n${head}`),
    Match.orElse(() => head),
  )
  const keptFor = (tip: string, head: string) => Option.orElse(Option.fromUndefinedOr(kept.get(head)), () => Option.fromUndefinedOr(kept.get(`${tip}\n${head}`)))
  const readHead = (repo: string, tip: string, stores: string, head: string) =>
    Effect.gen(function* () {
      // One call names the commit and its time; it fails for a commit neither the base nor the borrowed lanes hold.
      const named = Option.flatMap(yield* gitWith(stores, repo, ["log", "-1", "--format=%H%x09%ct", `${head}^{commit}`, "--"]), (text) => {
        const [full = "", seconds = ""] = text.trim().split("\t")
        return Option.liftPredicate({ full, at: Option.map(Option.liftPredicate(Number(seconds), (each) => Number.isFinite(each) && each > 0), (each) => each * 1000) }, () => full !== "")
      })
      if (Option.isNone(named)) return { onMain: OnMain.cases.Unknown.make({}), at: Option.none<number>() } satisfies HeadSeen
      const listed = yield* gitWith(stores, repo, ["log", "--cherry-mark", "--right-only", "--no-merges", "--format=%m%x09%H%x09%s", `${tip}...${named.value.full}`, "--"])
      return Option.match(listed, {
        onNone: (): HeadSeen => ({ onMain: OnMain.cases.Unknown.make({}), at: named.value.at }),
        onSome: (text): HeadSeen => ({ onMain: onMainOf(text), at: named.value.at }),
      })
    })
  return WorkGit.of({
    heads: Effect.fn("WorkGit.heads")(function* (repo: string, main: string, wanted: ReadonlyArray<Wanted>) {
      const tip = Option.map(yield* output(["git", "-C", repo, "rev-parse", "--verify", "--quiet", `${main}^{commit}`]), (text) => text.trim())
      if (Option.isNone(tip)) return new Map<string, HeadSeen>()
      if (kept.size > KEPT) kept.clear()
      const seen = yield* Effect.forEach(
        wanted,
        ({ head, lanes }) =>
          Option.match(keptFor(tip.value, head), {
            onSome: (found) => Effect.succeed([head, found] as const),
            onNone: () =>
              storesOf(lanes).pipe(
                Effect.flatMap((stores) => readHead(repo, tip.value, stores, head)),
                // An unknown head may be found once its lane is listed: only a known one is kept.
                Effect.tap((found) => Effect.sync(() => Option.map(Option.liftPredicate(found, (each) => !OnMain.guards.Unknown(each.onMain)), (each) => kept.set(keyOf(tip.value, head, each), each)))),
                Effect.map((found) => [head, found] as const),
              ),
          }),
        { concurrency: 8 },
      )
      return new Map(seen)
    }),
    touchedAt: (lane) => mtimeOf(`${bare(lane)}/.git/logs/HEAD`),
    // The process listing (~0.2 s for lsof) is read only when some lane is asked about.
    held: (lanes) =>
      Arr.match(lanes, {
        onEmpty: () => Effect.succeed(new Set<string>()),
        onNonEmpty: (asked) => Effect.map(cwds, (all) => new Set(asked.filter((lane) => all.some((dir) => within(bare(dir), bare(lane)))))),
      }),
    lands: (repo, main, limit) =>
      Effect.map(output(["git", "-C", repo, "log", "--first-parent", `--max-count=${limit}`, "--format=%ct", main, "--"]), (listed) =>
        linesOf(listed, (line) => Option.map(Option.liftPredicate(Number(line.trim()), (seconds) => Number.isFinite(seconds) && seconds > 0), (seconds) => String(seconds * 1000))).map(Number),
      ),
  })
})
