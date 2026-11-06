// Sessions over the TUI plugin's client: the switches from the server's
// message list filtered to location-switched messages (`client.message.list`,
// newest first, a page at a time), and the move through `client.session.move`,
// the route the host's own "Choose directory" calls. A message that does not
// decode as a switch is skipped.
import { Effect, Layer, Option, Schema } from "effect"
import type { Switch } from "../recover.ts"
import { MoveRefused, Sessions, SwitchesUnreadable } from "../service.ts"

/** One page of messages, newest first, and the cursor to the next older page. */
export interface Page {
  readonly data: ReadonlyArray<unknown>
  readonly cursor: { readonly next?: string | null | undefined }
}

/** The part of the TUI plugin's client this reads. */
export interface Source {
  readonly messages: (input: {
    readonly sessionID: string
    readonly type: "location-switched"
    readonly limit: number
    readonly order?: "desc"
    readonly cursor?: string
  }) => Promise<Page>
  readonly move: (input: { readonly sessionID: string; readonly directory: string }) => Promise<unknown>
}

/** Switches per page. */
export const PAGE = 100

/** How many pages one read reads at most. */
export const PAGES = 10

const LocationRef = Schema.Struct({ directory: Schema.String, workspaceID: Schema.optional(Schema.String) })
const LocationSwitched = Schema.Struct({
  type: Schema.Literal("location-switched"),
  location: LocationRef,
  previous: Schema.optional(Schema.Struct({ location: LocationRef })),
})
const decode = Schema.decodeUnknownOption(LocationSwitched)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export const layer = (source: Source) =>
  Layer.succeed(
    Sessions,
    Sessions.of({
      switches: (sessionID) =>
        Effect.tryPromise({
          try: async () => {
            const found: Array<Switch> = []
            let cursor: string | undefined
            for (let page = 0; page < PAGES; page++) {
              // The cursor carries the order; the host refuses both at once.
              const response = await source.messages({ sessionID, type: "location-switched", limit: PAGE, ...(cursor === undefined ? { order: "desc" } : { cursor }) })
              for (const item of response.data)
                Option.map(decode(item), ({ location, previous }) => found.push(previous ? { location, previous } : { location }))
              cursor = response.cursor.next ?? undefined
              if (cursor === undefined) break
            }
            return found
          },
          catch: (error) => new SwitchesUnreadable({ sessionID, message: message(error) }),
        }),
      move: (sessionID, directory) =>
        Effect.tryPromise({
          try: () => source.move({ sessionID, directory }),
          catch: (error) => new MoveRefused({ sessionID, directory, message: message(error) }),
        }).pipe(Effect.asVoid),
    }),
  )
