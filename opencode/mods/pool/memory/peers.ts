// The fleet's peers held in memory: each peer's report, or why it cannot be
// read, by name. The plugin's seam tests change an answer between polls.
import { Effect, Layer } from "effect"
import { Peers, PeerUnreachable } from "../service.ts"
import type { Report } from "../status.ts"

/** A peer's answer: its report, or the message it cannot be read with. */
export type Answer = Report | { readonly down: string }

export const layer = (answers: ReadonlyMap<string, Answer>) =>
  Layer.succeed(Peers, {
    names: [...answers.keys()],
    report: (peer: string) =>
      Effect.suspend(() => {
        const answer = answers.get(peer)
        if (answer === undefined) return Effect.fail(new PeerUnreachable({ peer, message: "not a peer" }))
        return "down" in answer ? Effect.fail(new PeerUnreachable({ peer, message: answer.down })) : Effect.succeed(answer)
      }),
  })
