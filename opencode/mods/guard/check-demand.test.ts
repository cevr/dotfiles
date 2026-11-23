import { expect, test } from "bun:test"
import { cpuDemand } from "./admission.ts"
import { type Width } from "./admission-wire.ts"
import { argvWidth, demandOnVolume, shellWidth } from "./check-demand.ts"
import { admissionLauncher, argvPurpose } from "./launcher.ts"
import { request } from "./memory/admission-acceptance.ts"
import { bunTestWidth, goTestWidth, makeWidth, ninjaWidth, type ToolWidth } from "./tool-width.ts"

const pool = 10_000
const verify = (width: ToolWidth, theoretical: number) => {
  if (width === "invalid") {
    expect(width).not.toBe("invalid")
    return
  }
  const reservation = cpuDemand({ ...request("fixture").demand, width }, pool)
  expect(reservation).toBeGreaterThanOrEqual(Math.min(theoretical * 1000, pool))
  expect(reservation).toBeLessThanOrEqual(pool)
}

test("Go package concurrency and runtime are independent; test-level -parallel cannot lower the CPU bound", () => {
  for (const packages of [0, 1, 2, 4, 32]) {
    for (const runtime of [0, 1, 2, 4, 32]) {
      const env = runtime > 0 ? { GOMAXPROCS: String(runtime) } : {}
      const workers = runtime || 12
      for (const parallel of [0, 1, 3, 48]) {
        const args = ["./fixture"]
        if (packages > 0) args.push(`-p=${packages}`)
        if (parallel > 0) args.push("-parallel", String(parallel))
        verify(goTestWidth(args, env), (packages || workers) * workers)
      }
    }
  }
  expect(String(goTestWidth(["-p=4", "-parallel", "1"], { GOMAXPROCS: "4" }))).toBe("16")
  expect(goTestWidth(["-p=1", "./fixture"], {})).toBe("full")
  expect(goTestWidth(["-p=1", "-fuzz=Fuzz"], { GOMAXPROCS: "1" })).toBe("unknown")
  expect(goTestWidth(["-p=1", "-cpu=4"], { GOMAXPROCS: "1" })).toBe("unknown")
  expect(String(goTestWidth(["-run", "-p=1"], { GOMAXPROCS: "4" }))).toBe("16")
  expect(String(goTestWidth(["-p=2"], { GOMAXPROCS: "3", GOFLAGS: "-p=4" }))).toBe("6")
})

test("Bun, GNU Make and Ninja bind only their own workers; unbounded and host defaults stay full", () => {
  for (const workers of [1, 2, 4, 32, 2048]) {
    verify(bunTestWidth([`--parallel=${workers}`]), workers)
    verify(makeWidth(["-j", String(workers)], {}), workers)
    verify(makeWidth([`-j${workers}`], {}), workers)
    verify(ninjaWidth(["-j", String(workers)]), workers)
  }
  verify(bunTestWidth([]), 1)
  expect(bunTestWidth(["--parallel"])).toBe("full")
  expect(bunTestWidth(["--parallel", "12"])).toBe("full")
  expect(bunTestWidth(["--parallel-strategy=wide"])).toBe("unknown")
  expect(String(bunTestWidth(["--test-name-pattern", "--parallel=8"]))).toBe("1")
  verify(makeWidth([], {}), 1)
  expect(makeWidth(["-j"], {})).toBe("full")
  expect(makeWidth([], { MAKEFLAGS: " --jobserver-auth=3,4 -j" })).toBe("unknown")
  expect(makeWidth(["-kj8"], {})).toBe("unknown")
  expect(String(makeWidth(["-f", "-j8"], {}))).toBe("1")
  expect(ninjaWidth([])).toBe("full")
  expect(ninjaWidth(["-j0"])).toBe("full")
  expect(ninjaWidth(["-f", "-j1"])).toBe("full")
  expect(argvWidth(["unmodeled", "--parallel=1"])).toBe("unknown")
})

test("literal wrappers preserve class and argv; width follows the effective environment", () => {
  const cases: ReadonlyArray<readonly [string, Width | "invalid" | number]> = [
    ["GOMAXPROCS=4 go test -p 4 -parallel 4 ./...", 16],
    ["go test -p=3 -parallel=2 ./...", "full"],
    ["env -i GOMAXPROCS=3 go test -p=2", 6],
    ["env -u GOMAXPROCS go test -p=1", "full"],
    ["bun test --parallel=4 ./test", 4],
    ["make -j4", 4],
    ["ninja -j 3", 3],
    ["go test -p \"$WIDTH\" ./...", "unknown"],
    ["go test -p 0", "invalid"],
    ["sh -c 'GOMAXPROCS=4 go test -p 2 -parallel 3' ", 8],
    ["printf '%s' '--parallel-workers=4'", 1],
    ["nice -n 19 env GOMAXPROCS=4 go test -p 4", 16],
    ["timeout 12 sh -c 'go test -p 4 -parallel=3 ./...'", "full"],
    ["env -S 'GOMAXPROCS=4 go test -p 4 -parallel 4 ./...'", 16],
    ["export GOMAXPROCS=4; go test -p 1", "unknown"],
  ]
  for (const [source, width] of cases) {
    expect(String(shellWidth(source))).toBe(String(width))
    expect(admissionLauncher("/bin/sh", ["/bin/admit"], source)).toContain("'--' '/bin/sh' \"$@\"")
  }
  expect(String(shellWidth("go test -p=2", { GOMAXPROCS: "3" }))).toBe("6")
  expect(demandOnVolume({ purpose: "vm", width: "unknown" }, "vol").keys).toEqual(["vm"])
  expect(demandOnVolume({ purpose: "inventory", width: "full" }, "vol").keys).toEqual(["trace"])
  expect(argvPurpose(["/usr/bin/du", "-hs", "path with a space"])).toBe("inventory")
  expect(argvPurpose(["/bin/sh", "-c", "bun scripts/accept.ts"])).toBe("land-check")
})
