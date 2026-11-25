// The `antigravity` tool: the orchestrator reads Antigravity's quota, records
// a limit an agy pane printed, asks whether a group is open and when it will
// be, and, when the owner asks, reads now with the keychain allowed. Every
// answer is words; none carries a token.
import { Effect, Match, Option, Schema } from "effect"
import { formatNotificationTime } from "@dotfiles/decider/notification-time"
import { toolInput } from "@dotfiles/decider/tool-input"
import type { Source } from "./source.ts"
import { openText } from "./text.ts"

export const AntigravityToolInput = toolInput(
  Schema.Struct({
    action: Schema.Literals(["status", "open", "limit", "clear", "read"]).annotate({
      description:
        "status: the windows as last read; open: is each group open now, else when; limit: record a limit a pane printed (text); clear: a pane on the group ran a turn since its limit (forget the limit); read: read now with the keychain allowed, only when the owner asked (macOS may show its keychain dialog once)",
    }),
    text: Schema.optionalKey(Schema.String).annotate({ description: "For limit: the pane's text, e.g. \"Individual quota reached. … Resets in 1h8m38s.\"" }),
    group: Schema.optionalKey(Schema.String).annotate({ description: "A quota group (gemini, claude-gpt, or its label): open answers only it; limit records it on only it. Default every group." }),
  }),
)
export type AntigravityToolInput = typeof AntigravityToolInput.Type

export const ANTIGRAVITY_DESCRIPTION = [
  "Antigravity's (agy's) quota on this host, as the pool reads it from Google at most every 5 minutes: each quota group (Gemini; the shared Claude & GPT quota) with its 5-hour and weekly windows' use and reset, or why it is unknown.",
  "Before starting agy panes, ask `open`: a group answers open (measured: a reading with room), limited until a time, limited with its reset unknown, usable but unmeasured (no reading and no limit seen), or unknown with why (an unknown window is never open). When an agy pane prints a quota limit (\"Individual quota reached … Resets in 1h8m38s.\"), record it with `limit`, its text and the pane's group (no group: every group): the group then reads limited until that reset. Once a pane on a group with a limit of unknown reset runs a turn again, call `clear` for that group.",
  "`read` reads now and allows the keychain: call it only when the owner asked, since macOS may show its keychain dialog once; a refusal is kept and not retried until `read` is called again.",
].join("\n\n")

const OFF = "Antigravity's quota is not read on this host: the pool's antigravity option is off."

/** The tool's answer to `input` from `source`, none when this host does not read Antigravity. */
export const answer = Effect.fn("Antigravity.tool")(function* (source: Option.Option<Source>, input: AntigravityToolInput) {
  if (Option.isNone(source)) return OFF
  const agy = source.value
  const group = Option.fromUndefinedOr(input.group)
  return yield* Match.value(input.action).pipe(
    Match.when("status", () => Effect.map(agy.lines, (lines) => lines.join("\n"))),
    Match.when("open", () =>
      Effect.map(agy.open(group), (answers) =>
        Match.value(answers.length).pipe(
          Match.when(0, () => `No quota group ${Option.getOrElse(group, () => "")} in the last reading.`),
          Match.orElse(() => answers.map((entry) => `${entry.label}: ${openText(entry.answer)}`).join("\n")),
        ),
      ),
    ),
    Match.when("limit", () =>
      Effect.map(agy.record(Option.getOrElse(Option.fromUndefinedOr(input.text), () => ""), group), (limit) =>
        Option.match(limit, {
          onNone: () => "That text is no Antigravity quota limit: nothing recorded.",
          onSome: (seen) =>
            Option.match(seen.resetAt, {
              onNone: () => "Recorded a limit with no reset time: the group reads limited, reset unknown, until a reading shows room or clear is called.",
              onSome: (at) => `Recorded: limited until ${formatNotificationTime(at)}.`,
            }),
        }),
      ),
    ),
    Match.when("clear", () =>
      Effect.as(agy.clear(group), `Cleared the pane limit on ${Option.getOrElse(group, () => "every group")}.`),
    ),
    Match.orElse(() =>
      Effect.gen(function* () {
        yield* agy.retry
        yield* agy.refresh
        return (yield* agy.lines).join("\n")
      }),
    ),
  )
})
