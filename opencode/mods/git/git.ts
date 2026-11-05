// The git mod's own RPC, which its TUI reads: the session's checkout, the
// branch's pull request, and how to review one changed file. Each method asks
// about one session; the server runs git and gh in that session's directory
// (its location, which can move), so the TUI runs no program to read them.
// The definition is the wire contract, kept byte for byte; the schemas below
// are the questions and the answers.
import { Schema } from "effect"
import { Checkout } from "./checkout.ts"
import { PullRequest } from "./pull-request.ts"

const SESSION = { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] } as const

export const GIT = {
  id: "dotfiles-opencode.git",
  methods: {
    checkout: { input: SESSION, output: { type: "object" } },
    pullRequest: { input: SESSION, output: { type: "object" } },
    review: {
      input: { type: "object", properties: { sessionID: { type: "string" }, path: { type: "string" } }, required: ["sessionID", "path"] },
      output: { type: "object" },
    },
  },
  events: {},
} as const

/** A question about one session. */
export const SessionQuery = Schema.Struct({ sessionID: Schema.String })
export type SessionQuery = typeof SessionQuery.Type

/** A question about one changed file of a session's checkout, by its path from the checkout's top. */
export const ReviewQuery = Schema.Struct({ sessionID: Schema.String, path: Schema.String })
export type ReviewQuery = typeof ReviewQuery.Type

/**
 * The checkout method's answer: the checkout, nothing when the session's
 * directory is in no checkout, or why it could not be read.
 */
export const CheckoutAnswer = Schema.Struct({
  checkout: Schema.optionalKey(Checkout),
  error: Schema.optionalKey(Schema.String),
})
export type CheckoutAnswer = typeof CheckoutAnswer.Type

/**
 * The pullRequest method's answer: the branch's request, or nothing (no `gh`,
 * no GitHub remote, no request, a detached head). `note` says why a `gh` that
 * is there could not answer, such as being signed out.
 */
export const PullRequestAnswer = Schema.Struct({
  pullRequest: Schema.optionalKey(PullRequest),
  note: Schema.optionalKey(Schema.String),
})
export type PullRequestAnswer = typeof PullRequestAnswer.Type

/** A program to hand the terminal to: what to run, and where. */
export const Command = Schema.Struct({
  /** `hunk`, or `pager` when git pages the diff because hunk is not on PATH. */
  program: Schema.Literals(["hunk", "pager"]),
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
})
export type Command = typeof Command.Type

/** The review method's answer: the command that reviews the file, and a note for the reader (hunk missing, the file no longer changed). */
export const ReviewAnswer = Schema.Struct({
  command: Schema.optionalKey(Command),
  note: Schema.optionalKey(Schema.String),
})
export type ReviewAnswer = typeof ReviewAnswer.Type
