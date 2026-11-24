import { expect, test } from "bun:test"
import { cpuDemand } from "./admission.ts"
import { type Width } from "./admission-wire.ts"
import { argvWidth, demandOnVolume, shellWidth } from "./check-demand.ts"
import { parseArgv, parseShell } from "./command-line.ts"
import { admissionLauncher, admissionPurpose } from "./launcher.ts"
import { bunTestWidth, goTestWidth, makeWidth, ninjaWidth, type ToolWidth } from "./tool-width.ts"

const pool = 10_000
const runtimeEnv = (runtime: number) => {
  if (runtime > 0) return { GOMAXPROCS: String(runtime) }
  return {}
}
const verify = (width: ToolWidth, theoretical: number) => {
  if (width === "invalid") {
    expect(width).not.toBe("invalid")
    return
  }
  const reservation = cpuDemand(demandOnVolume({ purpose: "check", width }, "fixture"), pool)
  expect(reservation).toBeGreaterThanOrEqual(Math.min(theoretical * 1000, pool))
  expect(reservation).toBeLessThanOrEqual(pool)
}

const configurations = (packages: ReadonlyArray<number>, runtime: ReadonlyArray<number>, testCpu: ReadonlyArray<number>) =>
  packages.flatMap((p) => runtime.flatMap((r) => testCpu.map((c) => [p, r, c] as const)))
const hiddenGo = configurations([1, 3, 128], [1, 8, 128], [1, 3, 128])

test("Go explicit dimensions bound arbitrary hidden package and test-runtime settings", () => {
  for (const [packages, runtime, testCpu] of configurations([0, 1, 2, 4, 32], [0, 1, 2, 4, 32], [0, 1, 3, 48])) {
    const args = ["./fixture"]
    if (packages > 0) args.push(`-p=${packages}`)
    if (testCpu > 0) args.push(`-cpu=${testCpu}`)
    for (const [hiddenPackages, hiddenRuntime, hiddenTestCpu] of hiddenGo) {
      const effective = (packages || hiddenPackages) * Math.max(runtime || hiddenRuntime, testCpu || hiddenTestCpu)
      verify(goTestWidth(args, runtimeEnv(runtime)), effective)
      verify(goTestWidth(args, { ...runtimeEnv(runtime), GOFLAGS: `-p=${hiddenPackages} -cpu=${hiddenTestCpu}` }), effective)
    }
  }
  expect(String(goTestWidth(["-p=4", "-parallel", "1", "-cpu=2"], { GOMAXPROCS: "4", GOENV: "off" }))).toBe("16")
  expect(goTestWidth(["-p=1", "./fixture"], {})).toBe("unknown")
  expect(goTestWidth(["-p=2"], { GOMAXPROCS: "4" })).toBe("unknown")
  expect(goTestWidth(["-p=1", "-fuzz=Fuzz"], { GOMAXPROCS: "1", GOENV: "off" })).toBe("unknown")
  expect(goTestWidth(["-p=1", "-cpu=1"], { GOMAXPROCS: "1", GOFLAGS: "-fuzz=Fuzz -parallel=16" })).toBe("unknown")
  expect(goTestWidth(["-p=1", "-cpu=1"], { GOMAXPROCS: "1", GOENV: "/fixture/hidden-mode" })).toBe("unknown")
  expect(String(goTestWidth(["-p=1", "-cpu=4"], { GOMAXPROCS: "1", GOENV: "off" }))).toBe("4")
  expect(String(goTestWidth(["-p", "2", "-cpu", "4,1,3"], { GOMAXPROCS: "1", GOENV: "off" }))).toBe("8")
  expect(goTestWidth(["-p=1", "-run", "-cpu=1"], { GOMAXPROCS: "1" })).toBe("unknown")
  expect(goTestWidth(["-p=1", "-args", "-cpu=1"], { GOMAXPROCS: "1" })).toBe("unknown")
  expect(goTestWidth(["-p=1", "-cpu=1", "-args", "-test.cpu=16"], { GOMAXPROCS: "1" })).toBe("unknown")
  expect(String(goTestWidth(["-p=2", "-cpu=3"], { GOMAXPROCS: "3", GOFLAGS: "-p=4 -cpu=12" }))).toBe("6")
  expect(String(goTestWidth(["-p=2"], { GOMAXPROCS: "4", GOENV: "off" }))).toBe("8")
})

test("Bun, GNU Make and Ninja bind only their own workers; unbounded and host defaults stay full", () => {
  for (const workers of [1, 2, 4, 32, 2048]) {
    verify(bunTestWidth([`--parallel=${workers}`]), workers)
    verify(makeWidth(["-j", String(workers)], {}), workers)
    verify(makeWidth([`-j${workers}`], {}), workers)
    verify(ninjaWidth(["-j", String(workers)]), workers)
  }
  for (const hidden of [1, 2, 8, 44, Number.MAX_SAFE_INTEGER]) {
    verify(bunTestWidth([]), hidden)
    verify(makeWidth([], {}), hidden)
    verify(ninjaWidth([]), hidden)
  }
  expect(bunTestWidth(["--parallel"])).toBe("unknown")
  expect(bunTestWidth(["--parallel", "12"])).toBe("unknown")
  expect(bunTestWidth(["--parallel-strategy=wide"])).toBe("unknown")
  expect(bunTestWidth(["--test-name-pattern", "--parallel=8"])).toBe("unknown")
  expect(makeWidth(["-j"], {})).toBe("full")
  expect(makeWidth([], { MAKEFLAGS: " --jobserver-auth=3,4 -j" })).toBe("unknown")
  expect(makeWidth(["-kj8"], {})).toBe("unknown")
  expect(makeWidth(["-f", "-j8"], {})).toBe("unknown")
  expect(ninjaWidth([])).toBe("unknown")
  expect(ninjaWidth(["-j0"])).toBe("full")
  expect(ninjaWidth(["-f", "-j1"])).toBe("unknown")
  expect(argvWidth(["unmodeled", "--parallel=1"])).toBe("unknown")
})

test("literal wrappers preserve class and argv; width follows the effective environment", () => {
  const cases: ReadonlyArray<readonly [string, Width | "invalid" | number]> = [
    ["GOENV=off GOMAXPROCS=4 go test -p 4 -cpu=4 -parallel 4 ./...", 16],
    ["go test -p=3 -parallel=2 ./...", "unknown"],
    ["env -i GOENV=off GOMAXPROCS=3 go test -p=2", 6],
    ["env -u GOMAXPROCS go test -p=1", "unknown"],
    ["bun test --parallel=4 ./test", 4],
    ["make -j4", 4],
    ["ninja -j 3", 3],
    ["go test -p \"$WIDTH\" ./...", "unknown"],
    ["GOMAXPROCS=1 go test -p=1 ''$EXTRA_FLAGS", "unknown"],
    ["bash -lc 'GOMAXPROCS=1 go test -p=1'", "unknown"],
    ["go test -p 0", "invalid"],
    ["sh -c 'GOENV=off GOMAXPROCS=4 go test -p 2 -parallel 3' ", 8],
    ["printf '%s' '--parallel-workers=4'", 1],
    ["nice -n 19 env GOENV=off GOMAXPROCS=4 go test -p 4", 16],
    ["timeout 12 sh -c 'go test -p 4 -parallel=3 ./...'", "unknown"],
    ["env -S 'GOENV=off GOMAXPROCS=4 go test -p 4 -parallel 4 ./...'", 16],
    ["export GOMAXPROCS=4; go test -p 1", "unknown"],
  ]
  for (const [source, width] of cases) {
    expect(String(shellWidth(source))).toBe(String(width))
    expect(admissionLauncher("/bin/sh", ["/bin/admit"], parseShell(source))).toContain("'--' '/bin/sh' \"$@\"")
  }
  expect(String(shellWidth("go test -p=2", { GOMAXPROCS: "3", GOENV: "off" }))).toBe("6")
  expect(demandOnVolume({ purpose: "vm", width: "unknown" }, "vol").keys).toEqual(["vm"])
  expect(demandOnVolume({ purpose: "inventory", width: "full" }, "vol").keys).toEqual(["trace"])
  expect(admissionPurpose(parseArgv(["/usr/bin/du", "-hs", "path with a space"]))).toBe("inventory")
  expect(admissionPurpose(parseArgv(["/bin/sh", "-c", "bun scripts/accept.ts"]))).toBe("land-check")
})
