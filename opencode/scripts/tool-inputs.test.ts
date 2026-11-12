// Every tool our plugins add shows the model a plain number (no "Infinity" or
// "NaN" string branch, which invites a model to send numbers as strings) and
// reads a numeric string or a JSON-array string the way `toolInput` does
// (decider/tool-input.ts). The list below is checked against the `input:` of
// every `cmd/*/server.ts`, so a new tool cannot skip it.
import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { PrInput } from "../mods/git/pr.ts"
import { KernelInput } from "../mods/kernel/description.ts"
import { SessionsInput } from "../mods/mail/directory.ts"
import { MessageInput } from "../mods/mail/letter.ts"
import { ForgetInput, SaveInput, SearchInput } from "../mods/memory/notebook.ts"
import { AskInput } from "../mods/questions/ask.ts"
import { PushToolInput } from "../mods/pool/push.ts"
import { QueueInput } from "../mods/queue/queue.ts"
import { RiftInput } from "../mods/rift/rift.ts"
import { CancelInput, JobInput, ListInput, MonitorInput, WakeInput } from "../mods/wake/tools.ts"

// The mods build their schemas on the fork's effect, this script on the root's: typed apart, the same at run time.
const INPUTS: Record<string, unknown> = {
  PrInput,
  KernelInput,
  SessionsInput,
  MessageInput,
  SaveInput,
  SearchInput,
  ForgetInput,
  AskInput,
  PushToolInput,
  QueueInput,
  RiftInput,
  WakeInput,
  MonitorInput,
  CancelInput,
  ListInput,
  JobInput,
}

const cmd = join(import.meta.dir, "..", "cmd")
const registered = readdirSync(cmd).flatMap((name) => {
  const text = (() => {
    try {
      return readFileSync(join(cmd, name, "server.ts"), "utf8")
    } catch {
      return ""
    }
  })()
  return [...text.matchAll(/^\s+input: ([A-Z]\w*),$/gm)].map((match) => match[1]!)
})

const jsonSchema = (schema: unknown) => JSON.stringify(Schema.toJsonSchemaDocument(schema as Schema.Top, { onExcessProperty: "error" }))
const decoder = (schema: unknown) => Schema.decodeUnknownSync(schema as Schema.Codec<unknown>)

describe("plugin tool inputs", () => {
  test("the list holds every input a cmd/*/server.ts registers", () => {
    expect(registered.length).toBeGreaterThan(10)
    expect([...new Set(registered)].toSorted()).toEqual(Object.keys(INPUTS).toSorted())
  })

  test.each(Object.keys(INPUTS))("%s emits no string branch for a number", (name) => {
    expect(jsonSchema(INPUTS[name]!)).not.toContain("Infinity")
  })

  test("memory_forget takes its id as a number or a numeric string, and nothing else", () => {
    const decode = decoder(ForgetInput)
    expect(decode({ id: 16 })).toEqual({ id: 16 })
    expect(decode({ id: "16" })).toEqual({ id: 16 })
    expect(() => decode({ id: "sixteen" })).toThrow("Expected number")
  })

  test("memory_save takes tags as a JSON-array string, and an id as a numeric string", () => {
    const decode = decoder(SaveInput)
    expect(decode({ text: "Use bun", id: "5", tags: '["preferences","reports"]' })).toEqual({ text: "Use bun", id: 5, tags: ["preferences", "reports"] })
    expect(decode({ text: "Use bun", tags: "tests, ci" })).toEqual({ text: "Use bun", tags: ["tests", "ci"] })
  })

  test("a wake's seconds and a pr's list arrive as strings and decode", () => {
    expect(decoder(WakeInput)({ afterSeconds: "90", note: "check CI" })).toEqual({ afterSeconds: 90, note: "check CI" })
    expect(decoder(PrInput)({ action: "status", prs: '[12, "owner/name#3"]' })).toEqual({ action: "status", prs: [12, "owner/name#3"] })
  })
})
