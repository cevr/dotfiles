// The workbox's zshenv, linked as ~/.zshenv by bootstrap.sh, is what every agent shell on the workbox reads
// (zsh reads it for every shell, a `zsh -c` one too). It runs here in a scratch HOME with nothing else in the
// environment; nothing touches the real host.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const zshenv = join(import.meta.dir, "..", "zshenv")
const home = mkdtempSync(join(tmpdir(), "zshenv-test-"))
symlinkSync(zshenv, join(home, ".zshenv"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** The value `name` has in a fresh `zsh -c` shell of the scratch HOME. */
const shellValue = (name: string) => {
  const run = Bun.spawnSync(["zsh", "-c", `print -r -- "\${${name}-unset}"`], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  })
  return run.stdout.toString().trim()
}

describe.skipIf(!Bun.which("zsh"))("workbox zshenv", () => {
  test("an agent shell mirrors the Mac's simulator: rex-show sim reaches it over ssh", () => {
    expect(shellValue("REX_SHOW_SIM_HOST")).toBe("cvr@cristians-macbook-pro")
  })

  test("the Mac's own zshenv names no simulator host: there rex-show sim reads this host's", () => {
    const mac = Bun.spawnSync(["zsh", "-fc", `source ${join(import.meta.dir, "..", "..", "zshenv")}; print -r -- "\${REX_SHOW_SIM_HOST-unset}"`], {
      env: { HOME: home, PATH: "/usr/bin:/bin" },
      stdout: "pipe",
      stderr: "pipe",
    })
    expect(mac.stdout.toString().trim()).toBe("unset")
  })
})
