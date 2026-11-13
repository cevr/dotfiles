// The client laws: what the server double (server.ts) does for the TUI, each
// stated as a law a server must keep, run on the double here
// (client-laws.test.ts) and meant to run on real OpenCode through the same
// `LawServer` shape (tests/client-laws.test.ts, not written yet). Every route
// the double serves (`SERVED`) and every event kind it may send (`EVENTS`) is
// named by a law (`ROUTES`, `KINDS`); client-laws.test.ts fails on one no law
// names.
//
// A law runs on a fresh server with a fresh root session, through HTTP-shaped
// calls and the events the server sent since the law began. Its scripted model
// answers as the real scenarios' does: a prompt containing `stall` streams
// `Working on it` and holds; `spawn` starts one background worker; anything
// else answers `Done.`.
import type { EventKind } from "./server.ts"
import type { SERVED } from "./server.ts"

export type Route = (typeof SERVED)[number]

/** One call's answer: its status and its JSON body (none for 204). */
export interface Answer {
  readonly status: number
  readonly body: unknown
}

/** An event the server sent: its kind and its data. */
export interface Sent {
  readonly type: string
  readonly data: Readonly<Record<string, unknown>>
}

/** A server under the laws: the double, or real OpenCode. */
export interface LawServer {
  /** A root session, idle and empty. */
  readonly session: () => Promise<string>
  readonly call: (method: string, path: string, body?: unknown) => Promise<Answer>
  /** Every event sent since the server started, in order. */
  readonly sent: () => ReadonlyArray<Sent>
  /** Lets the server finish what it does without time moving (the double's queued events; the real server's run). */
  readonly settle: () => Promise<void>
}

export interface Law {
  readonly name: string
  readonly routes: ReadonlyArray<Route>
  readonly kinds: ReadonlyArray<EventKind>
  /** The law's failures on `server`, empty when it holds. */
  readonly run: (server: LawServer) => Promise<ReadonlyArray<string>>
}

const prompt = (server: LawServer, sessionID: string, text: string, delivery: "steer" | "queue" = "steer") =>
  server.call("POST", `/api/session/${sessionID}/prompt`, { text, files: [], agents: [], delivery })

/** The kinds of the events about `sessionID` sent after the first `from`. */
const kindsOf = (server: LawServer, sessionID: string, from = 0) =>
  server
    .sent()
    .slice(from)
    .filter((event) => event.data.sessionID === sessionID)
    .map((event) => event.type)

/** Each of `want` not found in `kinds` in that order, as a failure. */
const inOrder = (kinds: ReadonlyArray<string>, want: ReadonlyArray<string>) => {
  let at = 0
  const missing: Array<string> = []
  for (const kind of want) {
    const found = kinds.indexOf(kind, at)
    if (found < 0) missing.push(`no ${kind} after ${kinds.slice(0, at).at(-1) ?? "the start"} (sent: ${kinds.join(", ")})`)
    else at = found + 1
  }
  return missing
}

const expectStatus = (what: string, answer: Answer, status: number) => (answer.status === status ? [] : [`${what}: status ${answer.status}, not ${status}`])

export const LAWS: ReadonlyArray<Law> = [
  {
    name: "a prompt to an idle session runs: it is enqueued, the run starts and takes it, a step streams its text and ends, the run succeeds, and the transcript holds both messages",
    routes: ["session.prompt", "session.messages", "session.message", "session.get", "session.list", "session.active", "session.wait"],
    kinds: [
      "session.inbox.enqueued",
      "session.inbox.delivered",
      "session.execution.started",
      "session.step.started",
      "session.step.first-token",
      "session.text.started",
      "session.text.delta",
      "session.text.ended",
      "session.step.streamed",
      "session.step.ended",
      "session.execution.succeeded",
      "session.renamed",
    ],
    run: async (server) => {
      const sessionID = await server.session()
      const sent = await prompt(server, sessionID, "Answer briefly.")
      await server.settle()
      const failures = [
        ...expectStatus("prompt", sent, 200),
        ...inOrder(kindsOf(server, sessionID), [
          "session.inbox.enqueued",
          "session.execution.started",
          "session.inbox.delivered",
          "session.step.started",
          "session.text.delta",
          "session.text.ended",
          "session.step.ended",
          "session.execution.succeeded",
        ]),
      ]
      const messages = await server.call("GET", `/api/session/${sessionID}/message`)
      const list = (messages.body as { data?: ReadonlyArray<{ type?: string; id?: string }> }).data ?? []
      if (list.map((message) => message.type).toSorted().join(",") !== "assistant,user") failures.push(`messages: ${JSON.stringify(list.map((message) => message.type))}`)
      const assistant = list.find((message) => message.type === "assistant")
      if (assistant?.id) failures.push(...expectStatus("message", await server.call("GET", `/api/session/${sessionID}/message/${assistant.id}`), 200))
      failures.push(...expectStatus("get", await server.call("GET", `/api/session/${sessionID}`), 200))
      failures.push(...expectStatus("list", await server.call("GET", "/api/session"), 200))
      const active = await server.call("GET", "/api/session/active")
      if (sessionID in ((active.body as Record<string, unknown> | undefined) ?? {})) failures.push("active: the idle session is listed")
      failures.push(...expectStatus("wait on an idle session", await server.call("POST", `/api/experimental/session/${sessionID}/wait`, {}), 204))
      return failures
    },
  },
  {
    name: "an interrupt ends a running step: the step fails aborted, the run is interrupted, and the answer says it interrupted",
    routes: ["session.interrupt"],
    kinds: ["session.step.failed", "session.execution.interrupted", "session.tool.failed", "session.reasoning.started", "session.reasoning.delta"],
    run: async (server) => {
      const sessionID = await server.session()
      await prompt(server, sessionID, "stall here")
      await server.settle()
      const from = server.sent().length
      const answer = await server.call("POST", `/api/session/${sessionID}/interrupt`)
      await server.settle()
      const failures = [...expectStatus("interrupt", answer, 200)]
      if ((answer.body as { interrupted?: boolean } | undefined)?.interrupted !== true) failures.push(`interrupt answered ${JSON.stringify(answer.body)}`)
      failures.push(...inOrder(kindsOf(server, sessionID, from), ["session.step.failed", "session.execution.interrupted"]))
      return failures
    },
  },
  {
    name: "a prompt sent while a run works waits in the inbox; taking it back cancels it and says so",
    routes: ["session.inbox.list", "session.inbox.cancel"],
    kinds: ["session.inbox.cancelled"],
    run: async (server) => {
      const sessionID = await server.session()
      await prompt(server, sessionID, "stall here")
      await server.settle()
      const queued = await prompt(server, sessionID, "Also update the docs.", "queue")
      await server.settle()
      const item = (queued.body as { data?: { id?: string } } | undefined)?.data
      const listed = await server.call("GET", `/api/session/${sessionID}/inbox`)
      const failures = [...expectStatus("inbox", listed, 200)]
      if (!JSON.stringify(listed.body).includes("Also update the docs.")) failures.push(`inbox: ${JSON.stringify(listed.body)}`)
      failures.push(...expectStatus("cancel", await server.call("DELETE", `/api/session/${sessionID}/inbox/${item?.id ?? ""}`), 204))
      await server.settle()
      failures.push(...inOrder(kindsOf(server, sessionID), ["session.inbox.enqueued", "session.inbox.cancelled"]))
      return failures
    },
  },
  {
    name: "an undo stages a revert and says so; committing it says so",
    routes: ["session.revert.stage", "session.revert.commit"],
    kinds: ["session.revert.staged", "session.revert.committed"],
    run: async (server) => {
      const sessionID = await server.session()
      await prompt(server, sessionID, "Answer briefly.")
      await server.settle()
      const messages = await server.call("GET", `/api/session/${sessionID}/message`)
      const user = ((messages.body as { data?: ReadonlyArray<{ type?: string; id?: string }> }).data ?? []).find((message) => message.type === "user")
      const failures = [...expectStatus("stage", await server.call("POST", `/api/session/${sessionID}/revert/stage`, { messageID: user?.id }), 200)]
      failures.push(...expectStatus("commit", await server.call("POST", `/api/session/${sessionID}/revert/commit`, {}), 204))
      await server.settle()
      failures.push(...inOrder(kindsOf(server, sessionID), ["session.revert.staged", "session.revert.committed"]))
      return failures
    },
  },
  {
    name: "switching a session to another agent or model says so; switching to the one it has says nothing",
    routes: ["session.switchAgent", "session.switchModel"],
    kinds: ["session.agent.selected", "session.model.selected"],
    run: async (server) => {
      const sessionID = await server.session()
      const from = server.sent().length
      const failures = [
        ...expectStatus("same agent", await server.call("POST", `/api/session/${sessionID}/agent`, { agent: "build" }), 204),
        ...expectStatus("same model", await server.call("POST", `/api/session/${sessionID}/model`, { model: { providerID: "simulation", id: "gpt-sim-model" } }), 204),
      ]
      await server.settle()
      if (kindsOf(server, sessionID, from).length > 0) failures.push(`a switch to the same said: ${kindsOf(server, sessionID, from).join(", ")}`)
      failures.push(...expectStatus("other agent", await server.call("POST", `/api/session/${sessionID}/agent`, { agent: "plan" }), 204))
      await server.settle()
      failures.push(...inOrder(kindsOf(server, sessionID, from), ["session.agent.selected"]))
      return failures
    },
  },
  {
    name: "viewing a session's idle says so once, never for an idle it has not had",
    routes: ["session.view"],
    kinds: ["session.viewed"],
    run: async (server) => {
      const sessionID = await server.session()
      await prompt(server, sessionID, "Answer briefly.")
      await server.settle()
      const info = (await server.call("GET", `/api/session/${sessionID}`)).body as { data?: { time?: { idle?: number } } } | { time?: { idle?: number } }
      const idle = ("data" in info ? info.data?.time?.idle : (info as { time?: { idle?: number } }).time?.idle) ?? 0
      const from = server.sent().length
      const failures = [
        ...expectStatus("view past the idle", await server.call("POST", `/api/session/${sessionID}/view`, { idle: idle + 60_000 }), 204),
        ...expectStatus("view", await server.call("POST", `/api/session/${sessionID}/view`, { idle }), 204),
        ...expectStatus("view again", await server.call("POST", `/api/session/${sessionID}/view`, { idle }), 204),
      ]
      await server.settle()
      const viewed = kindsOf(server, sessionID, from).filter((kind) => kind === "session.viewed")
      if (viewed.length !== 1) failures.push(`viewed ${viewed.length} times`)
      return failures
    },
  },
  {
    name: "a background subagent call creates its child session and completes at once, the child running",
    routes: ["session.family.request.list"],
    kinds: ["session.created", "session.tool.input.started", "session.tool.input.ended", "session.tool.called", "session.tool.progress", "session.tool.success"],
    run: async (server) => {
      const sessionID = await server.session()
      await prompt(server, sessionID, "spawn a worker")
      await server.settle()
      const failures = inOrder(kindsOf(server, sessionID), ["session.tool.input.started", "session.tool.called", "session.tool.success"])
      const created = server.sent().filter((event) => event.type === "session.created" && event.data.parentID === sessionID)
      if (created.length !== 1) failures.push(`${created.length} children created`)
      failures.push(...expectStatus("family requests", await server.call("GET", `/api/session/${sessionID}/family/request`), 200))
      return failures
    },
  },
  {
    name: "the catalog lists the agents, the models and the providers, and the server says its version",
    routes: ["agent.list", "model.list", "provider.list", "server.info"],
    kinds: [],
    run: async (server) => {
      const failures: Array<string> = []
      for (const path of ["/api/agent", "/api/model", "/api/provider", "/api/info"]) failures.push(...expectStatus(path, await server.call("GET", path), 200))
      return failures
    },
  },
  {
    name: "an RPC to a plugin the server has not loaded fails 404 RpcNotFoundError; the goal RPC answers no goal",
    routes: ["rpc.call"],
    kinds: [],
    run: async (server) => {
      const sessionID = await server.session()
      const missing = await server.call("POST", "/api/rpc/dotfiles-opencode.wake/pending", { input: { sessionIDs: [sessionID] } })
      const goal = await server.call("POST", "/api/rpc/opencode.goal/get", { input: { sessionID } })
      const failures = [...expectStatus("missing RPC", missing, 404), ...expectStatus("goal", goal, 200)]
      if ((missing.body as { _tag?: string } | undefined)?._tag !== "RpcNotFoundError") failures.push(`missing RPC answered ${JSON.stringify(missing.body)}`)
      if ((goal.body as { output?: unknown } | undefined)?.output !== null) failures.push(`goal answered ${JSON.stringify(goal.body)}`)
      return failures
    },
  },
]

/** The routes the laws name, and the event kinds. */
export const ROUTES = new Set(LAWS.flatMap((law) => law.routes))
export const KINDS = new Set(LAWS.flatMap((law) => law.kinds))
