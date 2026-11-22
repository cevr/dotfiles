// Tailscale's status, as `tailscale status --json` prints it (invented hosts), and the CLI that prints it:
// - it is found only at absolute paths, never through PATH;
// - no CLI, a failing one, a hanging one or one that prints nonsense gives no status, and says which (fake CLIs in a
//   scratch folder, each a small shell script).
import { describe, expect, test } from "bun:test"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Duration, Effect, Option } from "effect"
import { scratch } from "../../../tests/scratch.ts"
import { StatusRead } from "../bind.ts"
import { CLIS, statusFrom, statusOf } from "./tailnet.ts"

const RUNNING = '{"BackendState":"Running","Self":{"DNSName":"harbor.example-tailnet.ts.net.","TailscaleIPs":["100.101.102.103","fd7a:115c:a1e0::42"]}}'

/** What a status with no user and no peers reads as, beside its own fields. */
const BARE = { userId: Option.none(), tagged: false, peers: [] }

describe("Tailscale's status", () => {
  test("running, with its MagicDNS name and its own addresses; stopped; no Self; not JSON", () => {
    expect(statusOf(RUNNING)).toEqual(Option.some({ backendState: "Running", dnsName: Option.some("harbor.example-tailnet.ts.net"), ips: ["100.101.102.103", "fd7a:115c:a1e0::42"], ...BARE }))
    expect(statusOf('{"BackendState":"Stopped","Self":{"DNSName":""}}')).toEqual(Option.some({ backendState: "Stopped", dnsName: Option.none(), ips: [], ...BARE }))
    expect(statusOf('{"BackendState":"NeedsLogin"}')).toEqual(Option.some({ backendState: "NeedsLogin", dnsName: Option.none(), ips: [], ...BARE }))
    expect(statusOf("tailscale: command not found")).toEqual(Option.none())
  })

  test("its user, its tags, and each peer: names, addresses, user, tagged, shared in", () => {
    const text = [
      '{"BackendState":"Running","Self":{"DNSName":"harbor.example-tailnet.ts.net.","TailscaleIPs":["100.101.102.103"],"UserID":7},"Peer":{',
      '"nodekey:a":{"DNSName":"skiff.example-tailnet.ts.net.","HostName":"Skiff","TailscaleIPs":["100.101.102.104","fd7a:115c:a1e0::44"],"UserID":7},',
      '"nodekey:b":{"DNSName":"ferry.example-tailnet.ts.net.","HostName":"ferry","TailscaleIPs":["100.101.102.105"],"UserID":9,"Tags":["tag:server"]},',
      '"nodekey:c":{"DNSName":"","HostName":"guest","TailscaleIPs":null,"UserID":7,"ShareeNode":true,"Tags":null}}}',
    ].join("")
    expect(statusOf(text)).toEqual(
      Option.some({
        backendState: "Running",
        dnsName: Option.some("harbor.example-tailnet.ts.net"),
        ips: ["100.101.102.103"],
        userId: Option.some(7),
        tagged: false,
        peers: [
          { dnsName: Option.some("skiff.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "Skiff", ips: ["100.101.102.104", "fd7a:115c:a1e0::44"], userId: Option.some(7), tagged: false, shared: false },
          { dnsName: Option.some("ferry.example-tailnet.ts.net"), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "ferry", ips: ["100.101.102.105"], userId: Option.some(9), tagged: true, shared: false },
          { dnsName: Option.none(), stableId: Option.none(), os: "", lastSeen: Option.none(), hostName: "guest", ips: [], userId: Option.some(7), tagged: false, shared: true },
        ],
      }),
    )
    expect(Option.map(statusOf('{"BackendState":"Running","Self":{"UserID":3,"Tags":["tag:ci"]}}'), (status) => status.tagged)).toEqual(Option.some(true))
  })
})

describe("the Tailscale CLI", () => {
  test("is looked for at absolute paths only, never through PATH", () => {
    expect(CLIS.filter((each) => !each.startsWith("/"))).toEqual([])
  })

  test("the first that exists answers; none, a failing, a hanging or a nonsense one is no status, with its reason", async () => {
    using held = scratch("digest-cli-")
    const fake = (name: string, body: string) => {
      const path = join(held.path, name)
      writeFileSync(path, `#!/bin/sh\n${body}\n`)
      chmodSync(path, 0o700)
      return path
    }
    const good = fake("good", `printf '%s' '${RUNNING}'`)
    const failing = fake("failing", `printf '%s' '${RUNNING}'; exit 1`)
    const hanging = fake("hanging", "exec sleep 5")
    const nonsense = fake("nonsense", "echo 'Warning: client version differs'")
    const missing = join(held.path, "missing")
    const read = (clis: ReadonlyArray<string>) => Effect.runPromise(statusFrom(clis, Duration.millis(300)))
    expect(await read([missing, good])).toEqual(StatusRead.Read({ status: { backendState: "Running", dnsName: Option.some("harbor.example-tailnet.ts.net"), ips: ["100.101.102.103", "fd7a:115c:a1e0::42"], ...BARE } }))
    expect(await read([missing])).toEqual(StatusRead.Unread({ why: "no-cli" }))
    // The first that exists is the CLI: a failing one is not passed over for another.
    expect(await read([failing, good])).toEqual(StatusRead.Unread({ why: "cli-failed" }))
    expect(await read([hanging])).toEqual(StatusRead.Unread({ why: "cli-timeout" }))
    expect(await read([nonsense])).toEqual(StatusRead.Unread({ why: "unparseable" }))
  })
})
