// Sessions in memory, for the model's tests and the laws: Forks and
// ForkReadings over one World that a test writes answers into and reads the
// host's side of the story from. A fork copies its session's messages with
// their times and is made one tick after them; asking it queues the note and
// the question and starts its turn; `answer` ends the turn.
import { Effect, Layer } from "effect"
import { ForkReadings, Forks, HostFailed } from "../service.ts"
import { forkTurns } from "../turns.ts"

export interface Session {
  title?: string
  readonly createdAt: number
  readonly messages: Array<Record<string, unknown>>
  running: boolean
}

export interface World {
  readonly sessions: Map<string, Session>
  /** Operations that fail, by name: fork, name, ask, bringBack. */
  readonly failing: Set<string>
  now: number
  forks: number
}

/** A world holding `sessions`, each with a settled history of `turns` exchanges. */
export const world = (sessions: Readonly<Record<string, number>> = { main: 1 }): World => {
  const made = new Map<string, Session>()
  let now = 1_000
  for (const [id, turns] of Object.entries(sessions)) {
    const messages: Array<Record<string, unknown>> = []
    for (let turn = 0; turn < turns; turn++) {
      messages.push({ type: "user", id: `msg_${id}_u${turn}`, text: `question ${turn}`, time: { created: now++ } })
      messages.push({ type: "assistant", id: `msg_${id}_a${turn}`, content: [{ type: "text", text: `answer ${turn}` }], finish: "stop", time: { created: now++, completed: now } })
    }
    made.set(id, { createdAt: 0, messages, running: false })
  }
  return { sessions: made, failing: new Set(), now, forks: 0 }
}

/** The session's turn ends with `text` as its answer. */
export const answer = (world: World, sessionID: string, text: string) => {
  const session = world.sessions.get(sessionID)
  if (session === undefined) return
  session.messages.push({
    type: "assistant",
    id: `msg_${sessionID}_reply${session.messages.length}`,
    content: [{ type: "reasoning", text: "thinking" }, { type: "text", text }],
    finish: "stop",
    time: { created: world.now++, completed: world.now },
  })
  session.running = false
}

const sessionOf = (world: World, operation: string, sessionID: string): Effect.Effect<Session, HostFailed> => {
  const session = world.sessions.get(sessionID)
  if (world.failing.has(operation)) return Effect.fail(new HostFailed({ operation, message: `${operation} refused` }))
  if (session === undefined) return Effect.fail(new HostFailed({ operation, message: `session ${sessionID} not found` }))
  return Effect.succeed(session)
}

export const forksLayer = (world: World) =>
  Layer.succeed(Forks, {
    fork: (sessionID) =>
      sessionOf(world, "fork", sessionID).pipe(
        Effect.map((session) => {
          const id = `fork-${++world.forks}`
          const createdAt = world.now++
          world.sessions.set(id, { title: `${session.title ?? sessionID} (fork #${world.forks})`, createdAt, messages: [...session.messages], running: false })
          return { sessionID: id, createdAt }
        }),
      ),
    name: (sessionID, title) =>
      sessionOf(world, "name", sessionID).pipe(
        Effect.map((session) => {
          session.title = title
        }),
      ),
    ask: (sessionID, note, question) =>
      sessionOf(world, "ask", sessionID).pipe(
        Effect.map((session) => {
          if (note !== undefined)
            session.messages.push({ type: "synthetic", id: `msg_${sessionID}_note${session.messages.length}`, text: note, time: { created: world.now++ } })
          session.messages.push({ type: "user", id: `msg_${sessionID}_q${session.messages.length}`, text: question, time: { created: world.now++ } })
          session.running = true
        }),
      ),
    bringBack: (sessionID, notice) =>
      sessionOf(world, "bringBack", sessionID).pipe(
        Effect.map((session) => {
          if (session.messages.some((message) => message.id === notice.id)) return
          session.messages.push({ type: "synthetic", ...notice, time: { created: world.now++ } })
          session.running = true
        }),
      ),
  })

export const readingsLayer = (world: World) =>
  Layer.succeed(ForkReadings, {
    read: (fork) =>
      Effect.sync(() => {
        const session = world.sessions.get(fork.sessionID)
        return { turns: forkTurns(session?.messages ?? [], fork.createdAt), replying: session?.running ?? false }
      }),
  })

/** The World as the laws' HostProbe sees it. */
export const probe = (world: World) => ({
  messages: (sessionID: string) => world.sessions.get(sessionID)?.messages ?? [],
  title: (sessionID: string) => world.sessions.get(sessionID)?.title,
  running: (sessionID: string) => world.sessions.get(sessionID)?.running ?? false,
  answer: (sessionID: string, text: string) => answer(world, sessionID, text),
})
