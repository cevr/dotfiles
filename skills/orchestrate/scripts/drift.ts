// A run's drift from the batch machine, as its own log.md records it: on OpenCode the orchestrate
// plugin scores the root's ledger at each verdict (opencode/mods/orchestrate/drift.ts; 0 is a clean run,
// each refusal, departure, unfolded land, per-unit verifier, off-cadence batch and stale ledger state
// weighted by what it costs the owner) and appends one line to `<run dir>/log.md`:
//   2026-11-12T03:40Z drift 35 after batch-2026-11-12n accepted: 1 unfolded land ×6, 3 departed ×4, …
// status.ts prints a run's last one under its table, and `--trend` each run's across runs.
import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export type DriftReading = { at: string; score: number; batch: string; verdict: string; parts: string };

const LINE = /^(\d{4}-\d\d-\d\dT\d\d:\d\dZ) drift (\d+) after (\S+) (\S+?)(?:: (.*))?$/;

/** Each drift line of a run's log.md, in order. Other lines are skipped. */
export const readingsOf = (log: string): DriftReading[] =>
  log.split('\n').flatMap((line) => {
    const m = LINE.exec(line.trim());
    return m ? [{ at: m[1]!, score: Number(m[2]), batch: m[3]!, verdict: m[4]!, parts: m[5] ?? '' }] : [];
  });

/** The drift readings of the run at `dir`: none without a log.md of its own. */
export const runReadings = (dir: string): DriftReading[] => {
  const log = join(dir, 'log.md');
  return existsSync(log) ? readingsOf(readFileSync(log, 'utf8')) : [];
};

/** The line status.ts prints under a run's table: `Drift: 35 after batch-n accepted (2026-11-12T03:40Z): …`. */
export const driftRow = (reading: DriftReading): string =>
  `Drift: ${reading.score} after ${reading.batch} ${reading.verdict} (${reading.at})${reading.parts ? `: ${reading.parts}` : ''}`;

/** Which way the runs' drift goes: the newer half's mean against the older half's, by each run's last reading. */
export function trendOf(scores: number[]): string {
  if (scores.length < 2) return 'trend: too few runs';
  const half = Math.floor(scores.length / 2);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const older = mean(scores.slice(0, half));
  const newer = mean(scores.slice(scores.length - half));
  const way = newer < older ? 'falling' : newer > older ? 'rising' : 'flat';
  return `trend: ${way} (mean ${newer.toFixed(1)} over the newest ${half} runs, ${older.toFixed(1)} over the oldest ${half})`;
}

/** The trend table: each run with drift readings, oldest last verdict first, then which way it goes. */
export function trendTable(dirs: string[]): string {
  const runs = dirs
    .map((dir) => ({ dir, readings: runReadings(dir) }))
    .filter((run) => run.readings.length > 0)
    .map((run) => ({ ...run, last: run.readings.at(-1)! }))
    .sort((a, b) => a.last.at.localeCompare(b.last.at));
  if (runs.length === 0) return 'No run has a drift line yet.';
  const rows = runs.map(({ dir, readings, last }) => {
    const path = readings.map((r) => r.score).join(' → ');
    return `| ${basename(dir)} | ${last.at} | ${last.score} | ${readings.length} | ${path} | ${last.parts} |`;
  });
  return [
    '| Run | Last verdict | Drift | Verdicts | By verdict | Last parts |',
    '| --- | ------------ | ----- | -------- | ---------- | ---------- |',
    ...rows,
    '',
    trendOf(runs.map((run) => run.last.score)),
  ].join('\n');
}
