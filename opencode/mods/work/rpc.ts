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
 * `describe(DescribeAsk)` → `Inspected` (the Rift with its new purpose), `land(LandAsk)` → `LandAnswered`; any of them `Failed`. `sessionID` is the session the call is for: its directory
 * finds the warm source, and a land's background checks wake it.
 */
export const RIFT_RPC = {
  id: "dotfiles-opencode.rift",
  methods: {
    create: { input: object, output: object },
    list: { input: object, output: object },
    inspect: { input: object, output: object },
    describe: { input: object, output: object },
    land: { input: object, output: object },
  },
  events: {},
} as const

/** A Rift to land: by path, name or branch, or `{ path, unit }` (the `rift` tool's `rifts` entry). */
export const LandRift = Schema.Union([Schema.String, Schema.Struct({ path: Schema.String, unit: Schema.String })])
export type LandRift = typeof LandRift.Type

/**
 * The `rift` tool's create, and what its input lacks: `at`, a commit (or `origin/HEAD`) to detach the new Rift at, and
 * `purpose`, the lane's one line, set as its branch's description once it is made; `mark`, whether to mark it as an
 * `orchestrate lane`'s, made on its branch (`Rifts.mark`).
 */
export const CreateAsk = Schema.Struct({
  sessionID: Schema.String,
  branch: Schema.String,
  name: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(Schema.String),
  at: Schema.optionalKey(Schema.String),
  purpose: Schema.optionalKey(Schema.String),
  mark: Schema.optionalKey(Schema.Boolean),
})
export type CreateAsk = typeof CreateAsk.Type

/** A Rift's purpose set: its checked-out branch's description becomes `purpose`. */
export const DescribeAsk = Schema.Struct({ sessionID: Schema.String, path: Schema.String, purpose: Schema.String })
export type DescribeAsk = typeof DescribeAsk.Type

export const ListAsk = Schema.Struct({ sessionID: Schema.String, source: Schema.optionalKey(Schema.String) })
export type ListAsk = typeof ListAsk.Type

export const InspectAsk = Schema.Struct({ sessionID: Schema.String, path: Schema.String })
export type InspectAsk = typeof InspectAsk.Type

export const LandAsk = Schema.Struct({ sessionID: Schema.String, rifts: Schema.Array(LandRift), departs: Schema.optionalKey(Schema.String) })
export type LandAsk = typeof LandAsk.Type

/**
 * A Rift as an answer carries it: its directory, its branch (none when detached), its head, its unsaved work in words
 * (`clean`, `2 uncommitted`), its purpose (its branch's description; none when unset), and the branch it was marked
 * made on (`madeOn`; none for a lane `orchestrate lane` did not make).
 */
export const Lane = Schema.Struct({
  path: Schema.String,
  branch: Schema.optionalKey(Schema.String),
  head: Schema.String,
  state: Schema.String,
  purpose: Schema.optionalKey(Schema.String),
  madeOn: Schema.optionalKey(Schema.String),
})
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

/** A workspace a pushed land landed, and the head the batch merged of it. */
export const LandedWorkspace = Schema.Struct({ path: Schema.String, head: Schema.String })
export type LandedWorkspace = typeof LandedWorkspace.Type

/** A land's answer: its text, and for a pushed land what it pushed and each workspace's merged head (the tool's metadata). */
export const LandAnswered = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("answered"), text: Schema.String, pushed: Schema.optionalKey(Schema.String), landed: Schema.optionalKey(Schema.Array(LandedWorkspace)) }),
  Failed,
])
export type LandAnswered = typeof LandAnswered.Type

/** The directory name `workrift create <branch>` gives the branch's Rift on the workbox. */
export const workriftName = (branch: string): string => workspaceName(branch)
