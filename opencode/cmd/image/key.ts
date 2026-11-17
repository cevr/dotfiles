/**
 * The paid API's key command: `bun key.ts set --stdin` keeps the key piped in
 * as the plugin's key file (`$XDG_DATA_HOME/opencode-image/openai.key`, mode
 * 0600); `bun key.ts status` says whether a key is there. The key is never
 * printed, and is never taken as an argument, so it stays out of the shell's
 * history and the process list.
 */
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import { Effect, Option, Redacted } from "effect"
import * as FileKey from "@dotfiles/opencode-image/filesystem/key"
import { OpenAiKey } from "@dotfiles/opencode-image/service"

const USAGE = "usage: <key on stdin> | bun key.ts set --stdin\n       bun key.ts status"

/** Keeps `text`, trimmed, as the key in `file`; an empty one is refused. */
export const set = (file: string, text: string) =>
  Effect.gen(function* () {
    const key = text.trim()
    if (key.length === 0) return { ok: false, text: "No key on stdin: pipe it in, e.g. `pbpaste | bun key.ts set --stdin`." }
    yield* FileKey.store(file, Redacted.make(key))
    return { ok: true, text: `Stored the OpenAI key in ${file} (mode 0600).` }
  }).pipe(Effect.catch((failure) => Effect.succeed({ ok: false, text: failure.message })))

/** Whether `file` holds a key, without reading it out. */
export const status = (file: string) =>
  OpenAiKey.use((key) => key.read).pipe(
    Effect.provide(FileKey.layer({ env: Option.none(), file })),
    Effect.map(() => ({ ok: true, text: `A key is stored in ${file}.` })),
    Effect.catch(() => Effect.succeed({ ok: false, text: `No key in ${file}.` })),
  )

if (import.meta.main) {
  const args = process.argv.slice(2)
  const file = FileKey.keyFile(TuiDirs.dirs().data)
  const command = args[0]
  if (command === "set" && args.includes("--stdin")) {
    const outcome = await Effect.runPromise(set(file, await Bun.stdin.text()))
    console.log(outcome.text)
    process.exit(Number(!outcome.ok))
  }
  if (command === "status") {
    const outcome = await Effect.runPromise(status(file))
    console.log(outcome.text)
    process.exit(Number(!outcome.ok))
  }
  console.error(USAGE)
  process.exit(2)
}
