import { describe, expect, test } from 'bun:test';
import { digest, sha256, urlChange, type UrlSource } from './upstreams';

const content = '# Cleaning copy\n\nWalk each string down the ladder.\n';
const source = (hash: string): UrlSource => ({
  name: 'clean-copy',
  url: 'https://paste.example/raw/abc',
  into: ['ui'],
  license: 'none: restate, never copy',
  folded: { hash, date: '2026-11-09' },
});
const noManaged = { outdated: [], modified: [] };

describe('a URL source', () => {
  test('reads as unchanged while its content hashes to the folded hash', () => {
    const change = urlChange(source(sha256(content)), content);
    expect(change.commits).toEqual([]);
    expect(digest([change], noManaged)).toContain('0 of 1 moved');
    expect(digest([change], noManaged)).toContain('Unchanged: clean-copy');
  });

  test('reads as moved once its content changes, naming the URL and both hashes', () => {
    const before = sha256(content);
    const edited = content + 'Cut whole clauses.\n';
    const change = urlChange(source(before), edited);
    expect(change.commits).toEqual(['content changed since 2026-11-09']);
    const text = digest([change], noManaged);
    expect(text).toContain('1 of 1 moved');
    expect(text).toContain('### clean-copy (https://paste.example/raw/abc, none: restate, never copy) → ui');
    expect(text).toContain(`${before.slice(0, 7)}..${sha256(edited).slice(0, 7)}: ${edited.length} bytes now`);
  });
});
