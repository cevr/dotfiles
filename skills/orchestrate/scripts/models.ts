#!/usr/bin/env bun
// Cost, time and tokens per subagent role and model, read from Claude Code subagent transcripts.
// Usage: bun models.ts [--since 2026-10-17] [--json]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const sinceAt = args.indexOf('--since');
const since = sinceAt >= 0 ? Date.parse(args[sinceAt + 1]) : Date.now() - 7 * 86400e3;
const json = args.includes('--json');

// $ per million tokens: input, cache write (5-minute TTL, 1.25x input), cache read, output.
// From the claude-api skill's model table, cached 2026-10-06. Update when prices change.
const PRICE: Record<string, [number, number, number, number]> = {
  'claude-opus-5-5': [4, 5, 0.2, 20],
  'claude-sonnet-5-5': [2, 2.5, 0.2, 10],
  'claude-haiku-5-5': [0.1, 0.125, 0.01, 0.5],
  'claude-fable-5-1': [10, 12.5, 0.25, 50],
};

// The role comes from the Agent description and the first words of the prompt.
const role = (head: string) =>
  /\breview|counsel|findings/.test(head) ? 'review'
  : /\bverif/.test(head) ? 'verify'
  : /\bplanner|\bplan\b|write spec/.test(head) && !/implement/.test(head) ? 'plan'
  : /implement|round[- ]?\d|\bfix|\bbuild|spec\.md/.test(head) ? 'implement'
  : /explore|search|research|read-only|investigat/.test(head) ? 'explore'
  : 'other';

type Agent = { id: string; model: string; role: string; min: number; cost: number; out: number; compacted: boolean };
const agents = new Map<string, Agent>();
const root = join(homedir(), '.claude/projects');
for (const project of readdirSync(root)) {
  const pdir = join(root, project);
  if (!statSync(pdir).isDirectory()) continue;
  for (const session of readdirSync(pdir)) {
    const sdir = join(pdir, session, 'subagents');
    if (!existsSync(sdir)) continue;
    for (const f of readdirSync(sdir)) {
      if (!f.endsWith('.jsonl') || agents.has(f)) continue;
      const path = join(sdir, f);
      if (statSync(path).mtimeMs < since) continue;
      let desc = '';
      try { desc = JSON.parse(readFileSync(path.replace(/\.jsonl$/, '.meta.json'), 'utf8')).description ?? ''; } catch {}
      const models = new Map<string, number>();
      const seen = new Set<string>();
      let first = 0, last = 0, prompt = '', cost = 0, out = 0, compacted = false;
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        let d: any;
        try { d = JSON.parse(line); } catch { continue; }
        if (d.timestamp) { const t = Date.parse(d.timestamp); first ||= t; last = t; }
        if (d.type === 'system' && /compact/.test(d.subtype ?? '')) compacted = true;
        if (d.type === 'user' && !prompt) {
          const c = d.message?.content;
          prompt = typeof c === 'string' ? c : (c ?? []).map((x: any) => x?.text ?? '').join(' ');
        }
        const m = d.message;
        if (d.type !== 'assistant' || !PRICE[m?.model] || seen.has(m.id)) continue;
        seen.add(m.id);
        models.set(m.model, (models.get(m.model) ?? 0) + 1);
        const u = m.usage ?? {}, [i, w, r, o] = PRICE[m.model];
        cost += ((u.input_tokens ?? 0) * i + (u.cache_creation_input_tokens ?? 0) * w + (u.cache_read_input_tokens ?? 0) * r + (u.output_tokens ?? 0) * o) / 1e6;
        out += u.output_tokens ?? 0;
      }
      if (!models.size || last < since) continue;
      const model = [...models].sort((a, b) => b[1] - a[1])[0][0].replace('claude-', '');
      const head = `${desc} ${prompt.slice(0, 400)}`.toLowerCase();
      agents.set(f, { id: f.replace(/\.jsonl$/, ''), model, role: role(head), min: (last - first) / 60000, cost, out, compacted });
    }
  }
}
if (json) { console.log(JSON.stringify([...agents.values()])); process.exit(0); }

const med = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const groups = new Map<string, Agent[]>();
for (const a of agents.values()) groups.set(`${a.role} ${a.model}`, [...(groups.get(`${a.role} ${a.model}`) ?? []), a]);
const total = [...agents.values()].reduce((s, a) => s + a.cost, 0);
console.log(`agents ${agents.size}, API-priced $${total.toFixed(0)}`);
console.log('role       model         n   med-$  total-$  med-min  med-out-k  compacted');
for (const [key, xs] of [...groups].sort()) {
  const [r, m] = key.split(' ');
  console.log(`${r.padEnd(10)} ${m.padEnd(11)} ${String(xs.length).padStart(4)} ${med(xs.map((x) => x.cost)).toFixed(2).padStart(7)} ${xs.reduce((s, x) => s + x.cost, 0).toFixed(0).padStart(8)} ${med(xs.map((x) => x.min)).toFixed(1).padStart(8)} ${(med(xs.map((x) => x.out)) / 1e3).toFixed(1).padStart(10)} ${((100 * xs.filter((x) => x.compacted).length) / xs.length).toFixed(0).padStart(9)}%`);
}
