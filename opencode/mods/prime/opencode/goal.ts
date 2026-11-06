// The Host's goal read (tui/host.ts): each session's goal from OpenCode's goal
// plugin RPC (`opencode.goal`, packages/schema/src/goal.ts), fetched on the
// session's first read in its own location, again when the server reconnects
// (changes published meanwhile were missed), and kept current from the RPC's
// `changed` events. A server without the goal plugin answers with an error,
// and the session shows no goal. The answer decodes with Prime's own schema.
import type { Plugin } from "@opencode/plugin/tui"
import { Option, Schema } from "effect"
import { createStore } from "solid-js/store"
import type { Goal } from "../goal.ts"

/** The goal plugin's RPC, as its definition names it. */
export const GOAL = {
  id: "opencode.goal",
  methods: {
    get: { input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] }, output: {} },
  },
  events: {
    changed: { schema: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"] } },
  },
} as const

const State = Schema.Struct({
  objective: Schema.String,
  status: Schema.Literals(["active", "paused", "complete"]),
  reason: Schema.optional(Schema.String),
  rounds: Schema.Number,
  updatedAt: Schema.Number,
})
const decodeState = Schema.decodeUnknownOption(Schema.NullOr(State))
const decodeChanged = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal(`rpc.${GOAL.id}.changed`),
    data: Schema.Struct({ sessionID: Schema.String, goal: Schema.NullOr(State) }),
  }),
)

const toGoal = (state: typeof State.Type | null): Goal | null =>
  state === null
    ? null
    : { objective: state.objective, status: state.status, ...(state.reason === undefined ? {} : { reason: state.reason }), rounds: state.rounds, updatedAt: state.updatedAt }

/**
 * A reader of each session's goal, reactive in a Solid computation; the
 * returned `stop` ends its event subscriptions.
 */
export function goals(context: Plugin.Context) {
  // null records a session known to have no goal; a missing key is not loaded yet.
  const [store, setStore] = createStore<Record<string, Goal | null>>({})
  // A change that arrives while a fetch is in flight is newer than its reply, so each change or fetch takes a turn.
  const turns = new Map<string, number>()
  const turn = (sessionID: string) => {
    const next = (turns.get(sessionID) ?? 0) + 1
    turns.set(sessionID, next)
    return next
  }
  const load = (sessionID: string) => {
    const current = turn(sessionID)
    const directory = context.data.session.get(sessionID)?.location.directory
    void context.client
      .rpc(GOAL)
      .get({ sessionID }, directory ? { location: { directory } } : undefined)
      .then(
        (answer) => {
          const state = decodeState(answer)
          if (turns.get(sessionID) === current && Option.isSome(state)) setStore(sessionID, toGoal(state.value))
        },
        () => undefined,
      )
  }
  const unlisten = context.data.listen((event) => {
    const changed = decodeChanged(event.details)
    if (Option.isNone(changed) || !turns.has(changed.value.data.sessionID)) return
    turn(changed.value.data.sessionID)
    setStore(changed.value.data.sessionID, toGoal(changed.value.data.goal))
  })
  const unconnected = context.data.on("server.connected", () => turns.forEach((_, sessionID) => load(sessionID)))
  return {
    read(sessionID: string): Goal | undefined {
      if (!turns.has(sessionID)) load(sessionID)
      return store[sessionID] ?? undefined
    },
    stop() {
      unlisten()
      unconnected()
    },
  }
}
