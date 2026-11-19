// workbox/bin/workbox-rift-storage --fstab, run on a scratch fstab with shims for findmnt (the loop device the
// image is mounted from), sudo (runs the command as is), systemctl (logs its arguments) and a scratch
// /sys/fs/btrfs. The fstab is the workbox's own of 2026-11-19, whose UUID= lines for @home and @tmp failed the boot
// (systemd-udevd is masked there, so /dev/disk/by-uuid never appears). Nothing here touches the real host.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const SCRIPT = join(import.meta.dir, "..", "bin", "workbox-rift-storage")
const scratchRoot = realpathSync(mkdtempSync(join(tmpdir(), "rift-storage-test-")))
afterAll(() => rmSync(scratchRoot, { recursive: true, force: true }))
let count = 0

const UUID = "170ee675-18a3-48e1-931d-f0a84a51df83"
const OTHER = "0b7c1c55-0000-4000-8000-000000000001"
const IMAGE = "/var/lib/bite-workspaces.btrfs"
const OPTS = "noatime,compress=zstd:3,space_cache=v2,discard=async"

const WORKBOX_FSTAB = [
  "/dev/vda / ext4 defaults,x-systemd.growfs 0 1",
  "/swapfile none swap sw 0 0",
  `${IMAGE} /workspaces btrfs loop,noatime,user_subvol_rm_allowed,compress=zstd:3,space_cache=v2,discard=async,subvol=@workspaces 0 0`,
  `UUID=${UUID} /home/exedev btrfs subvol=@home,${OPTS},x-systemd.requires-mounts-for=/workspaces 0 0`,
  `UUID=${UUID} /tmp btrfs subvol=@tmp,${OPTS},x-systemd.requires-mounts-for=/workspaces 0 0`,
  // Another btrfs by UUID, as a disk udev does see would be: not the image's, so it stays.
  `UUID=${OTHER} /data btrfs subvol=@data,noatime 0 0`,
  "",
].join("\n")

const exe = (path: string, body: string) => {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

const bench = (fstabText: string) => {
  const dir = join(scratchRoot, `b-${count++}`)
  const bin = join(dir, "bin")
  const sys = join(dir, "sys")
  mkdirSync(bin, { recursive: true })
  for (const [uuid, device] of [[UUID, "loop0"], [OTHER, "vdb"]] as const) {
    mkdirSync(join(sys, uuid, "devices"), { recursive: true })
    writeFileSync(join(sys, uuid, "devices", device), "")
  }
  const etc = join(dir, "etc")
  mkdirSync(etc)
  const fstab = join(etc, "fstab")
  writeFileSync(fstab, fstabText)
  const calls = join(dir, "systemctl-calls")
  exe(join(bin, "findmnt"), `#!/bin/sh\ncase "$*" in *--mountpoint*) echo '/dev/loop0[/@workspaces]' ;; esac\n`)
  exe(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n')
  exe(join(bin, "systemctl"), `#!/bin/sh\necho "$*" >>'${calls}'\n`)
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, WORKBOX_RIFT_FSTAB: fstab, WORKBOX_SYSFS_BTRFS: sys }
  const run = () => {
    const ran = Bun.spawnSync(["sh", SCRIPT, "--fstab"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })
    return { code: ran.exitCode, out: ran.stdout.toString(), err: ran.stderr.toString() }
  }
  const reloads = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "").split("\n").filter((line) => line !== "")
  const backups = () => readdirSync(etc).filter((name) => name.startsWith("fstab.workbox-rift-storage."))
  return { etc, fstab, run, reloads, backups }
}

describe("workbox-rift-storage --fstab", () => {
  test("mounts @home and @tmp from the image file with loop, after /workspaces, keeps every other line, backs up, reloads once, and a rerun changes nothing", () => {
    const b = bench(WORKBOX_FSTAB)
    const ran = b.run()
    expect(ran.code, ran.err).toBe(0)
    expect(readFileSync(b.fstab, "utf8")).toBe(
      WORKBOX_FSTAB.replace(
        `UUID=${UUID} /home/exedev btrfs subvol=@home,`,
        `${IMAGE} /home/exedev btrfs loop,subvol=@home,`,
      ).replace(`UUID=${UUID} /tmp btrfs subvol=@tmp,`, `${IMAGE} /tmp btrfs loop,subvol=@tmp,`),
    )
    expect(b.backups().length).toBe(1)
    expect(readFileSync(join(b.etc, b.backups()[0] ?? ""), "utf8")).toBe(WORKBOX_FSTAB)
    expect(b.reloads()).toEqual(["daemon-reload"])

    const fixed = readFileSync(b.fstab, "utf8")
    const again = b.run()
    expect(again.code, again.err).toBe(0)
    expect(again.out).toContain("no fstab line mounts the image by UUID")
    expect(readFileSync(b.fstab, "utf8")).toBe(fixed)
    expect(b.backups().length).toBe(1)
    expect(b.reloads()).toEqual(["daemon-reload"])
  })

  test("a UUID= line of the image with no order after /workspaces gets one", () => {
    const b = bench(`${IMAGE} /workspaces btrfs loop,subvol=@workspaces 0 0\nUUID=${UUID} /home/exedev btrfs subvol=@home 0 0\n`)
    expect(b.run().code).toBe(0)
    expect(readFileSync(b.fstab, "utf8")).toBe(
      `${IMAGE} /workspaces btrfs loop,subvol=@workspaces 0 0\n${IMAGE} /home/exedev btrfs loop,subvol=@home,x-systemd.requires-mounts-for=/workspaces 0 0\n`,
    )
  })

  test("a box whose /workspaces is a subvolume of its own btrfs by UUID (the Hetzner box) changes nothing", () => {
    const native = `UUID=${UUID} /workspaces btrfs subvol=@workspaces,noatime 0 0\nUUID=${UUID} /home/exedev btrfs subvol=@home 0 0\n`
    const b = bench(native)
    const ran = b.run()
    expect(ran.code, ran.err).toBe(0)
    expect(readFileSync(b.fstab, "utf8")).toBe(native)
    expect(b.backups()).toEqual([])
    expect(b.reloads()).toEqual([])
  })
})
