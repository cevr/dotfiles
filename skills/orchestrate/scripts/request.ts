#!/usr/bin/env bun
// The orchestrator's check of a round's request before the unit lands (protocol.md, Implementor): it exists and
// names its head commit (a missing `Digest:` line is a hint).
// Usage: bun request.ts <unit dir> <round>   Exit 0: it is ready to land. Exit 1: send the reasons back.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

/** The head commit a request names: `Head: <sha>`, or the right side of `<base>..<head>`. */
export function headOf(request: string): string | undefined {
  return /\bhead\b[^\n]*?\b([0-9a-f]{7,40})\b/i.exec(request)?.[1] ?? /\b[0-9a-f]{7,40}\.\.([0-9a-f]{7,40})\b/.exec(request)?.[1];
}

/** The `Digest:` line's text, from the first 8 lines (as the digest reads it: line 2 by the protocol). */
export function digestOf(request: string): string | undefined {
  for (const line of request.split('\n').slice(0, 8)) {
    const said = /^[\s>*_`]*digest:[*_`]*\s*(.*?)\s*$/i.exec(line)?.[1];
    if (said) return said;
  }
  return undefined;
}

/** What round `n`'s request should add, without being held back for it: a `Digest:` line. */
export function hints(dir: string, n: number): string[] {
  const request = read(join(dir, `round-${n}-request.md`));
  if (request === undefined || digestOf(request)) return [];
  return [`round-${n}-request.md has no \`Digest:\` line: add it as line 2 (what changed or blocks, then why it matters)`];
}

/** Why round `n`'s request cannot land; empty when it can. */
export function refusals(dir: string, n: number): string[] {
  const request = read(join(dir, `round-${n}-request.md`));
  if (request === undefined) return [`round-${n}-request.md is missing`];
  // `Head: <sha>`, or a range `<base>..<head>`.
  if (!/\bhead\b[^\n]*\b[0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b/i.test(request)) return [`round-${n}-request.md names no head commit`];
  return [];
}

if (import.meta.main) {
  const [dir, round] = process.argv.slice(2);
  if (!dir || !/^\d+$/.test(round ?? '')) {
    console.error('usage: bun request.ts <unit dir> <round>');
    process.exit(2);
  }
  const out = refusals(dir, Number(round));
  for (const r of out) console.error(`request.ts refused: ${r}`);
  for (const h of hints(dir, Number(round))) console.error(`request.ts hint: ${h}`);
  process.exit(out.length ? 1 : 0);
}
