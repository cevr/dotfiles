import { Predicate, Schema } from "effect"
import { Purpose, purposeKeys, Width, type Demand } from "./admission-wire.ts"
import { executable, parseArgv, parseShell, type CommandEnvironment, type CommandLine } from "./command-line.ts"
import { CHECK_PROFILE } from "./host-supply.ts"
import { toolWidth, widthAdvice } from "./tool-width.ts"

export { joinWidth, readWidth } from "./tool-width.ts"
export const CheckDemand = Schema.Struct({ purpose: Purpose, width: Width })
export type CheckDemand = typeof CheckDemand.Type

export const checkModel = (line: CommandLine) => {
  const [run] = line.runs
  if (line.kind !== "literal" || line.runs.length !== 1 || !run)
    return { width: "unknown" as const, advice: "No tool model can prove a narrower width for this command." }
  const [head = "", ...args] = run.argv
  const tool = executable(head)
  return { width: toolWidth(tool, args, run.env), advice: widthAdvice(tool, args, run.env) }
}

export const argvModel = (argv: ReadonlyArray<string>, env?: CommandEnvironment) => checkModel(parseArgv(argv, env))
export const argvWidth = (argv: ReadonlyArray<string>, env?: CommandEnvironment) => argvModel(argv, env).width
export const shellWidth = (source: string, env?: CommandEnvironment) => checkModel(parseShell(source, env)).width

/** The wrapper runs before the actual payload environment is known. */
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
