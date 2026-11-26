// The orchestrate skill's docs check: the core stays small, keeps the owner's rules, names nothing that was cut,
// and every link and script it names exists. Run from anywhere: `bun test skills/orchestrate/scripts/skill.test.ts`.
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const SKILL_DIR = resolve(import.meta.dir, '..');
const REPO = resolve(SKILL_DIR, '..', '..');
const read = (path: string) => readFileSync(path, 'utf8');
const skill = read(join(SKILL_DIR, 'SKILL.md'));
const protocol = read(join(SKILL_DIR, 'protocol.md'));
const template = read(join(SKILL_DIR, 'spec-template.md'));
const references = readdirSync(join(SKILL_DIR, 'references'))
  .filter((name) => name.endsWith('.md'))
  .map((name) => join(SKILL_DIR, 'references', name));
const docs = [join(SKILL_DIR, 'SKILL.md'), join(SKILL_DIR, 'protocol.md'), join(SKILL_DIR, 'spec-template.md'), ...references];
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

test('the core stays small: the skill and the protocol under 1000 words each', () => {
  expect({ skill: words(skill) <= 1_000, protocol: words(protocol) <= 1_000, template: words(template) <= 250 }).toEqual({ skill: true, protocol: true, template: true });
});

describe("the owner's kept rules", () => {
  const kept: ReadonlyArray<readonly [string, RegExp]> = [
    ['at most four lanes', /At most four lanes/],
    ['no review step', /there is no review step/],
    ['done is the law red then green and the affected checks', /the law red before and green after, the checks the change affects green/],
    ['an install gets one verifier that runs the built pair', /Before an install, one fresh verifier \*\*runs\*\* the built pair/],
    ['three verdict words', /`pass`, `issues`[^\n]*`blocked`, which never passes/],
    ['subagents ask the orchestrator', /Subagents ask you \(`ask_orchestrator`\)/],
    ['deploy is reserved', /Reserved[^\n]*\bdeploy\b/],
    ['publish is reserved', /Reserved[^\n]*\bpublish\b/],
    ['paid runs are reserved', /Reserved[^\n]*paid runs/],
    ['a force-push to a shared branch is reserved', /Reserved[^\n]*force-push to a shared branch/],
    ['non-additive format changes are reserved', /Reserved[^\n]*non-additive/],
    ['the Sabbath hold', /\*\*The Sabbath\*\*[^\n]*no agent works/],
    ['a red merge check never pushes', /A red merge check never pushes/],
    ['verification never on Codex', /never verify on Codex/],
    ['every brief ends with the closing line', /`Finish the whole list; be economical\.` as its last line/],
  ];
  for (const [name, pattern] of kept) test(name, () => expect(skill).toMatch(pattern));
  test('the spec template ends with the closing line', () => expect(template.trimEnd().replace(/```$/, '').trimEnd()).toEndWith('Finish the whole list; be economical.'));
});

describe('nothing names what was cut', () => {
  const cut: ReadonlyArray<RegExp> = [/end-of-step/, /round-policy/, /rewrite\.md/, /\bTest strength\b/, /\bOn base\b/, /\bBlocker or Major\b/, /`long run`/, /\bbatch mode\b/, /`single fix`/, /third failed round/];
  for (const path of docs)
    test(path.slice(SKILL_DIR.length + 1), () => expect(cut.filter((pattern) => pattern.test(read(path))).map(String)).toEqual([]));
});

describe('links and scripts resolve', () => {
  /** A link's file: relative to the doc, or a `~/` path into this checkout. */
  const target = (doc: string, link: string) => {
    const path = link.split('#')[0]!;
    if (path.startsWith('~/.claude/skills/')) return join(REPO, 'skills', path.slice('~/.claude/skills/'.length));
    if (path.startsWith('~/Developer/personal/dotfiles/')) return join(REPO, path.slice('~/Developer/personal/dotfiles/'.length));
    return resolve(dirname(doc), path);
  };
  for (const doc of docs)
    test(doc.slice(SKILL_DIR.length + 1), () => {
      const text = read(doc);
      const links = [...text.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1]!).filter((link) => !/^(https?:|#|mailto:)/.test(link));
      expect(links.filter((link) => !existsSync(target(doc, link)))).toEqual([]);
      const scripts = [...text.matchAll(/([\w.~/-]*?)scripts\/([\w-]+)\.ts/g)].map(([, prefix, name]) =>
        prefix!.endsWith('opencode/') ? join(REPO, 'opencode', 'scripts', `${name}.ts`) : join(SKILL_DIR, 'scripts', `${name}.ts`),
      );
      expect(scripts.filter((path) => !existsSync(path))).toEqual([]);
    });
});
