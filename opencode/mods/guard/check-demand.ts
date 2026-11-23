import { Option, Predicate, Schema } from "effect"
import { Purpose, purposeKeys, Width, widthOf, type Demand } from "./admission-wire.ts"
import { unwrapped } from "./heavy.ts"
import { CHECK_PROFILE } from "./host-supply.ts"
import { SHELLS, shellScript, simpleCommands, type Word } from "./shell-line.ts"

export const CheckDemand = Schema.Struct({
  purpose: Purpose,
  width: Width,
})
export type CheckDemand = typeof CheckDemand.Type
const known = (n: number): Width => Option.getOrElse(widthOf(n), () => "unknown" as const)
export const readWidth = (value: string): Width => {
  if (!/^[1-9]\d*$/u.test(value)) return "unknown"
  return known(Number(value))
}
export const joinWidth = (a: Width, b: Width): Width => {
  if (a === "unknown" || b === "unknown") return "unknown"
  if (a >= b) return a
  return b
}
const serial = known(1)
const base = (arg: string) => arg.split("/").at(-1)
const asWord = (text: string): Word => ({ text, bareStart: true, singleQuoted: false })

/** One table for literal concurrency controls. An explicitly unbounded or
 * expansion-dependent width is Unknown, not an implicit single worker. */
const longWidth = new Set(["--parallel", "-parallel", "--jobs", "--threads", "--max-workers", "--maxWorkers", "--concurrency"])
const looksParallel = /(?:parallel|concurren|(?:^|-)jobs|workers|threads)/iu
const goModes = new Set(["build", "test", "vet"])
const tools = new Set(["go", "bun", "make", "gmake", "cargo", "ninja", "vitest", "jest", "turbo", "playwright", "rustc", "tsc", "tsgo"])
const makeTools = new Set(["make", "gmake", "ninja", "cargo"])
const literalWidth = (value: Option.Option<string>) => Option.match(value, {
  onSome: readWidth, onNone: () => "unknown" as const,
})

const widthFlag = (tool: string, text: string) => {
  const [flag = "", equals] = text.split("=", 2)
  const jobs = text.match(/^-j(\S+)$/u)?.[1]
  if (longWidth.has(flag) || (tool === "go" && flag === "-p") || (makeTools.has(tool) && (flag === "-j" || jobs)))
    return { kind: "width", inline: Option.fromNullishOr(equals ?? jobs), packages: flag === "-p" } as const
  if (looksParallel.test(flag) || (tools.has(tool) && flag === "-j")) return { kind: "unknown" } as const
  return { kind: "other" } as const
}

const flagWidths = (tool: string, args: ReadonlyArray<Word>, initial: Width) => {
  let width = initial
  let packages = false
  for (let i = 0; i < args.length; i += 1) {
    const text = args[i]?.text ?? ""
    if (text === "--") break
    if (!text.startsWith("-") || tool === "printf" || tool === "echo") continue
    const parsed = widthFlag(tool, text)
    if (parsed.kind === "unknown") return { width: "unknown" as const, packages }
    if (parsed.kind !== "width") continue
    packages ||= parsed.packages
    if (Option.isSome(parsed.inline)) width = joinWidth(width, readWidth(parsed.inline.value))
    else {
      width = joinWidth(width, literalWidth(Option.fromNullishOr(args[i + 1]?.text)))
      i += 1
    }
  }
  return { width, packages }
}

const runtimeWidth = (prefix: ReadonlyArray<Word>) =>
  prefix.reduce((width: Width, { text }) => {
    if (!text.startsWith("GOMAXPROCS=")) return width
    return joinWidth(width, readWidth(text.slice(11)))
  }, serial)

const wordsWidth = (input: ReadonlyArray<Word>, depth: number): Width => {
  if (depth >= 5) return "unknown"
  const command = unwrapped(input)
  if (command._tag === "Script") {
    // The launcher's command is a separate literal argument, not argv text
    // to re-quote; keep any outer runtime settings as a conservative bound.
    const prefix = input.slice(0, input.findIndex(({ text }) => text === command.script))
    return joinWidth(runtimeWidth(prefix), shellWidth(command.script, depth + 1))
  }
  const args = command.words
  const [head, sub] = args
  if (!head) return serial
  const tool = base(head.text) ?? ""
  const prefix = input.slice(0, input.indexOf(head))
  const width = runtimeWidth(prefix)
  if (SHELLS.has(tool)) return Option.match(Option.fromNullishOr(shellScript(args.slice(1))), {
    onNone: () => width, onSome: (source) => joinWidth(width, shellWidth(source, depth + 1)),
  })
  if (tool === "eval") return joinWidth(width, shellWidth(args.slice(1).map(({ text }) => text).join(" "), depth + 1))
  const parsed = flagWidths(tool, args.slice(1), width)
  // A Go driver's package defaults are not bounded by the check profile.
  // A literal `-p` makes the recognizable width chargeable; the advisory
  // ledger accounts for its process × thread fan-out.
  if (tool === "go" && sub && goModes.has(sub.text) && !parsed.packages && !prefix.some(({ text }) => text.startsWith("GOMAXPROCS=")))
    return "unknown"
  return parsed.width
}

export const shellWidth = (line: string, depth = 0): Width =>
  simpleCommands(line).reduce((width, words) => joinWidth(width, wordsWidth(words, depth)), serial)

export const argvWidth = (argv: ReadonlyArray<string>, gomaxprocs?: string): Width => {
  const width = wordsWidth(argv.map(asWord), 0)
  if (Predicate.isUndefined(gomaxprocs)) return width
  return joinWidth(width, readWidth(gomaxprocs))
}

export const checkPrefix = ({ purpose, width }: CheckDemand): ReadonlyArray<string> =>
  ["check", "run", "--class", purpose, "--width", String(width), "--"]

export const demandOnVolume = ({ purpose, width }: CheckDemand, volumeId: string): Demand => ({
  ...CHECK_PROFILE[purpose], width, ioClass: "idle", keys: purposeKeys[purpose], volumeReservations: [{ volumeId, bytes: 0 }],
})
