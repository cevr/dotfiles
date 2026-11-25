// Antigravity's quota source as the pool runs it on a host: the profile's
// files through the host's file system, the macOS keychain through the system
// `security` tool (no native dependency: the binding T3 Code loads,
// @napi-rs/keyring, is a native module the plugin would have to ship), the
// state file beside the pool's other state, and Google over fetch with no
// redirect followed. A host other than macOS has no keychain this reads: a
// Linux workbox reads its sign-in from the profile's files, else "sign-in not
// readable here".
import { readableStreamToText, spawn } from "bun"
import { Context, Effect, FileSystem, Layer, Match, Option, Path, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { type AuthMethod, GOOGLE, userAgent } from "./reader.ts"
import { KeychainRead, type KeychainMode, type Places } from "./signin.ts"
import { make, type Store } from "./source.ts"
import { State } from "./state.ts"

/** How long the keychain read may take: long enough for the owner to answer macOS's dialog once. */
export const KEYCHAIN_TIMEOUT_MS = 60_000

/** The CLI's profile under `home`. */
export const defaultProfile = (home: string) => `${home}/.gemini/antigravity-cli`

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

/**
 * One read of the CLI's keychain entry on macOS (`security
 * find-generic-password -s gemini -a antigravity -w`), killed past its
 * deadline. What it prints is the secret: it goes into a Redacted at once and
 * nowhere else; what it says on stderr is not read.
 */
export const macKeychain: Effect.Effect<KeychainRead> = Effect.try({
  try: () =>
    spawn(["/usr/bin/security", "find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }),
  catch: () => KeychainRead.cases.Failed.make({}),
}).pipe(
  Effect.flatMap((child) =>
    Effect.all({ code: Effect.promise(() => child.exited), out: Effect.promise(() => readableStreamToText(child.stdout)) }, { concurrency: 2 }).pipe(
      Effect.map(({ code, out }) => keychainOf(code, out)),
      Effect.onInterrupt(() => Effect.sync(() => child.kill())),
      Effect.timeoutOrElse({ duration: KEYCHAIN_TIMEOUT_MS, orElse: () => Effect.succeed(KeychainRead.cases.TimedOut.make({})) }),
    ),
  ),
  Effect.catch((failure) => Effect.succeed(failure)),
)

/** A host whose keychain this does not read. */
export const noKeychain: Effect.Effect<KeychainRead> = Effect.succeed(KeychainRead.cases.Unsupported.make({}))

/** The keychain read for the platform `platform` (`process.platform`'s value). */
export const keychainFor = (platform: string): Effect.Effect<KeychainRead> =>
  Match.value(platform).pipe(
    Match.when("darwin", () => macKeychain),
    Match.orElse(() => noKeychain),
  )

/** This host as Antigravity's user agent names it: `darwin` where the macOS `security` tool is, else `linux`; and `uname -m`. */
export const hostKind = Effect.fn("Antigravity.hostKind")(function* () {
  const fs = yield* FileSystem.FileSystem
  const mac = yield* Effect.orElseSucceed(fs.exists("/usr/bin/security"), () => false)
  const machine = yield* Effect.try({
    try: () => spawn(["uname", "-m"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" }),
    catch: () => "unknown",
  }).pipe(
    Effect.flatMap((child) => Effect.promise(() => readableStreamToText(child.stdout))),
    Effect.map((text) => Option.getOrElse(Option.liftPredicate(text.trim(), (name) => name !== ""), () => "unknown")),
    Effect.timeoutOrElse({ duration: 2_000, orElse: () => Effect.succeed("unknown") }),
    Effect.orElseSucceed(() => "unknown"),
  )
  const arch = Match.value(machine).pipe(
    Match.when("x86_64", () => "x64"),
    Match.when("aarch64", () => "arm64"),
    Match.orElse((name) => name),
  )
  return Match.value(mac).pipe(
    Match.when(true, () => ({ platform: "darwin", arch })),
    Match.orElse(() => ({ platform: "linux", arch })),
  )
})

/** The profile's files through the host's file system; a file that is not there, or cannot be read, is none. */
export const places = Effect.fn("Antigravity.places")(function* (keychain: Effect.Effect<KeychainRead>) {
  const fs = yield* FileSystem.FileSystem
  const read = (path: string) =>
    fs.exists(path).pipe(
      Effect.flatMap((there) => Match.value(there).pipe(Match.when(true, () => Effect.map(fs.readFileString(path), Option.some)), Match.orElse(() => Effect.succeed(Option.none<string>())))),
      Effect.orElseSucceed(() => Option.none<string>()),
    )
  return { read, keychain } satisfies Places
})

const StateFile = Schema.fromJsonString(State)
const decodeState = Schema.decodeUnknownOption(StateFile)
const encodeState = Schema.encodeEffect(StateFile)

/** The state kept in `file`, written whole through a temporary file; one that does not read is a fresh start. */
export const fileStore = Effect.fn("Antigravity.fileStore")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const load = fs.exists(file).pipe(
    Effect.flatMap((there) => Match.value(there).pipe(Match.when(true, () => Effect.map(fs.readFileString(file), decodeState)), Match.orElse(() => Effect.succeed(Option.none<State>())))),
    Effect.orElseSucceed(() => Option.none<State>()),
  )
  const save = (state: State) =>
    Effect.gen(function* () {
      const text = yield* encodeState(state)
      const temporary = `${file}.tmp`
      yield* fs.makeDirectory(path.dirname(file), { recursive: true })
      yield* fs.writeFileString(temporary, text, { mode: 0o600 })
      yield* fs.rename(temporary, file)
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("antigravity: the state file could not be written", cause)))
  return { load, save } satisfies Store
})

/** Where a host's source reads and keeps its state. */
export interface LiveConfig {
  readonly profile: string
  readonly stateFile: string
  readonly auth: AuthMethod
  readonly keychain: KeychainMode
}

/** The source as a host runs it: its files, its keychain, its state file and Google over fetch, in `scope`. */
export const liveSource = Effect.fn("Antigravity.liveSource")(function* (config: LiveConfig) {
  const http = yield* Layer.build(FetchHttpClient.layer)
  const host = yield* hostKind()
  return yield* make({
    profile: config.profile,
    places: yield* places(keychainFor(host.platform)),
    store: yield* fileStore(config.stateFile),
    auth: config.auth,
    keychain: config.keychain,
    endpoints: GOOGLE,
    agent: userAgent(host.platform, host.arch),
  }).pipe(Effect.provideService(HttpClient.HttpClient, Context.get(http, HttpClient.HttpClient)))
})

