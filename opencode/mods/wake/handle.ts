// The handle registry's decider (spec laws H1-H11): a `tools.*` call a cut cell left in flight, and a land,
// each a handle of one session that settles once and is told in one letter of that session. Every change
// goes through `Handles`: decide is pure and reads time only from its commands, evolve copies what the
// events carry. The registry delivers only its own two kinds; every other kind an agent lists has its own
// deliverer (`DELIVERS`), and the wakes' entries are read here only as a view (`handleOfEntry`).
//
// Held trace for trace to the reference model of the run (kernel-wake `acceptance/reference.ts`).
import type { Decider } from "@dotfiles/decider/decider"
import { Array as Arr, Effect, Match, Option, Order, Schema, Struct, type Types } from "effect"
import type { Letter } from "./message.ts"
import { dueOf, type Entry } from "./wake.ts"

// ── Kinds ──

/** What the registry opens, settles and tells: a `tools.*` call a cut cell left in flight, and a land. Nothing else. */
export const Kind = Schema.Literals(["call", "land"])
export type Kind = typeof Kind.Type

/** Every kind an agent can list, and the ONE component that tells its end (H8). */
export const DELIVERS = {
  call: "registry",
  land: "registry",
  timer: "wakes",
  job: "wakes",
  subagent: "host",
  shell: "host",
  question: "questions",
} as const

/** Kinds whose work lives in its owner's process and dies with it. A land is owed in the store and finished by the next server. */
export const VOLATILE: ReadonlySet<Kind> = new Set<Kind>(["call"])

/** Settles of an idle session that arrive within this of the first one go in one wake (H6). */
export const WINDOW_MS = 2_000

/**
 * How a handle ended. `lost`: its owner died under it; it may have run and is never run again.
 * `declined`: the owner refused its permission ask; told as a notice, it starts no turn.
 */
export const Disposition = Schema.Literals(["succeeded", "failed", "lost", "declined"])
export type Disposition = typeof Disposition.Type

/** What a settle may say; `started`: the call answered with work still running, which tells its own end (H2, H8). */
export const Outcome = Schema.Literals(["succeeded", "failed", "lost", "declined", "started"])
export type Outcome = typeof Outcome.Type

/** How a letter reaches its session: it joins the running turn, wakes an idle session, or is a notice that starts nothing. */
export const Mode = Schema.Literals(["join", "wake", "notice"])
export type Mode = typeof Mode.Type

// ── A handle ──

export const Phase = Schema.TaggedUnion({
  Open: {},
  Settled: { disposition: Disposition, at: Schema.Number },
  /** A letter under `delivery` carries it. `parked`: the host refused it for an archived session; not sent again until the session is back. */
  Claimed: { disposition: Disposition, at: Schema.Number, delivery: Schema.String, mode: Mode, parked: Schema.Boolean },
  Delivered: { disposition: Disposition, at: Schema.Number, delivery: Schema.String, mode: Mode },
  Cancelled: {},
  /** Its call answered with work still running: `to` names that work. Terminal; no letter. */
  Handed: { to: Schema.String },
})
export type Phase = typeof Phase.Type

const OPEN = Phase.cases.Open.make({})
const CANCELLED = Phase.cases.Cancelled.make({})

/** One handle, as the wake store keeps it beside the entries. */
export const Handle = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  session: Schema.String,
  kind: Kind,
  /** The plugin instance that runs its work: `<server id>/<location>/<epoch>`. Only its owner's end can lose it (H4). */
  owner: Schema.String,
  /** The tool a call ran, as its letter names it. */
  tool: Schema.optionalKey(Schema.String),
  phase: Phase,
})
export type Handle = typeof Handle.Type

export interface State {
  readonly handles: ReadonlyMap<string, Handle>
  /** Sessions deleted: nothing of theirs is opened, settled into a letter or delivered again. */
  readonly gone: ReadonlySet<string>
}

// ── Commands ──

export const Open = Schema.TaggedStruct("Open", { id: Schema.String, session: Schema.String, kind: Kind, owner: Schema.String, tool: Schema.optionalKey(Schema.String) })
export const Settle = Schema.TaggedStruct("Settle", { id: Schema.String, disposition: Outcome, at: Schema.Number, to: Schema.optionalKey(Schema.String) })
/** Take every settled, unclaimed handle of the session into one letter under `delivery`; `busy`: a turn of the session runs now (H9). */
export const Claim = Schema.TaggedStruct("Claim", { session: Schema.String, delivery: Schema.String, now: Schema.Number, busy: Schema.Boolean })
/** The host admitted the letter `delivery`. */
export const Deliver = Schema.TaggedStruct("Delivered", { delivery: Schema.String })
/** The host refused the letter `delivery`: its session is archived. */
export const Park = Schema.TaggedStruct("Park", { delivery: Schema.String })
/** The session is back (unarchived, or a new instance starts): its parked letters are owed again, under their ids. */
export const Unpark = Schema.TaggedStruct("Unpark", { session: Schema.String })
export const Cancel = Schema.TaggedStruct("Cancel", { id: Schema.String })
/** H10: the owner stopped the session. Its open handles are cancelled; no letter follows. */
export const Stopped = Schema.TaggedStruct("Stopped", { session: Schema.String })
/** The instance `owner` is over: its volatile work is gone. No other owner's is touched (H4). */
export const Retired = Schema.TaggedStruct("Retired", { owner: Schema.String, at: Schema.Number })
export const Forget = Schema.TaggedStruct("Forget", { session: Schema.String })

export type Command =
  | typeof Open.Type
  | typeof Settle.Type
  | typeof Claim.Type
  | typeof Deliver.Type
  | typeof Park.Type
  | typeof Unpark.Type
  | typeof Cancel.Type
  | typeof Stopped.Type
  | typeof Retired.Type
  | typeof Forget.Type

// ── Events ──

export const Opened = Schema.TaggedStruct("Opened", { id: Schema.String, session: Schema.String, kind: Kind, owner: Schema.String, tool: Schema.optionalKey(Schema.String) })
export const Settled = Schema.TaggedStruct("Settled", { id: Schema.String, disposition: Disposition, at: Schema.Number })
export const Claimed = Schema.TaggedStruct("Claimed", { ids: Schema.Array(Schema.String), delivery: Schema.String, mode: Mode })
export const LetterDelivered = Schema.TaggedStruct("LetterDelivered", { delivery: Schema.String })
export const LetterParked = Schema.TaggedStruct("LetterParked", { delivery: Schema.String })
export const LettersUnparked = Schema.TaggedStruct("LettersUnparked", { session: Schema.String })
export const Cancelled = Schema.TaggedStruct("Cancelled", { id: Schema.String })
export const Handed = Schema.TaggedStruct("Handed", { id: Schema.String, to: Schema.String })
export const Forgotten = Schema.TaggedStruct("Forgotten", { session: Schema.String })

export type Event =
  | typeof Opened.Type
  | typeof Settled.Type
  | typeof Claimed.Type
  | typeof LetterDelivered.Type
  | typeof LetterParked.Type
  | typeof LettersUnparked.Type
  | typeof Cancelled.Type
  | typeof Handed.Type
  | typeof Forgotten.Type

// ── Deciding ──

const sorted = (ids: Iterable<string>): ReadonlyArray<string> => Arr.sort(Arr.fromIterable(ids), Order.String)
const all = (state: State): ReadonlyArray<Handle> => Arr.fromIterable(state.handles.values())
const find = (state: State, id: string): Option.Option<Handle> => Option.fromNullishOr(state.handles.get(id))
const isOpen = (handle: Handle) => handle.phase._tag === "Open"

/** A session's settled handles, each with its settle. */
const settledOf = (state: State, session: string) =>
  Arr.flatMap(all(state), (handle) =>
    Option.match(Option.filter(settledPhase(handle), () => handle.session === session), { onNone: () => [], onSome: (phase) => [{ id: handle.id, phase }] }),
  )

/** Whether any handle is claimed under `delivery` and `also` holds of its phase. */
const anyClaimed = (state: State, delivery: string, also: (phase: typeof Phase.cases.Claimed.Type) => boolean) =>
  all(state).some((handle) => handle.phase._tag === "Claimed" && handle.phase.delivery === delivery && also(handle.phase))

/** `event` when `holds`, else nothing. */
const when = (holds: boolean, event: Event): ReadonlyArray<Event> => {
  if (holds) return [event]
  return []
}

const settle = (state: State, command: typeof Settle.Type): ReadonlyArray<Event> =>
  Option.match(Option.filter(find(state, command.id), isOpen), {
    // H3: the first settle wins; a second signal of the same end records nothing.
    onNone: () => [],
    onSome: (handle): ReadonlyArray<Event> => {
      // Only a call can answer with work still running; a land's end is its own.
      if (command.disposition === "started") return when(handle.kind === "call", Handed.make({ id: command.id, to: command.to ?? "" }))
      return [Settled.make({ id: command.id, disposition: command.disposition, at: command.at })]
    },
  })

const claim = (state: State, command: typeof Claim.Type): ReadonlyArray<Event> => {
  if (state.gone.has(command.session)) return []
  const settled = settledOf(state, command.session)
  if (settled.length === 0) return []
  const ids = sorted(settled.map((each) => each.id))
  const claimed = (mode: Mode) => [Claimed.make({ ids, delivery: command.delivery, mode })]
  // H9: a turn runs, so the letter joins it; it starts none.
  if (command.busy) return claimed("join")
  // H10's other half: what the owner declined starts no turn.
  if (settled.every((each) => each.phase.disposition === "declined")) return claimed("notice")
  // H6: an idle session's settles within the window of the first go in one wake.
  const first = Math.min(...settled.map((each) => each.phase.at))
  if (command.now - first < WINDOW_MS) return []
  return claimed("wake")
}

/** The ids of the handles `pick` takes, sorted. */
const idsWhere = (state: State, pick: (handle: Handle) => boolean): ReadonlyArray<string> => sorted(all(state).filter(pick).map((handle) => handle.id))

/** Pure. The events a command records, `[]` when the state already is what it asks for. No command is refused. */
const decide = (state: State, command: Command): ReadonlyArray<Event> =>
  Match.valueTags(command, {
    Open: (open) => when(!state.gone.has(open.session) && !state.handles.has(open.id), Opened.make(Struct.omit(open, ["_tag"]))),
    Settle: (command) => settle(state, command),
    Claim: (command) => claim(state, command),
    Delivered: ({ delivery }) => when(anyClaimed(state, delivery, () => true), LetterDelivered.make({ delivery })),
    Park: ({ delivery }) => when(anyClaimed(state, delivery, (phase) => !phase.parked), LetterParked.make({ delivery })),
    Unpark: ({ session }) =>
      when(all(state).some((handle) => handle.session === session && handle.phase._tag === "Claimed" && handle.phase.parked), LettersUnparked.make({ session })),
    Cancel: ({ id }) => when(Option.exists(find(state, id), isOpen), Cancelled.make({ id })),
    Stopped: ({ session }) => idsWhere(state, (handle) => handle.session === session && isOpen(handle)).map((id) => Cancelled.make({ id })),
    // H4: the volatile work of THIS owner that was open is settled `lost`, once, and told. Every other handle is as it was.
    Retired: ({ owner, at }) =>
      idsWhere(state, (handle) => isOpen(handle) && VOLATILE.has(handle.kind) && handle.owner === owner).map((id) => Settled.make({ id, disposition: "lost", at })),
    Forget: ({ session }) => when(!state.gone.has(session), Forgotten.make({ session })),
  })

// ── Evolving ──

/** The state with every handle `change` maps; one copy of the map for the event. */
const changed = (state: State, change: (handle: Handle) => Handle): State => {
  const handles = new Map(state.handles)
  for (const handle of state.handles.values()) handles.set(handle.id, change(handle))
  return { handles, gone: state.gone }
}

/** The state with handle `id` given `phase`, when it has one and `from` takes it. */
const moved = (state: State, id: string, phase: (handle: Handle) => Option.Option<Phase>): State =>
  Option.match(Option.flatMap(find(state, id), (handle) => Option.map(phase(handle), (next): Handle => ({ ...handle, phase: next }))), {
    onNone: () => state,
    onSome: (handle) => ({ handles: new Map(state.handles).set(id, handle), gone: state.gone }),
  })

const settledPhase = (handle: Handle): Option.Option<typeof Phase.cases.Settled.Type> =>
  Match.valueTags(handle.phase, {
    Settled: (phase) => Option.some(phase),
    Open: () => Option.none(),
    Claimed: () => Option.none(),
    Delivered: () => Option.none(),
    Cancelled: () => Option.none(),
    Handed: () => Option.none(),
  })

/** A claimed handle's phase changed by `change`; any other handle as it is. */
const whenClaimed = (handle: Handle, pick: (phase: typeof Phase.cases.Claimed.Type) => boolean, change: (phase: typeof Phase.cases.Claimed.Type) => Phase): Handle =>
  Match.valueTags(handle.phase, {
    Claimed: (phase): Handle => Option.getOrElse(Option.map(Option.liftPredicate(phase, pick), (taken): Handle => ({ ...handle, phase: change(taken) })), () => handle),
    Open: () => handle,
    Settled: () => handle,
    Delivered: () => handle,
    Cancelled: () => handle,
    Handed: () => handle,
  })

const claimAll = (state: State, event: typeof Claimed.Type): State => {
  const handles = new Map(state.handles)
  for (const id of event.ids)
    Option.map(Option.flatMap(find(state, id), (handle) => Option.map(settledPhase(handle), (phase) => ({ handle, phase }))), ({ handle, phase }) =>
      handles.set(id, { ...handle, phase: Phase.cases.Claimed.make({ disposition: phase.disposition, at: phase.at, delivery: event.delivery, mode: event.mode, parked: false }) }),
    )
  return { handles, gone: state.gone }
}

/** What an `Opened` carries, without its tag. */
const fieldsOf = (opened: typeof Opened.Type) => Struct.omit(opened, ["_tag"])

/** Total. */
const evolve = (state: State, event: Event): State =>
  Match.valueTags(event, {
    Opened: (opened): State => ({
      handles: new Map(state.handles).set(opened.id, { version: 1, ...fieldsOf(opened), phase: OPEN }),
      gone: state.gone,
    }),
    Settled: (settled) => moved(state, settled.id, () => Option.some(Phase.cases.Settled.make({ disposition: settled.disposition, at: settled.at }))),
    Claimed: (claimed) => claimAll(state, claimed),
    LetterDelivered: ({ delivery }) =>
      changed(state, (handle) =>
        whenClaimed(handle, (phase) => phase.delivery === delivery, (phase) => Phase.cases.Delivered.make({ disposition: phase.disposition, at: phase.at, delivery, mode: phase.mode })),
      ),
    LetterParked: ({ delivery }) => changed(state, (handle) => whenClaimed(handle, (phase) => phase.delivery === delivery, (phase) => ({ ...phase, parked: true }))),
    LettersUnparked: ({ session }) => changed(state, (handle) => whenClaimed(handle, () => handle.session === session, (phase) => ({ ...phase, parked: false }))),
    Cancelled: ({ id }) => moved(state, id, () => Option.some(CANCELLED)),
    Handed: ({ id, to }) => moved(state, id, () => Option.some(Phase.cases.Handed.make({ to }))),
    Forgotten: ({ session }): State => ({
      handles: new Map(Arr.filter(Arr.fromIterable(state.handles), ([, handle]) => handle.session !== session)),
      gone: new Set(state.gone).add(session),
    }),
  })

export const initial: State = { handles: new Map(), gone: new Set() }

export const Handles: Decider<State, Command, Event> = {
  initial,
  decide: (state, command) => Effect.succeed(decide(state, command)),
  evolve,
}

/** The state the stored handles make: what an instance reads at its start. Deleted sessions are not kept: a deleted session has no handle left. */
export const stateOf = (handles: ReadonlyArray<Handle>): State => ({ handles: new Map(handles.map((handle) => [handle.id, handle])), gone: new Set() })

// ── Reading ──

const tailOf = (phase: Phase): string =>
  Match.valueTags(phase, {
    Open: () => "",
    Cancelled: () => "",
    Handed: ({ to }) => ` ${to}`,
    Settled: ({ disposition, at }) => ` ${disposition} @${at}`,
    Claimed: ({ disposition, delivery, mode, parked }) => ` ${disposition} ${delivery} ${mode}${Arr.filter([" parked"], () => parked).join("")}`,
    Delivered: ({ disposition, delivery, mode }) => ` ${disposition} ${delivery} ${mode}`,
  })

/** Each handle's phase as one comparable line, sorted: what the model is held to the reference on. */
export const view = (state: State): ReadonlyArray<string> =>
  sorted(all(state).map((handle) => `${handle.id} ${handle.session} ${handle.kind} ${handle.owner} ${handle.phase._tag}${tailOf(handle.phase)}`))

/** One letter owed a send: claimed, not parked, not yet admitted. A restart sends it again under the same delivery id. */
export interface Owed {
  readonly session: string
  readonly delivery: string
  readonly mode: Mode
  readonly ids: ReadonlyArray<string>
}

export const owed = (state: State): ReadonlyArray<Owed> => {
  const letters = new Map<string, { readonly session: string; readonly mode: Mode; readonly ids: Array<string> }>()
  for (const handle of state.handles.values())
    if (handle.phase._tag === "Claimed" && !handle.phase.parked) {
      const letter = letters.get(handle.phase.delivery) ?? { session: handle.session, mode: handle.phase.mode, ids: [] }
      letter.ids.push(handle.id)
      letters.set(handle.phase.delivery, letter)
    }
  return sorted(letters.keys()).flatMap((delivery) =>
    Option.match(Option.fromNullishOr(letters.get(delivery)), {
      onNone: () => [],
      onSome: (letter) => [{ session: letter.session, delivery, mode: letter.mode, ids: sorted(letter.ids) }],
    }),
  )
}

/** The owners that hold open volatile work, over EVERY session: what an instance checks at its start, each against the host's liveness (H4). */
export const openOwners = (state: State): ReadonlyArray<string> =>
  sorted(new Set(all(state).filter((handle) => isOpen(handle) && VOLATILE.has(handle.kind)).map((handle) => handle.owner)))

/** When an idle session's unclaimed settles are due their one wake: the first settle plus the window. None: nothing to tell. One timer per burst; never a poll. */
export const dueAt = (state: State, session: string): Option.Option<number> =>
  Arr.match(settledOf(state, session), {
    onEmpty: () => Option.none(),
    onNonEmpty: (settled) => Option.some(Math.min(...settled.map((each) => each.phase.at)) + WINDOW_MS),
  })

/** The sessions whose letters are parked: an instance's start owes each an `Unpark`. */
export const parkedSessions = (state: State): ReadonlyArray<string> =>
  sorted(new Set(all(state).filter((handle) => handle.phase._tag === "Claimed" && handle.phase.parked).map((handle) => handle.session)))

/** The sessions that hold settled handles no letter took yet: a start claims each. */
export const unclaimedSessions = (state: State): ReadonlyArray<string> =>
  sorted(new Set(all(state).filter((handle) => handle.phase._tag === "Settled").map((handle) => handle.session)))

// ── The letter ──

/** A letter's text is at most this long (about 500 tokens); its metadata at most `METADATA_CHARS`. */
export const LETTER_CHARS = 2_000
export const METADATA_CHARS = 4_000
/** A letter names this many handles, a line each, then how many more. */
export const LETTER_LINES = 8
const TOOL_CHARS = 40

/** One settled handle, as a letter names it. Whatever else the caller holds (a call's value) is not the letter's to carry. */
export interface Told {
  readonly id: string
  readonly kind: Kind
  readonly disposition: Disposition
  readonly at: number
  /** The tool the call ran, when it is a call. */
  readonly tool?: string
}

const WORDS = {
  succeeded: "succeeded",
  failed: "failed",
  lost: "lost: its server went; it may have run and is never run again",
  declined: "declined: the owner said no; it did not run",
} satisfies Record<Disposition, string>

const lineOf = (told: Told) => {
  const tool = Option.getOrElse(Option.map(Option.fromNullishOr(told.tool), (name) => ` ${name.slice(0, TOOL_CHARS)}`), () => "")
  return `- ${told.id.slice(0, TOOL_CHARS)} ${told.kind}${tool}: ${WORDS[told.disposition]}`
}

const counted = (count: number) => {
  if (count === 1) return "1 handle"
  return `${count} handles`
}

/** The one letter of a claim: eight handles a line each, then `… and N more · tools.handles.list()`. It carries no result. */
export const letterOf = (handles: ReadonlyArray<Told>): Letter => {
  const shown = handles.slice(0, LETTER_LINES)
  const more = handles.length - shown.length
  const head = `${counted(handles.length)} settled. Read each with \`await tools.handles.get(id)\`.`
  const tail = Arr.filter([`… and ${more} more · tools.handles.list()`], () => more > 0)
  return {
    text: [head, ...shown.map(lineOf), ...tail].join("\n").slice(0, LETTER_CHARS),
    description: `${counted(handles.length)} settled`,
    metadata: {
      source: "handles",
      handles: shown.map((told) => ({ id: told.id.slice(0, TOOL_CHARS), kind: told.kind, disposition: told.disposition, at: told.at })),
      more,
    },
  }
}

/** A claimed or delivered handle as its letter names it; none for a handle no letter carries. */
export const toldOf = (handle: Handle): Option.Option<Told> => {
  const told = (phase: { readonly disposition: Disposition; readonly at: number }): Option.Option<Told> => {
    const named: Types.Mutable<Told> = { id: handle.id, kind: handle.kind, disposition: phase.disposition, at: phase.at }
    for (const tool of Option.toArray(Option.fromNullishOr(handle.tool))) named.tool = tool
    return Option.some(named)
  }
  return Match.valueTags(handle.phase, {
    Claimed: told,
    Delivered: told,
    Open: () => Option.none(),
    Settled: () => Option.none(),
    Cancelled: () => Option.none(),
    Handed: () => Option.none(),
  })
}

// ── The registry's RPC ──

/** What a cell reads of a handle at once: open, settled with its value (or `Unavailable`), or how else it stands. */
export const Unavailable = Schema.TaggedStruct("Unavailable", { reason: Schema.String })
export const Reading = Schema.Union([
  Schema.Struct({ state: Schema.Literal("open"), kind: Kind }),
  Schema.Struct({ state: Schema.Literal("settled"), disposition: Disposition, value: Schema.Union([Unavailable, Schema.Json]) }),
  Schema.Struct({ state: Schema.Literal("cancelled") }),
  /** Its call answered with work still running: `to` is that work, which tells its own end. */
  Schema.Struct({ state: Schema.Literal("handed"), to: Schema.String }),
  Schema.Struct({ state: Schema.Literal("unknown") }),
])
export type Reading = typeof Reading.Type

export const OpenAsk = Schema.Struct({ id: Schema.String, sessionID: Schema.String, kind: Kind, tool: Schema.optionalKey(Schema.String) })
export const SettleAsk = Schema.Struct({ id: Schema.String, outcome: Outcome, value: Schema.optionalKey(Schema.Json), to: Schema.optionalKey(Schema.String) })
export const HandleAsk = Schema.Struct({ sessionID: Schema.String, id: Schema.String })
export const SessionAsk = Schema.Struct({ sessionID: Schema.String })

/**
 * The registry's RPC, which the wakes serve and other mods call: `open(OpenAsk)` records a handle of this
 * server's (answers `{ opened }`, false for a deleted session or an id opened before); `settle(SettleAsk)` its
 * end, once (H3); `get(HandleAsk)` answers a `Reading` at once; `list(SessionAsk)` the session's handles;
 * `cancel(HandleAsk)` an open one (`{ cancelled }`); `stopped(SessionAsk)` the owner's stop of the session
 * (`{ ids }`, each cancelled, no letter). Event `cancelled({ ids })`: the work of each is to be interrupted.
 */
export const HANDLES = {
  id: "dotfiles-opencode.wake.handles",
  methods: {
    open: { input: { type: "object" }, output: { type: "object" } },
    settle: { input: { type: "object" }, output: { type: "object" } },
    get: { input: { type: "object" }, output: { type: "object" } },
    list: { input: { type: "object" }, output: { type: "object" } },
    cancel: { input: { type: "object" }, output: { type: "object" } },
    stopped: { input: { type: "object" }, output: { type: "object" } },
  },
  events: { cancelled: { schema: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } }, required: ["ids"] } } },
} as const

// ── The wakes' entries, read as handles ──

/** An entry of the wakes model, as the handle list shows it. The wakes deliver it; the registry never does (H8). */
export interface EntryHandle {
  readonly id: string
  readonly session: string
  readonly kind: "timer" | "job" | "subagent"
  readonly state: "open" | "held" | "claimed"
  readonly deliverer: "wakes"
  readonly note: string
  readonly settlesAt?: number
  readonly repeats?: boolean
  readonly startsSession?: boolean
  readonly delivery?: string
}

const KINDS = { alarm: "timer", monitor: "job", job: "job", latch: "subagent" } as const

/** What an entry is for, in its setter's words: a latch's is its subagent's description. */
const noteOf = (entry: Entry): string => {
  if (entry.kind === "latch") return entry.subagent.description
  return entry.note
}

/** A read-only view of a wakes entry: its id, note and time; a fire recorded and not yet sent is `claimed` under its delivery id (C27). */
export const handleOfEntry = (entry: Entry): EntryHandle => {
  const shown: Types.Mutable<EntryHandle> = {
    id: entry.id,
    session: entry.sessionID,
    kind: KINDS[entry.kind],
    state: "open",
    deliverer: "wakes",
    note: noteOf(entry),
    settlesAt: dueOf(entry),
  }
  if (entry.kind === "latch") shown.state = "held"
  if (entry.kind === "alarm" && Option.isSome(Option.fromNullishOr(entry.everySeconds))) shown.repeats = true
  if (entry.kind === "monitor" && Option.isSome(Option.fromNullishOr(entry.repeat))) shown.repeats = true
  if (entry.kind === "alarm" && Option.isSome(Option.fromNullishOr(entry.newSession))) shown.startsSession = true
  if (entry.kind !== "latch")
    for (const firing of Option.toArray(Option.fromNullishOr(entry.firing))) {
      shown.state = "claimed"
      shown.delivery = firing.delivery
    }
  return shown
}
