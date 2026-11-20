// The variables an installed tree build binds its plugin configuration by (the fork's
// packages/cli/src/adjacent-config.ts): `OPENCODE_CONFIG` (the tree's `opencode.json`),
// `OPENCODE_CLI_CONFIG_CONTENT` (the text of its `cli.json`, which the TUI reads in place of its own)
// and `OPENCODE_ADJACENT_CONFIG` (the tree's config folder, the mark that the other two are a
// binding's). The build sets them in its own environment, so every shell it runs, and every test
// started from an agent's shell, inherits them. A run from source (`OPENCODE_DEV`) is never bound and
// keeps what it inherited: a scenario then loaded the installed tree's server plugins and its TUI
// plugin list in place of its own `tuiConfig`, and waited on that tree's file watchers, so its
// editor never took focus in the driver's 30 s (the deep run of 2026-11-20). A child drops the
// binding it inherited (`outsideBuild`), as an unbound build does, and keeps a value its caller set.

/** The mark of a bound build's environment. */
const MARK = "OPENCODE_ADJACENT_CONFIG"

/** The keys a bound build sets, all or none. */
const BINDING: ReadonlySet<string> = new Set(["OPENCODE_CONFIG", "OPENCODE_CLI_CONFIG_CONTENT", MARK])

/** Whether `name` is a variable a bound build sets. */
export const isBindingVariable = (name: string): boolean => BINDING.has(name)

/**
 * `env` without the build binding it inherited from `parent`: with `parent` bound (it has
 * `OPENCODE_ADJACENT_CONFIG`), a binding key whose value is the parent's came from the installed
 * build; one the caller set to something else is the child's. An unbound parent's own
 * `OPENCODE_CONFIG` is the user's and stays.
 */
export const outsideBuild = <Value>(env: Readonly<Record<string, Value>>, parent: Readonly<Partial<Record<string, string>>>): Record<string, Value> => {
  const bound = MARK in parent
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => !bound || !isBindingVariable(name) || parent[name] !== value))
}
