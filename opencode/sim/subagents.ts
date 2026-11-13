// A subagent's idle report: when an execution of a session with a parent
// ends, OpenCode tells the parent, and the report wakes it. host.ts runs this
// rule at an execution's end; host-laws.ts (`report`) holds it to real
// OpenCode.
//
// From the fork (packages/core/src/session/execution/subagent-report.ts
// `prepare`, packages/core/src/session/subagent-completion.ts `deliver`):
// - a period that ends with an answer reports `completed`, its body the last
//   assistant message's text (`Subagent completed without a text response.`
//   when it has none); a failed one reports `error`, its body the failure's
//   message; a period with no assistant message of its own (control work, a
//   compaction alone) reports nothing; an execution the server's stop
//   interrupts reports nothing;
// - the report is a synthetic steer in the parent, its text
//   `<subagent sessionID="…" state="…" description="…">\n<body>\n</subagent>`,
//   its description the child's title (`Subagent` without one), its metadata
//   `{ source: "subagent", childID, agent, state }` (the agent `subagent`
//   when the child has none: a plugin's `session.create` sets none);
// - the body lists the child's background shells still running
//   (`formatBody`), and a completed period's state then reads `running`;
// - it is admitted under a fresh message id and wakes the parent; a parent
//   that is gone gets nothing.
//
// Not modelled: the fork's outbox, which redelivers a report a stopped server
// recorded but did not admit (packages/core/src/session/execution/restart.ts).
import { Option } from "effect"
import type { JsonObject } from "./runtime.ts"

/** The body of a completed period with no text. */
export const NO_TEXT = "Subagent completed without a text response."
/** The body of a failed period whose error the world did not keep. */
export const FAILED = "Subagent failed"

/** How a child's period ended, as far as its report reads it: its status and body, or nothing to report. */
export type Ended = Option.Option<{ readonly status: "completed" | "error"; readonly body: string }>

/** The report a parent is sent, as an inbox item's parts. */
export interface Report {
  readonly text: string
  readonly description: string
  readonly metadata: JsonObject
}

/** A period's messages, as far as its report reads them. */
type Said = { readonly type: "assistant"; readonly text: string } | { readonly type: "error"; readonly message: string } | { readonly type: string }

const isAssistant = (message: Said): message is Extract<Said, { readonly type: "assistant" }> => message.type === "assistant"
const isError = (message: Said): message is Extract<Said, { readonly type: "error" }> => message.type === "error"

/** How a period ended, from the messages it added: failed with its error's message, answered with its last assistant's text, or control work alone. */
export const periodOf = (messages: ReadonlyArray<Said>, failed: boolean): Ended => {
  if (failed)
    return Option.some({
      status: "error",
      body: Option.getOrElse(
        Option.map(Option.fromNullishOr(messages.findLast(isError)), (error) => error.message),
        () => FAILED,
      ),
    })
  return Option.map(Option.fromNullishOr(messages.findLast(isAssistant)), (assistant) => ({
    status: "completed" as const,
    body: Option.getOrElse(
      Option.liftPredicate(assistant.text, (text) => text.length > 0),
      () => NO_TEXT,
    ),
  }))
}

/** A one-line form of a command, as the fork's `formatBody` cleans it. */
const clean = (value: string) => value.replace(/\s+/g, " ").trim()

/** The body with the background still running listed under it, and the state the report's tag reads. */
const withRunning = (status: "completed" | "error", body: string, shells: ReadonlyArray<{ readonly id: string; readonly command: string }>) => {
  if (shells.length === 0) return { body, state: status }
  const lines = shells.map((shell) => `- shell (${shell.id}): ${clean(shell.command)}`).join("\n")
  const state = Option.getOrElse(
    Option.map(
      Option.liftPredicate(status, (value) => value === "completed"),
      () => "running",
    ),
    () => status,
  )
  return { body: `${body}\n\nBackground work still running:\n${lines}`, state }
}

/**
 * The report of a child's period, or none for a period with nothing to report. The child's description is the one
 * its subagent call gave (its title, `Subagent` without one) and its agent the one it runs as (`subagent` when it was
 * created with none).
 */
export const reportOf = (
  child: { readonly id: string; readonly description: string; readonly agent: string },
  ended: Ended,
  shells: ReadonlyArray<{ readonly id: string; readonly command: string }>,
): Option.Option<Report> =>
  Option.map(ended, ({ status, body }) => {
    const shown = withRunning(status, body, shells)
    return {
      text: `<subagent sessionID="${child.id}" state="${shown.state}" description="${child.description}">\n${shown.body}\n</subagent>`,
      description: child.description,
      metadata: { source: "subagent", childID: child.id, agent: child.agent, state: status },
    }
  })
