// The pairing state in a file the owner alone can read (0600, in a 0700
// directory): `$XDG_STATE_HOME/opencode-mail/pairs.json`, else
// `~/.local/state/opencode-mail/pairs.json`. The server's listener and the
// pair command (cmd/mail/pair.ts) share it. A missing or unreadable file
// reads as no pairing; a write goes to a file beside it, renamed over it.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer, Option, Schema } from "effect"
import { EMPTY, Pairs } from "../pairing.ts"
import { PairStore, PairsUnwritable } from "../service.ts"

/** Where the pairing state lives for an environment. */
export const fileOf = (env: Readonly<Record<string, string | undefined>>): string =>
  join(env.XDG_STATE_HOME || join(env.HOME ?? "", ".local", "state"), "opencode-mail", "pairs.json")

const decode = Schema.decodeUnknownOption(Schema.fromJsonString(Pairs))

const read = (file: string): Pairs => {
  try {
    return Option.getOrElse(decode(readFileSync(file, "utf8")), () => EMPTY)
  } catch {
    return EMPTY
  }
}

export const layer = (file: string) =>
  Layer.succeed(
    PairStore,
    PairStore.of({
      read: Effect.sync(() => read(file)),
      update: (change) =>
        Effect.try({
          try: () => {
            const [result, next] = change(read(file))
            mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
            const staged = `${file}.${process.pid}.tmp`
            writeFileSync(staged, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
            chmodSync(staged, 0o600)
            renameSync(staged, file)
            return result
          },
          catch: (cause) => new PairsUnwritable({ message: cause instanceof Error ? cause.message : String(cause) }),
        }),
    }),
  )
