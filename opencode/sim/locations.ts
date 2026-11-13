// Which copies of a plugin hear an event. OpenCode loads a server plugin once
// per location it serves, and each copy hears its own location's events and
// the global ones (the fork's 5cd5a2b998: packages/core/src/plugin/host.ts
// `local` gives a plugin's streams the host's Location; the bus,
// packages/core/src/bus.ts `local` and `prepareRoutes`, routes a Session's
// event by the Session's location, and any other event by the location it was
// published in). host.ts publishes every event through this rule;
// host-laws.ts (`located`) holds it to real OpenCode.
//
// The world's events are of two kinds: a session's (`data.sessionID` names
// it), routed to its session's directory, and a form's reply, which the host
// publishes in the location of the form's session, so it routes the same.
// An event with no session the world knows is global.
import { Option, Schema } from "effect"
import type { JsonObject } from "./runtime.ts"

const SessionData = Schema.Struct({ sessionID: Schema.String })

/** Where an event is heard: a location's directory, or none for every location. */
export const whereOf = (
  event: { readonly data: JsonObject },
  at: Option.Option<string>,
  directoryOf: (sessionID: string) => Option.Option<string>,
): Option.Option<string> => Option.orElse(at, () => Option.flatMap(Schema.decodeUnknownOption(SessionData)(event.data), (data) => directoryOf(data.sessionID)))

/** Whether a copy serving `directory` hears an event heard `where`. */
export const hears = (directory: string, where: Option.Option<string>) =>
  Option.match(where, {
    onNone: () => true,
    onSome: (located) => located === directory,
  })
