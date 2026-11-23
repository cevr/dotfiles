import { Predicate, Schema } from "effect"
import { Purpose, purposeKeys, Width, type Demand } from "./admission-wire.ts"
import { unwrapped } from "./heavy.ts"
import { CHECK_PROFILE } from "./host-supply.ts"
import { SHELLS, shellScript, simpleCommands, type Word } from "./shell-line.ts"
import { toolWidth, widthAdvice, type ToolEnvironment, type ToolWidth } from "./tool-width.ts"

export { joinWidth, readWidth } from "./tool-width.ts"
export const CheckDemand = Schema.Struct({ purpose: Purpose, width: Width })
export type CheckDemand = typeof CheckDemand.Type
const base = (arg: string) => arg.split("/").at(-1)
const asWord = (text: string): Word => ({ text, bareStart: true, singleQuoted: false })
const relevant = new Set(["GOMAXPROCS", "GOFLAGS", "GOENV", "MAKEFLAGS", "MFLAGS", "GNUMAKEFLAGS", "BASH_ENV", "ENV"])
const assignment = /^([A-Za-z_]\w*)=(.*)$/su
const opaqueWrappers = new Set(["sudo", "doas", "npx", "pnpx", "bunx", "pnpm", "yarn"])

const unsetEnv = (result: Partial<Record<string, string>>, text: string, next?: string) => {
  if (text === "-i" || text === "--ignore-environment" || text === "-")
    for (const key of relevant) delete result[key]
  if ((text === "-u" || text === "--unset") && Predicate.isString(next)) delete result[next]
  if (text.startsWith("--unset=")) delete result[text.slice(8)]
}
const envBefore = (prefix: ReadonlyArray<Word>, baseEnv: ToolEnvironment) => {
  const result = { ...baseEnv }
  let withinEnv = false
  for (const [i, { text }] of prefix.entries()) {
    const name = base(text)
    if (name === "env") withinEnv = true
    if (withinEnv) unsetEnv(result, text, prefix[i + 1]?.text)
    const matched = text.match(assignment)
    const [, assigned, value] = matched ?? []
    if (Predicate.isString(assigned) && relevant.has(assigned) && Predicate.isString(value)) result[assigned] = value
  }
  return result
}

type Advice = (message: string) => void
const wordsWidth = (input: ReadonlyArray<Word>, env: ToolEnvironment, depth: number, advice?: Advice): ToolWidth => {
  if (depth >= 5) return "unknown"
  const command = unwrapped(input)
  if (command._tag === "Script") {
    const prefix = input.slice(0, input.findIndex(({ text }) => text === command.script))
    return shellWidth(command.script, envBefore(prefix, env), depth + 1, advice)
  }
  const [head, ...args] = command.words
  if (!head) return "unknown"
  const prefix = input.slice(0, input.indexOf(head))
  if (prefix.some(({ text }) => opaqueWrappers.has(base(text) ?? ""))) return "unknown"
  const effective = envBefore(prefix, env)
  const tool = base(head.text) ?? ""
  if (SHELLS.has(tool)) {
    if (args.some(({ text }) => text === "--login" || /^-[^-]*l/u.test(text))) return "unknown"
    const source = shellScript(args)
    if (Predicate.isString(source) && !effective.BASH_ENV && !effective.ENV) return shellWidth(source, effective, depth + 1, advice)
    return "unknown"
  }
  const literal = args.map(({ text }) => text)
  advice?.(widthAdvice(tool, literal, effective))
  return toolWidth(tool, literal, effective)
}

export const shellWidth = (line: string, env: ToolEnvironment = {}, depth = 0, advice?: Advice): ToolWidth => {
  const commands = simpleCommands(line)
  const [first] = commands
  // A pipeline/background list may run concurrently; sequential shell
  // state may change cwd/env/commands. Never use one segment as its bound.
  if (commands.length !== 1 || !first) return "unknown"
  if (line.includes("`") || line.includes("$(")) return "unknown"
  if (first.some(({ text, bareStart }) =>
    text.includes("$") || (bareStart && /[*?[\]{}]/u.test(text) && !text.startsWith("./"))))
    return "unknown"
  return wordsWidth(first, env, depth, advice)
}

export const argvWidth = (argv: ReadonlyArray<string>, env: ToolEnvironment = {}): ToolWidth =>
  wordsWidth(argv.map(asWord), env, 0)

export const argvModel = (argv: ReadonlyArray<string>, env: ToolEnvironment = {}) => {
  let advice = widthAdvice("", [], {})
  const width = wordsWidth(argv.map(asWord), env, 0, (message) => { advice = message })
  return { width, advice }
}
/** Wrappers run before the effective payload environment is known. Carry
 * the literal argv and class unchanged and resolve the bound at the one
 * authority that can see both, rather than transporting a guessed number. */
export const checkPrefix = (purpose: Purpose): ReadonlyArray<string> => ["check", "run", "--class", purpose, "--"]

export const demandOnVolume = ({ purpose, width }: CheckDemand, volumeId: string): Demand => ({
  ...CHECK_PROFILE[purpose], width, ioClass: "idle", keys: purposeKeys[purpose], volumeReservations: [{ volumeId, bytes: 0 }],
})

export const enforceDeclaredWidth = (demand: Demand) => {
  if (!Predicate.isNumber(demand.width)) return demand
  // The nominal class reservation is a separate wire field. A hard scope
  // uses the declaration; a larger class baseline must not widen the cap.
  return { ...demand, cpuMilli: Math.min(demand.cpuMilli, demand.width * 1000) }
}
