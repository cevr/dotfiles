// The approved inventory of every generated prompt's text outside its end-of-step block (batch 22t T1: structural,
// not a list of words). Each prompt, per role and host format, is its paragraphs in order; prompt-inventory.json holds
// each paragraph once, word for word, and each prompt as its ordered paragraph ids. ending.test.ts fails on any
// paragraph appended, edited, removed or moved outside a block until the inventory is deliberately rewritten:
//   bun skills/orchestrate/scripts/inventory.ts           show what differs (exit 1 when anything does)
//   bun skills/orchestrate/scripts/inventory.ts --write   rewrite it, after reviewing that every change is meant
// agents.ts never writes it: regenerating prompts does not approve their text.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BLOCK, ROLES, type Role } from './ending.ts';

export const ROOT = join(import.meta.dir, '../../..');
export const INVENTORY = join(ROOT, 'skills/orchestrate/prompt-inventory.json');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

export type Prompt = { readonly role: Role; readonly format: 'claude' | 'codex' | 'opencode'; readonly text: string };
const body = (md: string) => md.replace(/^---\n[\s\S]*?\n---\n/, '');
const toml = (file: string) => {
  const found = /developer_instructions = '''\n([\s\S]*?)\n'''/.exec(file);
  if (found === null) throw new Error('no developer_instructions');
  return found[1] ?? '';
};

/** Every generated prompt as its host gives it to the model: three formats per role, two for the lean worker. */
export function prompts(): Prompt[] {
  const json = JSON.parse(read('opencode/mods/orchestrate/agents.json')) as { agents: Record<string, { system: string }> };
  return ROLES.flatMap((role): Prompt[] => [
    { role, format: 'claude', text: body(read(`agents/${role}.md`)) },
    ...(role === 'worker' ? [] : [{ role, format: 'codex' as const, text: toml(read(`codex/agents/${role}.toml`)) }]),
    { role, format: 'opencode', text: json.agents[role]?.system ?? '' },
  ]);
}

/** A prompt's text outside its block, as paragraphs in order (the block's place is one paragraph of its own). */
export const paragraphs = (text: string): string[] =>
  text
    .replace(BLOCK, '\n\n<end-of-step block>\n\n')
    .split(/\n\s*\n/)
    .map((one) => one.trim())
    .filter(Boolean);

export const id = (paragraph: string) => createHash('sha256').update(paragraph).digest('hex').slice(0, 12);

export type Inventory = { readonly paragraphs: Record<string, string>; readonly prompts: Record<string, ReadonlyArray<string>> };

/** The inventory the prompts as they are would have. */
export function current(all: ReadonlyArray<Prompt> = prompts()): Inventory {
  const texts: Record<string, string> = {};
  const lists: Record<string, string[]> = {};
  for (const prompt of all) {
    lists[`${prompt.role} ${prompt.format}`] = paragraphs(prompt.text).map((paragraph) => {
      texts[id(paragraph)] = paragraph;
      return id(paragraph);
    });
  }
  const sorted = Object.fromEntries(Object.entries(texts).sort(([a], [b]) => a.localeCompare(b)));
  return { paragraphs: sorted, prompts: lists };
}

export const approved = (): Inventory => JSON.parse(readFileSync(INVENTORY, 'utf8')) as Inventory;

/** Every paragraph a prompt has that the approved inventory does not, or lacks, or holds in another place. */
export function drift(prompt: Prompt, inventory: Inventory = approved()): string[] {
  const at = `${prompt.role} ${prompt.format}`;
  const want = inventory.prompts[at];
  if (want === undefined) return [`${at}: not in the inventory`];
  const have = paragraphs(prompt.text).map(id);
  const out: string[] = [];
  const shown = (key: string) => (paragraphs(prompt.text).find((one) => id(one) === key) ?? inventory.paragraphs[key] ?? key).slice(0, 160);
  for (const key of have) if (!want.includes(key)) out.push(`${at}: unapproved paragraph: ${shown(key)}`);
  for (const key of want) if (!have.includes(key)) out.push(`${at}: approved paragraph missing: ${shown(key)}`);
  if (out.length === 0 && have.join() !== want.join()) out.push(`${at}: paragraphs out of their approved order`);
  return out;
}

if (import.meta.main) {
  if (process.argv.includes('--write')) {
    writeFileSync(INVENTORY, `${JSON.stringify(current(), null, 2)}\n`);
    console.log(`wrote ${INVENTORY}`);
  } else {
    const found = prompts().flatMap((prompt) => drift(prompt));
    for (const line of found) console.log(line);
    console.log(found.length ? `${found.length} difference(s); review, then --write` : 'inventory matches');
    process.exitCode = found.length ? 1 : 0;
  }
}
