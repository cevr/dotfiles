// The variables a terminal multiplexer's pane gives the processes in it: herdr's (`HERDR_ENV`,
// `HERDR_PANE_ID`, …), a herdr-core terminal's `HC_TERMINAL_ID`, Rex's (`REX_SESSION`, `REX_BLOCK`, …)
// and the terminal's `TERM_PROGRAM`. The TUI decides by them, among other things, whether its own
// tab strip shows (`tabs.mode` "auto"). A scenario run inherits them from wherever it started, so
// its TUI drew one way from a herdr pane and another from a Rex pane or a plain shell. Runs drop
// the ones they inherited (`outsidePanes`) and keep the ones a test sets for its child: the herdr
// test hands its scenario `HERDR_FAKE_SOCKET`, and the scenario sets its pane itself (scenarios/herdr.ts).

/** Whether `name` is a variable a multiplexer pane sets. */
export const isPaneVariable = (name: string): boolean => /^(HERDR_|REX_)/.test(name) || name === "HC_TERMINAL_ID" || name === "TERM_PROGRAM"

/**
 * `env` without the pane variables it inherited from `parent`: one whose value is the parent's own
 * came from the pane the run started in; one the caller set to something else is the child's. A
 * caller that sets a pane variable to the very value its own pane has loses it: a run from a herdr
 * pane that wants `HERDR_ENV=1` for its child sets it in the scenario instead.
 */
export const outsidePanes = <Value>(env: Readonly<Record<string, Value>>, parent: Readonly<Partial<Record<string, Value>>>): Record<string, Value> =>
  Object.fromEntries(Object.entries(env).filter(([name, value]) => !isPaneVariable(name) || parent[name] !== value))
