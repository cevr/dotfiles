import { expect, test } from "bun:test"
import { argvWidth, demandOnVolume } from "./check-demand.ts"
import { admissionLauncher, argvPurpose, shellCheck } from "./launcher.ts"

test("one table reads literal widths, leaves payload untouched, and holds unrecognized or unbounded options", () => {
  const cases = [
    ["GOMAXPROCS=4 go test -p 4 -parallel 4 ./...", 4],
    ["go test -p=3 -parallel=2 ./...", 3],
    ["bun test --parallel=4 ./test", 4],
    ["bun test --parallel 3 ./test", 3],
    ["make -j4", 4],
    ["make -j 4", 4],
    ["make -j", "unknown"],
    ["bun test --parallel", "unknown"],
    ["bun test --parallel-workers=4", "unknown"],
    ["go test -p \"$WIDTH\" ./...", "unknown"],
    ["sh -c 'GOMAXPROCS=4 go test -p 2 -parallel 3' ", 4],
    ["printf '%s' '--parallel-workers=4'", 1],
    ["nice -n 19 env GOMAXPROCS=4 go test -p 4", 4],
    ["timeout 12 sh -c 'go test -p 4 -parallel=3 ./...'", 4],
    ["env -S 'GOMAXPROCS=4 go test -p 4 -parallel 4 ./...'", 4],
  ] as const
  for (const [source, width] of cases) {
    expect(String(shellCheck(source).width)).toBe(String(width))
    expect(admissionLauncher("/bin/sh", ["/bin/admit"], source)).toContain(`'--width' '${width}'`)
  }
  expect(Number(argvWidth(["sleep", "5"], "4"))).toBe(4)
  expect(argvWidth(["sleep", "5"], "0")).toBe("unknown")
})

test("classes carry their typed width and canonical memory, trace and VM budgets", () => {
  const volume = "volume-fixture"
  const check = shellCheck("go test -p 4 -parallel 4")
  const demand = demandOnVolume(check, volume)
  expect({ ...demand, width: Number(demand.width) }).toEqual({
    width: 4, cpuMilli: 1000, memoryBytes: 4 * 2 ** 30, ioClass: "idle", keys: [], volumeReservations: [{ volumeId: volume, bytes: 0 }],
  })
  expect(demandOnVolume(shellCheck("limactl shell demo"), volume)).toMatchObject({ memoryBytes: 8 * 2 ** 30, keys: ["vm"] })
  expect(demandOnVolume(shellCheck("du -hs ."), volume)).toMatchObject({ memoryBytes: 2 * 2 ** 30, keys: ["trace"] })
  expect(shellCheck("bun scripts/receipt.ts").purpose).toBe("exclusive-check")
  expect(argvPurpose(["/usr/bin/du", "-hs", "path with a space"])).toBe("inventory")
  expect(argvPurpose(["/bin/sh", "-c", "bun scripts/accept.ts"])).toBe("land-check")
})
