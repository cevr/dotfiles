// The orchestrate plugin's digest writer: each fact of a run as one line, handed to the digest through `log` (the relay
// to the digest plugin's RPC), stamped with the clock now. Each call returns at once and never fails, so a fact the
// digest misses changes nothing the tool or the hook answers. The facts themselves are mods/orchestrate/digest.ts's.
import { Clock, Effect, Option, Schema } from "effect"
import type { DigestEvent, DigestLog } from "@dotfiles/opencode-digest/event"
import * as Facts from "@dotfiles/opencode-orchestrate/digest"
import { hostName, readText } from "@dotfiles/opencode-orchestrate/filestore/digest-reads"
import type { Lane } from "@dotfiles/opencode-orchestrate/tools"

/** An inbox item that is the work plugin's land notice: synthetic, its metadata `{ rift: "land" }`. */
const LandNotice = Schema.Struct({ type: Schema.Literal("synthetic"), payload: Schema.Struct({ text: Schema.String, metadata: Schema.Struct({ rift: Schema.Literal("land") }) }) })
const decodeLandNotice = Schema.decodeUnknownOption(LandNotice)

/** A land notice's text, when the inbox item is one. */
export const landNoticeOf = (item: { readonly type: string }): Option.Option<string> => Option.map(decodeLandNotice(item), (notice) => notice.payload.text)

/** The repository a checkout is: its folder's name. */
const repoOf = (checkout: string): string => Option.getOrElse(Option.fromUndefinedOr(checkout.replace(/\/+$/, "").split("/").at(-1)), () => checkout)

/** The writer over `log`, for the plugin's location `checkout`. */
export const make = (log: DigestLog["Service"], checkout: string) => {
  const host = hostName()
  const repo = repoOf(checkout)
  /** The hand-backs written, by session and words. */
  const seen = new Set<string>()
  const append = (events: Iterable<DigestEvent>) => Effect.forEach(events, log.append, { discard: true })
  const at = (build: (t: number) => Iterable<DigestEvent>) => Effect.flatMap(Clock.currentTimeMillis, (t) => append(build(t))).pipe(Effect.ignoreCause)
  return {
    /** A unit's lane, answered or made, and the run's record; `runDir` when the unit's folder is known. */
    lane: (root: string, unit: string, lane: Lane, runDir: Option.Option<string>) => at((t) => Facts.laneFacts(root, unit, lane, { host, repo, runDir }, t)),
    /**
     * A step `root` started at `t`, written once the host ran its call (the hook's `execute.after`), so a call the host
     * refused writes none; `child` its session when known.
     */
    started: (root: string, child: Option.Option<string>, agent: string, description: string, t: number) =>
      append(Option.toArray(Facts.startFact(root, Option.getOrElse(child, () => ""), agent, description, t))).pipe(Effect.ignoreCause),
    /**
     * A step's last words, read as its hand-back; a verifier's findings file is read for its rows. A session idle
     * again with the same words wrote its line already, so it writes none.
     */
    handedBack: (root: string, session: string, agent: string, words: string) =>
      Effect.suspend(() => {
        const key = `${session}\n${words.slice(0, 400)}`
        if (seen.has(key)) return Effect.void
        seen.add(key)
        return Option.match(Facts.findingsPathOf(agent, words), { onNone: () => Effect.succeed(Option.none<string>()), onSome: readText }).pipe(
          Effect.flatMap((findings) => at((t) => Option.toArray(Facts.handBackFact(root, session, agent, words, findings, t)))),
        )
      }),
    /** A land that pushed `pushed`. */
    landed: (root: string, units: ReadonlyArray<string>, pushed: string) => at((t) => [Facts.landFact(root, units, pushed, t)]),
    /** A land notice the work plugin left in `root`'s inbox. */
    notice: (root: string, text: string) => at((t) => Option.toArray(Facts.checkFact(root, text, t))),
  }
}

export type Writer = ReturnType<typeof make>
