import { expect, test } from 'bun:test';
import { cleaner, isPeer } from './classify.ts';
import { opencodeSession, type SessionInfo } from './opencode.ts';

// Turns no person typed: probe prompts, the PR-checker monitor's notices, and
// the wake mod's alarm, monitor and wake-up notices.
const notOwner = [
  'Reply with exactly the word pong.',
  '"Reply with exactly OK and nothing else."',
  'Say the token back. Nonce 48213',
  'A review or checker state changed on PRs #412, #415: rerun the gate.',
  '[wake-up w01abc] the build you watched finished',
  '⏰ Wake w000001 fired: the alarm you set at 2026-11-05T10:00:00Z, due 2026-11-05T11:00:00Z.',
  '⏰ Monitor w0a1b2c matched: `gh pr checks 12` exited 0 after 3 checks.',
  '⏰ Latch w000003 could not start its subagent: no model',
  'Alarm w0a1b2c set: it wakes this session at 2026-11-05T11:00:00Z',
];

// The owner's own words, close to those patterns, stay the owner's.
const owner = [
  'Reply with the plan before you start',
  'reply with exactly what failed in the gate',
  'Alarm me when the deploy is done',
  'what does the monitor say about the review state?',
  'why did the nonce check fail',
];

test.each(notOwner)('a peer, not the owner: %s', (text) => expect(isPeer(text)).toBe(true));
test.each(owner)('the owner: %s', (text) => expect(isPeer(text)).toBe(false));

test('an OpenCode root counts probe prompts and monitor notices as peers, never as owner messages', () => {
  const T0 = Date.parse('2026-11-04T10:00:00Z');
  const root: SessionInfo = { id: 'ses_r', agent: 'build', time: { created: T0, updated: T0 }, location: { directory: '/w' } };
  const msgs = [...notOwner, ...owner].map((text, i) => ({ type: 'user', time: { created: T0 + i }, text }));
  const { session } = opencodeSession(root, msgs, { since: T0, clean: cleaner(true), skillDirs: new Set() });
  expect({ human: session.human, peer: session.peer }).toEqual({ human: owner.length, peer: notOwner.length });
});
