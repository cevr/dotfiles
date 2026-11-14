// The workbox's pinned Bun CLIs: each tool's lock resolves a consistent Effect
// tree, and install-bun-tools installs each tool in its own project and links
// its commands without replacing a link the owner made by hand. The install
// runs against a stub `bun` in a scratch HOME; nothing touches the real host.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const workbox = join(import.meta.dir, "..")
const toolsDir = join(workbox, "bun-tools")
const tools = readdirSync(toolsDir).filter((name) => lstatSync(join(toolsDir, name)).isDirectory())
const scratchRoot = mkdtempSync(join(tmpdir(), "bun-tools-test-"))
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }))

type Manifest = { dependencies: Record<string, string>; overrides?: Record<string, string> }
type Lock = {
  workspaces: { "": { dependencies: Record<string, string> } }
  overrides?: Record<string, string>
  packages: Record<string, [string, string, { peerDependencies?: Record<string, string> }?, string?]>
}

const manifest = (tool: string): Manifest => JSON.parse(readFileSync(join(toolsDir, tool, "package.json"), "utf8"))
const lock = (tool: string): Lock => Bun.JSONC.parse(readFileSync(join(toolsDir, tool, "bun.lock"), "utf8")) as Lock
const version = (entry: Lock["packages"][string]) => entry[0].slice(entry[0].lastIndexOf("@") + 1)

/** The `effect` a package at lock key `key` resolves: its own nested copy, then each parent's, then the root. */
const effectFor = (packages: Lock["packages"], key: string) => {
  const parts = key.split("/")
  for (let end = parts.length; end > 0; end--) {
    const entry = packages[[...parts.slice(0, end), "effect"].join("/")]
    if (entry) return version(entry)
  }
  return packages["effect"] ? version(packages["effect"]) : undefined
}

describe("bun-tools locks", () => {
  test("there is a tool per pinned CLI, and @cvr/linear is one", () => {
    expect(tools.map((tool) => Object.keys(manifest(tool).dependencies)).flat()).toContain("@cvr/linear")
  })

  for (const tool of tools) {
    test(`${tool}: one exact pin, and the lock matches package.json`, () => {
      const { dependencies, overrides } = manifest(tool)
      const pins = Object.values(dependencies)
      expect(pins).toHaveLength(1)
      expect(pins[0]).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/)
      expect(lock(tool).workspaces[""].dependencies).toEqual(dependencies)
      expect(lock(tool).overrides ?? {}).toEqual(overrides ?? {})
    })

    test(`${tool}: every package's effect peer range holds the effect it resolves`, () => {
      const { packages } = lock(tool)
      const broken = Object.entries(packages).flatMap(([key, entry]) => {
        const range = entry[2]?.peerDependencies?.effect
        if (!range) return []
        const effect = effectFor(packages, key)
        return effect && Bun.semver.satisfies(effect, range) ? [] : [`${version(entry)} ${key} wants effect ${range}, gets ${effect}`]
      })
      expect(broken).toEqual([])
    })
  }
})

// ---------------------------------------------------------------- install-bun-tools

/** A `bun` that answers `install --frozen-lockfile` by laying out the package its project pins, with one command. */
const stubBun = (dir: string, log: string) => {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "bun")
  writeFileSync(
    file,
    `#!/bin/sh
printf '%s %s\\n' "$PWD" "$*" >> '${log}'
[ "$*" = "install --frozen-lockfile" ] || exit 1
package=$(jq -er '.dependencies | keys[0]' package.json)
command=\${package##*/}
mkdir -p "node_modules/$package/bin" node_modules/.bin
printf '{"name":"%s","bin":{"%s":"bin/%s"}}' "$package" "$command" "$command" > "node_modules/$package/package.json"
printf '#!/bin/sh\\necho %s\\n' "$package" > "node_modules/$package/bin/$command"
chmod +x "node_modules/$package/bin/$command"
ln -sfn "../$package/bin/$command" "node_modules/.bin/$command"
`,
  )
  chmodSync(file, 0o755)
}

const installTools = async (prepare: (bunBin: string, home: string) => void) => {
  const home = mkdtempSync(join(scratchRoot, "home-"))
  const bunBin = join(home, ".bun", "bin")
  const log = join(home, "bun.log")
  stubBun(bunBin, log)
  cpSync(toolsDir, join(home, ".config", "bite-workbox", "bun-tools"), { recursive: true })
  prepare(bunBin, home)
  const proc = Bun.spawn(["/bin/sh", join(workbox, "bin", "install-bun-tools")], {
    env: { HOME: home, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  const projects = join(home, ".local", "share", "bite-workbox", "bun-tools")
  return { home, bunBin, projects, stderr, code, installs: readFileSync(log, "utf8").split("\n").filter(Boolean) }
}

describe("install-bun-tools", () => {
  test("installs each tool in its own project from its lock and links its command", async () => {
    const run = await installTools(() => {})
    expect(run.code).toBe(0)
    expect(run.installs.sort()).toEqual(tools.map((tool) => `${join(run.projects, tool)} install --frozen-lockfile`).sort())
    for (const tool of tools) {
      expect(readFileSync(join(run.projects, tool, "bun.lock"), "utf8")).toBe(readFileSync(join(toolsDir, tool, "bun.lock"), "utf8"))
    }
    expect(readlinkSync(join(run.bunBin, "linear"))).toBe(join(run.projects, "cvr-linear", "node_modules", ".bin", "linear"))
  })

  test("replaces a link into the old global tree, keeps a hand-made link and a plain file", async () => {
    const run = await installTools((bunBin, home) => {
      symlinkSync("../install/global/node_modules/@cvr/linear/bin/linear", join(bunBin, "linear"))
      symlinkSync(join(home, "Developer", "okra", "bin", "okra"), join(bunBin, "okra"))
      writeFileSync(join(bunBin, "stacked"), "#!/bin/sh\n")
    })
    expect(run.code).toBe(0)
    expect(readlinkSync(join(run.bunBin, "linear"))).toBe(join(run.projects, "cvr-linear", "node_modules", ".bin", "linear"))
    expect(readlinkSync(join(run.bunBin, "okra"))).toBe(join(run.home, "Developer", "okra", "bin", "okra"))
    expect(lstatSync(join(run.bunBin, "stacked")).isSymbolicLink()).toBe(false)
    expect(run.stderr).toContain(`keeping ${join(run.bunBin, "okra")}`)
  })

  test("a second run is a no-op for the links", async () => {
    const run = await installTools(() => {})
    const again = Bun.spawn(["/bin/sh", join(workbox, "bin", "install-bun-tools")], {
      env: { HOME: run.home, PATH: "/usr/bin:/bin:/opt/homebrew/bin" },
      stderr: "pipe",
    })
    const [stderr, code] = await Promise.all([new Response(again.stderr).text(), again.exited])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(readlinkSync(join(run.bunBin, "linear"))).toBe(join(run.projects, "cvr-linear", "node_modules", ".bin", "linear"))
  })
})
