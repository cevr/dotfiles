// The workbox's zshenv, linked as ~/.zshenv by bootstrap.sh, is what every agent shell on the workbox reads
// (zsh reads it for every shell, a `zsh -c` one too). It runs here in a scratch HOME with nothing else in the
// environment; nothing touches the real host.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const zshenv = join(import.meta.dir, "..", "zshenv")
const home = mkdtempSync(join(tmpdir(), "zshenv-test-"))
symlinkSync(zshenv, join(home, ".zshenv"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** A made-up token: the real one never enters this repository. */
const fake = "fake-turbo-token-0123"

/** What a fresh `zsh -c` shell of the scratch HOME prints for `script`, with `env` added. */
const shell = (script: string, env: Record<string, string> = {}) => {
  const run = Bun.spawnSync(["zsh", "-c", script], {
    env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

/** The value `name` has in a fresh `zsh -c` shell of the scratch HOME. */
const shellValue = (name: string, env: Record<string, string> = {}) =>
  shell(`print -r -- "\${${name}-unset}"`, env).stdout.trim()

let n = 0
/** A Dockerfile in the scratch HOME holding `text`; the zshenv reads it through its test seam. */
const dockerfile = (text: string) => {
  const path = join(home, `Dockerfile-${n++}`)
  writeFileSync(path, text)
  return path
}

/** TURBO_CACHE and TURBO_TOKEN in a fresh shell that reads the Dockerfile at `path`, and what it printed. */
const turbo = (path: string, env: Record<string, string> = {}) => {
  const seam = { WORKBOX_TURBO_DOCKERFILE: path, ...env }
  const quiet = shell("true", seam)
  return {
    cache: shellValue("TURBO_CACHE", seam),
    token: shellValue("TURBO_TOKEN", seam),
    printed: quiet.stdout + quiet.stderr,
  }
}

const head = "FROM oven/bun:1.4.4-slim AS base\n\nENV TURBO_API=https://cache.example\nENV TURBO_TEAM=team\n"
const tail = "\nRUN apt-get update && apt-get install -y \\\n  git\n"

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

  describe("remote turbo cache", () => {
    test.each([
      ["ENV K=V", `ENV TURBO_TOKEN=${fake}`],
      ["ENV K=\"V\"", `ENV TURBO_TOKEN="${fake}"`],
      ["ENV K='V'", `ENV TURBO_TOKEN='${fake}'`],
      ["ENV K V", `ENV TURBO_TOKEN ${fake}`],
      ["ENV K \"V\"", `ENV TURBO_TOKEN "${fake}"`],
      ["indented, CRLF", `  ENV  TURBO_TOKEN=${fake}\r`],
      ["ENV K=V with another pair after it", `ENV TURBO_TOKEN=${fake} OTHER=1`],
    ])("a Dockerfile token (%s) turns on the remote beside the local store", (_, line) => {
      expect(turbo(dockerfile(`${head}${line}\n${tail}`))).toEqual({ cache: "local:rw,remote:rw", token: fake, printed: "" })
    })

    test.each([
      ["no Dockerfile", () => join(home, "nonexistent", "Dockerfile")],
      ["no token line", () => dockerfile(`${head}${tail}`)],
      ["an empty value", () => dockerfile(`${head}ENV TURBO_TOKEN=\n${tail}`)],
      ["an empty quoted value", () => dockerfile(`${head}ENV TURBO_TOKEN=""\n${tail}`)],
      ["a commented-out line", () => dockerfile(`${head}# ENV TURBO_TOKEN=${fake}\n${tail}`)],
      ["another variable that ends in the name", () => dockerfile(`${head}ENV MY_TURBO_TOKEN=${fake}\n${tail}`)],
    ])("%s: the store stays local only, no token, nothing printed", (_, path) => {
      expect(turbo(path())).toEqual({ cache: "local:rw", token: "unset", printed: "" })
    })

    test.skipIf(process.getuid?.() === 0)("an unreadable Dockerfile: local only, no token, nothing printed", () => {
      const path = dockerfile(`${head}ENV TURBO_TOKEN=${fake}\n`)
      chmodSync(path, 0o000)
      expect(turbo(path)).toEqual({ cache: "local:rw", token: "unset", printed: "" })
    })

    test("a token already in the environment wins over the Dockerfile's", () => {
      const path = dockerfile(`${head}ENV TURBO_TOKEN=${fake}\n`)
      expect(turbo(path, { TURBO_TOKEN: "preset-token" })).toEqual({ cache: "local:rw,remote:rw", token: "preset-token", printed: "" })
    })

    test("a token already in the environment turns the remote on with no Dockerfile", () => {
      expect(turbo(join(home, "nonexistent"), { TURBO_TOKEN: "preset-token" })).toEqual({ cache: "local:rw,remote:rw", token: "preset-token", printed: "" })
    })
  })
})
