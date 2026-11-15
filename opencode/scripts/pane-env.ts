// The variables a terminal multiplexer's pane gives the processes in it: herdr's (`HERDR_ENV`,
// `HERDR_PANE_ID`, …), a herdr-core terminal's `HC_TERMINAL_ID`, Rex's (`REX_SESSION`, `REX_BLOCK`, …)
// and the terminal's `TERM_PROGRAM`. The TUI decides by them, among other things, whether its own
// tab strip shows (`tabs.mode` "auto"). A scenario run inherits them from wherever it started, so
// its TUI drew one way from a herdr pane and another from a Rex pane or a plain shell. Runs drop
// them (`outsidePanes`); a scenario that wants a pane sets its variables itself (scenarios/herdr.ts).

/** Whether `name` is a variable a multiplexer pane sets. */
export const isPaneVariable = (name: string): boolean => /^(HERDR_|REX_)/.test(name) || name === "HC_TERMINAL_ID" || name === "TERM_PROGRAM"

/** `env` without the variables a multiplexer pane sets. */
export const outsidePanes = <Value>(env: Readonly<Record<string, Value>>): Record<string, Value> =>
  Object.fromEntries(Object.entries(env).filter(([name]) => !isPaneVariable(name)))
