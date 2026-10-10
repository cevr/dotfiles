import { describe, expect, test } from 'claude-code/testing'

import { type Identity, checkCommand, parseIdentity, parseRuns, summary } from '../hooks/protocol'

const impl: Identity = { run: 'hymn', role: 'impl', track: 'hymn-src' }
const orch: Identity = { run: 'hymn', role: 'orch', track: '' }

describe('hook guard', () => {
  test('a commit that skips the hook is refused; a gated one passes', async () => {
    for (const command of ['git commit --no-verify -m wip', 'LEFTHOOK=0 git commit -m wip'])
      expect(checkCommand(command, impl)?.deny).toContain('passes the hook')
    expect(checkCommand('git commit -m wip', impl)).toBeUndefined()
  })
})

describe('command guard', () => {
  test('polling is refused in every seat', async () => {
    for (const command of [
      'herdr agent wait hymn-src-rev --until idle',
      'sleep 60',
      'until grep -q done log; do sleep 5; done',
    ])
      expect(checkCommand(command, impl)).toBeDefined()
    expect(checkCommand('sleep 1 && bun test', impl)).toBeUndefined()
  })

  test("a hand-written message to the run's agents names the baton command", async () => {
    const worker = checkCommand('herdr agent prompt hymn-src-rev "round 1 ready"', impl)
    expect(worker?.deny).toContain('baton pass')
    const lead = checkCommand("herdr agent prompt 'hymn-src-impl' 'merge main'", orch)
    expect(lead?.deny).toContain('baton tell')
    expect(checkCommand('herdr agent prompt someone-else "hi"', impl)).toBeUndefined()
    expect(checkCommand('baton pass /r/src/round-1-request.md', impl)).toBeUndefined()
  })
})

describe('baton JSON', () => {
  test('whoami and status parse; anything else is nothing', async () => {
    expect(parseIdentity('[{"run":"hymn","role":"orch","track":""}]')).toEqual(orch)
    expect(parseIdentity('[]')).toBeUndefined()
    expect(parseIdentity('not json')).toBeUndefined()
    expect(parseRuns('{"run":"hymn"}')).toEqual([])
  })

  test('the status line counts tracks, the ones waiting on you, and what is owed', async () => {
    const track = { track: 'hymn-src', unit: 'src', step: 'accepted', holder: 'orch', round: 2, failures: 1, since: 0, agents: [] }
    expect(summary({ run: 'hymn', tracks: [], undelivered: [] })).toBeUndefined()
    expect(
      summary({
        run: 'hymn',
        tracks: [track, { ...track, track: 'hymn-ui', holder: 'impl' }],
        undelivered: [{ ref: 4, to: 'hymn-ui-impl', state: 'failed', failure: 'agent_blocked' }],
      }),
    ).toBe('hymn: 2 tracks · 1 for you · 1 undelivered')
  })
})
