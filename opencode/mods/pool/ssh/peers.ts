// The fleet's peers over SSH: each peer is read by running report.ts on it
// (`bun run -`, the program on stdin), which asks that host's own OpenCode
// server on loopback. SSH keys authenticate both ways, no port opens to the
// tailnet, and no password or token crosses: only the report does. A peer that
// does not answer in time, refuses, or answers something that is not a report
// is unreachable.
import { Effect, Layer, Schema } from "effect"
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

const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(Report))

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
      const byName = new Map(peers.map((peer) => [peer.name, peer]))

      const run = (peer: Peer) =>
        Effect.tryPromise({
          try: async () => {
            const child = Bun.spawn([...(peer.command ?? sshCommand(peer.ssh))], {
              stdin: new Blob([program]),
              stdout: "pipe",
              stderr: "pipe",
              timeout: timeoutMs,
            })
            const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
            return { out, err, code, killed: child.signalCode !== null }
          },
          catch: (error) => new PeerUnreachable({ peer: peer.name, message: String(error) }),
        })

      return {
        names: peers.map((peer) => peer.name),
        report: (name: string) =>
          Effect.gen(function* () {
            const peer = byName.get(name)
            if (peer === undefined) return yield* new PeerUnreachable({ peer: name, message: "not a peer" })
            const { out, err, code, killed } = yield* run(peer)
            if (killed) return yield* new PeerUnreachable({ peer: name, message: `no answer in ${timeoutMs / 1000}s` })
            if (code !== 0) return yield* new PeerUnreachable({ peer: name, message: lastLine(err) ?? `exited ${code}` })
            const report = decodeReport(out)
            if (report._tag === "None") return yield* new PeerUnreachable({ peer: name, message: "its answer is not a report" })
            return report.value
          }).pipe(Effect.withSpan("Peers.report", { attributes: { peer: name } })),
      }
    }),
  )
