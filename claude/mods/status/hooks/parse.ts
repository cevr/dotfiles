import type { Pool, Run, Unit } from '../types'

// The unit states that still need work or the owner; merged, done and dropped
// units are history.
const ACTIVE = /^(plan|implement|review|verify|decide|blocked|stuck)/

// budget.ts prints one line per host, then `budget: 5/8 agents, 181 MW in 5 h`.
export function parseBudget(stdout: string): Pool | undefined {
  const lines = stdout.trim().split('\n').filter(Boolean)
  const total = lines.at(-1)?.match(/^budget: (\d+)\/(\d+) agents, (\d+) MW in 5 h/)
  if (!total) return undefined
  return {
    agents: Number(total[1]),
    cap: Number(total[2]),
    megaWeighted: Number(total[3]),
    hosts: lines.slice(0, -1),
  }
}

// status.ts prints a Markdown table: | Unit | State | Round | Since | Cause |.
export function parseRun(name: string, stdout: string): Run {
  const units: Unit[] = []
  for (const line of stdout.split('\n')) {
    const cells = line.split('|').map(cell => cell.trim())
    if (cells.length < 6 || cells[1] === 'Unit' || cells[1]?.startsWith('-')) continue
    const [, unit = '', state = '', round = '', since = ''] = cells
    if (ACTIVE.test(state)) units.push({ unit, state, round: Number(round) || 0, since })
  }
  return { name, units }
}

// `pool 5/8 · 181 MW/5h · hymnapp: 2 implement, 1 verify`
export function statusLine(pool: Pool | undefined, runs: readonly Run[]): string | undefined {
  const parts: string[] = []
  if (pool) parts.push(`pool ${pool.agents}/${pool.cap} · ${pool.megaWeighted} MW/5h`)
  for (const run of runs) {
    if (run.units.length === 0) continue
    const counts = new Map<string, number>()
    for (const { state } of run.units) {
      const key = state.split(/[ (]/)[0] ?? state
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    parts.push(`${run.name}: ${[...counts].map(([state, n]) => `${n} ${state}`).join(', ')}`)
  }
  return parts.length > 0 ? parts.join(' · ') : undefined
}
