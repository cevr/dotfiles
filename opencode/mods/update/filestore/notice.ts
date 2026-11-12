import { UpstreamReading } from "@dotfiles/opencode-prime/update"
import { Clock, Effect, Layer, Option, Schema } from "effect"
import { iso } from "../gate.ts"
import { Notice } from "../service.ts"
import { readText, writeText } from "./files.ts"

const ReadingJson = Schema.fromJsonString(UpstreamReading, { space: 2 })
const decode = Schema.decodeUnknownOption(ReadingJson)
const encode = Schema.encodeSync(ReadingJson)

/** The reading with the failure set (`Option.some`) or cleared; a host with no reading gets one that counts nothing. */
export const withFailure = (reading: Option.Option<UpstreamReading>, failed: Option.Option<string>, at: string): UpstreamReading => {
  const base: UpstreamReading = Option.getOrElse(reading, () => ({ commits: 0, blocked: false, upstream: "", build: "", at }))
  const { failed: _gone, ...rest } = base
  return Option.match(failed, { onNone: () => rest, onSome: (text) => ({ ...rest, failed: text }) })
}

/**
 * The notice in the reading Prime's TUI corner already draws (`@dotfiles/opencode-prime/update`,
 * daily's `upstream.json`): read on each TUI start and reconnect, so a restart shows it, and no
 * server plugin is needed to show it.
 */
export const layer = (path: string) => {
  const set = (failed: Option.Option<string>) =>
    Effect.gen(function* () {
      const reading = Option.flatMap(yield* readText(path), decode)
      if (Option.isNone(failed) && !Option.exists(reading, (each) => Option.isSome(Option.fromNullishOr(each.failed)))) return
      const at = iso(yield* Clock.currentTimeMillis)
      yield* writeText("write the update notice", path, `${encode(withFailure(reading, failed, at))}\n`)
    }).pipe(Effect.orElseSucceed(() => "unwritten"), Effect.asVoid)
  return Layer.succeed(Notice, Notice.of({ show: (text) => set(Option.some(text)), clear: set(Option.none()) }))
}
