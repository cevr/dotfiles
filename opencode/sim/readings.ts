// What a simulated test reads off a world's sessions: whether one is at rest,
// its model requests, the model's texts, a tool's answers and the synthetic
// messages it holds.
import { Option } from "effect"
import type { Message, World } from "./world.ts"

/** The first group of `pattern` in `text`, if it matches. */
export const group = (pattern: RegExp, text: string): Option.Option<string> =>
  Option.flatMap(Option.fromNullishOr(pattern.exec(text)), (match) => Option.fromNullishOr(match[1]))

/** Whether the session has no execution running (a session the world lacks is at rest). */
export const idle = (world: World, sessionID: string) => !Option.exists(Option.fromNullishOr(world.sessions.get(sessionID)), (session) => session.running)

/** The texts of the session's primary model requests, in order. */
export const requests = (world: World, sessionID: string) =>
  world
    .asked()
    .filter((asked) => asked.sessionID === sessionID && asked.kind === "primary")
    .map((asked) => asked.text)

type Of<T extends Message["type"]> = Extract<Message, { readonly type: T }>

const ofType =
  <T extends Message["type"]>(type: T) =>
  (message: Message): message is Of<T> =>
    message.type === type

/** The model's texts in the session, in order, the empty ones (a tool call's) left out. */
export const texts = (world: World, sessionID: string) =>
  world
    .messages(sessionID)
    .filter(ofType("assistant"))
    .map((message) => message.text)
    .filter((text) => text !== "")

/** What the tool `name` answered in the session, in order. */
export const answers = (world: World, sessionID: string, name: string) =>
  world
    .messages(sessionID)
    .filter(ofType("tool"))
    .filter((message) => message.name === name)
    .map((message) => message.output)

/** The synthetic messages the session holds whose metadata names `source`, in order. */
export const synthetic = (world: World, sessionID: string, source: string) =>
  world
    .messages(sessionID)
    .filter(ofType("synthetic"))
    .filter((message) => message.metadata["source"] === source)

/** The session's synthetic messages and the model's texts, in order: a transcript's rows. */
export const rows = (world: World, sessionID: string) =>
  world.messages(sessionID).flatMap((message) => {
    if (message.type === "synthetic") return [message.description]
    if (message.type === "assistant" && message.text !== "") return [message.text]
    return []
  })

/** A message as a model reads it: who spoke (a tool's result, the model, or the user's side) and the text. */
export interface Spoken {
  readonly role: "tool" | "assistant" | "user"
  readonly text: string
}

const spoken = (message: Message): Spoken => {
  switch (message.type) {
    case "tool":
      return { role: "tool", text: message.output }
    case "assistant":
      return { role: "assistant", text: message.text }
    case "user":
    case "synthetic":
      return { role: "user", text: message.text }
    default:
      return { role: "user", text: "" }
  }
}

/** The last message of the session's context, as a model reads it: what a scripted model answers. */
export const last = (world: Option.Option<World>, sessionID: string) =>
  Option.flatMap(world, (found) => Option.fromNullishOr(found.context(sessionID).at(-1))).pipe(Option.map(spoken))

/** Whether the session's model has called a tool. */
export const called = (world: World, sessionID: string) => world.messages(sessionID).filter(ofType("assistant")).some((message) => Option.isSome(message.call))
