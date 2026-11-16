// Which Rex pane a process belongs to, from the variables Rex gives the
// programs of a terminal it opens: `REX_SESSION` (the session) and
// `REX_BLOCK` (the pane). The OpenCode server sits in no pane, so these two
// are taken out of its environment; a TUI keeps them and hands them, with the
// rest of its environment, to the sessions it shows.
import { Option, Record, Result } from "effect"

/** The variables that name one pane: the session and the block. `REX_SERVER` and `REX_BIN_DIR` name the host's server and stay. */
export const PANE_VARIABLES: ReadonlyArray<string> = ["REX_SESSION", "REX_BLOCK"]

/** The variables a session's environment never carries: the server's password, as the host's own TUI leaves it out. */
const SECRET_VARIABLES: ReadonlyArray<string> = ["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"]

/** A process environment, where any variable may be unset. */
export type Environment = Readonly<Partial<Record<string, string>>>

/** One Rex pane: its session and its block, both full ids. */
export interface Pane {
  readonly session: string
  readonly block: string
}

const present = (env: Environment, name: string): Option.Option<string> => Option.filter(Option.fromUndefinedOr(env[name]), (text) => text !== "")

/** The pane `env` names, when it names both its session and its block. */
export const paneOf = (env: Environment): Option.Option<Pane> => Option.all({ session: present(env, "REX_SESSION"), block: present(env, "REX_BLOCK") })

/** The names in `env` that name a pane, to take out of an environment that belongs to no pane. */
export const paneVariablesIn = (env: Environment): ReadonlyArray<string> => PANE_VARIABLES.filter((name) => Record.has(env, name))

/**
 * A TUI's environment as a session's: every set variable but the server's
 * password, the same set the host's TUI sends for the session it shows.
 */
export const sessionVariables = (env: Environment): Readonly<Record<string, string>> =>
  Record.filterMap(env, (value, name) =>
    Result.fromOption(
      Option.filter(Option.fromUndefinedOr(value), () => !SECRET_VARIABLES.includes(name)),
      () => name,
    ),
  )
