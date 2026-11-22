// Tailscale's status, as `tailscale status --json` prints it (invented hosts): running or not, and the MagicDNS name
// without its trailing dot.
import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { statusOf } from "./tailnet.ts"

describe("Tailscale's status", () => {
  test("running, with its MagicDNS name; stopped; no name; not JSON", () => {
    expect(statusOf('{"BackendState":"Running","Self":{"DNSName":"harbor.example-tailnet.ts.net."}}')).toEqual(Option.some({ running: true, dnsName: Option.some("harbor.example-tailnet.ts.net") }))
    expect(statusOf('{"BackendState":"Stopped","Self":{"DNSName":""}}')).toEqual(Option.some({ running: false, dnsName: Option.none() }))
    expect(statusOf('{"BackendState":"NeedsLogin"}')).toEqual(Option.some({ running: false, dnsName: Option.none() }))
    expect(statusOf("tailscale: command not found")).toEqual(Option.none())
  })
})
