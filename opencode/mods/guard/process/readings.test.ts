// The Linux readings a host sample rests on, on the workbox's real output
// (read 2026-11-26, read-only, as its user; device names are its loop and
// shm devices, no hostnames, users or secrets), with extra fields and
// columns added, and broken. A failed reading names its file or command
// and the line.
import { describe, expect, test } from "bun:test"
import { Option, Result } from "effect"
import {
  controlGroupOf, dfFreeInodes, dfSizes, fsKindOf, keyed, meminfo, pressure, procTicks, swapPages, userPlaceOf, volumeReading,
} from "./readings.ts"

const DF_KP = `Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/loop0       796917760 663386052  99167996      87% /tmp`
const DF_KI_BTRFS = `Filesystem     Inodes IUsed IFree IUse% Mounted on
/dev/loop0          0     0     0     - /tmp`
const DF_KI_TMPFS = `Filesystem      Inodes IUsed   IFree IUse% Mounted on
shm            8229389     3 8229386    1% /dev/shm`
const DF_KI_MAC = `Filesystem 1024-blocks      Used Available Capacity  iused     ifree %iused  Mounted on
/dev/disk3s5 971350180 612345678 340000000    65% 3456789 3400000000    0%   /System/Volumes/Data`
const PROC_STAT = `cpu  22992133 107240677 22931007 151607504 5079491 0 3220044 44676762 0 0
cpu0 1309120 6328128 1427259 9983602 322882 0 942864 2896214 0 0
intr 4991020520 0 0 0
ctxt 5249338984
btime 1795439118
processes 19322730
procs_running 5
procs_blocked 0`
const VMSTAT = `nr_free_pages 305424
pswpin 1137209
pswpout 2048119
pgfault 22580534043`
const MEMINFO = `MemTotal:       65835112 kB
MemFree:         1221292 kB
MemAvailable:   54028780 kB`
const PSI_CPU = `some avg10=19.39 avg60=12.06 avg300=7.24 total=44930837818
full avg10=0.00 avg60=0.00 avg300=0.00 total=0`

const ok = <A>(reading: Result.Result<A, string>) => Result.getOrThrow(reading)
const why = <A>(reading: Result.Result<A, string>) => Result.match(reading, { onSuccess: () => "", onFailure: (text) => text })

describe("df", () => {
  test("df -kP gives the device, size, free blocks and mount; a wrapped row and a mount with spaces read the same", () => {
    expect(ok(dfSizes(DF_KP, "df -kP /tmp"))).toEqual({ device: "/dev/loop0", totalBlocks: 796917760, freeBlocks: 99167996, mount: "/tmp" })
    const wrapped = DF_KP.replace("/dev/loop0       ", "/dev/mapper/a-very-long-volume-name\n                 ")
    expect(ok(dfSizes(wrapped, "df -kP /tmp")).freeBlocks).toBe(99167996)
    expect(ok(dfSizes(DF_KP.replace("% /tmp", "% /mnt/My Volume"), "df -kP x")).mount).toBe("/mnt/My Volume")
  })
  test("free inodes by the header's IFree or ifree column; a filesystem with no inode count is dynamic", () => {
    expect(ok(dfFreeInodes(DF_KI_BTRFS, "df -ki /tmp"))).toBe("dynamic")
    expect(ok(dfFreeInodes(DF_KI_TMPFS, "df -ki /dev/shm"))).toBe(8229386)
    expect(ok(dfFreeInodes(DF_KI_MAC, "df -ki /"))).toBe(3400000000)
  })
  test("a broken df names the command and the line", () => {
    expect(why(dfSizes("Filesystem 1024-blocks Used Available Capacity Mounted on", "df -kP /x"))).toBe(
      "df -kP /x: no line below the header (read \"Filesystem 1024-blocks Used Available Capacity Mounted on\")")
    expect(why(dfSizes(DF_KP.replace("99167996", "lots"), "df -kP /tmp"))).toContain("df -kP /tmp: no Available count in \"/dev/loop0")
    expect(why(dfFreeInodes(DF_KI_TMPFS.replace("8229386", "-"), "df -ki /dev/shm"))).toContain("df -ki /dev/shm: no IFree count in \"shm")
  })
})

describe("a volume's reading by its filesystem kind", () => {
  const sizes = { capacityBytes: 100, freeBytes: 40, diskFloorBytes: 6 }
  test("btrfs reads its metadata and counts inodes dynamically; ext4 and tmpfs read df alone; an unknown kind reads as df says", () => {
    const usage = Option.some({ text: "Metadata,DUP: Size:1000, Used:400 (40.00%)", command: "btrfs filesystem usage -b /tmp" })
    expect(ok(volumeReading({ ...sizes, fsKind: fsKindOf("btrfs\n"), inodes: dfFreeInodes(DF_KI_BTRFS, "df"), btrfsUsage: usage })))
      .toEqual({ ...sizes, freeInodes: "dynamic", metadataFreeBytes: 600 })
    for (const kind of ["ext2/ext3", "tmpfs", "fuseblk", "zz-unknown"])
      expect(ok(volumeReading({ ...sizes, fsKind: kind, inodes: dfFreeInodes(DF_KI_TMPFS, "df"), btrfsUsage: Option.none() })))
        .toEqual({ ...sizes, freeInodes: 8229386, metadataFreeBytes: 40 })
  })
  test("btrfs with no metadata line fails naming its command", () => {
    const usage = Option.some({ text: "Data,single: Size:10, Used:5", command: "btrfs filesystem usage -b /tmp" })
    expect(why(volumeReading({ ...sizes, fsKind: "btrfs", inodes: Result.succeed("dynamic"), btrfsUsage: usage })))
      .toBe("btrfs filesystem usage -b /tmp: no Metadata Size/Used line")
  })
})

describe("/proc", () => {
  test("the workbox's /proc/stat, vmstat, meminfo and PSI read; extra fields and lines are ignored", () => {
    expect(ok(procTicks(PROC_STAT, 7))).toEqual({ at: 7, total: 22992133 + 107240677 + 22931007 + 151607504 + 5079491 + 0 + 3220044 + 44676762, idle: 151607504 })
    expect(ok(procTicks(PROC_STAT.replace("44676762 0 0", "44676762 0 0 9 9 9"), 7)).idle).toBe(151607504)
    expect(ok(keyed(PROC_STAT, "procs_running", "/proc/stat"))).toBe(5)
    expect(ok(swapPages(VMSTAT))).toBe(1137209 + 2048119)
    expect(ok(meminfo(MEMINFO, "MemAvailable"))).toBe(54028780)
    expect(ok(pressure(PSI_CPU, "some", "/proc/pressure/cpu"))).toBe(19.39)
    expect(ok(pressure("some avg10=3.98\n", "some", "/proc/pressure/io"))).toBe(3.98)
  })
  test("a broken /proc reading names its file and its line", () => {
    expect(why(procTicks("cpu  1 2 3\nprocs_running 1", 0))).toBe("/proc/stat: fewer than 8 counters in \"cpu  1 2 3\"")
    expect(why(procTicks("intr 1", 0))).toBe("/proc/stat: no aggregate cpu line")
    expect(why(keyed(PROC_STAT.replace("procs_running 5", "procs_running x"), "procs_running", "/proc/stat")))
      .toBe("/proc/stat: procs_running is not a count in \"procs_running x\"")
    expect(why(swapPages("pswpin 1"))).toBe("/proc/vmstat: no pswpout line")
    expect(why(meminfo("MemTotal: 1 kB", "MemAvailable"))).toBe("/proc/meminfo: no MemAvailable line")
    expect(why(pressure("some avg60=1.00", "some", "/proc/pressure/memory"))).toBe("/proc/pressure/memory: no avg10 percentage in \"some avg60=1.00\"")
  })
})

describe("systemd and the caller's cgroup", () => {
  test("systemctl show ControlGroup, with or without --value, and inactive as none", () => {
    expect(controlGroupOf("/user.slice/user-1000.slice/user@1000.service/app.slice\n"))
      .toEqual(Option.some("/user.slice/user-1000.slice/user@1000.service/app.slice"))
    expect(controlGroupOf("ControlGroup=/user.slice/x.slice")).toEqual(Option.some("/user.slice/x.slice"))
    expect(controlGroupOf("\n")).toEqual(Option.none())
    expect(controlGroupOf("/a/../b")).toEqual(Option.none())
  })
  test("a login session, a user-manager service and a transient scope are one place: the user's slice", () => {
    const slice = "/user.slice/user-1000.slice"
    for (const path of [`${slice}/session-11124.scope`, `${slice}/user@1000.service/app.slice/run-u107.service`,
      `${slice}/user@1000.service/app.slice/run-r035c0eb3e62a45f6bd52b592b619dfbe.scope`]) expect(userPlaceOf(path)).toBe(slice)
    expect(userPlaceOf("/system.slice/cron.service")).toBe("/system.slice/cron.service")
  })
})
