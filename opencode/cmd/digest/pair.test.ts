// `digest pair` over a scratch digest folder: the link it prints carries a code that pairs one browser once, the
// pairing file is the owner's alone (0600), and a port that is not one is refused before anything is written.
import { describe, expect, test } from "bun:test"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { Clock, Effect, Exit, Ref } from "effect"
import { scratch } from "../../tests/scratch.ts"
import * as FilePairing from "@dotfiles/opencode-digest/filestore/pairing"
import { main } from "./pair.ts"

const said = async (args: ReadonlyArray<string>) => {
  const printed = Effect.runSync(Ref.make<ReadonlyArray<string>>([]))
  const code = await Effect.runPromise(main(args, (text) => Ref.update(printed, (all) => [...all, text])))
  return { code, text: Effect.runSync(Ref.get(printed)).join("\n") }
}

describe("digest pair", () => {
  test("prints the page's link with a one-use code; the code pairs once; the file is 0600", async () => {
    using held = scratch("digest-pair-")
    const dir = join(held.path, "digest")
    const { code, text } = await said(["--dir", dir, "--port", "8299"])
    expect(code).toBe(0)
    const link = /http:\/\/127\.0\.0\.1:8299\/#pair=([A-Z0-9]+)/.exec(text)
    expect(link).not.toBeNull()
    const pairing = FilePairing.make(dir)
    const given = String(link?.[1])
    const first = await Effect.runPromise(Effect.exit(Effect.flatMap(Clock.currentTimeMillis, (now) => pairing.exchange(given, now))))
    const again = await Effect.runPromise(Effect.exit(Effect.flatMap(Clock.currentTimeMillis, (now) => pairing.exchange(given, now))))
    expect([Exit.isSuccess(first), Exit.isSuccess(again)]).toEqual([true, false])
    expect(statSync(join(dir, FilePairing.FILE)).mode & 0o777).toBe(0o600)
  })

  test("a port that is not one: exit 1, nothing written", async () => {
    using held = scratch("digest-pair-")
    const dir = join(held.path, "digest")
    const { code } = await said(["--dir", dir, "--port", "70000"])
    expect(code).toBe(1)
    expect(existsSync(join(dir, FilePairing.FILE))).toBe(false)
  })
})
