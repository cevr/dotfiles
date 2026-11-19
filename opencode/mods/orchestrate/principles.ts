// The `principles` tool's domain, pure: its input, its description, and each action's answer over the principle
// skills as read (`filestore/principles.ts` reads `<skills dir>/principle-*/SKILL.md`). One source: the answers derive
// from the skill files at each call, so there is no index to keep in step. The plugin (cmd/orchestrate/server.ts)
// registers it for roots and subagents alike.
import { Array as Arr, Option, Order, Schema } from "effect"
import { toolInput } from "@dotfiles/decider/tool-input"

/** The tool's name. */
export const PRINCIPLES = "principles"

/** The folder prefix that marks a principle skill. */
export const PREFIX = "principle-"

export const ACTIONS = ["list", "search", "get"] as const
export type Action = (typeof ACTIONS)[number]

export const PrinciplesInput = toolInput(
  Schema.Struct({
    action: Schema.Literals(ACTIONS).annotate({
      description: "list: every principle with its one-line 'Apply when' description. search: the principles that match query, best first, with the matching lines. get: one principle's full text.",
    }),
    query: Schema.optional(Schema.String).annotate({ description: "search: words or a phrase to find in the principles' names, descriptions and text." }),
    name: Schema.optional(Schema.String).annotate({ description: "get: the principle, as `principle-<name>` or `<name>` (e.g. `subtract-before-you-add`)." }),
  }),
)
export type PrinciplesInput = typeof PrinciplesInput.Type

export const PRINCIPLES_DESCRIPTION = [
  "The owner's principles, one skill each (`principle-<name>`), read from the skill files at each call. Decide an open choice by them and name the one you used (\"decided by <principle>\").",
  '- list: principles({ action: "list" }) answers every principle with its one-line "Apply when" description.',
  '- search: principles({ action: "search", query: "shared state" }) answers the principles that match, best first, each with its matching lines.',
  '- get: principles({ action: "get", name: "subtract-before-you-add" }) answers one principle\'s full text.',
].join("\n")

/** One principle skill file as read: its folder name and its text. */
export interface PrincipleFile {
  readonly id: string
  readonly path: string
  readonly text: string
}

/** A principle as its file states it. */
export interface Principle {
  readonly id: string
  readonly path: string
  readonly description: string
  readonly body: string
  readonly text: string
}

/** An answer, or why the call does not run. */
export type Answer = { readonly text: string } | { readonly refused: string }

const FRONT = /^---\n([\s\S]*?)\n---\n?/

/** A front matter field's value, unquoted. */
const fieldOf = (front: string, key: string): Option.Option<string> =>
  Option.map(Option.fromNullishOr(new RegExp(`^${key}:\\s*(.*)$`, "m").exec(front)?.[1]), (raw) => {
    const value = raw.trim()
    if (!value.startsWith('"')) return value
    const parsed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.String))(value)
    return Option.getOrElse(parsed, () => value.slice(1, -1))
  })

/** A principle from its file: the description from the front matter, the body after it. */
export const parse = (file: PrincipleFile): Principle => {
  const front = Option.fromNullishOr(FRONT.exec(file.text))
  const body = Option.match(front, { onNone: () => file.text, onSome: (found) => file.text.slice(found[0].length) })
  const description = Option.getOrElse(
    Option.flatMap(
      Option.flatMap(front, (found) => Option.fromNullishOr(found[1])),
      (fields) => fieldOf(fields, "description"),
    ),
    () => "",
  )
  return { id: file.id, path: file.path, description, body: body.trim(), text: file.text }
}

const byId = Order.mapInput(Order.String, (principle: Principle) => principle.id)

/** The principles, from their files, by name. */
export const principlesOf = (files: ReadonlyArray<PrincipleFile>): ReadonlyArray<Principle> =>
  Arr.sort(
    files.flatMap((file) => Option.toArray(Option.map(Option.liftPredicate(file, (each) => each.id.startsWith(PREFIX)), parse))),
    byId,
  )

/** `n` when `held`, else nothing. */
const points = (held: boolean, n: number) => Number(held) * n

/** The name without its prefix, lowercased. */
const bare = (name: string) => {
  const lower = name.trim().toLowerCase()
  return lower.slice(points(lower.startsWith(PREFIX), PREFIX.length))
}

const GET_CALL = 'principles({ action: "get", name: "<name>" })'

/** The list answer. */
export const listAnswer = (principles: ReadonlyArray<Principle>): string =>
  [`${principles.length} principles; read one with ${GET_CALL}.`, ...principles.map((p) => `${p.id}: ${p.description}`)].join("\n")

/** Edit distance between two names. */
const distance = (a: string, b: string): number => {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0]!
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = row[j]!
      row[j] = Math.min(above + 1, row[j - 1]! + 1, diagonal + points(a[i - 1] !== b[j - 1], 1))
      diagonal = above
    }
  }
  return row[b.length]!
}

/** The names closest to `name`: those that contain it or that it contains first, then by edit distance. */
export const closest = (principles: ReadonlyArray<Principle>, name: string, count = 3): ReadonlyArray<string> => {
  const wanted = bare(name)
  const ranked = principles.map((p) => {
    const id = bare(p.id)
    const near = wanted.length > 0 && (id.includes(wanted) || wanted.includes(id))
    return { id: p.id, rank: points(!near, 1_000) + distance(wanted, id) }
  })
  return Arr.sort(ranked, Order.mapInput(Order.Number, (r: { readonly rank: number }) => r.rank))
    .slice(0, count)
    .map((r) => r.id)
}

/** The get answer: the file's full text, or a refusal naming the closest principles. */
export const getAnswer = (principles: ReadonlyArray<Principle>, name: string): Answer =>
  Option.match(
    Arr.findFirst(principles, (p) => bare(p.id) === bare(name)),
    {
      onSome: (p) => ({ text: `${p.path}\n\n${p.text}` }),
      onNone: () => ({
        refused: `principles: no principle ${name}. Closest: ${closest(principles, name).join(", ")}. principles({ action: "list" }) lists them all.`,
      }),
    },
  )

/** The words of a query, lowercased; a word of one character is dropped. */
const wordsOf = (query: string) => query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1)

interface Hit {
  readonly principle: Principle
  readonly score: number
  readonly lines: ReadonlyArray<string>
}

/** How a principle matches a query: the phrase counts most, then each word in its name, description and lines. */
const hitOf = (principle: Principle, phrase: string, words: ReadonlyArray<string>): Hit => {
  const name = bare(principle.id).replaceAll("-", " ")
  const description = principle.description.toLowerCase()
  const scored = principle.body.split("\n").flatMap((line) => {
    const lower = line.toLowerCase()
    const score = points(lower.includes(phrase), 5) + words.filter((word) => lower.includes(word)).length
    return Option.toArray(Option.liftPredicate({ line: line.trim(), score }, (each) => each.score > 0 && each.line.length > 0 && !each.line.startsWith("#")))
  })
  const fields =
    points(name.includes(phrase), 10) +
    points(description.includes(phrase), 6) +
    words.reduce((sum, word) => sum + points(name.includes(word), 3) + points(description.includes(word), 2), 0)
  const matching = Arr.sort(scored, Order.mapInput(Order.flip(Order.Number), (s: { readonly score: number }) => s.score))
  return { principle, score: fields + matching.reduce((sum, s) => sum + s.score, 0), lines: matching.slice(0, 3).map((s) => s.line) }
}

/** The search answer: the principles that match, best first, each with up to three matching lines. */
export const searchAnswer = (principles: ReadonlyArray<Principle>, query: string, limit = 8): Answer => {
  const phrase = query.trim().toLowerCase()
  const words = wordsOf(query)
  if (phrase.length === 0) return { refused: 'principles: search needs a query: principles({ action: "search", query: "shared state" }).' }
  const hits = Arr.sort(
    principles.flatMap((p) => Option.toArray(Option.liftPredicate(hitOf(p, phrase, words), (hit) => hit.score > 0))),
    Order.combine(
      Order.mapInput(Order.flip(Order.Number), (hit: Hit) => hit.score),
      Order.mapInput(Order.String, (hit: Hit) => hit.principle.id),
    ),
  )
  if (hits.length === 0) return { text: `No principle matches "${query}". principles({ action: "list" }) lists them all.` }
  const shown = hits.slice(0, limit)
  return {
    text: [
      `${hits.length} principles match "${query}"${Option.getOrElse(Option.liftPredicate(`, the best ${shown.length} shown`, () => hits.length > shown.length), () => "")}; read one with ${GET_CALL}.`,
      ...shown.map((hit) => [`${hit.principle.id}: ${hit.principle.description}`, ...hit.lines.map((line) => `  > ${line}`)].join("\n")),
    ].join("\n"),
  }
}

/** A call's answer over the principles read now. */
export const answer = (input: PrinciplesInput, files: ReadonlyArray<PrincipleFile>): Answer => {
  const principles = principlesOf(files)
  if (principles.length === 0) return { refused: "principles: no principle-*/SKILL.md was found in the skills directory." }
  switch (input.action) {
    case "list":
      return { text: listAnswer(principles) }
    case "search":
      return searchAnswer(principles, Option.getOrElse(Option.fromNullishOr(input.query), () => ""))
    case "get":
      return Option.match(
        Option.filter(Option.fromNullishOr(input.name), (name) => name.trim().length > 0),
        {
          onNone: (): Answer => ({ refused: `principles: get needs a name: ${GET_CALL}.` }),
          onSome: (name) => getAnswer(principles, name),
        },
      )
  }
}
