#!/usr/bin/env bun
// The orchestrator's check of a round's request before review (protocol.md, Implementor → Request):
// it exists and names its head commit, and it names a red test for each Blocker or Major the last
// round's findings mark `repeat of`.
// Usage: bun request.ts <unit dir> <round>   Exit 0: review it. Exit 1: send the reasons back.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The ids of the Blockers and Majors whose first line says `repeat of r<N> <id>`. */
export function repeats(findings: string): string[] {
  const out: string[] = [];
  let failing = false, id: string | undefined;
  for (const line of findings.split('\n')) {
    const heading = /^#{1,6}\s*\**\s*(blockers?|majors?|minor|optional|test strength|rejected|receipts)\b/i.exec(line)?.[1];
    if (heading) { failing = /^(blocker|major)/i.test(heading); id = undefined; continue; }
    if (!failing) continue;
    const at = line.search(/repeat of r\d+/i);
    const own = /\b([A-Z]{1,2}\d+)\b/.exec(at >= 0 ? line.slice(0, at) : line)?.[1];
    if (own) id = own;
    if (at >= 0 && id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Why round `n`'s request cannot go to review; empty when it can. */
export function refusals(dir: string, n: number): string[] {
  const request = read(join(dir, `round-${n}-request.md`));
  if (request === undefined) return [`round-${n}-request.md is missing`];
  const out: string[] = [];
  // `Head: <sha>`, or a range `<base>..<head>`.
  if (!/\bhead\b[^\n]*\b[0-9a-f]{7,40}\b|\b[0-9a-f]{7,40}\.\.[0-9a-f]{7,40}\b/i.test(request)) out.push(`round-${n}-request.md names no head commit`);
  const reviewed = new Set(read(join(dir, `round-${n - 1}-request.md`))?.match(/\b[0-9a-f]{7,40}\b/g) ?? []);
  for (const id of repeats(read(join(dir, `round-${n - 1}-findings.md`)) ?? '')) {
    const m = new RegExp(String.raw`^[\s>*-]*repeat\s+${escape(id)}\**:\s*\S.*?\bred at\s+\`?([0-9a-f]{7,40})\b`, 'im').exec(request);
    if (!m) out.push(`${id} is a repeat: add \`repeat ${id}: <new test> red at <the head round ${n - 1} reviewed>\``);
    else if (![...reviewed].some((sha) => sha.startsWith(m[1]) || m[1].startsWith(sha))) out.push(`repeat ${id}: ${m[1]} is not a commit round-${n - 1}-request.md names`);
  }
  return out;
}

if (import.meta.main) {
  const [dir, round] = process.argv.slice(2);
  if (!dir || !/^\d+$/.test(round ?? '')) {
    console.error('usage: bun request.ts <unit dir> <round>');
    process.exit(2);
  }
  const out = refusals(dir, Number(round));
  for (const r of out) console.error(`request.ts refused: ${r}`);
  process.exit(out.length ? 1 : 0);
}
