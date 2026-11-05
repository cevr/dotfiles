// ForkReadings over the TUI plugin's client and session data (packages/plugin/
// src/tui/context.ts): the fork's messages from the server's message list
// (`client.message.list`, newest first, a page at a time, until a page reaches
// the history the fork copied), and `data.session.status`, "running" while the
// fork answers.
//
// Not the TUI's own message cache (`data.session.message.list`): the TUI keeps
// messages only for the sessions it retains (the one on screen, open tabs and
// the few viewed last, packages/client/src/solid/retention.ts) and evicts
// every other session's, a fork included, whenever its session list changes.
// The status survives eviction. A list that fails reads as no messages.
import { Effect, Layer } from "effect"
import { ForkReadings } from "../service.ts"
import { forkTurns } from "../turns.ts"

/** One page of a session's messages, newest first, and the cursor to the next older page. */
export interface Page {
  readonly data: ReadonlyArray<unknown>
  readonly cursor: { readonly next?: string | null | undefined }
}

/** The part of the TUI plugin's client and session data a reading uses. */
export interface Source {
  readonly messages: (input: {
    readonly sessionID: string
    readonly limit: number
    readonly order: "desc"
    readonly cursor?: string
  }) => Promise<Page>
  readonly status: (sessionID: string) => "idle" | "running"
}

/** Messages per page. */
export const PAGE = 50

/** How many pages one reading reads at most. */
export const PAGES = 20

const createdOf = (message: unknown): number | undefined => {
  if (typeof message !== "object" || message === null || !("time" in message)) return undefined
  const time = message.time
  if (typeof time !== "object" || time === null || !("created" in time)) return undefined
  return typeof time.created === "number" ? time.created : undefined
}

/** The session's messages made at or after `since`, oldest first. */
const messagesSince = (source: Source, sessionID: string, since: number) =>
  Effect.tryPromise(async () => {
    const newestFirst: Array<unknown> = []
    let cursor: string | undefined
    for (let page = 0; page < PAGES; page++) {
      const response = await source.messages({ sessionID, limit: PAGE, order: "desc", ...(cursor === undefined ? {} : { cursor }) })
      newestFirst.push(...response.data)
      const oldest = createdOf(response.data.at(-1))
      cursor = response.cursor.next ?? undefined
      if (cursor === undefined || oldest === undefined || oldest < since) break
    }
    return newestFirst.toReversed()
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<unknown> => []))

export const layer = (source: Source) =>
  Layer.succeed(
    ForkReadings,
    ForkReadings.of({
      read: (fork) =>
        messagesSince(source, fork.sessionID, fork.createdAt).pipe(
          Effect.map((messages) => ({
            turns: forkTurns(messages, fork.createdAt),
            replying: source.status(fork.sessionID) === "running",
          })),
        ),
    }),
  )
