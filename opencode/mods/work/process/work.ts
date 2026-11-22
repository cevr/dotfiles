// Rifts over Ergo's `work` binary and Git, run as child processes: the contract's process provider.
// A workspace is a record in its base's registry (`work --json list`);
// the bases are the ones `work init` registered (`work --json bases`). Every call that reads or
// writes a registry names its base with WORK_BASE: inside an adopted copy `work` would otherwise
// take the copy for a base and read an empty registry. With `workrift: true` (the workbox) a
// workspace is made and removed by `workrift`; the rest asks `work`.
// A fresh workspace (made by `work new` or `workrift create`, never one a create adopts) restores the
// copies of its source's uncommitted work first, and its uncommitted work is only its own (inherited.ts).
// Unsaved work is read with Git (unpushed.ts). A removal is
// `work rm -abandon -expect <id>`: the tool's removal rule (workspace.ts) has judged it already,
// and the id is the one the caller's inspect saw, so a workspace replaced since is refused.
import { Effect, Layer, Option, Schedule, Schema } from "effect"
import { RiftFailed, Rifts, type CreateRequest } from "../service.ts"
import { holds, ownStashes, type Workspace } from "../workspace.ts"
import { commands, lines, type Ran } from "./command.ts"
import { inheritance, ownEntries } from "./inherited.ts"
import { describeBranch, madeOnField, madeOnOf, markBranch, purposeField, purposeOf } from "./purpose.ts"
import { unpushed as unpushedOf } from "./unpushed.ts"

export interface Options {
  /** The `work` binary, a path or a name on PATH; `work` when absent. */
  readonly work?: string
  /** Make and remove workspaces with `workrift` (the workbox). */
  readonly workrift: boolean
  /** Variables added to every command's environment (a test's scratch HOME). */
  readonly env?: Readonly<Record<string, string>>
  /** How long a create waits for a workspace of its name still being made (`creating`) to be made; 5 minutes when absent. */
  readonly makingWaitMs?: number
}

/** The `work` commands that write the registry in steps: an interrupt leaves them to finish (command.ts `finish`). */
const STEPPED: ReadonlySet<string> = new Set(["new", "rm"])

/** How often a create reads the registry while it waits for a workspace being made. */
const MAKING_POLL_MS = 1_000

/** One registry record, as `work --json list` prints it; other fields are left out. */
const Rec = Schema.Struct({
  name: Schema.String,
  id: Schema.String,
  path: Schema.String,
  parent: Schema.String,
  branch: Schema.String,
  state: Schema.Struct({ _tag: Schema.String }),
})
type Rec = typeof Rec.Type

const Records = Schema.fromJsonString(Schema.Array(Rec))
const Bases = Schema.fromJsonString(Schema.Array(Schema.String))
const Created = Schema.fromJsonString(Schema.Struct({ name: Schema.String, id: Schema.String, path: Schema.String, branch: Schema.String }))
const Removed = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String, id: Schema.String, trash: Schema.String, already: Schema.Boolean })))
const Failure = Schema.fromJsonString(Schema.Struct({ _tag: Schema.String }))

/** What a failed `work --json` call said: its tag and JSON (status 1), else a usage error (status 2) or its stderr. */
export const failureOf = (ran: Ran): string => {
  const said = ran.stderr.trim()
  if (ran.code === 2) return `usage (exit 2): ${said}`
  return Option.match(Schema.decodeUnknownOption(Failure)(ran.stdout.trim()), {
    onNone: () => `exit ${ran.code}: ${said || ran.stdout.trim()}`,
    onSome: (failure) => `${failure._tag}: ${ran.stdout.trim()}`,
  })
}

/** Where a workspace is: its base, the base's live records, and its own record (none for the base itself). */
interface Place {
  readonly base: string
  readonly records: ReadonlyArray<Rec>
  readonly record: Option.Option<Rec>
}

/** What a removal names: the base, the workspace's name and the id it had when last read. */
interface Known {
  readonly base: string
  readonly name: string
  readonly id: string
}

/** A record that still names a workspace: anything but trashed. */
const isLive = (record: Rec): boolean => record.state._tag !== "Trashed"

/** A record of a workspace `work new` is still making. */
const isCreating = (record: Rec): boolean => record.state._tag === "Creating"

/**
 * Asks whether the maker of a reservation still holds its lock. `work new` holds an flock on
 * `<storage home>/.lock-<id>` from its reservation to its activation (Ergo's journal/lock.ergo), and the kernel
 * frees it when the process ends however it ends. The probe opens the file without creating it and tries the
 * lock at once, then lets it go. Exit 0 means it took the lock, so the maker is gone. Exit 3 means the file is
 * missing: a maker removes it only after its record has left Creating, so a creating record without the file
 * also has no maker. Exit 1 means the lock is held, so the maker is alive. Anything else (no perl) is unknown.
 */
const MAKER_PROBE = 'use Fcntl ":flock"; open(my $f, "<", $ARGV[0]) or exit 3; exit(flock($f, LOCK_EX | LOCK_NB) ? 0 : 1)'

/** A record `list` shows: live and made (a clone in progress is not listed yet). */
const isMade = (record: Rec): boolean => isLive(record) && !isCreating(record)

/**
 * `bases` in the order to search for `path`: a path under `<dir>/.work/<name>/` or `<dir>/.rifts/<name>/`
 * tries the base `<dir>/<name>` first.
 */
export const searchOrder = (bases: ReadonlyArray<string>, path: string): ReadonlyArray<string> => {
  const hinted = Option.fromNullishOr(/^(.*?)\/\.(?:work|rifts)\/([^/]+)\//.exec(`${path}/`)).pipe(
    Option.map((match) => `${match[1]}/${match[2]}`),
    Option.filter((base) => bases.includes(base)),
  )
  return Option.match(hinted, { onNone: () => bases, onSome: (base) => [base, ...bases.filter((each) => each !== base)] })
}

/** The deepest of `records` whose folder holds `path`. */
const deepest = (records: ReadonlyArray<Rec>, path: string): Option.Option<Rec> =>
  Option.fromUndefinedOr([...records].filter((record) => holds(record.path, path)).sort((a, b) => b.path.length - a.path.length)[0])

/** The workspaces between `record` and its base, nearest first, the base last. */
const above = (records: ReadonlyArray<Rec>, base: string, record: Rec): ReadonlyArray<string> => {
  const out: Array<string> = []
  let at = record.parent
  while (at !== base && out.length <= records.length) {
    out.push(at)
    const here = at
    at = Option.match(Option.fromUndefinedOr(records.find((each) => each.path === here)), { onNone: () => base, onSome: (parent) => parent.parent })
  }
  return [...out, base]
}

export const layer = (options: Options) => {
  const { spawn, run } = commands(options.env)
  const copies = inheritance(options.env)
  const bin = options.work ?? "work"
  /** The id each workspace path had when last read: what `rm -expect` names. */
  const seen = new Map<string, Known>()

  const git = (path: string, ...args: ReadonlyArray<string>) => run(["git", "-C", path, ...args], path)

  /** Runs `work --json <args>` (on `base` when given) and reads its answer with `schema`. */
  const call = <A>(schema: Schema.Codec<A, string>, base: Option.Option<string>, args: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const operation = `work ${args[0] ?? ""}`
      const where = Option.getOrElse(base, () => "/")
      const env = Option.match(base, { onNone: () => ({}), onSome: (named) => ({ WORK_BASE: named }) })
      const ran = yield* spawn([bin, "--json", ...args], where, env, STEPPED.has(args[0] ?? ""))
      if (ran.code !== 0) return yield* new RiftFailed({ operation, message: failureOf(ran) })
      return yield* Schema.decodeUnknownEffect(schema)(ran.stdout.trim()).pipe(
        Effect.mapError((error) => new RiftFailed({ operation, message: `its answer does not read: ${error.message}` })),
      )
    })

  const bases = call(Bases, Option.none(), ["bases"])
  const live = (base: string) => call(Records, Option.some(base), ["list"]).pipe(Effect.map((records) => records.filter(isLive)))
  /** A base's live records, none when its registry cannot be read (a base folder gone): it holds nothing known. */
  const liveOrNone = (base: string) => live(base).pipe(Effect.catchTag("RiftFailed", () => Effect.succeed<ReadonlyArray<Rec>>([])))

  /** `directory` as the file system names it (symbolic links resolved); as given when it does not exist. */
  const physical = (directory: string) =>
    run(["pwd", "-P"], directory).pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => directory),
    )

  /** The checkout `directory` is in: its Git top level, else the directory itself. */
  const checkoutOf = (directory: string) =>
    git(directory, "rev-parse", "--show-toplevel").pipe(
      Effect.map((out) => out.trim()),
      Effect.catch(() => physical(directory)),
    )

  const remember = (place: Place) => {
    Option.map(place.record, (record) => seen.set(record.path, { base: place.base, name: record.name, id: record.id }))
    return place
  }

  /** The base or live workspace whose folder is `path` exactly. */
  const placeOf = Effect.fn("WorkRifts.placeOf")(function* (path: string) {
    const all = yield* bases
    for (const base of searchOrder(all, path)) {
      const records = yield* liveOrNone(base)
      if (base === path) return { base, records, record: Option.none() } satisfies Place
      const record = Option.fromUndefinedOr(records.find((each) => each.path === path))
      if (Option.isSome(record)) return remember({ base, records, record })
    }
    return yield* new RiftFailed({ operation: "work list", message: `${path} is no work base and no workspace of one (bases: ${all.join(", ") || "none"})` })
  })

  const source = Effect.fn("WorkRifts.source")(function* (directory: string) {
    const top = yield* checkoutOf(directory)
    const all = yield* bases
    for (const base of searchOrder(all, top)) {
      if (base === top) return base
      const hit = deepest(yield* liveOrNone(base), top)
      if (Option.isSome(hit)) return base
    }
    const holding = [...all].filter((base) => holds(base, top)).sort((a, b) => b.length - a.length)
    return yield* Option.match(Option.fromUndefinedOr(holding[0]), {
      onNone: () =>
        Effect.fail(
          new RiftFailed({
            operation: "work bases",
            message: `${top} is in no work base (bases: ${all.join(", ") || "none"}). The owner makes a repository a base with \`work init\` in it.`,
          }),
        ),
      onSome: (base) => Effect.succeed(base),
    })
  })

  const list = Effect.fn("WorkRifts.list")(function* (from: string) {
    const place = yield* placeOf(from)
    return place.records
      .filter((record) => isMade(record) && record.parent === from)
      .map((record) => record.path)
      .sort()
  })

  const inspect = Effect.fn("WorkRifts.inspect")(function* (path: string) {
    const place = yield* placeOf(path)
    const children = place.records
      .filter((record) => record.parent === path)
      .map((record) => record.path)
      .sort()
    const chain = Option.match(place.record, { onNone: () => [], onSome: (record) => above(place.records, place.base, record) })
    const base = { path, source: Option.isNone(place.record), children }
    const isGit = (yield* spawn(["git", "-C", path, "rev-parse", "--is-inside-work-tree"], path)).code === 0
    // Outside Git there is no branch to read, and nothing more.
    const branch = (yield* Effect.when(git(path, "branch", "--show-current"), Effect.succeed(isGit))).pipe(
      Option.map((out) => out.trim()),
      Option.filter((name) => name !== ""),
    )
    if (!isGit) return { ...base, git: false, branch: Option.getOrUndefined(branch), head: "", uncommitted: [], unpushed: [], stashes: 0 } satisfies Workspace
    const head = yield* git(path, "rev-parse", "--short", "HEAD").pipe(
      Effect.map((out) => out.trim()),
      Effect.orElseSucceed(() => "(no commits)"),
    )
    // A workspace's own changes only: a copy of the uncommitted work of the checkout it was copied from is that checkout's (inherited.ts).
    const from = yield* Option.match(place.record, { onNone: () => Effect.succeedNone, onSome: (record) => copies.copiedFrom(path, record.parent) })
    const uncommitted = ownEntries(path, from, yield* copies.status(path)).map((entry) => entry.line)
    // Commits found only here: on no remote, and in no branch of the base it was cloned from.
    const root = Option.fromUndefinedOr(chain.at(-1))
    const sourceTips = yield* Option.match(root, {
      onNone: () => Effect.succeed<ReadonlyArray<string>>([]),
      onSome: (at) => git(at, "for-each-ref", "--format=%(objectname)", "refs/heads").pipe(Effect.map(lines)),
    })
    const unpushed = yield* unpushedOf({ git, spawn }, path, sourceTips, head !== "(no commits)")
    // Stash entries found only here: a clone carries the stash of the workspaces it was made from.
    const stashOf = (at: string) => git(at, "stash", "list", "--format=%H").pipe(Effect.map(lines))
    const inherited = yield* Effect.forEach(chain, stashOf).pipe(Effect.map((each) => each.flat()))
    const stashes = ownStashes(yield* stashOf(path), inherited)
    const purpose = yield* purposeOf({ git, spawn }, path, branch)
    const madeOn = yield* madeOnOf({ git, spawn }, path)
    return { ...base, git: true, branch: Option.getOrUndefined(branch), head, uncommitted, unpushed, stashes, ...purposeField(purpose), ...madeOnField(madeOn) } satisfies Workspace
  })

  const describe = Effect.fn("WorkRifts.describe")(function* (path: string, purpose: string) {
    yield* describeBranch({ git, spawn }, path, purpose)
  })

  const mark = Effect.fn("WorkRifts.mark")(function* (path: string) {
    yield* markBranch({ git, spawn }, path)
  })

  /** Whether the checkout at `path` has `ref`. */
  const has = (path: string, ref: string) => spawn(["git", "-C", path, "show-ref", "--verify", "--quiet", ref], path).pipe(Effect.map((ran) => ran.code === 0))

  /** Whether `at` names a commit in the checkout at `path`. */
  const hasCommit = (path: string, at: string) =>
    spawn(["git", "-C", path, "rev-parse", "--verify", "--quiet", `${at}^{commit}`], path).pipe(Effect.map((ran) => ran.code === 0))

  /** Trashes the workspace `known` names, that id only; a retry answers what the first did. */
  const trash = (known: Known, withChildren: boolean) =>
    call(Removed, Option.some(known.base), ["rm", "-abandon", "-expect", known.id, ...["-tree"].filter(() => withChildren), known.name])

  /**
   * Detaches a fresh workspace at `at`, fetching origin first when it lacks the commit (and asking origin
   * for its default branch when `at` is `origin/HEAD`). A detach that fails trashes the workspace, so no
   * half-made one is left.
   */
  const detach = (path: string, at: string, made: Option.Option<Known>) =>
    Effect.gen(function* () {
      if (!(yield* hasCommit(path, at))) {
        yield* spawn(["git", "-C", path, "fetch", "--quiet", "origin"], path)
        if (at === "origin/HEAD") yield* spawn(["git", "-C", path, "remote", "set-head", "origin", "--auto"], path)
      }
      if (!(yield* hasCommit(path, at))) return yield* new RiftFailed({ operation: "git switch", message: `no commit ${at} here or on origin` })
      yield* git(path, "switch", "--quiet", "--detach", at)
    }).pipe(
      Effect.catch((error: RiftFailed) =>
        Option.match(made, { onNone: () => remove(path), onSome: (known) => trash(known, false) }).pipe(
          Effect.ignore,
          Effect.andThen(Effect.fail(new RiftFailed({ operation: error.operation, message: `the workspace ${path} was removed: ${error.message}` }))),
        ),
      ),
    )

  /** The `work new` arguments that start `branch` as the checkout at `from` holds it: its local branch, else origin's, else new at its head. */
  const branchArgs = Effect.fn("WorkRifts.branchArgs")(function* (from: string, branch: string) {
    if (yield* has(from, `refs/heads/${branch}`)) return { args: [], track: false }
    if (yield* has(from, `refs/remotes/origin/${branch}`)) return { args: ["-from", `origin/${branch}`], track: true }
    return { args: [], track: false }
  })

  /**
   * The workspace `request` names once the `work new` making it is done, waiting at most `makingWaitMs`: made
   * on the request's branch, it is answered (and started at `at`, refusing rather than overwriting what it
   * holds); still being made, or made on another branch, fails saying so. Its folder is never removed here:
   * one an interrupted create left can already hold an agent's work.
   */
  /** Whether the `work new` that reserved `record` is gone: its lock free or its lock file removed (MAKER_PROBE). */
  const makerGone = (record: Rec) =>
    spawn(["perl", "-e", MAKER_PROBE, `${record.path.slice(0, record.path.lastIndexOf("/"))}/.lock-${record.id}`], "/").pipe(
      Effect.map((ran) => record.id !== "" && (ran.code === 0 || ran.code === 3)),
    )

  /** What to do with a workspace of this name left creating: look in it, then clear its name, which `work gc` must never do. */
  const clearIt = (name: string, path: string) =>
    `Its folder may already hold work: look in ${path}, then move it to the trash with \`work rm ${name}\` on its base and call again, or pick another name; never run \`work gc\` on its base for it`

  const madeMeanwhile = Effect.fn("WorkRifts.madeMeanwhile")(function* (base: string, request: CreateRequest) {
    const recordOf = live(base).pipe(Effect.map((records) => Option.fromUndefinedOr(records.find((record) => record.name === request.name))))
    /**
     * The record of the name, and whether it is creating with its maker gone. A maker that activates between
     * the read and the probe has removed its lock file by the time the probe runs, so a "gone" probe reads the
     * record again: only the same reservation still creating is left by its maker; anything else is what the
     * maker made (or gave up) meanwhile.
     */
    const look = recordOf.pipe(
      Effect.flatMap((found) =>
        Option.match(Option.filter(found, isCreating), {
          onNone: () => Effect.succeed({ found, orphan: false }),
          onSome: (making) =>
            makerGone(making).pipe(
              Effect.flatMap((gone) =>
                Effect.gen(function* () {
                  if (!gone) return { found, orphan: false }
                  const again = yield* recordOf
                  return { found: again, orphan: Option.exists(again, (record) => record.id === making.id && isCreating(record)) }
                }),
              ),
            ),
        }),
      ),
    )
    const waitMs = options.makingWaitMs ?? 300_000
    const seenLast = yield* look.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(MAKING_POLL_MS),
        while: (state) => Option.exists(state.found, isCreating) && !state.orphan,
        times: Math.ceil(waitMs / MAKING_POLL_MS),
      }),
    )
    const record = seenLast.found
    return yield* Option.match(record, {
      onNone: () => Effect.fail(new RiftFailed({ operation: "work new", message: `the workspace ${request.name} being made was given up while this create waited for it; call again` })),
      onSome: (found) =>
        Effect.gen(function* () {
          if (isCreating(found) && seenLast.orphan)
            return yield* new RiftFailed({
              operation: "work new",
              message: `the workspace ${request.name} at ${found.path} was left being made by a \`work new\` that is gone (its record says creating; a reboot, a crash or a kill cut it off), so it will never be made. ${clearIt(request.name, found.path)}`,
            })
          if (isCreating(found))
            return yield* new RiftFailed({
              operation: "work new",
              message: `the workspace ${request.name} at ${found.path} is still being made after ${Math.round(waitMs / 1000)} s (its record says creating, and its \`work new\` still runs). Wait and call again. ${clearIt(request.name, found.path)}`,
            })
          if (found.branch !== request.branch)
            return yield* new RiftFailed({ operation: "work new", message: `the workspace ${request.name} at ${found.path} was made meanwhile on branch ${found.branch}, not ${request.branch}; pick another name` })
          seen.set(found.path, { base, name: found.name, id: found.id })
          yield* Option.match(Option.fromUndefinedOr(request.at), {
            onNone: () => Effect.void,
            onSome: (at) => Effect.asVoid(git(found.path, "switch", "--quiet", "--detach", at)),
          })
          return found.path
        }),
    })
  })

  /**
   * A fresh workspace's first step (inherited.ts `settle`): the copies of `from`'s uncommitted work go back to HEAD.
   * One that fails leaves them, which a land and a removal still tell from the workspace's own work: it is logged, never fatal.
   */
  const settled = (path: string, from: string) =>
    copies.settle(path, from).pipe(Effect.catch((failure: RiftFailed) => Effect.logWarning("work: the copies a new workspace inherited were not restored", failure)))

  const create = Effect.fn("WorkRifts.create")(function* (request: CreateRequest) {
    if (options.workrift) {
      // From the caller's checkout, so workrift imports its gh stack metadata; the source is named outright.
      const out = yield* run(["workrift", "create", request.branch], request.from, { WORKRIFT_SOURCE: request.source })
      const path = yield* Option.match(Option.fromUndefinedOr(lines(out).at(-1)), {
        onNone: () => Effect.fail(new RiftFailed({ operation: "workrift create", message: "it printed no workspace path" })),
        onSome: Effect.succeed,
      })
      yield* Option.match(Option.fromUndefinedOr(request.at), { onNone: () => Effect.void, onSome: (at) => detach(path, at, Option.none()) })
      yield* settled(path, request.source)
      return path
    }
    const parent = yield* placeOf(request.source)
    // A workspace of this name still being made (an earlier create an interrupt cut off, its `work new` left
    // to finish): wait for it, then answer it as this create's, so the earlier call's lane is finished here.
    const pending = Option.fromUndefinedOr(parent.records.find((record) => record.name === request.name))
    if (Option.exists(pending, isCreating)) return yield* madeMeanwhile(parent.base, request)
    const on = Option.match(parent.record, { onNone: () => [], onSome: (record) => ["-on", record.name] })
    const start = yield* branchArgs(request.source, request.branch)
    const made = yield* call(Created, Option.some(parent.base), ["new", "-branch", request.branch, ...on, ...start.args, request.name])
    const known = { base: parent.base, name: made.name, id: made.id }
    seen.set(made.path, known)
    const tracked = Effect.when(git(made.path, "branch", "--quiet", `--set-upstream-to=origin/${request.branch}`, request.branch), Effect.succeed(start.track))
    yield* Option.match(Option.fromUndefinedOr(request.at), { onNone: () => Effect.asVoid(tracked), onSome: (at) => detach(made.path, at, Option.some(known)) })
    // Fresh, before any agent runs in it: the copies of the uncommitted work it was copied with go back to HEAD.
    yield* settled(made.path, request.source)
    return made.path
  })

  const remove = Effect.fn("WorkRifts.remove")(function* (path: string, removeOptions?: { readonly withChildren?: boolean }) {
    const withChildren = removeOptions?.withChildren === true
    if (options.workrift) {
      yield* run(["workrift", "remove", ...["--with-children"].filter(() => withChildren), path], path.slice(0, path.lastIndexOf("/")) || "/")
      return
    }
    // The id the caller's inspect saw: a workspace that has since been replaced under the name is refused.
    const known = yield* Option.match(Option.fromUndefinedOr(seen.get(path)), {
      onSome: Effect.succeed,
      onNone: () =>
        placeOf(path).pipe(
          Effect.flatMap((place) =>
            Option.match(place.record, {
              onNone: () => Effect.fail(new RiftFailed({ operation: "work rm", message: `${path} is a base; the tool never removes one` })),
              onSome: (record) => Effect.succeed({ base: place.base, name: record.name, id: record.id }),
            }),
          ),
        ),
    })
    yield* trash(known, withChildren)
  })

  return Layer.succeed(Rifts, Rifts.of({ source, create, list, inspect, describe, mark, remove }))
}
