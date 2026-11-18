// The guard's work gc rule: `work gc` is refused while the base it runs on has
// a workspace whose record says `creating` and whose folder exists. gc takes
// such a record for a reservation whose maker died and deletes its folder
// outright, not to the trash, whatever it holds; but a `work new` cut off
// between its clone and its activation leaves exactly that over a whole
// workspace an agent may already work in (2026-11-17: an orchestrate lane cut
// off by a plugin reload, then `work gc -older 0s`, lost an implementor's two
// commits). The refusal names the folders and what to do instead.
//
// The line is read as the destructive rule reads it (verdict.ts
// `placedCommands`): prefixes and assignments, `cd`, chained commands, and the
// script of `sh -c` or `eval`. The workspaces being made are the fact from
// outside, asked of the `Reservations` contract (service.ts) only for a line
// that runs `work gc`.
import type { Reservation } from "./service.ts"
import { type Place, placedCommands } from "./verdict.ts"
import { resolve } from "./path.ts"

/** One `work gc` of a line: the command as the refusal names it, and the directory it runs in (work finds its base from there). */
export interface WorkGc {
  readonly command: string
  readonly directory: string
}

/** Each `work gc` of `line`, in order: `work`'s subcommand is its first word that is no flag (`work --json gc`). */
export const workGcs = (line: string, place: Place): ReadonlyArray<WorkGc> =>
  placedCommands(line, resolve("/", place.cwd), place.home).flatMap(({ head, args, command, runsIn }) => {
    const sub = args.filter((word) => !word.text.startsWith("-")).slice(0, 1)
    return [{ command, directory: runsIn }].filter(() => head === "work" && sub.some((word) => word.text === "gc"))
  })

/** Why the guard refuses `gc` while `making` are on its base. */
export const workGcReason = (gc: WorkGc, making: ReadonlyArray<Reservation>): string =>
  `\`${gc.command}\` would delete, outright and not to the trash, ${["workspaces", "a workspace"][Number(making.length === 1)]} whose record still says creating: ` +
  `${making.map((each) => `${each.name} (${each.path})`).join(", ")}. A \`work new\` cut off before it finished leaves that over a whole workspace, ` +
  "which may already hold work; wait for it to be made, or move it to the trash with `work rm <name>`, then run gc"
