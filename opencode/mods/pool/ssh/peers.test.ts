import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { peersLaws } from "../laws.ts"
import { Peers } from "../service.ts"
import type { Report } from "../status.ts"
import * as SshPeers from "./peers.ts"

// The laws, with each peer a local command standing in for `ssh <peer> bun run -`:
// one that prints its report, one that fails as ssh does when the host is down.
peersLaws("SSH Peers", (world) =>
  SshPeers.layer(
    world.map(({ name, answer }) => ({
      name,
      ssh: `${name}.invalid`,
      command:
        "down" in answer
          ? [process.execPath, "-e", `process.stderr.write(${JSON.stringify(`ssh: connect to host ${name}: ${answer.down}\n`)}); process.exit(255)`]
          : [process.execPath, "-e", `process.stdout.write(${JSON.stringify(JSON.stringify(answer))})`],
    })),
  ),
)

const run = <A, E>(layer: ReturnType<typeof SshPeers.layer>, effect: Effect.Effect<A, E, Peers>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)))

const report: Report = {
  host: "bite-cristian",
  at: 1_800_000_000_000,
  starts: [{ providerID: "anthropic", at: 1_799_999_900_000 }],
  readings: [
    {
      pool: "anthropic",
      credentialID: "store:work",
      reading: { at: 1_799_999_950_000, status: "allowed", windows: [{ name: "7d", utilization: 0.4, resetAt: 1_800_300_000_000 }] },
    },
  ],
}

/** A loopback server standing in for a peer's OpenCode server: it answers the pool's report RPC to the right password only. */
const seen: Array<{ readonly path: string; readonly auth: string | null; readonly body: string }> = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = await request.text()
    seen.push({ path: new URL(request.url).pathname, auth: request.headers.get("authorization"), body })
    if (request.headers.get("authorization") !== `Basic ${btoa("opencode:sesame")}`) return new Response("unauthorized", { status: 401 })
    return Response.json({ output: report })
  },
})
const dir = mkdtempSync(join(tmpdir(), "pool-ssh-"))
afterAll(() => {
  server.stop(true)
  rmSync(dir, { recursive: true, force: true })
})
const serviceFile = (name: string, password: string) => {
  const path = join(dir, `${name}.json`)
  writeFileSync(path, JSON.stringify({ id: name, url: server.url.origin, pid: process.pid, password }))
  return path
}
/** report.ts run as a peer runs it, on stdin, against the service file `file`. */
const local = (name: string, file: string): SshPeers.Peer => ({
  name,
  ssh: `${name}.invalid`,
  command: ["env", `OPENCODE_SERVICE_FILE=${file}`, process.execPath, "run", "-"],
})

describe("report.ts, the program a peer runs", () => {
  test("asks the host's own server for the pool's report with its password, and the report comes back whole", async () => {
    const answer = await run(
      SshPeers.layer([local("workbox", serviceFile("good", "sesame"))]),
      Effect.flatMap(Peers, (peers) => peers.report("workbox")),
    )
    expect(answer).toEqual(report)
    const last = seen.at(-1)
    expect(last?.path).toBe("/api/rpc/dotfiles-opencode.pool/report")
    expect(last?.auth).toBe(`Basic ${btoa("opencode:sesame")}`)
    expect(JSON.parse(last?.body ?? "")).toEqual({ input: {} })
  })

  test("a server that refuses it, or no server at all, leaves the peer unreachable with the reason", async () => {
    const refused = await run(
      SshPeers.layer([local("workbox", serviceFile("wrong", "guess")), local("studio", join(dir, "missing.json"))]),
      Effect.gen(function* () {
        const peers = yield* Peers
        return [yield* Effect.flip(peers.report("workbox")), yield* Effect.flip(peers.report("studio"))] as const
      }),
    )
    expect(refused[0].message).toBe("the pool's report answered 401")
    expect(refused[1].message).toContain("missing.json is missing")
  })

  test("an answer that is not a report, or none in time, is unreachable too", async () => {
    const failed = await run(
      SshPeers.layer(
        [
          { name: "garbled", ssh: "garbled.invalid", command: [process.execPath, "-e", "process.stdout.write('{\"host\":1}')"] },
          { name: "slow", ssh: "slow.invalid", command: [process.execPath, "-e", "await Bun.sleep(5000)"] },
        ],
        300,
      ),
      Effect.gen(function* () {
        const peers = yield* Peers
        return [yield* Effect.flip(peers.report("garbled")), yield* Effect.flip(peers.report("slow"))] as const
      }),
    )
    expect(failed[0].message).toBe("its answer is not a report")
    expect(failed[1].message).toBe("no answer in 0.3s")
  })

  test("the default command reaches a peer through ssh without a prompt", () => {
    expect(SshPeers.sshCommand("bite-workbox")).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=5",
      "bite-workbox",
      'PATH="$HOME/.bun/bin:$PATH" bun run -',
    ])
  })
})
