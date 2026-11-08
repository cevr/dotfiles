/**
 * Memory as an OpenCode server plugin. The composition root: it opens the
 * host's memory file (`@dotfiles/opencode-memory/sqlite/store`), builds the
 * memory model (`@dotfiles/opencode-memory/model`) on it and OpenCode's
 * sessions, registers the tools and adds the digest to each request.
 *
 * - `memory_save({ text, scope?, tags?, id? })`, `memory_search({ query, limit? })`,
 *   `memory_forget({ id })`: direct tools, so a kernel cell reaches them as
 *   `tools.memory_save(...)` and the rest. A subagent searches; only a main
 *   session saves and forgets.
 * - The `context` hook (every primary request): the session's digest, chosen
 *   at its first request and kept in the file, goes last in the system prompt,
 *   the same text on every request of the session so the cached prefix holds.
 *   Compaction, title and generate requests get none.
 *
 * Options (all optional; an absent one takes its default, a malformed one stops the plugin):
 * - `path`: the SQLite file; default `$XDG_STATE_HOME/opencode-memory/memory.db`.
 * - `digestNotes`: the most notes a digest holds; default 30.
 * - `digestChars`: the most characters its note lines take; default 4000 (about 1k tokens).
 */
import { Plugin, Tool } from "@opencode/plugin/effect"

import { Context, Effect, Layer, Schema } from "effect"
import { LIMITS } from "@dotfiles/opencode-memory/digest"
import * as Model from "@dotfiles/opencode-memory/model"
import {
  explain,
  FORGET,
  FORGET_DESCRIPTION,
  ForgetInput,
  forgotText,
  foundText,
  type Rejection,
  SAVE,
  SAVE_DESCRIPTION,
  savedText,
  SaveInput,
  SEARCH,
  SEARCH_DESCRIPTION,
  SearchInput,
} from "@dotfiles/opencode-memory/notebook"
import * as OpenCodeSessions from "@dotfiles/opencode-memory/opencode/sessions"
import type { MemoryStoreFailed, NoteStore, Sessions, SessionUnreadable } from "@dotfiles/opencode-memory/service"
import * as SqliteStore from "@dotfiles/opencode-memory/sqlite/store"

type SessionID = Parameters<Plugin.Context["session"]["get"]>[0]["sessionID"]

const withDefault =
  <A>(fallback: A) =>
  <S extends Schema.Codec<A, any, never, never>>(schema: S) =>
    schema.pipe(Schema.withDecodingDefaultType(Effect.succeed(fallback)))

const Positive = Schema.Number.check(Schema.isGreaterThan(0))

export const Options = Schema.Struct({
  path: Schema.optional(Schema.String),
  digestNotes: Positive.pipe(withDefault(LIMITS.notes)),
  digestChars: Positive.pipe(withDefault(LIMITS.chars)),
})
export type Options = typeof Options.Type

/** The outside systems memory runs on. */
export type Externals = NoteStore | Sessions

/** The outside systems on this host: its memory file and OpenCode's sessions. */
export const live = (ctx: Plugin.Context, options: Options): Layer.Layer<Externals, MemoryStoreFailed> =>
  Layer.merge(
    SqliteStore.layer(options.path ?? SqliteStore.defaultPath()),
    OpenCodeSessions.layer((sessionID) => ctx.session.get({ sessionID: sessionID as SessionID })),
  )

const messageOf = (failure: Rejection | MemoryStoreFailed | SessionUnreadable): string => {
  if (failure._tag === "MemoryStoreFailed") return `Memory could not be read or written: ${failure.message}`
  if (failure._tag === "SessionUnreadable") return `The session could not be read: ${failure.message}`
  return explain(failure)
}

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })
const refused = (failure: Rejection | MemoryStoreFailed | SessionUnreadable) => new Tool.Error({ message: messageOf(failure), error: failure })

/** The plugin on `externals`: the host's file and sessions in OpenCode, a scratch store and stand-in sessions in the seam test. */
export const make = (externals: (ctx: Plugin.Context, options: Options) => Layer.Layer<Externals, MemoryStoreFailed>) =>
  Plugin.define({
    id: "dotfiles-opencode.memory",
    effect: Effect.fn("Memory.plugin")(function* (ctx) {
      const options = yield* Schema.decodeUnknownEffect(Options)(ctx.options ?? {}).pipe(
        Effect.mapError((error) => new Error(`dotfiles-opencode.memory: invalid options: ${error.message}`)),
        Effect.orDie,
      )
      const services = yield* Layer.build(
        Model.layer({ notes: options.digestNotes, chars: options.digestChars }).pipe(Layer.provide(externals(ctx, options))),
      ).pipe(Effect.orDie)
      const memory = Context.get(services, Model.MemoryModel)

      yield* ctx.tool.transform((editor) => {
        editor.add({
          name: SAVE,
          description: SAVE_DESCRIPTION,
          input: SaveInput,
          options: { codemode: false },
          execute: (input, context) => memory.save(context.sessionID, input).pipe(Effect.map(savedText), Effect.map(text), Effect.mapError(refused)),
        })
        editor.add({
          name: SEARCH,
          description: SEARCH_DESCRIPTION,
          input: SearchInput,
          options: { codemode: false },
          execute: (input, context) =>
            memory.search(context.sessionID, input).pipe(
              Effect.map((notes) => text(foundText(input.query, notes))),
              Effect.mapError(refused),
            ),
        })
        editor.add({
          name: FORGET,
          description: FORGET_DESCRIPTION,
          input: ForgetInput,
          options: { codemode: false },
          execute: (input, context) => memory.forget(context.sessionID, input).pipe(Effect.map(forgotText), Effect.map(text), Effect.mapError(refused)),
        })
      })

      // Last in the system prompt, after the instructions, so a session's digest never moves what precedes it.
      yield* ctx.session.hook("context", (event) =>
        memory.digest(event.sessionID).pipe(
          Effect.map((digest) => {
            if (digest !== "") event.system.push({ type: "text", text: digest })
          }),
          Effect.catch((failure) => Effect.logWarning("memory: no digest for the session", { sessionID: event.sessionID, failure: messageOf(failure) })),
        ),
      )
    }),
  })

export default make(live)
