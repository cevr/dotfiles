// @reads all
// @reads-reason subprocess reads at mods/guard/process/command-line.test.ts: const probe = spawnSync([...prefix, ...env("-0")], { env: caller, timeout: 1200 })
import { expect, test } from "bun:test"
import { Option } from "effect"
import { spawnSync } from "bun"
import { cpuDemand } from "../admission.ts"
import { argvWidth, checkModel, demandOnVolume } from "../check-demand.ts"
import { parseArgv, type CommandEnvironment } from "../command-line.ts"
import { DEFAULT_HEAVY, heavyCommand } from "../heavy.ts"

const program = "/usr/bin/env"
const caller = { PATH: "/usr/bin:/bin", GOENV: "off", GOFLAGS: "-p=7 -cpu=9", GOMAXPROCS: "2", MAKEFLAGS: "-j8" }
const env = (...args: ReadonlyArray<string>) => [program, ...args]
const clear = env("-i", "GOENV=off", "GOMAXPROCS=1")
const unset = env("-uGOENV")
const overlay = env("GOENV=off", "GOMAXPROCS=3")
const portable = [
  [], env("-u", "GOENV"), unset, env("-u", "GOFLAGS"), env("-uGOMAXPROCS"), env("-i"),
  env("-"), env("-C", "/"), env("-C/"), env("--"), env("GOENV=off", "GOFLAGS=", "GOMAXPROCS=2"),
  env("-S", "GOENV=off GOFLAGS= GOMAXPROCS=4"), env("-SGOENV=off GOFLAGS= GOMAXPROCS=1"),
  env("-S", "-uGOENV"), env("-S", "-u GOENV"), env("-u", "MAKEFLAGS"), ["/usr/bin/nice", "-n", "19"],
]
const platformOptions = [
  env("--unset=GOENV"), env("--unset", "GOFLAGS"), env("--ignore-environment"),
  env("--chdir=/"), env("--chdir", "/"), env("--split-string=GOFLAGS= GOMAXPROCS=5"),
  env("--split-string", "GOENV=off GOMAXPROCS=1"),
]
const uninterpreted = [env("-v"), env("-iuGOENV"), env("-S", 'GOENV="off"'), env("--unlisted-option"),
  ["/bin/sh", "-c", 'exec "$@"', "printer"]]
const prefixes = [...portable, ...platformOptions, ...uninterpreted].flatMap((one, index) => [
  one,
  [...overlay, ...one],
  [...one, ...clear, ...unset],
  [...clear, ...one, ...overlay],
  [...unset, ...one, ...(portable[index % portable.length] ?? [])],
])

const readEnvironment = (prefix: ReadonlyArray<string>) => {
  const probe = spawnSync([...prefix, ...env("-0")], { env: caller, timeout: 1200 })
  if (!probe.success) return Option.none()
  return Option.some(Object.fromEntries(probe.stdout.toString().split("\0").filter(Boolean).map((row) => row.split(/=(.*)/su, 2))))
}
const flags = (config: string, name: string) =>
  Number(new RegExp(`(?:^| )-${name}=(\\d+)(?: |$)`, "u").exec(config)?.[1] ?? 0)
const actualGo = (observed: CommandEnvironment, hidden: number, packages: number, testCpu: number) => {
  let effective = observed.GOFLAGS || ""
  if (!effective && observed.GOENV !== "off") effective = `-p=${hidden} -cpu=${hidden + 1}`
  const runtime = Number(observed.GOMAXPROCS) || hidden + 2
  return (packages || flags(effective, "p") || runtime) * Math.max(runtime, testCpu || flags(effective, "cpu") || runtime)
}
const verify = (prefix: ReadonlyArray<string>, observed: CommandEnvironment, hidden: number) => {
  for (const [tool, width] of [
    [["go", "test", "-p=1"], actualGo(observed, hidden, 1, 0)],
    [["go", "test", "-p=2", "-cpu=3"], actualGo(observed, hidden, 2, 3)],
    [["go", "test"], actualGo(observed, hidden, 0, 0)],
    [["bun", "test", "--parallel=4"], 4],
    [["bun", "test"], hidden],
    [["make"], Number(/-j(\d+)/u.exec(observed.MAKEFLAGS ?? "")?.[1] ?? 0) || hidden],
    [["ninja", "-j2"], 2],
    [["ninja"], hidden],
  ] as const) {
    const model = argvWidth([...prefix, ...tool], caller)
    expect(model).not.toBe("invalid")
    if (model === "invalid") continue
    const charge = cpuDemand(demandOnVolume({ purpose: "check", width: model }, "fixture"), 10000)
    expect({ prefix, tool, charge: charge >= Math.min(10000, 1000 * width) }).toEqual({ prefix, tool, charge: true })
  }
}

test("nested wrapper charges bound an executed environment with independent hidden Go and tool settings", () => {
  for (const prefix of portable) {
    expect({ prefix, ran: Option.isSome(readEnvironment(prefix)) }).toEqual({ prefix, ran: true })
    expect(parseArgv([...prefix, "go", "test", "-p=1"], caller).kind).toBe("literal")
  }
  for (const prefix of prefixes) {
    const real = readEnvironment(prefix)
    const tool = ["go", "test", "-p=1"]
    if (Option.isNone(real)) {
      expect({ prefix, width: argvWidth([...prefix, ...tool], caller) }).toEqual({ prefix, width: "unknown" })
      continue
    }
    const parsed = parseArgv([...prefix, ...tool], caller)
    if (parsed.kind === "literal") {
      const [run] = parsed.runs
      expect(run?.argv).toEqual(tool)
      for (const key of ["GOENV", "GOFLAGS", "GOMAXPROCS", "MAKEFLAGS", "PATH"])
        expect({ prefix, key, value: run?.env[key] }).toEqual({ prefix, key, value: real.value[key] })
    }
    for (const hidden of [1, 2, 7, 100]) verify(prefix, real.value, hidden)
  }
})

test("a fully interpreted unset supports a narrow bound; an unknown option never exposes the tail as a bound", () => {
  const initial = { GOENV: "off", GOMAXPROCS: "1", GOFLAGS: "-cpu=8" }
  const tool = ["go", "test", "-p=1"]
  const proven = parseArgv([...env("-uGOFLAGS"), ...tool], initial)
  const unknown = parseArgv([...env("-v"), ...tool], initial)
  expect(String(checkModel(proven).width)).toBe("1")
  expect(proven.kind).toBe("literal")
  expect(heavyCommand(proven, DEFAULT_HEAVY)).toBe(true)
  expect(checkModel(unknown).width).toBe("unknown")
  expect(heavyCommand(unknown, DEFAULT_HEAVY)).toBe(true)
  expect(unknown.runs).toEqual([])
})

test("literal sh command and exec prefixes share the effective environment with classification", () => {
  for (const prefix of ["command", "exec", "command exec"]) {
    const source = `GOENV=off GOMAXPROCS=2 ${prefix} /usr/bin/env -uGOFLAGS`
    const actual = readEnvironment(["/bin/sh", "-c", `${source} /usr/bin/env -0; :`])
    const parsed = parseArgv(["/bin/sh", "-c", `${source} go test -p=2`], caller)
    expect(Option.getOrThrow(actual).GOFLAGS).toBeUndefined()
    expect(String(checkModel(parsed).width)).toBe("4")
    expect(heavyCommand(parsed, DEFAULT_HEAVY)).toBe(true)
  }
})
