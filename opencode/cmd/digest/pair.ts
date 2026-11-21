/**
 * `digest pair`: a one-use code that pairs one browser with the digest page, so it may answer there.
 *
 *   bun cmd/digest/pair.ts [--dir <digest dir>] [--port <port>]
 *
 * It prints the page's link with the code in it (`http://127.0.0.1:8240/#pair=<code>`) and the code alone, to type
 * on the page instead. The code is good once, for five minutes; only its hash is kept, in the pairing file beside
 * the log (`--dir`, default `$XDG_STATE_HOME/opencode-digest`, the digest plugin's). Run it again for another
 * browser; deleting `pairing.json` unpairs every browser.
 */
import { parseArgs } from "node:util"
import { Clock, Console, Effect, Option, Schema } from "effect"
import * as TuiDirs from "@dotfiles/decider/tui-dirs"
import * as FilePairing from "@dotfiles/opencode-digest/filestore/pairing"
import { HOSTNAME, PORT } from "@dotfiles/opencode-digest/http/listener"
import { CODE_TTL_MS, showCode } from "@dotfiles/opencode-digest/pairing"

/** What one pairing writes to, and the page it links to. */
export interface Target {
  readonly dir: string
  readonly port: number
}

/** The target the arguments name; none for a port that is not one. */
export const targetOf = (args: ReadonlyArray<string>): Option.Option<Target> => {
  const { values } = parseArgs({ args: [...args], options: { dir: { type: "string" }, port: { type: "string" } }, strict: true })
  const port = Option.getOrElse(Option.map(Option.fromUndefinedOr(values.port), Number), () => PORT)
  return Option.map(
    Option.liftPredicate(port, (each) => Number.isInteger(each) && each > 0 && each < 65_536),
    (valid) => ({ dir: Option.getOrElse(Option.fromUndefinedOr(values.dir), () => `${TuiDirs.dirs().state}/opencode-digest`), port: valid }),
  )
}

/** What the owner reads: the link to open, and the code to type instead. */
export const said = (code: string, port: number): string =>
  [
    `Open this in the browser to pair it (good once, for ${CODE_TTL_MS / 60_000} minutes):`,
    `  http://${HOSTNAME}:${port}/#pair=${code}`,
    `or type the code on the page: ${showCode(code)}`,
  ].join("\n")

/** Arguments that name no target. */
class Usage extends Schema.TaggedError<Usage>()("Usage", { message: Schema.String }) {}

/** A new code in the target's pairing file, said; the exit code, 0 once written. */
export const main = (args: ReadonlyArray<string>, print: (text: string) => Effect.Effect<void>) =>
  Effect.try({ try: () => targetOf(args), catch: (cause) => new Usage({ message: String(cause) }) }).pipe(
    Effect.flatMap((target) => Effect.mapError(Effect.fromOption(target), () => new Usage({ message: "usage: bun cmd/digest/pair.ts [--dir <digest dir>] [--port <port>]" }))),
    Effect.flatMap((target) => Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.map(FilePairing.make(target.dir).issue(now), (code) => said(code, target.port)))),
    Effect.flatMap((text) => Effect.as(print(text), 0)),
    Effect.catch((error) => Effect.as(Effect.logError(`digest pair: ${error.message}`), 1)),
  )

if (import.meta.main) Effect.runFork(Effect.tap(main(Bun.argv.slice(2), Console.log), (code) => Effect.sync(() => void (process.exitCode = code))))
