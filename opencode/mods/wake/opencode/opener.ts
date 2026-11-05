// The opener over OpenCode's RPC: orchestrate serves `OPENER` and decides the
// latch again. No server for it yet (its plugin is still loading), a failure,
// a timeout, or an answer that is not `Opened` is OpenerUnavailable, and the
// wakes ask again.
import type { Plugin } from "@opencode/plugin/effect"
import { Effect, Layer, Schema } from "effect"
import { type Latch, Opened, OPENER } from "../latch.ts"
import { Opener, OpenerUnavailable } from "../service.ts"
import { messageOf } from "./courier.ts"

/** The opener's `open` method, as the plugin's RPC client calls it. */
export type Open = (latch: Latch) => Effect.Effect<unknown, unknown>

/** How long the opener has to answer: starting a subagent in the background returns once it is prompted. */
const TIMEOUT = "60 seconds"

const decode = Schema.decodeUnknownOption(Opened)

export const layer = (open: Open) =>
  Layer.succeed(Opener, {
    open: (latch) =>
      Effect.suspend(() => open(latch)).pipe(
        Effect.timeoutOption(TIMEOUT),
        Effect.mapError((cause) => new OpenerUnavailable({ message: messageOf(cause) })),
        Effect.catchDefect((cause) => Effect.fail(new OpenerUnavailable({ message: messageOf(cause) }))),
        Effect.flatMap((answer) => {
          if (answer._tag === "None") return Effect.fail(new OpenerUnavailable({ message: "the opener did not answer in time" }))
          const opened = decode(answer.value)
          return opened._tag === "Some" ? Effect.succeed(opened.value) : Effect.fail(new OpenerUnavailable({ message: "the opener's answer is not one" }))
        }),
      ),
  })

/** The opener orchestrate serves, through the plugin context. */
export const fromContext = (ctx: Plugin.Context) => layer((latch) => ctx.rpc(OPENER).open(latch))
