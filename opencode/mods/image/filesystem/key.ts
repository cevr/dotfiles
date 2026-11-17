// The OpenAiKey contract: OPENAI_API_KEY when it is set and not empty, else
// the key this plugin keeps in its own file (`$XDG_DATA_HOME/opencode-image/
// openai.key`, mode 0600, its folder 0700). The composition root passes the
// environment's value in; nothing here reads the environment. `store` writes
// the file for the key command. The key is answered Redacted, and no message
// here holds it.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { Effect, Layer, Option, Redacted } from "effect"
import { fail } from "../outcome.ts"
import { OpenAiKey } from "../service.ts"

/** The key file under a data home (`$XDG_DATA_HOME`, else `~/.local/share`). */
export const keyFile = (dataHome: string) => `${dataHome}/opencode-image/openai.key`

export interface Options {
  /** OPENAI_API_KEY's value, when set. */
  readonly env: Option.Option<string>
  /** The key file. */
  readonly file: string
}

const MISSING = "No OpenAI API key. Set OPENAI_API_KEY or store a key with `bun cmd/image/key.ts set --stdin`."

const present = (value: string) => Option.filter(Option.some(value.trim()), (trimmed) => trimmed.length > 0)

const fromFile = (file: string) =>
  Effect.tryPromise({ try: () => readFile(file, "utf8"), catch: () => fail("AUTH_MISSING", MISSING) }).pipe(
    Effect.flatMap((text) => Effect.fromOption(present(text), () => fail("AUTH_MISSING", MISSING))),
  )

export const layer = (options: Options) =>
  Layer.succeed(
    OpenAiKey,
    OpenAiKey.of({
      read: Option.match(Option.flatMap(options.env, present), {
        onSome: (key) => Effect.succeed(key),
        onNone: () => fromFile(options.file),
      }).pipe(Effect.map(Redacted.make)),
    }),
  )

/** Keep `key` in `file`, readable by the owner alone. */
export const store = (file: string, key: Redacted.Redacted<string>) =>
  Effect.tryPromise({
    try: () =>
      mkdir(dirname(file), { recursive: true, mode: 0o700 })
        .then(() => writeFile(file, `${Redacted.value(key).trim()}\n`, { mode: 0o600 }))
        .then(() => chmod(file, 0o600)),
    catch: () => fail("WRITE_FAILED", `Cannot write the key file ${file}.`),
  })
