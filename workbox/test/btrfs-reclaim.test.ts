// workbox/systemd/system/workbox-btrfs-reclaim, which workbox-btrfs-reclaim.service runs at boot, on a scratch
// /sys/fs/btrfs with a findmnt shim. Nothing here touches the real host.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { readScratchFileSync as readFileSync, scratchExistsSync } from "../../opencode/tests/read-path.ts"
import { spawnCheckoutShellSync } from "../../opencode/tests/scratch-child.ts"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = "../workbox/systemd/system/workbox-btrfs-reclaim"
const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "btrfs-reclaim-test-")))
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }))
let count = 0

/** A sysfs of two btrfs file systems (the image on loop0, another on vdb) and a findmnt that names `source`. */
const bench = (source: string, knobs = true) => {
  const dir = join(scratchRoot, `b-${count++}`)
  const bin = join(dir, "bin")
  const sys = join(dir, "sys")
  mkdirSync(bin, { recursive: true })
  const knob = (uuid: string) => join(sys, uuid, "allocation/data/dynamic_reclaim")
  for (const [uuid, device] of [["image-uuid", "loop0"], ["other-uuid", "vdb"]] as const) {
    mkdirSync(join(sys, uuid, "devices"), { recursive: true })
    writeFileSync(join(sys, uuid, "devices", device), "")
    if (knobs) {
      mkdirSync(join(sys, uuid, "allocation/data"), { recursive: true })
      writeFileSync(knob(uuid), "0\n")
    }
  }
  writeFileSync(join(bin, "findmnt"), `#!/bin/sh\n[ -n '${source}' ] && echo '${source}'\nexit 0\n`)
  chmodSync(join(bin, "findmnt"), 0o755)
  const ran = spawnCheckoutShellSync(dir, SCRIPT, [join(dir, "workspaces")], { tools: bin, paths: { WORKBOX_SYSFS_BTRFS: sys } })
  const read = (uuid: string) => (scratchExistsSync(knob(uuid)) ? readFileSync(knob(uuid), "utf8") : undefined)
  return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString(), read }
}

describe("workbox-btrfs-reclaim", () => {
  test("turns dynamic reclaim on for the btrfs /workspaces is mounted from (a subvolume of a loop device), and no other", () => {
    const b = bench("/dev/loop0[/@workspaces]")
    expect(b.code, b.err).toBe(0)
    expect(b.read("image-uuid")).toBe("1\n")
    expect(b.read("other-uuid")).toBe("0\n")
    expect(b.out).toContain("dynamic reclaim is on for image-uuid")
  })

  test("a kernel with no dynamic_reclaim knob is left alone and the unit still succeeds", () => {
    const b = bench("/dev/loop0[/@workspaces]", false)
    expect(b.code, b.err).toBe(0)
    expect(b.read("image-uuid")).toBeUndefined()
    expect(b.out).toContain("left as it is")
  })

  test("nothing mounted at /workspaces, or a device of no btrfs, fails and writes nothing", () => {
    for (const source of ["", "/dev/vda"]) {
      const b = bench(source)
      expect(b.code).toBe(1)
      expect(b.read("image-uuid")).toBe("0\n")
      expect(b.read("other-uuid")).toBe("0\n")
    }
  })
})
