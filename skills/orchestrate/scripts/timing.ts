#!/usr/bin/env bun
// Wall-clock per machine state across orchestrate units, read from each unit's log.md.
// Usage: bun timing.ts <run dir>... [--since 2026-10-17] [--json]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
const since = sinceAt >= 0 ? Date.parse(args[sinceAt + 1]) : 0;
const json = args.includes('--json');
const given = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--since').map((a) => a.replace(/\/$/, ''));
// A parent of another given run dir holds run logs, not unit logs.
const dirs = given.filter((d) => !given.some((o) => o.startsWith(d + '/')));
if (!dirs.length) {
  console.error('usage: bun timing.ts <run dir>... [--since YYYY-MM-DD] [--json]');
  process.exit(2);
}

// `<time> <from> → <to> r<round> ...`; `stuck(quota)` counts as `stuck`, `merged <sha>` as `merged`.
const TRANSITION = /^(\d{4}-\d\d-\d\dT\d\d:\d\dZ?)\S*\s+(\S+)\s*(?:→|->)\s*([a-z]+)/;
type Unit = {
  run: string; unit: string; final: string; total: number; time: Record<string, number>;
  rework: number; rounds: number; reviewBounces: number; verifyBounces: number; outOfOrder: number;
};
const units: Unit[] = [];
for (const dir of dirs) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const log = join(dir, d.name, 'log.md');
    if (!d.isDirectory() || !existsSync(log)) continue;
    const ts: { at: number; from: string; to: string; round: number }[] = [];
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      const m = TRANSITION.exec(line);
      if (!m) continue;
      const round = / r(\d+)\b/.exec(line.slice(m[1].length));
      ts.push({ at: Date.parse(m[1].endsWith('Z') ? m[1] : m[1] + 'Z'), from: m[2], to: m[3], round: round ? Number(round[1]) : 0 });
    }
    if (ts.length < 2 || ts[ts.length - 1].at < since) continue;
    const time: Record<string, number> = {};
    let rework = 0, outOfOrder = 0;
    for (let i = 0; i < ts.length - 1; i++) {
      const min = (ts[i + 1].at - ts[i].at) / 60000;
      if (min < 0) { outOfOrder++; continue; }
      time[ts[i].to] = (time[ts[i].to] ?? 0) + min;
      if (ts[i].to === 'implement' && ts[i].round >= 2) rework += min;
    }
    units.push({
      run: basename(dir), unit: d.name, final: ts[ts.length - 1].to,
      total: (ts[ts.length - 1].at - ts[0].at) / 60000, time, rework, outOfOrder,
      rounds: Math.max(...ts.map((t) => t.round)),
      reviewBounces: ts.filter((t) => t.from === 'review' && t.to === 'implement').length,
      verifyBounces: ts.filter((t) => t.from === 'verify' && t.to === 'implement').length,
    });
  }
}
if (json) { console.log(JSON.stringify(units)); process.exit(0); }
if (!units.length) { console.log('no units with two or more transitions in range'); process.exit(0); }

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const h = (min: number) => (min / 60).toFixed(1);
const all = sum(units.map((u) => sum(Object.values(u.time))));
console.log(`units ${units.length}, merged ${units.filter((u) => u.final === 'merged').length}`);
console.log('state      total-h  share  median-min-per-unit');
const named = ['plan', 'approved', 'implement', 'review', 'verify', 'decide', 'waiting', 'stuck', 'blocked'];
for (const s of [...named, 'other']) {
  const of = (u: Unit) => (s === 'other' ? sum(Object.entries(u.time).filter(([k]) => !named.includes(k)).map(([, v]) => v)) : u.time[s] ?? 0);
  const xs = units.map(of);
  if (!sum(xs)) continue;
  console.log(`${s.padEnd(10)} ${h(sum(xs)).padStart(7)}  ${((100 * sum(xs)) / all).toFixed(0).padStart(4)}%  ${med(xs.filter((x) => x > 0)).toFixed(0)}`);
}
const impl = sum(units.map((u) => u.time.implement ?? 0)), rework = sum(units.map((u) => u.rework));
console.log(`implement: round 1 ${h(impl - rework)} h, rework (round 2+) ${h(rework)} h`);
for (const [name, key] of [['review', 'reviewBounces'], ['verify', 'verifyBounces']] as const) {
  const xs = units.map((u) => u[key]);
  console.log(`${name} bounces: total ${sum(xs)}, units with ≥1 ${xs.filter((x) => x > 0).length}, max ${Math.max(...xs)}`);
}
console.log(`rounds: median ${med(units.map((u) => u.rounds))}, max ${Math.max(...units.map((u) => u.rounds))}`);
console.log(`first→last transition: median ${med(units.map((u) => u.total)).toFixed(0)} min, worst ${Math.max(...units.map((u) => u.total)).toFixed(0)} min`);
const slow = [...units].sort((a, b) => b.rounds - a.rounds || b.total - a.total).slice(0, 5);
console.log(`longest tails: ${slow.map((u) => `${u.run}/${u.unit} (${u.rounds} rounds, ${h(u.total)} h)`).join(', ')}`);
const skewed = units.filter((u) => u.outOfOrder);
if (skewed.length) console.log(`out-of-order lines skipped in: ${skewed.map((u) => `${u.run}/${u.unit} (${u.outOfOrder})`).join(', ')}`);
