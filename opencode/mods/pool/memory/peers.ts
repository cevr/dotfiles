// The fleet's peers held in memory: each peer's report, or why it cannot be
// read, by name. The plugin's seam tests change an answer between polls. A
// lease message sent to a peer goes to `leases` (a two-host test hands it to
// the other host's pool); a peer with none cannot be reached for it.
import { Effect, Layer } from "effect"
import type { LeaseAnswer, LeaseMessage } from "../lease.ts"
import { Peers, PeerUnreachable } from "../service.ts"
import type { Report } from "../status.ts"

/** A peer's answer: its report, or the message it cannot be read with. */
export type Answer = Report | { readonly down: string }

/** What a peer does with a lease message. */
export type Leases = (peer: string, message: LeaseMessage) => Effect.Effect<LeaseAnswer, PeerUnreachable>

export const layer = (answers: ReadonlyMap<string, Answer>, leases?: Leases) =>
  Layer.succeed(Peers, {
    names: [...answers.keys()],
    report: (peer: string) =>
      Effect.suspend(() => {
        const answer = answers.get(peer)
        if (answer === undefined) return Effect.fail(new PeerUnreachable({ peer, message: "not a peer" }))
        return "down" in answer ? Effect.fail(new PeerUnreachable({ peer, message: answer.down })) : Effect.succeed(answer)
      }),
    lease: (peer: string, message: LeaseMessage) =>
      Effect.suspend(() =>
        leases === undefined || !answers.has(peer) ? Effect.fail(new PeerUnreachable({ peer, message: "takes no leases" })) : leases(peer, message),
      ),
  })
