// The rift mod's RPC: what another plugin (orchestrate's `orchestrate` tool) asks the rift plugin, on the one
// model its `rift` tool runs on, so a land asked over it is the tool's land (its integration Rift, its
// background accept check, the wake of the asking session). Each method answers what the `rift` tool answers
// for the same input, as `text`, with the Rifts it read as data; or `failed` with the words the tool's failure
// gives. The definition literals stay byte for byte here (ARCHITECTURE.md, the composition root); a reader
// imports this file alone and decodes an answer with its schemas.
import { Schema } from "effect"
import { workspaceName } from "./rift.ts"

const object = { type: "object" } as const

/**
 * `create(CreateAsk)` → `Created`, `list(ListAsk)` → `Listed`, `inspect(InspectAsk)` → `Inspected`,
 * `land(LandAsk)` → `LandAnswered`; any of them `Failed`. `sessionID` is the session the call is for: its directory
 * finds the warm source, and a land's background checks wake it.
 */
export const RIFT_RPC = {
  id: "dotfiles-opencode.rift",
  methods: {
    create: { input: object, output: object },
    list: { input: object, output: object },
    inspect: { input: object, output: object },
    land: { input: object, output: object },
  },
  events: {},
} as const

/** A Rift to land: by path, name or branch, or `{ path, unit }` (the `rift` tool's `rifts` entry). */
export const LandRift = Schema.Union([Schema.String, Schema.Struct({ path: Schema.String, unit: Schema.String })])
export type LandRift = typeof LandRift.Type

/** The `rift` tool's create, and `at`: a commit (or `origin/HEAD`) to detach the new Rift at, which the tool's input lacks. */
export const CreateAsk = Schema.Struct({
  sessionID: Schema.String,
  branch: Schema.String,
  name: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.String),
})
export type CreateAsk = typeof CreateAsk.Type

export const ListAsk = Schema.Struct({ sessionID: Schema.String, source: Schema.optionalKey(Schema.String) })
export type ListAsk = typeof ListAsk.Type

export const InspectAsk = Schema.Struct({ sessionID: Schema.String, path: Schema.String })
export type InspectAsk = typeof InspectAsk.Type

export const LandAsk = Schema.Struct({ sessionID: Schema.String, rifts: Schema.Array(LandRift), departs: Schema.optionalKey(Schema.String) })
export type LandAsk = typeof LandAsk.Type

/** A Rift as an answer carries it: its directory, its branch (none when detached), its head and its unsaved work in words (`clean`, `2 uncommitted`). */
export const Lane = Schema.Struct({ path: Schema.String, branch: Schema.optionalKey(Schema.String), head: Schema.String, state: Schema.String })
export type Lane = typeof Lane.Type

/** The call did not act: what the `rift` tool's failure says. */
export const Failed = Schema.Struct({ outcome: Schema.Literal("failed"), message: Schema.String })
export type Failed = typeof Failed.Type

export const Created = Schema.Union([Schema.Struct({ outcome: Schema.Literal("answered"), text: Schema.String, rift: Lane }), Failed])
export type Created = typeof Created.Type

/** The warm source's Rifts, and whether its Rifts are workrift's (the workbox: a Rift is named after its branch). */
export const Listed = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("answered"), text: Schema.String, source: Schema.String, workrift: Schema.Boolean, rifts: Schema.Array(Lane) }),
  Failed,
])
export type Listed = typeof Listed.Type

/** One Rift: `text` is its line in the tool's list answer. */
export const Inspected = Schema.Union([Schema.Struct({ outcome: Schema.Literal("answered"), text: Schema.String, rift: Lane }), Failed])
export type Inspected = typeof Inspected.Type

export const LandAnswered = Schema.Union([Schema.Struct({ outcome: Schema.Literal("answered"), text: Schema.String }), Failed])
export type LandAnswered = typeof LandAnswered.Type

/** The directory name `workrift create <branch>` gives the branch's Rift on the workbox. */
export const workriftName = (branch: string): string => workspaceName(branch)
