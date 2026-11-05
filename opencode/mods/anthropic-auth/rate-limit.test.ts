import { describe, expect, test } from 'bun:test'
import { createConnectionLabel, describeConnection } from './rate-limit.ts'

describe('privacy-safe connection identity', () => {
  test('creates distinguishable labels from random bytes, not credentials', () => {
    expect(createConnectionLabel(Uint8Array.of(0x01, 0x23, 0xab, 0xcd))).toBe(
      'Claude OAuth • 0123ABCD',
    )
    expect(createConnectionLabel(Uint8Array.of(0x01, 0x23, 0xab, 0xce))).toBe(
      'Claude OAuth • 0123ABCE',
    )
  })

  test('describes generic and plugin labels without exposing arbitrary labels', () => {
    expect(
      describeConnection({
        type: 'credential',
        id: 'cred-active-stale',
        label: 'Anthropic 3',
      }),
    ).toMatch(/^Anthropic 3 \[connection [a-f0-9]{10}\]$/)
    expect(
      describeConnection({
        type: 'credential',
        id: 'cred-personal',
        label: 'person@example.com',
      }),
    ).toMatch(/^Custom label hidden \[connection [a-f0-9]{10}\]$/)
    expect(
      describeConnection({
        type: 'credential',
        id: 'cred-generated',
        label: 'Claude OAuth • 0123ABCD',
      }),
    ).toMatch(/^Claude OAuth • 0123ABCD \[connection [a-f0-9]{10}\]$/)
  })
})
