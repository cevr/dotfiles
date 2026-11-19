#!/usr/bin/env bun
// After a fold: every sentence the old files held at <base> that no current target file still holds.
// A sentence counts as kept when its normalized text is in the targets, or when at least 80% of its
// words (longer than three letters) appear in one target file. What it prints is either a rule to put
// back or a pure rewording to name in the fold's report; it never decides which.
//
// Usage: bun lost-sentences.ts <base rev> <old pathspec> <target file>...
//   e.g. bun lost-sentences.ts f9da27f7 principles/ skills/principle-*/SKILL.md
// Prints `<old file>\t<best cover>\t<best target>\t<sentence>`; exit 1 when any is printed.
import { $ } from 'bun';

const [base, old, ...targets] = process.argv.slice(2);
if (!base || !old || targets.length === 0) {
  console.error('usage: bun lost-sentences.ts <base rev> <old pathspec> <target file>...');
  process.exit(2);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/\[\[([^\]]+)\]\]|\[([^\]]+)\]\([^)]+\)/g, ' $1$2 ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const sentences = (t: string) =>
  t
    .replace(/^---\n[\s\S]*?\n---\n/, '')
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[-*>#\d.\s]+/, '').trim())
    .filter((s) => norm(s).split(' ').length >= 5);
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 3));

const texts = await Promise.all(targets.map(async (path) => ({ path, text: await Bun.file(path).text() })));
const all = texts.map((t) => norm(t.text)).join(' ');
const sets = texts.map((t) => ({ path: t.path, words: words(t.text) }));

const files = (await $`git ls-tree -r --name-only ${base} -- ${old}`.text()).trim().split('\n').filter(Boolean);
let lost = 0;
for (const file of files) {
  const text = await $`git show ${base}:${file}`.text();
  for (const s of sentences(text)) {
    if (all.includes(norm(s))) continue;
    const want = [...words(s)];
    if (want.length === 0) continue;
    const best = sets
      .map((t) => ({ path: t.path, cover: want.filter((w) => t.words.has(w)).length / want.length }))
      .reduce((a, b) => (b.cover > a.cover ? b : a));
    if (best.cover >= 0.8) continue;
    lost += 1;
    console.log(`${file}\t${best.cover.toFixed(2)}\t${best.path}\t${s}`);
  }
}
process.exit(lost > 0 ? 1 : 0);
