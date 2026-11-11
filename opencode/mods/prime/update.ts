// The update notice. An install builds a new OpenCode and restarts the
// service onto it, while a TUI already open keeps the build it started with:
// it then runs an older build than its service, the newest installed one.
// The notice says so, in a corner (the dock's model line, the home footer),
// until the TUI is restarted; it never shows while the two builds match.
// Beside it, how far upstream OpenCode has moved past the installed build,
// as `bun run daily` last counted it, and whether its merge is blocked.
import { Option, Schema } from "effect"

/** What the notice says: an update waits, and restarting the TUI loads it. */
export const UPDATE_LEAD = "update available"
export const UPDATE_REST = " · restart to update"

/**
 * Whether the TUI on build `own` runs an older build than its service on
 * `served`: the service's build differs. A service not read yet (`undefined`)
 * or one that does not know its version (`"unknown"`, as `/api/info` answers
 * then) shows nothing.
 */
export function updateAvailable(own: string, served: string | undefined) {
  return served !== undefined && served !== "unknown" && served !== own
}

/**
 * Upstream OpenCode against the installed build, as `bun run daily` wrote it
 * (`~/.local/state/opencode-daily/upstream.json`, scripts/upstream.ts
 * `upstreamReading`): the commits of `upstream/dev` the build does not carry,
 * and whether the last merge of them stopped (a conflict, a red check, or a
 * merge that could not land).
 */
export const UpstreamReading = Schema.Struct({
  commits: Schema.Int,
  blocked: Schema.Boolean,
  upstream: Schema.String,
  build: Schema.String,
  at: Schema.String,
})
export type UpstreamReading = typeof UpstreamReading.Type

/** Where daily writes the reading under `home`, and the TUI reads it. */
export const upstreamFile = (home: string) => `${home}/.local/state/opencode-daily/upstream.json`

const decodeReading = Schema.decodeUnknownOption(Schema.fromJsonString(UpstreamReading))

/** The reading in a file's text; nothing for text that is not one. */
export function parseUpstream(text: string): UpstreamReading | undefined {
  return Option.getOrUndefined(decodeReading(text))
}

/**
 * The upstream part of the notice: `upstream +12`, and ` · merge blocked`
 * while the merge is stopped. Nothing while the build carries every
 * upstream commit, or with no reading.
 */
export function upstreamNotice(reading: UpstreamReading | undefined): { readonly lead: string; readonly rest: string } | undefined {
  if (reading === undefined || reading.commits <= 0) return undefined
  return { lead: `upstream +${reading.commits}`, rest: reading.blocked ? " · merge blocked" : "" }
}
