// The feature flags a driven OpenCode resolves. A run against a fork checkout
// (`OPENCODE_DEV`) starts OpenCode from source, whose channel is `local`, and
// a local or dev build turns every flag on by default. Since upstream 77b322ceae
// (2026-11-18) that includes `full_codemode`, which moves `shell`, `read`,
// `edit`, `write`, `patch` and `websearch` behind Code Mode's `execute` tool:
// a scripted model's direct `shell` call then finds no tool, no shell starts,
// and the dock reads `0 shells` (tests/prime-panel.test.ts). The owner runs a
// `latest` build (scripts/daily.ts), where `full_codemode` is off, so a run
// turns it off too unless its caller names it in `OPENCODE_FLAGS`. The list
// outranks the config, so a run that wants Code Mode's full tools names
// `full_codemode` there, not in `experimental.full_codemode`.
//
// Every place that starts OpenCode from fork source takes its list from here,
// through two shared seams and the two launchers outside them: a CLI started
// as `forkLaunch(...).base` with its `env` (testbeds/gamut/gamut.ts: gamut,
// verify:launch and every test that starts a service or a TUI itself); any
// child a test starts through `owned()` (tests/owned.ts: opencode-drive runs,
// the SDK runners of orchestrate and kernel); `verify:drive`'s scenario runs
// (scripts/verify.ts); and the law runners, which start OpenCode in their own
// process on an env of their own (tests/host-laws.test.ts,
// tests/client-laws.test.ts). Accept and the post-land step start no OpenCode
// of their own: they run `bun test` files, which use these.

/** The flags a run turns off unless its caller names them: off in the owner's build, and changing what a model is offered. */
export const RELEASE_OFF: ReadonlyArray<string> = ["full_codemode"]

/** The flags an `OPENCODE_FLAGS` list (`all,-media_blob`) names, on or off. */
const named = (flags: string): ReadonlySet<string> => {
  const names = new Set<string>()
  for (const entry of flags.split(",")) {
    const name = entry.trim().replace(/^-/, "")
    if (name !== "") names.add(name)
  }
  return names
}

/**
 * The `OPENCODE_FLAGS` list for a driven OpenCode: `flags` (the caller's list, "" for none) with each of
 * `RELEASE_OFF` it does not name turned off, so the model is offered the tools the owner's build offers. A flag
 * the caller names, on or off, keeps the caller's word; `all` names none.
 */
export const releaseFlags = (flags: string): string => {
  const own = named(flags)
  const entries: Array<string> = []
  if (flags.trim() !== "") entries.push(flags)
  for (const flag of RELEASE_OFF) if (!own.has(flag)) entries.push(`-${flag}`)
  return entries.join(",")
}
