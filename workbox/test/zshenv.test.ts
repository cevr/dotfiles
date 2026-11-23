// The workbox's zshenv, linked as ~/.zshenv by bootstrap.sh, is what every agent shell on the workbox reads
// (zsh reads it for every shell, a `zsh -c` one too). It runs here in a scratch HOME with nothing else in the
// environment; nothing touches the real host.
// @reads ../workbox/zshenv ../zshenv
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { matchingInput } from "../../opencode/tests/read-path.ts"

const zshenv = matchingInput("../workbox/zshenv")
const home = mkdtempSync(join(tmpdir(), "zshenv-test-"))
symlinkSync(zshenv, join(home, ".zshenv"))
afterAll(() => rmSync(home, { recursive: true, force: true }))

/** A made-up token: the real one never enters this repository. */
const fake = "fake-turbo-token-0123"

/** What a fresh `zsh -c` shell of the scratch HOME, started in `cwd`, prints for `script`, with `env` added. */
const shell = (script: string, env: Record<string, string> = {}, cwd = home) => {
  const run = Bun.spawnSync(["zsh", "-c", script], {
    cwd,
    env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { stdout: run.stdout.toString(), stderr: run.stderr.toString() }
}

/** The value `name` has in a fresh `zsh -c` shell of the scratch HOME. */
const shellValue = (name: string, env: Record<string, string> = {}, cwd = home) =>
  shell(`print -r -- "\${${name}-unset}"`, env, cwd).stdout.trim()

let n = 0
/** A base checkout `<root>/bite` holding a Dockerfile of `text`, in its own scratch root; the Dockerfile's path. */
const dockerfile = (text: string) => {
  const base = join(home, `root-${n++}`, "bite")
  mkdirSync(base, { recursive: true })
  const path = join(base, "Dockerfile")
  writeFileSync(path, text)
  return path
}

/**
 * TURBO_CACHE and TURBO_TOKEN in a fresh shell that reads the Dockerfile at `path` (the zshenv's test seam), and
 * what it printed. The shell starts in `cwd`, by default the base checkout that holds the Dockerfile.
 */
const turbo = (path: string, env: Record<string, string> = {}, cwd = dirname(path)) => {
  const seam = { WORKBOX_TURBO_DOCKERFILE: path, ...env }
  const quiet = shell("true", seam, cwd)
  return {
    cache: shellValue("TURBO_CACHE", seam, cwd),
    token: shellValue("TURBO_TOKEN", seam, cwd),
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
    const mac = Bun.spawnSync(["zsh", "-fc", `source ${matchingInput("../zshenv")}; print -r -- "\${REX_SHOW_SIM_HOST-unset}"`], {
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
      ["no Dockerfile", () => {
        const path = dockerfile("")
        rmSync(path)
        return path
      }],
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
      const path = dockerfile("")
      rmSync(path)
      expect(turbo(path, { TURBO_TOKEN: "preset-token" })).toEqual({ cache: "local:rw,remote:rw", token: "preset-token", printed: "" })
    })
  })

  // The token reaches only the Bite tree: the base checkout that holds the Dockerfile and its workspaces in
  // work's storage beside it (`<parent>/.work/bite/…`, and Rift's older `<parent>/.rifts/bite/…`). A shell
  // anywhere else gets the store local only and no token, so no other repository's cache server sees it.
  describe("the token stays in the Bite tree", () => {
    const path = dockerfile(`${head}ENV TURBO_TOKEN=${fake}\n${tail}`)
    const root = dirname(dirname(path))
    const dir = (...parts: string[]) => {
      const at = join(root, ...parts)
      mkdirSync(at, { recursive: true })
      return at
    }
    const lane = dir(".work", "bite", "some-lane", "packages", "api")
    const link = join(home, `lane-link-${n++}`)
    symlinkSync(dirname(dirname(lane)), link)
    const inside = { cache: "local:rw,remote:rw", token: fake, printed: "" }
    const outside = { cache: "local:rw", token: "unset", printed: "" }

    test.each([
      ["the base checkout", () => dirname(path)],
      ["a folder of the base", () => dir("bite", "apps", "web")],
      ["a work lane", () => lane],
      ["an older Rift lane", () => dir(".rifts", "bite", "old-lane")],
      ["a symlinked path to a lane", () => link],
    ])("%s gets the token and the remote", (_, cwd) => {
      expect(turbo(path, {}, cwd())).toEqual(inside)
    })

    test.each([
      ["a sibling sharing the prefix (bite-other)", () => dir("bite-other")],
      ["another repository's lane", () => dir(".work", "dotfiles", "lane")],
      ["work's storage root itself", () => dir(".work")],
      ["another repository", () => dir("ergo")],
      ["HOME", () => home],
    ])("%s gets the store local only and no token", (_, cwd) => {
      expect(turbo(path, {}, cwd())).toEqual(outside)
    })

    test("a token inherited from a Bite shell is dropped in a shell started outside the tree", () => {
      expect(turbo(path, { TURBO_TOKEN: fake, TURBO_CACHE: "local:rw,remote:rw" }, dir("ergo"))).toEqual(outside)
    })

    test("a shell that cds out of the tree and starts another shell gives that one no token", () => {
      const run = shell(`cd ${JSON.stringify(dir("ergo"))} && zsh -c 'print -r -- "\${TURBO_TOKEN-unset} $TURBO_CACHE"'`, { WORKBOX_TURBO_DOCKERFILE: path }, lane)
      expect(run).toEqual({ stdout: "unset local:rw\n", stderr: "" })
    })
  })
})
