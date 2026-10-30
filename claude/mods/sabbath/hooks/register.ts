import type { EngineInterface, Register } from 'claude-code'

import { local, sabbath } from './sabbath'

// From Friday sunset to Saturday sunset (sabbath.ts) no agent work runs: a new
// subagent, Codex turn or workflow is refused, and a running subagent's next
// tool call is refused, so it ends its turn. The main loop answers the owner as
// always. The status line names when the Sabbath ends.

// Tools that start agent work outside this session's subagents.
const STARTS = new Set(['mcp__codex__start', 'mcp__codex__send', 'Workflow'])
const MINUTE = 60e3

async function now($: EngineInterface) {
  const s = sabbath(await $.clock.now())
  return { ...s, why: `It is the Sabbath until ${local(s.end)} (sunset, Knowlton, QC).` }
}

async function show($: EngineInterface) {
  const s = await now($)
  $.ui.status(s.on ? `Sabbath until ${local(s.end)}` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const done = await next(e)
    void show($)
    $.clock.every(MINUTE, () => void show($))
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const s = await now($)
    return s.on ? { deny: `${s.why} No agent starts now. Do not retry before then; resume the work after it.` } : next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId && !STARTS.has(e.tool)) return next(e)
    const s = await now($)
    if (!s.on) return next(e)
    return e.agentId
      ? { deny: `${s.why} Stop now: end your turn with one line on where you stopped. Make no more tool calls.` }
      : { deny: `${s.why} No Codex turn or workflow starts now. Do not retry before then; resume the work after it.` }
  })
}
