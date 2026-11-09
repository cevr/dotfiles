// A message from one session to another, and the `message` tool that sends
// it. The receiver reads the text as a synthetic message under a header that
// names the sender and the session to answer; the transcript shows one line,
// `from <sender> · <excerpt>`. Delivered as a steer, a running receiver reads
// it at its next step; an idle one is woken to read it, unless the sender
// says not to, and then it waits for the session's next turn.
import { Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"
import type { AmbiguousTitle, NoSuchSession, SelfAddressed } from "./address.ts"
import { nameOf } from "./directory.ts"

/** A session as a letter names it. */
export interface Party {
  readonly id: string
  readonly title?: string | undefined
  /** The paired host it is on; none for this server's own. */
  readonly host?: string | undefined
}

/** A party as a header names it: `session "Title" (ses_…)`, then ` on host <host>` for a paired host's. */
const named = (party: Party): string =>
  `session ${JSON.stringify(nameOf(party))} (${party.id})${party.host === undefined ? "" : ` on host ${party.host}`}`

export const MessageInput = toolInput(Schema.Struct({
  to: Schema.String.annotate({
    description: "The session to write to: its id (ses_…), or its title (an exact title, or text only one title contains). The sessions tool lists both.",
  }),
  text: Schema.String.annotate({ description: "What to tell it. It arrives as a message from your session, not from the user." }),
  wake: Schema.optional(Schema.Boolean).annotate({
    description: "Default true: an idle session starts a turn to read it. false leaves it for that session's next turn. A running session reads it at its next step either way.",
  }),
  replyTo: Schema.optional(Schema.String).annotate({
    description: "The session the receiver should answer (an id or a title). Default: your session.",
  }),
}))
export type MessageInput = typeof MessageInput.Type

export const MESSAGE_DESCRIPTION = [
  "Send a message to another OpenCode session (find it with the sessions tool), to coordinate with it without the owner relaying. It arrives in that session as a message from you, with your session's id and title and how to answer.",
  "A running session reads it at its next step; an idle one wakes to read it (wake: false leaves it for its next turn). Answers come back the same way, as a message in your session. A session on a host paired with this one (listed `on <host>`) is reached by its id. You cannot write to your own session.",
  "Answer a message only when it asks for something, so two sessions do not reply to each other forever.",
].join("\n\n")

/** The message has no text. */
export class EmptyMessage extends Schema.TaggedError<EmptyMessage>()("EmptyMessage", {}) {}

/** Why a message was not sent, as the sender reads it. */
export type Rejection = NoSuchSession | AmbiguousTitle | SelfAddressed | EmptyMessage

/** What the receiving session is handed: the model's text, the transcript's line and the message's metadata. */
export interface Letter {
  readonly text: string
  readonly description: string
  readonly metadata: {
    readonly source: "mail"
    readonly from: { readonly sessionID: string; readonly title: string; readonly host?: string }
    readonly replyTo: { readonly sessionID: string; readonly title: string; readonly host?: string }
  }
}

const signed = (party: Party) => ({ sessionID: party.id, title: nameOf(party), ...(party.host === undefined ? {} : { host: party.host }) })

/** The text on one line, at most `max` characters, `…` where it was cut. */
export const excerpt = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}

/** How much of a transcript line's excerpt shows. */
export const LINE_EXCERPT = 80

/** How much of a message the delivery log keeps. */
export const LOG_EXCERPT = 200

/** The header the receiver reads above the text: who wrote, and how to answer. */
export const header = (from: Party, replyTo: Party): ReadonlyArray<string> => {
  const answer = `{ "to": "${replyTo.id}", "text": "…" }`
  return [
    `✉ Message from ${named(from)}, sent with the message tool. It is not the user speaking.`,
    replyTo.id === from.id
      ? `To answer, call the message tool with ${answer}; answer only if it asks for something.`
      : `Answers go to ${named(replyTo)}: call the message tool with ${answer}; answer only if it asks for something.`,
  ]
}

/** The letter `from` sends with `body`, answered at `replyTo`. */
export const compose = (from: Party, replyTo: Party, body: string): Letter => ({
  text: [...header(from, replyTo), "", body.trim()].join("\n"),
  description: `from ${nameOf(from)} · ${excerpt(body, LINE_EXCERPT)}`,
  metadata: { source: "mail", from: signed(from), replyTo: signed(replyTo) },
})

/** How the receiver gets it: at its next step (running), woken now (idle), or at its next turn (idle, not woken). */
export type Delivery = "steered" | "woke" | "queued"

export const deliveryOf = (running: boolean, wake: boolean): Delivery => (running ? "steered" : wake ? "woke" : "queued")

/** What the sender reads once it is delivered. */
export const receipt = (to: Party, delivery: Delivery): string => {
  const target = named(to)
  if (delivery === "steered") return `Delivered to ${target}. It is running and reads it at its next step.`
  if (delivery === "woke") return `Delivered to ${target}. It was idle and is now reading it.`
  return `Delivered to ${target}. It is idle and reads it at its next turn (not woken).`
}

/** What the sender reads when the message is refused. */
export const explain = (rejection: Rejection): string => {
  switch (rejection._tag) {
    case "NoSuchSession": {
      const peers = rejection.peers ?? []
      const where = peers.length === 0 ? "this server" : `this server or its paired hosts (${peers.map((peer) => peer.name).join(", ")})`
      const missed = peers.flatMap((peer) => (peer.missed === undefined ? [] : [` ${peer.name} could not be asked: ${peer.missed}.`]))
      return `No session on ${where} is ${JSON.stringify(rejection.to)}.${missed.join("")} List them with the sessions tool, and give an id (ses_…) or a title.`
    }
    case "AmbiguousTitle":
      return `More than one session matches ${JSON.stringify(rejection.to)}: ${rejection.matches
        .map((match) => `${match.id} ${JSON.stringify(match.title)}`)
        .join(", ")}. Give the id.`
    case "SelfAddressed":
      return `That is your own session (${rejection.sessionID}). Write to another one.`
    case "EmptyMessage":
      return "The message has no text."
  }
}
