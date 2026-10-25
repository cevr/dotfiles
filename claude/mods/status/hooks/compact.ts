import type { EngineInterface, Register } from 'claude-code'

// The compaction window each agent kind runs at, tuned from the burn. Once a
// day `budget.ts --tune` replays the week's transcripts at each window and
// writes the cheapest for each kind, re-reads after a compaction counted, to
// compact.json. The settings' CLAUDE_CODE_AUTO_COMPACT_WINDOW stays the
// ceiling, and the mod only lowers it:
// - orchestrate-worker and each role's agent (orchestrate-planner, ...) run as
//   this mod's copy, which carries the kind's tuned autoCompactWindow; a role
//   with too few transcripts to tune takes orchestrate-worker's;
// - the main session compacts between turns once its context passes root's
//   window, so that compaction never lands in the middle of a step. Root's
//   window is the owner's (burn.ts PINNED), below the ceiling, so the
//   engine's own compaction is only for a turn that overruns it.
// Every compaction is told to keep the paths of the files that hold the work's
// state: the agent reads them again rather than losing them.

type On = Parameters<Register>[0]

const HOUR = 3600e3
const WORKER = 'orchestrate-worker'
export const KINDS = [WORKER, ...['planner', 'implementor', 'reviewer', 'verifier'].map(role => `orchestrate-${role}`)]
const CACHE = '"$HOME/.cache/orchestrate"'
export const KEEP =
  'Keep these word for word: the path of every plan, log, notes or state file the work reads or writes; the current step and its next action; each instruction the user gave during the session. Name a file by its path rather than restating its contents: it can be read again.'

// Runs the tuner when compact.json is a day old, one session per host at a
// time (a lock older than an hour is a dead run's).
const TUNE = `f=${CACHE}/compact.json lock=${CACHE}/tune.lock
[ -n "$(find "$f" -mmin -1440 2>/dev/null)" ] && exit 0
find "$lock" -maxdepth 0 -mmin +60 -exec rmdir {} \\; 2>/dev/null
mkdir -p ${CACHE} && mkdir "$lock" 2>/dev/null || exit 0
PATH="$HOME/.bun/bin:$PATH" bun "$HOME/.claude/skills/orchestrate/scripts/budget.ts" --tune --deadline-ms 480000
s=$?; rmdir "$lock"; exit $s`

const sh = (script: string) => ['sh', '-c', script]

// compact.json's `windows`: agent kind → tokens, each within the engine's 100k–1M.
export function parseWindows(stdout: string): Record<string, number> {
  const windows = (JSON.parse(stdout) as { windows?: Record<string, unknown> }).windows ?? {}
  return Object.fromEntries(
    Object.entries(windows).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] >= 100e3 && entry[1] <= 1e6,
    ),
  )
}

// An agent file: front matter with `description` and `tools`, then the prompt.
export function parseAgent(text: string): { description: string; tools?: string[]; prompt: string } | undefined {
  const parts = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!parts) return undefined
  const field = (key: string) => parts[1]?.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'))?.[1]?.trim()
  const description = field('description')
  if (!description) return undefined
  const tools = field('tools')
    ?.split(',')
    .map(tool => tool.trim())
    .filter(Boolean)
  return { description, ...(tools?.length ? { tools } : {}), prompt: (parts[2] ?? '').trim() }
}

let windows: Record<string, number> = {}
// The kinds whose copy carries a tuned window.
let copied = new Set<string>()

async function load($: EngineInterface) {
  const tuned = await $.process.run(sh(`cat ${CACHE}/compact.json`), { timeoutMs: 5e3 })
  windows = tuned.exitCode === 0 ? parseWindows(tuned.stdout) : {}
  const next = new Set<string>()
  for (const name of KINDS) {
    const window = windows[name] ?? windows[WORKER]
    const file = window ? await $.process.run(sh(`cat "$HOME/.claude/agents/${name}.md"`), { timeoutMs: 5e3 }) : undefined
    const agent = file?.exitCode === 0 ? parseAgent(file.stdout) : undefined
    if (!window || !agent) continue
    await $.agent.register({ name, ...agent, autoCompactWindow: window })
    next.add(name)
  }
  copied = next
}

async function tuneOnce($: EngineInterface) {
  try {
    await $.process.run(sh(TUNE), { timeoutMs: 600e3 })
    await load($)
  } catch (error) {
    $.ui.log(`status: compaction tuning failed: ${String(error)}`, { to: 'debug' })
  }
}

// From session start: load the tuned windows, and check every hour whether they are a day old.
export function tune($: EngineInterface) {
  void tuneOnce($)
  $.clock.every(HOUR, () => void tuneOnce($))
}

export const compaction = (on: On) => {
  // The copy stays offered: an offer the model is refused is refused at dispatch too, and the spawn names the copy.
  on('agent.spawn', ($, e, next) => next(e.subagentType && copied.has(e.subagentType) ? { ...e, subagentType: `status:${e.subagentType}` } : e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const window = windows.root
    if (!e.agentId && window) {
      const { context } = await $.session.usage()
      if ((context.tokens ?? 0) > window)
        // The engine skips this mod's own session.compact hook on its call: KEEP goes in here.
        $.clock.after(0, () => {
          $.session.compact({ instructions: KEEP }).catch(error => $.ui.log(`status: compaction failed: ${String(error)}`, { to: 'debug' }))
        })
    }
    return done
  })

  on('session.compact', ($, e, next) => next({ ...e, instructions: e.instructions ? `${e.instructions}\n\n${KEEP}` : KEEP }))
}
