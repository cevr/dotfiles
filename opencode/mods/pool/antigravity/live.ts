// Antigravity's read authority as the pool runs it on a host: the profile's
// files through the host's file system, the macOS keychain through the system
// `security` tool (no native dependency: the binding T3 Code loads,
// @napi-rs/keyring, is a native module the plugin would have to ship), the
// state file beside the pool's other state under its lock file, and Google
// over the HttpClient given, with no redirect followed. A host other than
// macOS has no keychain this reads: a Linux workbox reads its sign-in from the
// profile's files, else "sign-in not readable here". One authority per state
// file in the process; building it does no I/O.
import { readableStreamToText, spawn } from "bun"
import { Clock, Effect, FileSystem, Match, Option, Path, Random, Redacted, Schedule, Schema } from "effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { DEFAULT_GEMINI_CAP, type GeminiCap } from "./gate.ts"
import { envFileText, type ManagedProfile, signInLine, type UserLink } from "./profile.ts"
import { type AuthMethod, AuthMethod as AuthMethodSchema, GOOGLE, userAgent } from "./reader.ts"
import { KeychainRead, type Places } from "./signin.ts"
import { type FleetContext, make, type Source, type Store, StoreFailed } from "./source.ts"
import { EMPTY, State, unreadable } from "./state.ts"

/** How long the keychain read may take: long enough for the owner to answer macOS's dialog once. */
export const KEYCHAIN_TIMEOUT_MS = 60_000

/** The managed profile under the pool's state directory `state` (profile.ts): the default; ~/.gemini is never read by default. */
export const defaultProfile = (state: string) => `${state}/opencode-pool/antigravity/profiles/default`

/** The `security` tool's exit codes it answers by (Security framework: errSecItemNotFound, errSecUserCanceled, errSecInteractionNotAllowed, errSecAuthFailed). */
const SECURITY_ABSENT = 44
const SECURITY_DENIED: ReadonlySet<number> = new Set([128, 36, 51])

const keychainOf = (code: number, out: string): KeychainRead =>
  Match.value(code).pipe(
    Match.when(0, () =>
      Option.match(Option.liftPredicate(out.trim(), (text) => text !== ""), {
        onNone: () => KeychainRead.cases.Failed.make({}),
        onSome: (text) => KeychainRead.cases.Found.make({ secret: Redacted.make(text) }),
      }),
    ),
    Match.when(SECURITY_ABSENT, () => KeychainRead.cases.Absent.make({})),
    Match.when((exit) => SECURITY_DENIED.has(exit), () => KeychainRead.cases.Denied.make({})),
    Match.orElse(() => KeychainRead.cases.Failed.make({})),
  )


/** Sends SIGTERM to the process group `pgid` this code started (`detached`, so it leads its own group). */
const killGroup = (pgid: number) =>
  Effect.try({ try: () => spawn(["/bin/kill", "-TERM", "--", `-${pgid}`], { stdin: "ignore", stdout: "ignore", stderr: "ignore" }), catch: () => "kill failed" }).pipe(
    Effect.flatMap((killer) => Effect.tryPromise({ try: () => killer.exited, catch: () => "kill failed" })),
    Effect.ignore,
  )

/**
 * One read of the CLI's keychain entry on macOS (`security
 * find-generic-password -s gemini -a antigravity -w`), in its own process
 * group, the group killed past its deadline or on interruption. What it
 * prints is the secret: it goes into a Redacted at once and nowhere else;
 * what it says on stderr is not read. Any failure, a defect too, is `Failed`.
 */
export const macKeychain: Effect.Effect<KeychainRead> = Effect.try({
  try: () =>
    spawn(["/usr/bin/security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      detached: true,
    }),
  catch: () => KeychainRead.cases.Failed.make({}),
}).pipe(
  Effect.flatMap((child) =>
    Effect.all(
      {
        code: Effect.tryPromise({ try: () => child.exited, catch: () => KeychainRead.cases.Failed.make({}) }),
        out: Effect.tryPromise({ try: () => readableStreamToText(child.stdout), catch: () => KeychainRead.cases.Failed.make({}) }),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.map(({ code, out }) => keychainOf(code, out)),
      Effect.onInterrupt(() => killGroup(child.pid)),
      Effect.timeoutOrElse({ duration: KEYCHAIN_TIMEOUT_MS, orElse: () => Effect.as(killGroup(child.pid), KeychainRead.cases.TimedOut.make({})) }),
    ),
  ),
  Effect.catchCause(() => Effect.succeed(KeychainRead.cases.Failed.make({}))),
)

/** A host whose keychain this does not read. */
export const noKeychain: Effect.Effect<KeychainRead> = Effect.succeed(KeychainRead.cases.Unsupported.make({}))

/** The keychain read for the platform `platform` (`process.platform`'s value). */
export const keychainFor = (platform: string): Effect.Effect<KeychainRead> =>
  Match.value(platform).pipe(
    Match.when("darwin", () => macKeychain),
    Match.orElse(() => noKeychain),
  )

/** What a machine name `uname -m` prints is, as Antigravity's user agent names it. */
const archOf = (machine: string) =>
  Match.value(machine).pipe(
    Match.when("x86_64", () => "x64"),
    Match.when("aarch64", () => "arm64"),
    Match.orElse((name) => name),
  )

/**
 * This host as Antigravity's user agent names it: `darwin` where the macOS
 * `security` tool is, else `linux`; and `uname -m`. Run only by a read; any
 * failure, a defect too, is `unknown`.
 */
export const hostKind = Effect.fn("Antigravity.hostKind")(function* () {
  const fs = yield* FileSystem.FileSystem
  const mac = yield* fs.exists("/usr/bin/security").pipe(Effect.catchCause(() => Effect.succeed(false)))
  const machine = yield* Effect.try({
    try: () => spawn(["uname", "-m"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }),
    catch: () => "unknown",
  }).pipe(
    Effect.flatMap((child) => Effect.tryPromise({ try: () => readableStreamToText(child.stdout), catch: () => "unknown" })),
    Effect.map((text) => Option.getOrElse(Option.liftPredicate(text.trim(), (name) => name !== ""), () => "unknown")),
    Effect.timeoutOrElse({ duration: 2_000, orElse: () => Effect.succeed("unknown") }),
    Effect.catchCause(() => Effect.succeed("unknown")),
  )
  return Match.value(mac).pipe(
    Match.when(true, () => ({ platform: "darwin", arch: archOf(machine) })),
    Match.orElse(() => ({ platform: "linux", arch: archOf(machine) })),
  )
})

/** The profile's files through the host's file system; a file that is not there, or cannot be read, is none. */
export const places = Effect.fn("Antigravity.places")(function* (keychain: Effect.Effect<KeychainRead>) {
  const fs = yield* FileSystem.FileSystem
  const read = (path: string) =>
    fs.exists(path).pipe(
      Effect.flatMap((there) => Match.value(there).pipe(Match.when(true, () => Effect.map(fs.readFileString(path), Option.some)), Match.orElse(() => Effect.succeed(Option.none<string>())))),
      Effect.catchCause(() => Effect.succeed(Option.none<string>())),
    )
  return { read, keychain } satisfies Places
})

const StateFile = Schema.fromJsonString(State)
const decodeState = Schema.decodeUnknownOption(StateFile)
const encodeState = Schema.encodeEffect(StateFile)

/** A lock this old was left by a process that died or stalled holding it: it is taken over. */
export const LOCK_STALE_MS = 10_000
/** How long a change waits for the lock: about 5 s, tried every 10 ms. */
const LOCK_TRIES = 500

class Held extends Schema.TaggedError<Held>()("Held", {}) {}
class Lost extends Schema.TaggedError<Lost>()("Lost", {}) {}

/** A name for one taking of the lock, unique on the host. */
const ownerId = Effect.gen(function* () {
  return `${yield* Clock.currentTimeMillis}-${yield* Random.nextIntBetween(0, 1_000_000_000)}-${yield* Random.nextIntBetween(0, 1_000_000_000)}`
})

/**
 * The state kept in `file`, every change under the lock file `<file>.lock`,
 * so every process on the host changes it one at a time from what is on
 * disk. The lock names its owner:
 * - it is made whole and exclusively (a file of the owner's id, hard-linked to
 *   the lock's name, which fails when one is there);
 * - a lock older than LOCK_STALE_MS is taken over atomically: renamed to a
 *   name of the taker's own, and kept dead only when it is still the one the
 *   taker judged stale; a fresh one it caught is linked back;
 * - a change is saved only while the lock is still its owner's (a holder that
 *   stalled past the takeover finds it lost and saves nothing), and the lock
 *   is let go the same way, so no one removes another's lock.
 * A save is whole, through a temporary file of the owner's. A state file that
 * does not decode keeps the floor: it reads as an attempt made just now
 * (state.ts `unreadable`), and the first change keeps its text beside it as
 * `<file>.undecodable`. Building it does no I/O.
 */
export const fileStore = Effect.fn("Antigravity.fileStore")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const lock = `${file}.lock`
  const failed = (what: string) => () => new StoreFailed({ what })
  /** The file's text and its state: none when there is no file; the floored state when it does not decode. */
  const raw = Effect.gen(function* () {
    if (!(yield* fs.exists(file))) return { text: Option.none<string>(), state: EMPTY }
    const text = yield* fs.readFileString(file)
    const decoded = decodeState(text)
    if (Option.isSome(decoded)) return { text: Option.none<string>(), state: decoded.value }
    return { text: Option.some(text), state: unreadable(yield* Clock.currentTimeMillis) }
  })
  const load = raw.pipe(
    Effect.map((read) => read.state),
    Effect.mapError(failed(`reading ${file}`)),
  )
  /** The lock's owner and age; none when there is no lock. */
  const lockOf = (name: string) =>
    Effect.gen(function* () {
      const owner = yield* fs.readFileString(name)
      const info = yield* fs.stat(name)
      const now = yield* Clock.currentTimeMillis
      return Option.some({ owner, age: Option.getOrElse(Option.map(info.mtime, (at) => now - at.getTime()), () => 0) })
    }).pipe(Effect.orElseSucceed(() => Option.none<{ readonly owner: string; readonly age: number }>()))
  /**
   * The lock moved aside to `aside`: kept there when it is `expected`'s (the
   * caller removes it), else linked back where it was, for its owner.
   */
  const moveAside = (aside: string, expected: string) =>
    Effect.gen(function* () {
      yield* fs.rename(lock, aside)
      const moved = yield* fs.readFileString(aside).pipe(Effect.orElseSucceed(() => ""))
      if (moved !== expected) yield* fs.link(aside, lock).pipe(Effect.ignore)
      yield* fs.remove(aside).pipe(Effect.ignore)
      return moved === expected
    }).pipe(Effect.orElseSucceed(() => false))
  const take = (id: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      const candidate = `${lock}.${id}`
      yield* fs.writeFileString(candidate, id, { mode: 0o600 })
      const made = yield* fs.link(candidate, lock).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      yield* fs.remove(candidate).pipe(Effect.ignore)
      if (made) return
      const there = yield* lockOf(lock)
      if (Option.exists(there, (held) => held.age > LOCK_STALE_MS)) yield* moveAside(`${lock}.stale-${id}`, Option.getOrElse(Option.map(there, (held) => held.owner), () => ""))
      return yield* new Held()
    }).pipe(
      Effect.catchIf((error) => !(error instanceof Held), () => Effect.fail(new Held())),
      Effect.retry({ times: LOCK_TRIES, schedule: Schedule.spaced(10) }),
      Effect.mapError(failed(`locking ${lock}`)),
    )
  const owns = (id: string) => Effect.map(lockOf(lock), (there) => Option.exists(there, (held) => held.owner === id))
  const release = (id: string) => moveAside(`${lock}.release-${id}`, id).pipe(Effect.asVoid)
  const save = (id: string, state: State) =>
    Effect.gen(function* () {
      if (!(yield* owns(id))) return yield* new Lost()
      const text = yield* encodeState(state)
      const temporary = `${file}.${id}.tmp`
      yield* fs.writeFileString(temporary, text, { mode: 0o600 })
      yield* fs.rename(temporary, file)
    }).pipe(
      Effect.catchTag("Lost", () => Effect.fail(new StoreFailed({ what: `the lock ${lock} was taken over: nothing saved` }))),
      Effect.mapError((error) => Match.value(error).pipe(Match.when(Match.instanceOf(StoreFailed), (lost) => lost), Match.orElse(failed(`writing ${file}`)))),
    )
  const transact = <A, R>(step: (state: State) => Effect.Effect<readonly [State, A], never, R>) =>
    Effect.flatMap(ownerId, (id) =>
      Effect.acquireUseRelease(
        take(id),
        () =>
          Effect.gen(function* () {
            const read = yield* raw.pipe(Effect.mapError(failed(`reading ${file}`)))
            // A state file that does not decode is kept beside it, never lost.
            if (Option.isSome(read.text)) yield* fs.writeFileString(`${file}.undecodable`, read.text.value, { mode: 0o600 }).pipe(Effect.mapError(failed(`keeping ${file}`)))
            const [next, answer] = yield* step(read.state)
            yield* save(id, next)
            return answer
          }),
        () => release(id),
      ),
    )
  return { load, transact } satisfies Store
})

/** What became of one of T3's links into the user's ~/.gemini. */
export type LinkOutcome = "linked" | "no target" | "kept: not a link"

/**
 * One of T3's links into ~/.gemini, made as T3 makes it
 * (antigravityAuthSupport.ts 263-330): none, and a dangling one removed, where
 * the target is absent; else a link to it, replacing a link elsewhere or an
 * empty placeholder directory. Anything else there is kept as it is.
 */
const linkUser = Effect.fn("Antigravity.linkUser")(function* (link: UserLink) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const pointsTo = yield* fs.readLink(link.link).pipe(
    Effect.map((value) => Option.some(path.resolve(path.dirname(link.link), value))),
    Effect.orElseSucceed(() => Option.none<string>()),
  )
  if (!(yield* fs.exists(link.target))) {
    if (Option.isSome(pointsTo)) yield* fs.remove(link.link)
    return "no target" satisfies LinkOutcome
  }
  if (Option.contains(pointsTo, link.target)) return "linked" satisfies LinkOutcome
  if (Option.isSome(pointsTo)) yield* fs.remove(link.link)
  else if (yield* fs.exists(link.link)) {
    const info = yield* fs.stat(link.link)
    const empty = info.type === "Directory" && (yield* fs.readDirectory(link.link)).length === 0
    if (!empty) return "kept: not a link" satisfies LinkOutcome
    yield* fs.remove(link.link, { recursive: true })
  }
  yield* fs.makeDirectory(path.dirname(link.link), { recursive: true })
  yield* fs.symlink(link.target, link.link)
  return "linked" satisfies LinkOutcome
})

/**
 * The managed profile made as T3 makes it (profile.ts): its two directories
 * 0700, its `settings.json`, its links into the user's ~/.gemini; then, beside
 * it, the env file (0600, no secret). The env file's path, the sign-in line
 * and each link's outcome.
 */
export const prepareProfile = Effect.fn("Antigravity.prepareProfile")(function* (profile: ManagedProfile) {
  const fs = yield* FileSystem.FileSystem
  for (const directory of profile.directories) {
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 })
    yield* fs.chmod(directory, 0o700)
  }
  yield* fs.writeFileString(profile.settings.path, profile.settings.text)
  const links = yield* Effect.forEach(profile.links, (link) => Effect.map(linkUser(link), (outcome) => [link.link, outcome] as const))
  yield* fs.writeFileString(profile.envFile, envFileText(profile), { mode: 0o600 })
  yield* fs.chmod(profile.envFile, 0o600)
  return { envFile: profile.envFile, signIn: signInLine(profile), links }
})

/** Where a host's source reads and keeps its state. */
export interface LiveConfig {
  readonly profile: string
  readonly stateFile: string
  readonly auth: AuthMethod
  readonly fleet?: FleetContext
  readonly geminiCap?: GeminiCap
}

/** The pool's `antigravity` option: `false` reads nothing; else where to read, all defaulted. */
export const PoolOption = Schema.Union([
  Schema.Literal(false),
  Schema.Struct({
    /** The CLI's profile; default the managed one, `$XDG_STATE_HOME/opencode-pool/antigravity/profiles/default`. */
    profile: Schema.optionalKey(Schema.String),
    /** The state file; default `$XDG_STATE_HOME/opencode-pool/antigravity.json`. */
    stateFile: Schema.optionalKey(Schema.String),
    /** `personal` (the daily host first, the default) or `business` (production first). */
    auth: Schema.optionalKey(AuthMethodSchema),
    /** Concurrent Gemini agent cap: default 4 per agent and 8 fleet total across hosts. */
    geminiCap: Schema.optionalKey(
      Schema.Struct({
        perAgent: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
        fleet: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      }),
    ),
  }),
])
export type PoolOption = typeof PoolOption.Type

/** The state file beside the pool's other state. */
export const defaultStateFile = () => `${TuiDirs.dirs().state}/opencode-pool/antigravity.json`

/**
 * The source as a host runs it: its files, its keychain, its state file and
 * Google over the HttpClient given. Building it does no I/O: the host's kind
 * is worked out by each read.
 */
export const liveSource = Effect.fn("Antigravity.liveSource")(function* (config: LiveConfig) {
  const fs = yield* FileSystem.FileSystem
  // Worked out at each read (reads are minutes apart at the least), never at build.
  const host = Effect.provideService(hostKind(), FileSystem.FileSystem, fs)
  return yield* make({
    profile: config.profile,
    places: yield* places(Effect.flatMap(host, (kind) => keychainFor(kind.platform))),
    store: yield* fileStore(config.stateFile),
    auth: config.auth,
    endpoints: GOOGLE,
    agent: Effect.map(host, (kind) => userAgent(kind.platform, kind.arch)),
    ...Option.match(Option.fromUndefinedOr(config.fleet), { onNone: () => ({}), onSome: (fleet) => ({ fleet }) }),
    ...Option.match(Option.fromUndefinedOr(config.geminiCap), { onNone: () => ({}), onSome: (geminiCap) => ({ geminiCap }) }),
  })
})

const KEY = Symbol.for("dotfiles.opencode-pool.antigravity.v1")
const registry: { [key: symbol]: Map<string, Source> } = globalThis
// The first copy of this module in the process puts the one map in: every
// plugin instance, and a re-evaluated module graph, share one authority per state file.
registry[KEY] ??= new Map()

/**
 * The pool's Antigravity source for `option` on this host (its home from
 * tui-dirs): one per state file in the process, whatever builds it; none when
 * the option is `false`. It does no I/O and starts nothing.
 */
export const poolSource = Effect.fn("Antigravity.poolSource")(function* (option: PoolOption, fleet?: FleetContext) {
  if (option === false) return Option.none<Source>()
  const stateFile = Option.getOrElse(Option.fromUndefinedOr(option.stateFile), defaultStateFile)
  const authorities = Option.getOrElse(Option.fromUndefinedOr(registry[KEY]), () => new Map<string, Source>())
  const existing = Option.fromUndefinedOr(authorities.get(stateFile))
  if (Option.isSome(existing)) return existing
  const cap: GeminiCap = {
    perAgent: Option.getOrElse(Option.flatMap(Option.fromUndefinedOr(option.geminiCap), (c) => Option.fromUndefinedOr(c.perAgent)), () => DEFAULT_GEMINI_CAP.perAgent),
    fleet: Option.getOrElse(Option.flatMap(Option.fromUndefinedOr(option.geminiCap), (c) => Option.fromUndefinedOr(c.fleet)), () => DEFAULT_GEMINI_CAP.fleet),
  }
  const source = yield* liveSource({
    profile: Option.getOrElse(Option.fromUndefinedOr(option.profile), () => defaultProfile(TuiDirs.dirs().state)),
    stateFile,
    auth: Option.getOrElse(Option.fromUndefinedOr(option.auth), (): AuthMethod => "personal"),
    geminiCap: cap,
    ...Option.match(Option.fromUndefinedOr(fleet), { onNone: () => ({}), onSome: (ctx) => ({ fleet: ctx }) }),
  })
  authorities.set(stateFile, source)
  registry[KEY] = authorities
  return Option.some(source)
})
