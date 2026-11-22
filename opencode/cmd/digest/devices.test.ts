// `digest devices`, the one way an ID enters or leaves the device store: it looks a name up once, among this host's
// own user's devices only, says which device it found so a human can confirm it, and writes both copies; with none or
// several it writes nothing. Two commands at once both land. Every run here uses scratch copies and a fake CLI.
import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Match, Path } from "effect"
import { copyOfText } from "@dotfiles/opencode-digest/devices"
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
    const direct = await run(held.path, "/nonexistent/loop-probe-x", "agent", "skiff", "--id", "nSkiff1")
    expect(direct.code).toBe(0)
    expect(stored(held.path)[0]).toEqual({ v: 1, agents: [{ name: "skiff", ids: ["nSkiff1"] }], excluded: [] })
  })

  test("list shows both copies' condition and what each ID is now; forget removes a name, explicitly", async () => {
    using held = scratch("digest-devices-cli-")
    const cli = fakeCli(held.path, [{ name: "lifeboat", id: "nDinghy1", user: 7, os: "linux", seen: "2026-11-20T10:00:00Z" }])
    await run(held.path, cli, "exclude", "dinghy", "--id", "nDinghy1")
    await run(held.path, cli, "exclude", "dinghy", "--id", "nDinghy0")
    const listed = await run(held.path, cli, "list")
    expect(listed.out.split("\n").slice(2)).toEqual(["  exclude dinghy: 2 ID(s)", "    nDinghy1: lifeboat.example-tailnet.ts.net  linux  last seen 2026-11-20T10:00:00Z  ID nDinghy1", "    nDinghy0: no device of yours now"])
    expect(listed.out.split("\n").slice(0, 2).map((line) => line.split(": ")[1])).toEqual(["ok", "ok"])
    expect((await run(held.path, cli, "forget", "exclude", "dinghy")).code).toBe(0)
    expect(stored(held.path)[1]).toEqual({ v: 1, agents: [], excluded: [] })
    expect((await run(held.path, cli, "frobnicate")).code).toBe(1)
  })

  test("eight commands at once, each adding an ID: every ID lands in both copies (the lock)", async () => {
    using held = scratch("digest-devices-cli-")
    // Each in its own process group, killed whole when the case ends, however it ends.
    const codes = await Effect.runPromise(
      Effect.acquireUseRelease(
        Effect.map(commandFile, (command) => Array.from({ length: 8 }, (_, at) => Bun.spawn(["bun", command, "exclude", "dinghy", "--id", `nDinghy${at}`, "--dir", join(held.path, "state"), "--config", join(held.path, "config"), "--cli", "/nonexistent/loop-probe-x"], { stdout: "ignore", stderr: "pipe", detached: true }))),
        (children) => Effect.forEach(children, (child) => Effect.promise(() => child.exited), { concurrency: children.length }).pipe(Effect.timeout("20 seconds"), Effect.orDie),
        (children) => Effect.sync(() => children.forEach((child) => child.kill())),
      ),
    )
    expect(codes).toEqual(codes.map(() => 0))
    expect(codes.length).toBe(8)
    for (const copy of stored(held.path)) expect(Match.value(copy).pipe(Match.when(Match.string, () => []), Match.orElse((store) => store.excluded.flatMap((entry) => entry.ids).toSorted()))).toEqual(Array.from({ length: 8 }, (_, at) => `nDinghy${at}`))
  }, 30_000)
})
