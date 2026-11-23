// accept: deep (30.9 s alone on a quiet host: 1-minute load 6.7–7.2 on 12 cores; it boots real OpenCode and drives its scenario through events that take that long)
// Public UI seam: real OpenCode, the real pool and status plugins, a login
// store on disk and a fake token endpoint. A pooled store login whose refresh
// token the endpoint refuses shows in the sidebar's Pool section, with the
// slot file to sign it in to again, and as a toast; once it is signed in again,
// a refresh that succeeds clears both. scenarios/lost-login.ts drives it.
import { describe, expect, test } from "bun:test"
import { Array as Arr } from "effect"
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
    // and alpha's slot. Compared without the wrapping's spaces. It runs until the
    // sidebar's first blank row, however many rows its path wraps to.
    const column = rows[first + 1]?.indexOf("alpha") ?? -1
    const wrapped = Arr.takeWhile(rows.slice(first + 2).map((row) => row.slice(column)), (row) => row.trim() !== "").join("")
    const slot = join(out, "store-auth/.slots/anthropic/alpha")
    const squeeze = (text: string) => text.replace(/\s+/g, "")
    expect(squeeze(wrapped)).toStartWith(squeeze(`sign in again into ${slot}`))
    // The toast, before the section: its title and the same slot file.
    const toast = readFileSync(join(out, "lost-login-toast.txt"), "utf8")
    expect(toast).toContain("Pool login alpha is signed out")
    // The toast's box sits beside the session pane, so its lines interleave with it: read its
    // column, each row up to the box's right border, from the message's first row to the box's
    // first blank row, however many rows the slot file's path wraps to.
    const toastRows = toast.split("\n")
    const message = toastRows.findIndex((row) => row.includes("The token endpoint refused"))
    const toastColumn = toastRows[message]?.indexOf("The token endpoint refused") ?? -1
    expect(toastColumn).toBeGreaterThan(-1)
    const inBox = toastRows.slice(message).map((row) => row.slice(toastColumn).split("┃")[0] ?? "")
    const said = Arr.takeWhile(inBox, (row) => row.trim() !== "").join("")
    expect(squeeze(said)).toStartWith(squeeze(`The token endpoint refused its refresh token. Sign it in again into ${slot}`))
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
