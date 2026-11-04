// Tool contracts from the Claude Code codex mod. Canonical OpenCode names use the codex_ prefix.
export const TOOLS = [
  {
    name: 'start',
    description:
      'Starts a Codex thread on this host and runs its first turn in the background. Returns at once with the thread id; ' +
      'when the turn ends, its final message arrives as a message from the codex plugin, so never poll. ' +
      'For an orchestrate role pass `role`: the thread then carries that role agent\'s instructions and effort (~/.codex/agents/<role>.toml). ' +
      '`model` takes a slug, or a family (luna, sol, terra, astra) for its newest release; left out, Codex\'s configured default. ' +
      'The thread runs under the host Codex config (sandbox and approvals included) unless `sandbox` is passed. ' +
      'When the Codex budget has no room (the account\'s burn with this turn past the weekly pace, or, when that cannot be measured, weekly use ahead of an even burn), the turn is latched and starts by itself later; the answer says why and when it should start. ' +
      'When it would start more than 10 minutes from now, no thread is made and the answer says to run the role on Claude now.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'Starts like the hand-back line: `<role> <unit> r<N>` (`implementor sheet r1`).' },
        prompt: { type: 'string', description: 'The first message: role, spec path and round, for a role thread.' },
        role: { type: 'string', enum: ['planner', 'implementor', 'verifier', 'reviewer'], description: '`reviewer` is the verifier\'s former name and runs as the verifier.' },
        unit: { type: 'string', description: 'The orchestrate unit (`sheet`), for the bridge\'s log and the cost of each unit.' },
        round: { type: 'integer', description: 'The orchestrate round, 1 for r1.' },
        model: { type: 'string' },
        effort: { type: 'string', enum: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Overrides the role\'s effort.' },
        cwd: { type: 'string', description: 'Absolute; the session\'s directory by default.' },
        sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
      },
      required: ['description', 'prompt'],
    },
  },
  {
    name: 'send',
    description:
      'Runs the next turn on an idle Codex thread, with its context and prompt cache kept (a round 2 fix is a delta). ' +
      'The answer arrives as a message, like the first turn\'s. Refused while the thread runs or has a latched turn. ' +
      'A next turn passes the same Codex budget as a first one: without room it is latched (ahead of new threads) and starts by itself.',
    inputSchema: {
      type: 'object',
      properties: { thread: { type: 'string' }, prompt: { type: 'string' } },
      required: ['thread', 'prompt'],
    },
  },
  {
    name: 'interrupt',
    description: 'Stops the running turn of a Codex thread. Its end arrives as a message with status interrupted.',
    inputSchema: { type: 'object', properties: { thread: { type: 'string' } }, required: ['thread'] },
  },
  {
    name: 'threads',
    description:
      "This session's Codex threads: status, model and effort, turns, tokens, context fill and compactions; and the Codex budget: each usage window and whether new threads and next turns go on.",
    inputSchema: { type: 'object', properties: {} },
  },
] as const

