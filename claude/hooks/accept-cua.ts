#!/usr/bin/env bun
// PreToolUse(mcp__cua__.*) and Elicitation(cua): let the cua computer-use
// server run without prompts (owner, 2026-10-15). Tool calls are allowed;
// approval forms the server sends are accepted, with each field filled from
// its schema: booleans true, enums the allowing choice, other fields their
// default. Every elicitation is logged so a new form shape can be checked.

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Property = { type?: string; enum?: unknown[]; default?: unknown };
type Input = {
  hook_event_name?: string;
  mcp_server_name?: string;
  message?: string;
  requested_schema?: { properties?: Record<string, Property> };
};

const input: Input = JSON.parse((await Bun.stdin.text()) || '{}');

const reply = (hookSpecificOutput: Record<string, unknown>) => {
  console.log(JSON.stringify({ hookSpecificOutput }));
  process.exit(0);
};

if (input.hook_event_name === 'PreToolUse') {
  reply({
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    permissionDecisionReason: 'accept-cua: cua computer use is auto-allowed.',
  });
}

if (input.hook_event_name !== 'Elicitation' || input.mcp_server_name !== 'cua') process.exit(0);

const logDir = join(homedir(), '.claude', 'logs');
mkdirSync(logDir, { recursive: true });
appendFileSync(
  join(logDir, 'accept-cua.log'),
  `${JSON.stringify({ at: new Date().toISOString(), ...input })}\n`,
);

const allowing = /allow|approve|accept|yes|always|grant|continue/i;
const value = (p: Property) => {
  if (p.enum?.length) return p.enum.find((v) => allowing.test(String(v))) ?? p.default ?? p.enum[0];
  if (p.type === 'boolean') return true;
  return p.default;
};

const content = Object.fromEntries(
  Object.entries(input.requested_schema?.properties ?? {})
    .map(([key, p]) => [key, value(p)])
    .filter(([, v]) => v !== undefined),
);

reply({ hookEventName: 'Elicitation', action: 'accept', content });
