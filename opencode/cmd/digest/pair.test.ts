// `digest pair` over a scratch digest folder:
// - The link it prints carries a code that pairs one browser once, and never a token.
// - The pairing file is the owner's alone (0600).
// - `--list` names the paired browsers, and `--revoke` unpairs one by id, or all.
// - A port that is not one is refused before anything is written.
// - With Tailscale up it names the page's tailnet addresses (invented here), where a phone types the code.
import { describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { Clock, Effect, Exit, Option, Ref } from "effect"
import { scratch } from "../../tests/scratch.ts"
import { NO_TAILNET, type Tailnet } from "@dotfiles/opencode-digest/bind"
import * as FilePairing from "@dotfiles/opencode-digest/filestore/pairing"
import { main } from "./pair.ts"

const said = async (args: ReadonlyArray<string>, tailnet: Tailnet = NO_TAILNET) => {
  const printed = Effect.runSync(Ref.make<ReadonlyArray<string>>([]))
  const code = await Effect.runPromise(main(args, (text) => Ref.update(printed, (all) => [...all, text]), Effect.succeed(tailnet)))
  return { code, text: Effect.runSync(Ref.get(printed)).join("\n") }
}

/** Pair through the code the command printed, as the page does. */
const pairWith = (dir: string, text: string) => {
  const code = String(/#pair=([A-Z0-9]+)/.exec(text)?.[1])
  return Effect.runPromise(Effect.exit(Effect.flatMap(Clock.currentTimeMillis, (now) => FilePairing.make(dir).exchange(code, now, "Invented Browser 1.0"))))
}

describe("digest pair", () => {
  test("prints the page's link with a one-use code; the code pairs once; the file is 0600", async () => {
    using held = scratch("digest-pair-")
    const dir = join(held.path, "digest")
    const { code, text } = await said(["--dir", dir, "--port", "8299"])
    expect(code).toBe(0)
    expect(text).toMatch(/http:\/\/127\.0\.0\.1:8299\/#pair=[A-Z0-9]{10}\n/)
    const first = await pairWith(dir, text)
    const again = await pairWith(dir, text)
    expect([Exit.isSuccess(first), Exit.isSuccess(again)]).toEqual([true, false])
    expect(statSync(join(dir, FilePairing.FILE)).mode & 0o777).toBe(0o600)
    expect(text).toContain("Tailscale is not running here")
  })

  test("with Tailscale up, it names the page's tailnet addresses, names first, and says each pairs on its own", async () => {
    using held = scratch("digest-pair-")
    const tailnet = { addresses: ["100.101.102.103", "fd7a:115c:a1e0::42"], names: ["harbor.example-tailnet.ts.net", "harbor"] }
    const { text } = await said(["--dir", join(held.path, "digest")], tailnet)
    expect(text.split("\n").slice(3)).toEqual([
      "On a phone or another device on your tailnet, open one of these and type the code:",
      "  http://harbor.example-tailnet.ts.net:8240/",
      "  http://harbor:8240/",
      "  http://100.101.102.103:8240/",
      "  http://[fd7a:115c:a1e0::42]:8240/",
      "Each address pairs on its own: a browser paired at one of them is asked to pair again at another.",
    ])
  })

  test("--list names each paired browser; --revoke unpairs one by its id, then all; an unknown id exits 1", async () => {
    using held = scratch("digest-pair-")
    const dir = join(held.path, "digest")
    expect((await said(["--dir", dir, "--list"])).text).toBe("No browser is paired.")
    const mac = Exit.match(await pairWith(dir, (await said(["--dir", dir])).text), { onSuccess: (paired) => paired, onFailure: () => ({ id: "", token: "" }) })
    const phone = Exit.match(await pairWith(dir, (await said(["--dir", dir])).text), { onSuccess: (paired) => paired, onFailure: () => ({ id: "", token: "" }) })
    const listed = (await said(["--dir", dir, "--list"])).text
    expect(listed).toContain(`  ${mac.id}  paired `)
    expect(listed).toContain(`  ${phone.id}  paired `)
    expect(listed).toContain("Invented Browser 1.0")
    expect(listed).not.toContain(mac.token)
    expect(await said(["--dir", dir, "--revoke", phone.id])).toEqual({ code: 0, text: "Unpaired 1 browser." })
    const pairing = FilePairing.make(dir)
    expect([Option.isSome(await Effect.runPromise(pairing.verify(mac.token))), Option.isSome(await Effect.runPromise(pairing.verify(phone.token)))]).toEqual([true, false])
    expect((await said(["--dir", dir, "--revoke", "nosuchid"])).code).toBe(1)
    expect(await said(["--dir", dir, "--revoke", "all"])).toEqual({ code: 0, text: "Unpaired 1 browser." })
    expect(Option.isSome(await Effect.runPromise(pairing.verify(mac.token)))).toBe(false)
  })

  test("a port that is not one: exit 1, nothing written", async () => {
    using held = scratch("digest-pair-")
    const dir = join(held.path, "digest")
    const { code } = await said(["--dir", dir, "--port", "70000"])
    expect(code).toBe(1)
    expect(existsSync(join(dir, FilePairing.FILE))).toBe(false)
  })
})
