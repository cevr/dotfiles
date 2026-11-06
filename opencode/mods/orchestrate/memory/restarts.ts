// Restarts held in memory: OpenCode's restarts (opencode/restarts.ts) over a
// record of sessions and their messages. A resume prompts the child as the
// subagent tool does (a user message), or fails with `fail`; a notice lands
// in `told`.
import { Effect } from "effect"
import * as OpenCodeRestarts from "../opencode/restarts.ts"
import type { ResumeStart } from "../service.ts"

export interface MemorySession extends OpenCodeRestarts.SessionView {
  readonly messages: Array<OpenCodeRestarts.MessageView>
}

export interface MemoryRestarts {
  readonly location: OpenCodeRestarts.Place
  readonly sessions: Record<string, MemorySession>
  /** A resume fails with this; absent, it prompts the child. */
  fail?: string
  /** A notice is refused with this. */
  refuseNotice?: string
  readonly resumed: Array<ResumeStart>
  readonly told: Array<OpenCodeRestarts.Synthetic>
  /** The clock a resume's prompt is stamped with. */
  readonly now: () => number
}

export const empty = (location: OpenCodeRestarts.Place = { directory: "/work" }): MemoryRestarts => ({
  location,
  sessions: {},
  resumed: [],
  told: [],
  now: () => Date.now(),
})

const missing = (sessionID: string) => Effect.fail(`no session ${sessionID}`)

/** The restarts over `memory`; `tool`, when given, is the subagent tool a resume runs, as the plugin hands it in. */
export const layer = (memory: MemoryRestarts, tool?: OpenCodeRestarts.Host["run"]) =>
  OpenCodeRestarts.layer({
    location: memory.location,
    list: Effect.sync(() => Object.values(memory.sessions).toSorted((a, b) => b.updated - a.updated)),
    get: (sessionID) => {
      const session = memory.sessions[sessionID]
      return session === undefined ? missing(sessionID) : Effect.succeed(session)
    },
    context: (sessionID) => {
      const session = memory.sessions[sessionID]
      return session === undefined ? missing(sessionID) : Effect.succeed([...session.messages])
    },
    run: (start) =>
      Effect.suspend(() => {
        if (memory.fail !== undefined) return Effect.fail(new Error(memory.fail))
        const child = memory.sessions[start.child]
        if (child === undefined) return missing(start.child)
        return (tool === undefined ? Effect.void : tool(start)).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              memory.resumed.push(start)
              child.messages.push({ type: "user", created: memory.now(), text: start.prompt })
            }),
          ),
        )
      }),
    synthetic: (input) =>
      memory.refuseNotice === undefined
        ? Effect.sync(() => {
            memory.told.push(input)
            memory.sessions[input.sessionID]?.messages.push({ type: "synthetic", created: memory.now(), metadata: input.metadata })
          })
        : Effect.fail(new Error(memory.refuseNotice)),
  })
