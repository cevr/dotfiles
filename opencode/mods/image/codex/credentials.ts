// The subscription's credentials: the token and account Codex's own login
// keeps in `~/.codex/auth.json` (`codex login`), and the CLI version from
// `~/.codex/version.json` the backend expects in its headers. Read on each
// request, never refreshed or written here. The token lives only in the
// returned value, wrapped in Redacted; no message names it.
import { readFile } from "node:fs/promises"
import { Effect, Option, Redacted, Schema } from "effect"
import { fail } from "../outcome.ts"

/** The version sent when Codex has not recorded one. */
export const FALLBACK_VERSION = "0.142.3"

export interface Credentials {
  readonly token: Redacted.Redacted<string>
  readonly account: string
  readonly version: string
}

const AuthFile = Schema.fromJsonString(
  Schema.Struct({ tokens: Schema.Struct({ access_token: Schema.String, account_id: Schema.String }) }),
)
const VersionFile = Schema.fromJsonString(Schema.Struct({ latest_version: Schema.optionalKey(Schema.NullOr(Schema.String)) }))

const decodeAuth = Schema.decodeUnknownOption(AuthFile)
const decodeVersion = Schema.decodeUnknownOption(VersionFile)

/** A file's text, or none when it cannot be read; `missing` says whether it was absent. */
const text = (path: string) =>
  Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: (cause) => Schema.is(Schema.Struct({ code: Schema.Literal("ENOENT") }))(cause) })

const versionIn = (home: string) =>
  text(`${home}/.codex/version.json`).pipe(
    Effect.map((found) =>
      Option.getOrElse(
        Option.flatMap(decodeVersion(found), (file) => Option.fromNullishOr(file.latest_version)),
        () => FALLBACK_VERSION,
      ),
    ),
    Effect.orElseSucceed(() => FALLBACK_VERSION),
  )

/** The credentials under `home`, or AUTH_MISSING naming the file and `codex login`. */
export const read = Effect.fn("Credentials.read")(function* (home: string) {
  const path = `${home}/.codex/auth.json`
  const found = yield* text(path).pipe(
    Effect.mapError((missing) => {
      if (missing) return fail("AUTH_MISSING", `No codex credentials at ${path}. Run \`codex login\` first.`)
      return fail("AUTH_MISSING", `Cannot read ${path}. Run \`codex login\` to refresh credentials.`)
    }),
  )
  const auth = yield* Option.match(decodeAuth(found), {
    onNone: () => Effect.fail(fail("AUTH_MISSING", `Malformed codex credentials at ${path}. Run \`codex login\` again.`)),
    onSome: Effect.succeed,
  })
  const version = yield* versionIn(home)
  return { token: Redacted.make(auth.tokens.access_token), account: auth.tokens.account_id, version } satisfies Credentials
})
