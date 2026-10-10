import { describe, expect, test } from 'claude-code/testing'

import { type Identity, checkCommand, parseIdentity, parseRuns, summary } from '../hooks/protocol'

const impl: Identity = { run: 'hymn', role: 'impl', track: 'hymn-src' }
const orch: Identity = { run: 'hymn', role: 'orch', track: '' }

describe('safety guard', () => {
  test("safety.md's banned shapes are refused, each with what to do instead", async () => {
    const refused: [string, string][] = [
      ["cat > src/a.ts <<'EOF'\nx\nEOF", 'Write and Edit'],
      ['git commit -F - <<EOF\nfix\nEOF', 'Write and Edit'],
      ['python3 -c "open(\'a\',\'w\').write(1)"', 'jq'],
      ["python3 - <<'X'\nprint(1)\nX", 'Write and Edit'],
      ['bun -e "await Bun.write(1)"', 'bun <file>'],
      ['rm -rf node_modules', 'trash'],
      ['cd x && rm -r dist', 'trash'],
      ['git stash push -m wip', 'git show'],
      ['git reset --hard HEAD~1', 'new commit'],
      ['git push -f origin main', 'without force'],
      ['git commit --no-verify -m wip', 'passes the hook'],
      ['LEFTHOOK=0 git commit -m wip', 'passes the hook'],
    ]
    for (const [command, hint] of refused) expect(checkCommand(command, impl)?.deny).toContain(hint)
  })

  test('the safe neighbours of those shapes pass', async () => {
    for (const command of [
      'trash dist',
      'git commit -m "fix: rm -r handling"',
      'jq .result <<< "$json"',
      'git show HEAD~1:src/a.ts',
      'git push origin main',
      'bun test',
      'git restore --staged src/a.ts',
      'echo "1 << 2"',
    ])
      expect(checkCommand(command, impl)).toBeUndefined()
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
