import { describe, expect, test } from 'claude-code/testing'

import { checkCommand, deriveTrack, roleOf, stallOf, STALL_MS, UNREPORTED_MS } from '../hooks/protocol'

const impl = roleOf('hymn-src-impl')!
const rev = roleOf('hymn-src-rev')!

describe('roles', () => {
  test('names map to roles; other names are not track agents', async () => {
    expect(roleOf('hymn-orch')).toEqual({ kind: 'orch', run: 'hymn' })
    expect(impl).toEqual({ kind: 'impl', run: 'hymn', track: 'hymn-src' })
    expect(roleOf('hymn-deck-b-ver')).toEqual({ kind: 'ver', run: 'hymn', track: 'hymn-deck-b' })
    expect(roleOf('reviewer')).toBeUndefined()
    expect(roleOf(null)).toBeUndefined()
  })
})

describe('command guard', () => {
  test('polling is refused for every role', async () => {
    for (const command of [
      'herdr agent wait hymn-src-rev --until idle',
      'herdr agent prompt hymn-src-rev "[hymn-src] Round 1 ready: /r/round-1-request.md" --wait',
      'sleep 60',
      'until grep -q done log; do sleep 5; done',
    ])
      expect('deny' in checkCommand(command, impl)).toBe(true)
    expect('deny' in checkCommand('sleep 1 && bun test', impl)).toBe(false)
  })

  test('a well-formed handoff passes and names its file', async () => {
    const check = checkCommand(
      'herdr agent prompt hymn-src-rev "[hymn-src] Round 2 ready: /r/src/round-2-request.md"',
      impl,
    )
    expect(check).toEqual({
      handoffs: [
        {
          target: 'hymn-src-rev',
          message: '[hymn-src] Round 2 ready: /r/src/round-2-request.md',
          path: '/r/src/round-2-request.md',
        },
      ],
    })
    expect('deny' in checkCommand("herdr agent prompt hymn-orch '[hymn-src] accepted: /r/src/round-2-findings.md'", rev)).toBe(false)
  })

  test('a free-form, foreign-track or misrouted handoff is refused', async () => {
    expect('deny' in checkCommand('herdr agent prompt hymn-src-rev "ready for review, see the diff"', impl)).toBe(true)
    expect('deny' in checkCommand('herdr agent prompt hymn-src-rev "[hymn-dsg] Round 1 ready: /r/x.md"', impl)).toBe(true)
    const misrouted = checkCommand('herdr agent prompt hymn-orch "[hymn-src] Round 1 ready: /r/x.md"', impl)
    expect(misrouted).toEqual({ deny: 'orchestrate: "Round 1 ready" goes to hymn-src-rev, not hymn-orch.' })
  })

  test('the orchestrator writes free-form messages to workers', async () => {
    const orch = roleOf('hymn-orch')!
    expect(checkCommand('herdr agent prompt hymn-src-impl "orch: [hymn-src] decision: keep drafts; continue"', orch)).toEqual({ handoffs: [] })
  })
})

const file = (name: string, mtimeMs: number, firstLine?: string) => ({ name, mtimeMs, firstLine })

describe('track state', () => {
  test('each protocol file moves the turn along the chain', async () => {
    expect(deriveTrack([file('spec.md', 1)], false).next).toBe('impl')
    const r1 = [file('spec.md', 1), file('round-1-request.md', 2)]
    expect(deriveTrack(r1, false)).toEqual({ round: 1, next: 'rev', label: 'r1 in review', since: 2 })
    const fixing = [...r1, file('round-1-findings.md', 3, 'Verdict: CHANGES REQUIRED')]
    expect(deriveTrack(fixing, false).next).toBe('impl')
    expect(deriveTrack([...fixing, file('round-2-request.md', 4)], false).label).toBe('r2 in review')
    const accepted = [...r1, file('round-1-findings.md', 3, 'Verdict: ACCEPTED')]
    expect(deriveTrack(accepted, false).next).toBe('orch')
    expect(deriveTrack(accepted, true).next).toBe('ver')
    expect(deriveTrack([...accepted, file('round-1-verify.md', 4, 'Verdict: FAIL')], true).next).toBe('impl')
    expect(deriveTrack([...accepted, file('round-1-verify.md', 4, 'Verdict: PASS')], true).label).toBe('accepted')
    expect(deriveTrack([...r1, file('round-1-findings.md', 3, 'Verdict: STUCK')], false).label).toBe('stuck')
    expect(deriveTrack([...r1, file('blocked.md', 5)], false)).toEqual({ round: 1, next: 'orch', label: 'blocked', since: 5 })
  })
})

describe('stalls', () => {
  const review = { round: 1, next: 'rev' as const, label: 'r1 in review', since: 0 }

  test('a quiet track stalls only after the threshold; a working one never does', async () => {
    const base = { state: review, agents: { impl: 'idle', rev: 'idle' } as const, blockedSince: undefined, reportedAt: undefined }
    expect(stallOf({ ...base, quietSince: 0, now: STALL_MS - 1 })).toBeUndefined()
    expect(stallOf({ ...base, quietSince: 0, now: STALL_MS })).toContain('idle 10m')
    expect(stallOf({ ...base, quietSince: undefined, now: STALL_MS * 3 })).toBeUndefined()
  })

  test('a missing agent whose turn it is, and an unreported acceptance, alert', async () => {
    const common = { quietSince: undefined, blockedSince: undefined, reportedAt: undefined }
    expect(stallOf({ ...common, state: review, agents: { impl: 'idle' }, now: 0 })).toContain('rev agent is gone')
    const accepted = { round: 1, next: 'orch' as const, label: 'accepted', since: 100 }
    expect(stallOf({ ...common, state: accepted, agents: {}, now: 100 + UNREPORTED_MS })).toContain('no message reached you')
    expect(stallOf({ ...common, state: accepted, agents: {}, reportedAt: 150, now: 100 + UNREPORTED_MS })).toBeUndefined()
  })
})
