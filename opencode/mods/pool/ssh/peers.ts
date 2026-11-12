// The fleet's peers over SSH: each peer is read by running report.ts on it
// (`bun run -`, the program on stdin), which asks that host's own OpenCode
// server on loopback. SSH keys authenticate both ways, no port opens to the
// tailnet, and no password or token crosses: only the report does. A peer that
// does not answer in time, refuses, or answers something that is not a report
// is unreachable.
import { Effect, Layer, Schema } from "effect"
import { LeaseAnswer, type LeaseMessage } from "../lease.ts"
import { PushAnswer, type PushRequest } from "../push.ts"
import { Peers, PeerUnreachable } from "../service.ts"
import { Report } from "../status.ts"

/** A peer: its name in the fleet, and the SSH destination (an alias or user@host) that reaches it. */
export interface Peer {
  readonly name: string
  readonly ssh: string
  /** The command that prints its report with report.ts on stdin; tests run it locally. Default: `sshCommand(ssh)`. */
  readonly command?: ReadonlyArray<string>
}

/** How long a peer has to answer, the SSH handshake included. */
export const TIMEOUT_MS = 15_000

/** The SSH command that runs report.ts on `destination`: no prompt, a short connect, and Bun from its usual place. */
export const sshCommand = (destination: string): ReadonlyArray<string> => [
  "ssh",
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  destination,
  'PATH="$HOME/.bun/bin:$PATH" bun run -',
]

/** How long a lease message's SSH run may take, the handshake included: past it the child is stopped (the asker stopped waiting earlier, model.ts). */
export const LEASE_TIMEOUT_MS = 15_000

/** How long a push request's SSH run may take: the peer plans on its pool, which reads its accounts. */
export const PUSH_TIMEOUT_MS = 30_000

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(Report))
const decodeAnswer = Schema.decodeUnknownOption(Schema.fromJsonString(LeaseAnswer))
const decodePush = Schema.decodeUnknownOption(Schema.fromJsonString(PushAnswer))

/** The last line of what a failed command wrote, for the log and the pane. */
const lastLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1)

export const layer = (peers: ReadonlyArray<Peer>, timeoutMs = TIMEOUT_MS) =>
  Layer.effect(
    Peers,
    Effect.gen(function* () {
      const program = yield* Effect.promise(() => Bun.file(new URL("./report.ts", import.meta.url)).text())
      const leaseProgram = yield* Effect.promise(() => Bun.file(new URL("./lease.ts", import.meta.url)).text())
      const pushProgram = yield* Effect.promise(() => Bun.file(new URL("./push.ts", import.meta.url)).text())
      const byName = new Map(peers.map((peer) => [peer.name, peer]))

      const run = (peer: Peer, text = program, timeout = timeoutMs) =>
        Effect.tryPromise({
          try: async () => {
            const child = Bun.spawn([...(peer.command ?? sshCommand(peer.ssh))], {
              stdin: new Blob([text]),
              stdout: "pipe",
              stderr: "pipe",
              timeout,
            })
            const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
            return { out, err, code, killed: child.signalCode !== null }
          },
          catch: (error) => new PeerUnreachable({ peer: peer.name, message: String(error) }),
        })

      return {
        names: peers.map((peer) => peer.name),
        report: Effect.fn("Peers.report")(function* (name: string) {
          yield* Effect.annotateCurrentSpan("peer", name)
          const peer = byName.get(name)
          if (peer === undefined) return yield* new PeerUnreachable({ peer: name, message: "not a peer" })
          const { out, err, code, killed } = yield* run(peer)
          if (killed) return yield* new PeerUnreachable({ peer: name, message: `no answer in ${timeoutMs / 1000}s` })
          if (code !== 0) return yield* new PeerUnreachable({ peer: name, message: lastLine(err) ?? `exited ${code}` })
          const report = decodeReport(out)
          if (report._tag === "None") return yield* new PeerUnreachable({ peer: name, message: "its answer is not a report" })
          return report.value
        }),
        // The message rides in the program, as a JSON literal on its first line: no argument, no file, no token.
        lease: Effect.fn("Peers.lease")(function* (name: string, message: LeaseMessage) {
          yield* Effect.annotateCurrentSpan("peer", name)
          const peer = byName.get(name)
          if (peer === undefined) return yield* new PeerUnreachable({ peer: name, message: "not a peer" })
          const text = `globalThis.POOL_LEASE = ${JSON.stringify(message)};\n${leaseProgram}`
          const { out, err, code, killed } = yield* run(peer, text, LEASE_TIMEOUT_MS)
          if (killed) return yield* new PeerUnreachable({ peer: name, message: `no answer in ${LEASE_TIMEOUT_MS / 1000}s` })
          if (code !== 0) return yield* new PeerUnreachable({ peer: name, message: lastLine(err) ?? `exited ${code}` })
          const answer = decodeAnswer(out)
          if (answer._tag === "None") return yield* new PeerUnreachable({ peer: name, message: "its answer is not a lease's" })
          return answer.value
        }),
        push: Effect.fn("Peers.push")(function* (name: string, request: PushRequest) {
          yield* Effect.annotateCurrentSpan("peer", name)
          const peer = byName.get(name)
          if (peer === undefined) return yield* new PeerUnreachable({ peer: name, message: "not a peer" })
          const text = `globalThis.POOL_PUSH = ${JSON.stringify(request)};\n${pushProgram}`
          const { out, err, code, killed } = yield* run(peer, text, PUSH_TIMEOUT_MS)
          if (killed) return yield* new PeerUnreachable({ peer: name, message: `no answer in ${PUSH_TIMEOUT_MS / 1000}s` })
          if (code !== 0) return yield* new PeerUnreachable({ peer: name, message: lastLine(err) ?? `exited ${code}` })
          const answer = decodePush(out)
          if (answer._tag === "None") return yield* new PeerUnreachable({ peer: name, message: "its answer is not a push's" })
          return answer.value
        }),
      }
    }),
  )
