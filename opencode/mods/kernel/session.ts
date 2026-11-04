// One session's kernel: whether a worker holds its bindings now. A call resets
// it, starts a worker from the stored bindings, records the cell it ran, or
// loses the worker under it; the host stops an idle or deleted session's
// worker. Each command is decided on its own inputs, which the handler
// gathered from the worker; only a stop reads the state, to record nothing
// when no worker runs. No command is refused: a cell that throws and a worker
// that dies are facts the call's answer reads (answer.ts).
//
// The state lives in memory, as the worker does. What a restart keeps is not
// this history but the worker's bindings, stored as its snapshot (service.ts,
// `Snapshots`).
import { Effect, Schema } from "effect"
import type { Decider } from "@dotfiles/decider/decider"
import { Omission } from "./frame.ts"

/** One OpenCode session's kernel: the session's id. */
export const KernelSessionId = Schema.String.pipe(Schema.brand("KernelSessionId"))
export type KernelSessionId = typeof KernelSessionId.Type

// ── ResetKernel: a call asked for `reset`; the worker and its stored bindings go ──

export const ResetKernel = Schema.TaggedStruct("ResetKernel", { session: KernelSessionId })
export interface ResetKernel extends Schema.Schema.Type<typeof ResetKernel> {}

/** Always recorded: the call's answer opens with it. */
export const KernelReset = Schema.TaggedStruct("KernelReset", { session: KernelSessionId })
export interface KernelReset extends Schema.Schema.Type<typeof KernelReset> {}

export declare namespace ResetKernel {
  export type Rejections = never
}

// ── StartKernel: a call found no live worker; a new one took back the stored bindings ──

/** `stored` bindings were in the store; the worker defined `restored` from them. */
export const StartKernel = Schema.TaggedStruct("StartKernel", {
  session: KernelSessionId,
  stored: Schema.Number,
  restored: Schema.Array(Schema.String),
})
export interface StartKernel extends Schema.Schema.Type<typeof StartKernel> {}

/** `restored` is set when the store had bindings: then the call's answer names them. */
export const KernelStarted = Schema.TaggedStruct("KernelStarted", {
  session: KernelSessionId,
  restored: Schema.optional(Schema.Array(Schema.String)),
})
export interface KernelStarted extends Schema.Schema.Type<typeof KernelStarted> {}

export declare namespace StartKernel {
  export type Rejections = never
}

// ── RecordCell: a cell ran to its end in the worker ──

/**
 * What the cell left: whether it threw, what it wrote outside `console`, its
 * display and the bindings it added or rebound. `omitted` is set when the
 * worker lived on and its snapshot was stored: every binding the snapshot
 * left out.
 */
export const RecordCell = Schema.TaggedStruct("RecordCell", {
  session: KernelSessionId,
  ok: Schema.Boolean,
  output: Schema.String,
  display: Schema.String,
  bindings: Schema.Array(Schema.String),
  omitted: Schema.optional(Schema.Array(Omission)),
})
export interface RecordCell extends Schema.Schema.Type<typeof RecordCell> {}

/** `unkept`: the bindings this cell made that a restart loses. `stored`: the worker lived on and its bindings were stored. */
export const CellRan = Schema.TaggedStruct("CellRan", {
  session: KernelSessionId,
  ok: Schema.Boolean,
  output: Schema.String,
  display: Schema.String,
  unkept: Schema.Array(Omission),
  stored: Schema.Boolean,
})
export interface CellRan extends Schema.Schema.Type<typeof CellRan> {}

export declare namespace RecordCell {
  export type Rejections = never
}

// ── LoseKernel: the worker died under a call ──

/**
 * It crashed, used its compute, could not start, was aborted or sent what the
 * protocol does not allow. Its state since the last stored snapshot is gone;
 * the next call starts a new one.
 */
export const LoseKernel = Schema.TaggedStruct("LoseKernel", { session: KernelSessionId, message: Schema.String })
export interface LoseKernel extends Schema.Schema.Type<typeof LoseKernel> {}

export const KernelLost = Schema.TaggedStruct("KernelLost", { session: KernelSessionId, message: Schema.String })
export interface KernelLost extends Schema.Schema.Type<typeof KernelLost> {}

export declare namespace LoseKernel {
  export type Rejections = never
}

// ── StopKernel: the host ends a session's worker ──

/** It sat idle too long, or its session was deleted. Its stored bindings stay unless the session was deleted. */
export const StopReason = Schema.Literals(["idle", "deleted"])
export type StopReason = typeof StopReason.Type

export const StopKernel = Schema.TaggedStruct("StopKernel", { session: KernelSessionId, reason: StopReason })
export interface StopKernel extends Schema.Schema.Type<typeof StopKernel> {}

export const KernelStopped = Schema.TaggedStruct("KernelStopped", { session: KernelSessionId, reason: StopReason })
export interface KernelStopped extends Schema.Schema.Type<typeof KernelStopped> {}

export declare namespace StopKernel {
  export type Rejections = never
}

// ── The decider ──

export const NoKernel = Schema.TaggedStruct("NoKernel", {})
export const LiveKernel = Schema.TaggedStruct("LiveKernel", {})
export const KernelSessionState = Schema.Union([NoKernel, LiveKernel])
export type KernelSessionState = typeof KernelSessionState.Type

export type Command = ResetKernel | StartKernel | RecordCell | LoseKernel | StopKernel
export type Event = KernelReset | KernelStarted | CellRan | KernelLost | KernelStopped

export const KernelSession: Decider<KernelSessionState, Command, Event> = {
  initial: NoKernel.make({}),
  decide: (state, command) => {
    switch (command._tag) {
      case "ResetKernel":
        return Effect.succeed([KernelReset.make({ session: command.session })])
      case "StartKernel":
        return Effect.succeed([
          KernelStarted.make({ session: command.session, ...(command.stored > 0 ? { restored: command.restored } : {}) }),
        ])
      case "RecordCell":
        // A binding left out is named once, by the cell that bound it; later cells do not repeat it.
        return Effect.succeed([
          CellRan.make({
            session: command.session,
            ok: command.ok,
            output: command.output,
            display: command.display,
            unkept: (command.omitted ?? []).filter((item) => command.bindings.includes(item.name)),
            stored: command.omitted !== undefined,
          }),
        ])
      case "LoseKernel":
        return Effect.succeed([KernelLost.make({ session: command.session, message: command.message })])
      case "StopKernel":
        // Nothing when the session has no live worker.
        return Effect.succeed(state._tag === "NoKernel" ? [] : [KernelStopped.make({ session: command.session, reason: command.reason })])
    }
  },
  evolve: (_state, event) => {
    switch (event._tag) {
      case "KernelStarted":
        return LiveKernel.make({})
      case "CellRan":
        return event.stored ? LiveKernel.make({}) : NoKernel.make({})
      case "KernelReset":
      case "KernelLost":
      case "KernelStopped":
        return NoKernel.make({})
    }
  },
}
