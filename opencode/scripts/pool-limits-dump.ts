#!/usr/bin/env bun
// What the limit tally needs from one host's OpenCode database, as compact
// JSON on stdout: the pool's newest reading of each login (its own and the
// ones its peers reported), every step the pool's ledger placed (login and
// assistant message) joined to that message's model and tokens, and the
// Codex steps of a paced pool. Standalone (bun:sqlite only), so it can be
// copied to another host and run there. Open a COPY of the database, never
// the live one: `bun pool-limits-dump.ts <copy of opencode.db>`.
// pool-limits.ts reads one dump per host (`--dump <host>=<file>`).
import { Database } from "bun:sqlite"

const path = process.argv[2]
if (path === undefined) {
  console.error("usage: bun pool-limits-dump.ts <copy of opencode.db>")
  process.exit(2)
}

const db = new Database(path, { readonly: true })
const PLUGIN = "dotfiles-opencode.pool"
const prefix = `plugin:${[...PLUGIN].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("")}:`

type Row = { key: string; value: string }
const kv = (pattern: string) =>
  db.query<Row, [string]>("select key, value from kv where key like ?").all(`${prefix}${pattern}`).map((row) => ({ key: row.key.slice(prefix.length), value: JSON.parse(row.value) as any }))

// Readings: each pool's newest of each login, and what each peer last reported.
const readings: Array<{ pool: string; credentialID: string; reading: unknown; own: boolean }> = []
for (const { key, value } of kv("%/reading/%")) {
  const [pool, , credentialID] = key.split("/", 3)
  if (pool !== undefined && credentialID !== undefined) readings.push({ pool, credentialID, reading: value, own: true })
}
for (const { value } of kv("fleet/peer/%")) for (const shared of value?.report?.readings ?? []) readings.push({ ...shared, own: false })

// The resets claimed: a claim that emptied a window cuts its period short.
const claims = kv("resets/claim/%").flatMap(({ value }) =>
  value?.outcome === "reset" || value?.outcome === "already-redeemed" ? [{ pool: value.pool, credentialID: value.credentialID, at: value.at }] : [],
)

// The placed steps: login by assistant message. The tokens count from the
// last step the ledger kept without its message (an older pool named none):
// before it, steps cannot be joined to their tokens.
const steps = new Map<string, { pool: string; credentialID: string; at: number }>()
let first = Number.POSITIVE_INFINITY
let unnamed = Number.NEGATIVE_INFINITY
for (const { key, value } of kv("%/step/%")) {
  const pool = key.split("/", 1)[0]!
  first = Math.min(first, value.at)
  if (typeof value.messageID === "string") steps.set(value.messageID, { pool, credentialID: value.credentialID, at: value.at })
  else unnamed = Math.max(unnamed, value.at)
}
const since = Number.isFinite(first) ? Math.max(first, unnamed + 1) : Date.now()

// A Codex step went out on the paced pool's login: the dump names it when this host has exactly one.
const paced = new Map<string, Array<string>>()
for (const { pool, credentialID, own } of readings) if (own && pool === "openai") paced.set(pool, [...new Set([...(paced.get(pool) ?? []), credentialID])])

type Message = { id: string; created: number; provider: string | null; model: string | null; tokens: string | null }
const messages = db
  .query<Message, [number]>(
    `select id, time_created as created, json_extract(data, '$.model.providerID') as provider, json_extract(data, '$.model.id') as model,
            json_extract(data, '$.tokens') as tokens
       from session_message where type = 'assistant' and time_created >= ?`,
  )
  .all(Number.isFinite(first) ? first : since)

const uses: Array<{ at: number; pool: string; credentialID: string; model: string; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number } }> = []
const unplaced: Record<string, number> = {}
for (const message of messages) {
  if (message.model === null || message.tokens === null) continue
  const t = JSON.parse(message.tokens) as { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  const tokens = { input: t.input ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), cacheRead: t.cache?.read ?? 0, cacheWrite: t.cache?.write ?? 0 }
  const step = steps.get(message.id)
  const codex = message.provider === "openai" ? paced.get("openai") : undefined
  if (step !== undefined) uses.push({ at: step.at, pool: step.pool, credentialID: step.credentialID, model: message.model, tokens })
  else if (codex?.length === 1) uses.push({ at: message.created, pool: "openai", credentialID: codex[0]!, model: message.model, tokens })
  else if (message.created >= since) unplaced[`${message.provider}/${message.model}`] = (unplaced[`${message.provider}/${message.model}`] ?? 0) + 1
}

console.log(JSON.stringify({ at: Date.now(), since, readings, claims, uses, unplaced }))
