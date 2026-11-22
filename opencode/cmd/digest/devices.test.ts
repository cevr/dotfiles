// `digest devices`, the one way an ID enters or leaves the device store: it looks a name up once, among this host's
// own user's devices only, says which device it found so a human can confirm it, and writes both copies; with none or
// several it writes nothing. Two commands at once both land. Every run here uses scratch copies and a fake CLI.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Match, Path } from "effect"
import { copyOfText, keysOf, membersWith } from "@dotfiles/opencode-digest/devices"
import * as FileDevices from "@dotfiles/opencode-digest/filestore/devices"
import { sourceOf } from "@dotfiles/opencode-digest/members"
import { statusFrom } from "@dotfiles/opencode-digest/process/tailnet"
import { scratch } from "../../tests/scratch.ts"
import { main } from "./devices.ts"

/** The command's file, beside this one. */
const commandFile = Effect.flatMap(Path.Path, (path) => path.fromFileUrl(new URL("./devices.ts", import.meta.url))).pipe(Effect.provide(Path.layer), Effect.orDie)

/** A fake `tailscale status --json`: this host (user 7), his devices, and a colleague's (user 9) also called dinghy. */
const fakeCli = (dir: string, peers: ReadonlyArray<{ readonly name: string; readonly id: string; readonly user: number; readonly os: string; readonly seen: string }>) => {
  const cli = join(dir, "tailscale")
  const peer = (each: (typeof peers)[number], at: number) =>
    `"k${at}":{"DNSName":"${each.name}.example-tailnet.ts.net.","ID":"${each.id}","HostName":"${each.name}","OS":"${each.os}","LastSeen":"${each.seen}","TailscaleIPs":["100.101.102.${130 + at}"],"UserID":${each.user}}`
  const status = `{"BackendState":"Running","Self":{"DNSName":"harbor.example-tailnet.ts.net.","ID":"nHarbor","TailscaleIPs":["100.101.102.103"],"UserID":7},"Peer":{${peers.map(peer).join(",")}}}`
  writeFileSync(join(dir, "status.json"), status)
  writeFileSync(cli, `#!/bin/sh\ncat '${join(dir, "status.json")}'\n`, { mode: 0o755 })
  return cli
}

/** The command run in this process: what it printed and its exit code. */
const run = async (dir: string, cli: string, ...args: ReadonlyArray<string>) => {
  const printed: Array<string> = []
  const code = await Effect.runPromise(main([...args, "--dir", join(dir, "state"), "--config", join(dir, "config"), "--cli", cli], (text) => Effect.sync(() => void printed.push(text))))
  return { code, out: printed.join("\n") }
}
const stored = (dir: string) => [join(dir, "state/devices.json"), join(dir, "config/opencode-digest/devices.json")].map((path) => Match.valueTags(copyOfText(readFileSync(path, "utf8")), { Read: ({ store }) => store, Absent: () => "absent", Unreadable: () => "unreadable", Invalid: ({ why }) => why }))

describe("digest devices", () => {
  test("exclude <name>: the one device of his by that MagicDNS name, shown (name, OS, last seen, ID) and keyed in both copies; never a colleague's", async () => {
    using held = scratch("digest-devices-cli-")
    const cli = fakeCli(held.path, [
      { name: "dinghy", id: "nTheirs1", user: 9, os: "windows", seen: "2026-11-20T10:00:00Z" },
      { name: "dinghy-1", id: "nDinghy1", user: 7, os: "linux", seen: "2026-11-19T08:00:00Z" },
      { name: "phone", id: "nPhone1", user: 7, os: "iOS", seen: "2026-11-20T10:00:00Z" },
    ])
    // Tailscale named his dinghy-1 because a colleague's device holds dinghy: "dinghy" finds none of his.
    const none = await run(held.path, cli, "exclude", "dinghy")
    expect([none.code, none.out.includes("No device of yours is named dinghy"), none.out.includes("nTheirs1"), none.out.includes("windows")]).toEqual([1, true, false, false])
    const found = await run(held.path, cli, "exclude", "dinghy-1")
    expect(found.code).toBe(0)
    expect(found.out).toContain("Found: dinghy-1.example-tailnet.ts.net  linux  last seen 2026-11-19T08:00:00Z  ID nDinghy1")
    expect(stored(held.path)).toEqual([0, 1].map(() => ({ v: 1, agents: [], excluded: [{ name: "dinghy-1", ids: ["nDinghy1"] }] })))
  })

  test("several devices of his answer to the name: nothing written, each shown, --id keys one with no lookup", async () => {
    using held = scratch("digest-devices-cli-")
    const cli = fakeCli(held.path, [
      { name: "skiff", id: "nSkiff1", user: 7, os: "linux", seen: "2026-11-20T10:00:00Z" },
      { name: "skiff.other", id: "nSkiff2", user: 7, os: "linux", seen: "2026-11-20T10:00:00Z" },
    ])
    const several = await run(held.path, cli, "agent", "skiff")
    expect([several.code, several.out.includes("Several devices of yours answer to skiff"), several.out.includes("nSkiff1"), several.out.includes("nSkiff2")]).toEqual([1, true, true, true])
    const direct = await run(held.path, cli, "agent", "skiff", "--id", "nSkiff1")
    expect(direct.code).toBe(0)
    expect(stored(held.path)[0]).toEqual({ v: 1, agents: [{ name: "skiff", ids: ["nSkiff1"] }], excluded: [] })
  })

  test("list shows both copies' condition and what each ID is now; forget removes a name, explicitly", async () => {
    using held = scratch("digest-devices-cli-")
    // Keyed while both were his devices; then nDinghy0 left his tailnet and dinghy was renamed lifeboat.
    fakeCli(held.path, [{ name: "dinghy", id: "nDinghy1", user: 7, os: "linux", seen: "2026-11-20T10:00:00Z" }, { name: "dinghy-old", id: "nDinghy0", user: 7, os: "linux", seen: "2026-11-01T10:00:00Z" }])
    await run(held.path, join(held.path, "tailscale"), "exclude", "dinghy", "--id", "nDinghy1")
    await run(held.path, join(held.path, "tailscale"), "exclude", "dinghy", "--id", "nDinghy0")
    const cli = fakeCli(held.path, [{ name: "lifeboat", id: "nDinghy1", user: 7, os: "linux", seen: "2026-11-20T10:00:00Z" }])
    const listed = await run(held.path, cli, "list")
    expect(listed.out.split("\n").slice(2)).toEqual(["  exclude dinghy: 2 ID(s)", "    nDinghy1: lifeboat.example-tailnet.ts.net  linux  last seen 2026-11-20T10:00:00Z  ID nDinghy1", "    nDinghy0: no device of yours now"])
    expect(listed.out.split("\n").slice(0, 2).map((line) => line.split(": ")[1])).toEqual(["ok", "ok"])
    expect((await run(held.path, cli, "forget", "exclude", "dinghy")).code).toBe(0)
    expect(stored(held.path)[1]).toEqual({ v: 1, agents: [], excluded: [] })
    expect((await run(held.path, cli, "frobnicate")).code).toBe(1)
  })

  test("eight commands at once, each adding an ID: every ID lands in both copies (the lock)", async () => {
    using held = scratch("digest-devices-cli-")
    const cli = fakeCli(held.path, Array.from({ length: 8 }, (_, at) => ({ name: `boat${at}`, id: `nDinghy${at}`, user: 7, os: "linux", seen: "2026-11-20T10:00:00Z" })))
    // Each in its own process group, killed whole when the case ends, however it ends.
    const codes = await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.map(commandFile, (command) => Array.from({ length: 8 }, (_, at) => Bun.spawn(["bun", command, "exclude", "dinghy", "--id", `nDinghy${at}`, "--dir", join(held.path, "state"), "--config", join(held.path, "config"), "--cli", cli], { stdout: "ignore", stderr: "pipe", detached: true }))),
        (children) => Effect.forEach(children, (child) => Effect.promise(() => child.exited), { concurrency: children.length }).pipe(Effect.timeout("20 seconds"), Effect.orDie),
        (children) => Effect.sync(() => children.forEach((child) => child.kill())),
      ),
    )
    expect(codes).toEqual(codes.map(() => 0))
    expect(codes.length).toBe(8)
    for (const copy of stored(held.path)) expect(Match.value(copy).pipe(Match.when(Match.string, () => []), Match.orElse((store) => store.excluded.flatMap((entry) => entry.ids).toSorted()))).toEqual(Array.from({ length: 8 }, (_, at) => `nDinghy${at}`))
  }, 30_000)
})

/** Both copies' bytes as they are now ("absent" for none), to tell that a refused command wrote nothing. */
const bytes = (dir: string) => [join(dir, "state/devices.json"), join(dir, "config/opencode-digest/devices.json")].map((path) => (existsSync(path) && readFileSync(path, "utf8")) || "absent")

// Round 4's B1 (the verifier's probe-B1, adopted): `--id` keyed any ID, so a typo or a colleague's ID counted as keyed
// and opened the tailnet while the real device was not excluded. The store now only ever gains an ID that is, in a
// status read under its lock, a device of his own user; every write path (by name, by --id) goes through that check.
describe("digest devices: the store only ever gains an ID of one of his devices", () => {
  const DEVICES = [
    { name: "lenovo-rescue", id: "nL1", user: 7, os: "linux", seen: "2026-08-11T01:16:53Z" },
    { name: "cristians-macbook-pro-rex", id: "nRex1", user: 7, os: "macOS", seen: "2026-11-19T23:37:29Z" },
    { name: "theirs", id: "nTheirs", user: 9, os: "windows", seen: "2026-11-20T10:00:00Z" },
  ]

  test("--id of no device of his (a typo, a colleague's) is refused for exclude and agent: exit 1, both copies byte for byte as they were", async () => {
    using held = scratch("digest-devices-id-")
    const cli = fakeCli(held.path, DEVICES)
    for (const [kind, name, id] of [["exclude", "lenovo-rescue", "nL1typo"], ["exclude", "lenovo-rescue", "nTheirs"], ["agent", "cristians-macbook-pro-rex", "nRextypo"], ["agent", "cristians-macbook-pro-rex", "nTheirs"]] as const) {
      const before = bytes(held.path)
      const refused = await run(held.path, cli, kind, name, "--id", id)
      expect([kind, id, refused.code, bytes(held.path)]).toEqual([kind, id, 1, before])
      expect(refused.out).not.toContain("Keyed")
    }
    // Then his device's own ID is keyed, and a later typo leaves those bytes alone.
    expect((await run(held.path, cli, "exclude", "lenovo-rescue", "--id", "nL1")).code).toBe(0)
    const keyed = bytes(held.path)
    expect((await run(held.path, cli, "exclude", "lenovo-rescue", "--id", "nL1typo")).code).toBe(1)
    expect(bytes(held.path)).toEqual(keyed)
    expect(stored(held.path)).toEqual([0, 1].map(() => ({ v: 1, agents: [], excluded: [{ name: "lenovo-rescue", ids: ["nL1"] }] })))
  })

  test("probe-B1 adopted: after a typo --id, lenovo renamed is still no member of his (the store keys nothing, everything is paired), and the same for an agent typo", async () => {
    using held = scratch("digest-devices-id-")
    fakeCli(held.path, DEVICES)
    await run(held.path, join(held.path, "tailscale"), "exclude", "lenovo-rescue", "--id", "nL1typo")
    await run(held.path, join(held.path, "tailscale"), "agent", "cristians-macbook-pro-rex", "--id", "nRextypo")
    // lenovo renamed lenovo-x, rex renamed rex-2, and his laptop took rex's name.
    const cli = fakeCli(held.path, [
      { name: "lenovo-x", id: "nL1", user: 7, os: "linux", seen: "2026-08-11T01:16:53Z" },
      { name: "rex-2", id: "nRex1", user: 7, os: "macOS", seen: "2026-11-19T23:37:29Z" },
      { name: "cristians-macbook-pro-rex", id: "nLaptop", user: 7, os: "linux", seen: "2026-11-20T10:00:00Z" },
    ])
    const read = await Effect.runPromise(statusFrom([cli]))
    const copies = await Effect.runPromise(FileDevices.readCopies(FileDevices.pathsOf(join(held.path, "state"), join(held.path, "config"))))
    const members = membersWith("member-except-hosts", keysOf({ agentHosts: ["cristians-macbook-pro-rex"], excluded: ["lenovo-rescue"] }, copies[0], copies[1]), read, Date.now())
    // 100.101.102.130 is lenovo-x, .131 rex-2 (fakeCli numbers the peers from .130).
    expect([sourceOf("100.101.102.130", members), sourceOf("100.101.102.131", members), members.write, members.why]).toEqual(["other", "other", "paired", "unkeyed:lenovo-rescue:agent-unkeyed:cristians-macbook-pro-rex:store-absent/absent"])
  })

  test("with Tailscale's status unreadable or not running, nothing is added, by --id or by name; a removal still runs", async () => {
    using held = scratch("digest-devices-id-")
    const cli = fakeCli(held.path, DEVICES)
    expect((await run(held.path, cli, "exclude", "lenovo-rescue")).code).toBe(0)
    const keyed = bytes(held.path)
    for (const args of [["exclude", "cristians-macbook-pro-rex", "--id", "nRex1"], ["agent", "cristians-macbook-pro-rex", "--id", "nRex1"], ["agent", "cristians-macbook-pro-rex"]]) {
      expect([args, (await run(held.path, "/nonexistent/loop-probe-x", ...args)).code, bytes(held.path)]).toEqual([args, 1, keyed])
    }
    // A rerun of what is there adds nothing: it needs no status.
    expect((await run(held.path, "/nonexistent/loop-probe-x", "exclude", "lenovo-rescue", "--id", "nL1")).code).toBe(0)
    writeFileSync(join(held.path, "stopped"), '{"BackendState":"Stopped","Self":{"UserID":7},"Peer":{}}')
    writeFileSync(join(held.path, "tailscale-stopped"), `#!/bin/sh\ncat '${join(held.path, "stopped")}'\n`, { mode: 0o755 })
    expect([(await run(held.path, join(held.path, "tailscale-stopped"), "agent", "cristians-macbook-pro-rex", "--id", "nRex1")).code, bytes(held.path)]).toEqual([1, keyed])
    expect((await run(held.path, "/nonexistent/loop-probe-x", "forget", "exclude", "lenovo-rescue")).code).toBe(0)
  })

  test("forget of a name not in the store says so, exits 1 and writes nothing", async () => {
    using held = scratch("digest-devices-id-")
    const cli = fakeCli(held.path, DEVICES)
    expect((await run(held.path, cli, "exclude", "lenovo-rescue")).code).toBe(0)
    const keyed = bytes(held.path)
    for (const args of [["forget", "exclude", "lenovo-rescu"], ["forget", "agent", "lenovo-rescue"]]) expect([args, (await run(held.path, cli, ...args)).code, bytes(held.path)]).toEqual([args, 1, keyed])
  })

  test("a full MagicDNS name, any case, keys the entry under the name the installer ships", async () => {
    using held = scratch("digest-devices-id-")
    const cli = fakeCli(held.path, DEVICES)
    const keyed = await run(held.path, cli, "exclude", "Lenovo-Rescue.example-tailnet.ts.net.")
    expect([keyed.code, keyed.out.includes("as lenovo-rescue, the form the installer ships")]).toEqual([0, true])
    expect((await run(held.path, cli, "agent", "cristians-macbook-pro-rex.example-tailnet.ts.net", "--id", "nRex1")).code).toBe(0)
    expect(stored(held.path)[0]).toEqual({ v: 1, agents: [{ name: "cristians-macbook-pro-rex", ids: ["nRex1"] }], excluded: [{ name: "lenovo-rescue", ids: ["nL1"] }] })
    expect((await run(held.path, cli, "forget", "exclude", "lenovo-rescue.example-tailnet.ts.net")).code).toBe(0)
  })
})
