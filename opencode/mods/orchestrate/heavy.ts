// The heavy-check footer: what every implementor and verifier prompt ends
// with. A heavy check (a build, test, vet, lint or benchmark run) takes the
// agent's thread share of the host, worked out when the prompt is sent from
// the host's cores and the heavy agents working on it then; and a round runs
// its spec's round gate only, since the batch runs the full gate, the full
// e2e and the affected acceptance once on its merged head. The share is
// advice in the prompt, never a cap on agents (the owner, 2026-11-13).
//
// The footer goes at the prompt's very end, never in the system prompt, so the
// role's cached prefix stays as it is.
import { Option } from "effect"

/** The host's load average over the last minute and its count of cores, as the pool and `mods/rift` read them. */
export interface HostLoad {
  readonly load: number
  readonly cores: number
}

/** What the host answers when a footer is worked out: its load, and the heavy agents working on it now, this one not counted. */
export interface HeavyReading {
  readonly host: HostLoad
  readonly working: number
}

/** The roles whose prompts end with the footer: the agents that run heavy checks. */
export type HeavyRole = "implementor" | "verifier"

export const isHeavy = (agent: string): agent is HeavyRole => agent === "implementor" || agent === "verifier"

/** The fewest threads a share gives, where the host has them: a test runner on fewer is slower than the wait it saves. */
export const FLOOR = 4

/**
 * An agent's thread share: the host's cores split between the heavy agents working now, this agent and the batch
 * lane (the `+ 2`), never under `FLOOR` and never above the host's cores.
 */
export const shareOf = (cores: number, working: number): number => {
  const host = Math.max(1, Math.floor(cores))
  const lanes = Math.max(0, Math.floor(working)) + 2
  return Math.min(host, Math.max(FLOOR, Math.floor(host / lanes)))
}

/** The footer's first words: how a prompt's footer is found again, so a prompt never holds two. */
export const FOOTER_MARK = "Heavy share (orchestrate):"

/** The footer of a heavy role's prompt, for a share of the host's `cores`. */
export const footerOf = (role: HeavyRole, share: number, cores: number): string => {
  const flags = `Run one heavy check (a build, test, vet, lint or benchmark run) at a time, on at most ${share} threads: \`bun test --parallel=${share}\`, Go's \`-p ${share}\` with \`GOMAXPROCS=${share}\`, Cargo's \`-j ${share}\`.`
  if (role === "verifier")
    return [
      `${FOOTER_MARK} ${share} of this host's ${cores} cores, the batch lane's share, read when this prompt was sent.`,
      flags,
      "You run only the checks a finding needs, never the full gate, the full e2e or an affected-acceptance run, because the batch runs them once: you read the batch's gate and accept logs and rerun neither.",
    ].join("\n")
  return [
    `${FOOTER_MARK} ${share} of this host's ${cores} cores, read when this prompt was sent.`,
    flags,
    "You run your spec's round gate only, never the full gate, the full e2e or an affected-acceptance run, because the batch runs them once on its merged head.",
  ].join("\n")
}

/** The footer for `agent` on a host of `cores` with `working` heavy agents working; none for a role that runs no heavy check. */
export const footerFor = (agent: string, cores: number, working: number): Option.Option<string> => {
  if (!isHeavy(agent)) return Option.none()
  return Option.some(footerOf(agent, shareOf(cores, working), cores))
}

/** `prompt` ending with `footer`, and with no other: an older footer, and all that follows it, goes. */
export const withFooter = (prompt: string, footer: string): string => {
  const [body = ""] = prompt.split(FOOTER_MARK, 1)
  const kept = body.trimEnd()
  if (kept === "") return footer
  return `${kept}\n\n${footer}`
}
