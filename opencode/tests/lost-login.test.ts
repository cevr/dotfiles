// Public UI seam: real OpenCode, the real pool and status plugins, a login
// store on disk and a fake token endpoint. A pooled store login whose refresh
// token the endpoint refuses shows in the sidebar's Pool section, with the
// slot file to sign it in to again, and as a toast; a refresh that succeeds
// clears both. scenarios/lost-login.ts drives it.
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { owned } from "./owned.ts"
import { keptScratch } from "./scratch.ts"

const fork = process.env.OPENCODE_DEV
if (!fork) console.warn("tests/lost-login.test.ts: skipped. Set OPENCODE_DEV to the fork.")
describe.skipIf(!fork)("a lost store login in the TUI", () => {
  const kept = keptScratch(Boolean(fork), "lost-login-")
  test("the sidebar and a toast name it with its slot file, and a good refresh clears both", kept.test(async () => {
    const out = kept.dir("lost-login-")
    const child = owned(["bunx", "opencode-drive", "run", "scenarios/lost-login.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, SCENARIO_OUT: out, OPENCODE_DRIVE_MEDIA_DIR: join(out, "media") },
      stdout: "pipe", stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    const timeout = join(out, "lost-login-timeout.txt")
    if (code !== 0) throw new Error(`lost-login scenario exited ${code}:\n${(stdout + stderr).slice(-5000)}\n${existsSync(timeout) ? readFileSync(timeout, "utf8") : ""}`)
    const frame = readFileSync(join(out, "lost-login.txt"), "utf8")
    // The sidebar shares its rows with the transcript, so match its lines in order.
    const rows = frame.split("\n")
    const at = (line: RegExp) => rows.findIndex((row) => line.test(row))
    const section = [/\sPool$/, /\salpha · signed out$/, /\ssign in again into/].map(at)
    const [first = -1] = section
    expect(first).toBeGreaterThan(-1)
    expect(section).toEqual([first, first + 1, first + 2])
    // The slot file, wrapped in the sidebar's column, names the store's directory
    // and alpha's slot. Compared without the wrapping's spaces.
    const column = rows[first + 1]?.indexOf("alpha") ?? -1
    const wrapped = rows.slice(first + 2, first + 9).map((row) => row.slice(column)).join("")
    const slot = join(out, "store-auth/.slots/anthropic/alpha")
    const squeeze = (text: string) => text.replace(/\s+/g, "")
    expect(squeeze(wrapped)).toStartWith(squeeze(`sign in again into ${slot}`))
    // The toast, before the section: its title and the same slot file.
    const toast = readFileSync(join(out, "lost-login-toast.txt"), "utf8")
    expect(toast).toContain("Pool login alpha is signed out")
    // The toast wraps beside the session pane, so its lines interleave with it.
    expect(toast).toContain("The token endpoint refused its refresh token. Sign it")
    expect(toast).toContain("in again into ")
    expect(toast).toContain("store-auth/.slots/anthropic/alpha")
    // alpha was asked for again and the refresh went through: both are gone.
    expect(readFileSync(join(out, "lost-login-asked"), "utf8")).toBe("2 resolved")
    const cleared = readFileSync(join(out, "lost-login-cleared.txt"), "utf8")
    expect(cleared).toContain("Session ready")
    expect(cleared).not.toContain("signed out")
    expect(cleared).not.toContain("sign in again into")
    // No token reaches the screen.
    for (const text of [toast, frame, cleared]) expect(text).not.toMatch(/fake-(access|refresh)-/)
  }), 150_000)
})
