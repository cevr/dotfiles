import type { EngineInterface, Register } from 'claude-code'

import { local, rest } from './sabbath'

// From Friday sunset to 30 minutes after Saturday's (sabbath.ts `rest`) no agent
// work runs. A new subagent or workflow is refused, and a running subagent's next
// tool call is refused, so it ends its turn. A Codex start or send goes on: the
// codex-bridge latches its turn until the rest ends. The main loop answers the
// owner as always. Each refusal is kept, and once the rest ends the session gets
// one message to resume that work: the latch for Claude's side. The status line
// names when work resumes.

// Tools that start agent work outside this session's subagents. Codex's latch in the bridge.
const STARTS = new Set(['Workflow'])
const MINUTE = 60e3
// The work held in this session, in the plugin's store so a restart keeps it.
const HELD = (session: string) => `held:${session}`
type Held = { end: number; work: string[] }

async function now($: EngineInterface) {
  const s = rest(await $.clock.now())
  return { ...s, why: `It is the Sabbath; agent work resumes at ${local(s.end)} (30 min after sunset, Knowlton, QC).` }
}

/** Keeps one line of held work, to resume once the rest ends. */
async function hold($: EngineInterface, end: number, what: string) {
  try {
    const key = HELD(await $.session.id())
    const held = ((await $.store.get(key)) as Held | undefined) ?? { end, work: [] }
    if (!held.work.includes(what)) held.work.push(what)
    await $.store.set(key, { end, work: held.work.slice(-20) })
  } catch (error) {
    // The refusal stands without its note; the owner restarts that work by hand.
    $.ui.log(`sabbath: could not keep held work: ${String(error)}`, { to: 'debug' })
  }
}

/** Shows the rest on the status line, and once it ends sends the message to resume what it held. */
async function tick($: EngineInterface) {
  const s = await now($)
  $.ui.status(s.on ? `Sabbath; work resumes ${local(s.end)}` : undefined)
  if (s.on) return
  const key = HELD(await $.session.id())
  const held = (await $.store.get(key)) as Held | undefined
  if (!held) return
  await $.store.delete(key)
  void $.prompt.submit({
    text: [
      `The Sabbath rest ended at ${local(held.end)}. Resume the agent work it held, from the files and state where each piece stopped:`,
      ...held.work.map(w => `- ${w}`),
      'Codex turns latched in the codex-bridge start by themselves.',
    ].join('\n'),
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const done = await next(e)
    void tick($)
    $.clock.every(MINUTE, () => void tick($))
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const s = await now($)
    if (!s.on) return next(e)
    await hold($, s.end, `start the ${e.subagentType ?? 'general-purpose'} agent "${e.description}"`)
    return { deny: `${s.why} No agent starts now. Do not retry; this session gets a message to resume when work resumes.` }
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId && !STARTS.has(e.tool)) return next(e)
    const s = await now($)
    if (!s.on) return next(e)
    if (e.agentId) {
      await hold($, s.end, `continue the work of subagent ${e.agentId}, which stopped for the Sabbath`)
      return { deny: `${s.why} Stop now: end your turn with one line on where you stopped. Make no more tool calls.` }
    }
    await hold($, s.end, `run the ${e.tool} call that was refused`)
    return { deny: `${s.why} No workflow starts now. Do not retry; this session gets a message to resume when work resumes.` }
  })
}
