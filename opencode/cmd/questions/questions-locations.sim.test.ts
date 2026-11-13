// The questions plugin with two directories open on one host, on the
// simulated host, each test at 20 seeds: tests/questions-locations.test.ts's
// names and claims, moved off real OpenCode. As the real run
// (tests/questions/run.ts) does: the plugin is loaded for both directories, a
// session in the other one runs first, a session in the asking one asks
// through `ask_user_async` and is answered through the /answer form
// (`session.form.create` and its reply, sim/forms.ts); then a root session
// and a subagent of it, whose question is answered in the root's form.
//
// The model is the real run's (tests/questions/sim.ts): its answers by task
// and conversation. Where the real run's model holds the subagent's answer
// to its letter, the world's subagent runs a 30 s foreground command first,
// so its turn on the letter, and its report, wait the same; the root's
// executions are also read off the trace, which the real run cannot see:
// none starts between the answer and the subagent's second report.
//
// The seed varies how long each answer streams, the order of fibers and the
// ids.
import { Effect, Option, Schema } from "effect"
import { formOf } from "@dotfiles/opencode-questions/form"
import type { Question } from "@dotfiles/opencode-questions/question"
import * as Plugins from "../../sim/plugins.ts"
import { line, plain } from "../../sim/runtime.ts"
import * as Seed from "../../sim/seed.ts"
import * as World from "../../sim/world.ts"
import { answeredAfter, ANSWERED, ASK_TASK, ASKED, IDLE, IDLE_TASK, isNotice, isReport, LETTER, type Message, messagesOf, NOTICE, QUESTION, ROOT_TASK, ROOT_TOLD, ROOT_UNTOLD, SUBAGENT } from "../../tests/questions/sim.ts"

const { seeded } = Seed.runner("cmd/questions/questions-locations.sim.test.ts")

const ASKING = "/scratch/asking"
const OTHER = "/scratch/other"
/** How long the real run waited for a session to come to rest. */
const LIMIT_MS = 30_000
/** How long the world's subagent holds its turn on the letter. */
const HOLD = "sleep 30"
const HOLD_MS = 30_000

/** The task a request's session was given: its first prompt. */
const taskOf = (text: string) => Option.getOrElse(Option.fromNullishOr(/^user: (.*)$/m.exec(text)?.[1]), () => "").trim()

/**
 * tests/questions/sim.ts's model on the world's requests. While `hold.on`, an asking task's turn on its letter
 * runs `sleep 30` in the shell before it answers.
 */
const scriptOf =
  (hold: { on: boolean }): World.Script =>
  (request) => {
    if (request.kind === "title") return World.say("Questions run")
    const task = taskOf(request.text)
    if (task.endsWith(ROOT_TASK) && request.text.includes(NOTICE)) return World.say(ROOT_TOLD)
    if (task.endsWith(ROOT_TASK)) return World.say(ROOT_UNTOLD)
    if (!task.endsWith(ASK_TASK)) return World.say(IDLE)
    if (request.text.includes(LETTER)) {
      if (hold.on && !/^tool \S+ shell:/m.test(request.text)) return World.call("call_hold", "shell", { command: HOLD })
      return World.say(ANSWERED)
    }
    if (/^tool \S+ ask_user_async:/m.test(request.text)) return World.say(ASKED)
    return World.call("call_ask", "ask_user_async", { questions: [QUESTION] })
  }

/** What the real run's result held, read off the world. */
interface Result {
  readonly asked: ReadonlyArray<Message>
  readonly other: ReadonlyArray<Message>
  readonly subagent: {
    readonly field: string
    readonly child: ReadonlyArray<Message>
    readonly untold: ReadonlyArray<Message>
    readonly root: ReadonlyArray<Message>
    /** The root's execution starts after the answer and before the subagent's second report: none, unless the notice woke it. */
    readonly wokenByNotice: ReadonlyArray<number>
  }
  readonly warnings: ReadonlyArray<string>
}

const TraceLine = Schema.fromJsonString(Schema.Struct({ t: Schema.Number, kind: Schema.String, sessionID: Schema.optional(Schema.String), childID: Schema.optional(Schema.String), type: Schema.optional(Schema.String), data: Schema.optional(Schema.Struct({ sessionID: Schema.optional(Schema.String) })) }))

/** The /answer form for `questions`, in session `screen` when it is a root's for its subagent's: the TUI's input to `session.form.create`. */
const formFor = (questions: ReadonlyArray<Question>, screen?: string) =>
  Effect.fromOption(Option.fromNullishOr(formOf(questions, screen, () => SUBAGENT))).pipe(Effect.orDie)

/** One run, as tests/questions/run.ts makes it in real OpenCode. */
const run = (seed: number) =>
  Effect.gen(function* () {
    const hold = { on: false }
    const world = World.make({ seed, script: scriptOf(hold) })
    const atRest = (sessionID: string) => world.sessions.get(sessionID)?.running === false
    const rest = (sessionID: string) => world.until(() => atRest(sessionID), LIMIT_MS)
    /** The session's messages as `sessions.context` answers them over the wire: JSON. */
    const view = (sessionID: string) => messagesOf(plain(world.context(sessionID)))
    const has = (sessionID: string, text: string) => view(sessionID).some((message) => line(message).includes(text))
    yield* world.load(Plugins.questions, { directory: OTHER })
    yield* world.load(Plugins.questions, { directory: ASKING })

    // The other directory first.
    const idle = yield* world.session(OTHER)
    yield* world.prompt(idle, IDLE_TASK)
    yield* rest(idle)

    const session = yield* world.session(ASKING)
    yield* world.prompt(session, ASK_TASK)
    yield* rest(session)

    // /answer: the form the TUI opens for the session's open question, answered off the assumption.
    const asked: Question = { id: "q1", sessionID: session, askedAt: 0, ...QUESTION }
    const input = yield* formFor([asked])
    const form = yield* world.form.create(session, input)
    yield* world.form.reply(form, { [input.fields[0].key]: "Redis" })
    yield* world.until(() => has(session, LETTER), LIMIT_MS)
    yield* rest(session)

    // A root session and a subagent of it: the subagent asks, the form in the root answers it.
    const root = yield* world.session(ASKING)
    yield* world.prompt(root, ROOT_TASK)
    yield* rest(root)
    const child = yield* world.session(ASKING, { parentID: root, title: SUBAGENT })
    yield* world.prompt(child, ASK_TASK)
    yield* rest(child)
    // The subagent's idle report wakes the root: let that turn end before the answer.
    yield* world.until(() => answeredAfter(view(root), isReport) && atRest(root), LIMIT_MS)
    const subInput = yield* formFor([{ id: "q1", sessionID: child, askedAt: 0, ...QUESTION }], root)
    const subForm = yield* world.form.create(root, subInput)
    // The subagent's turn on the letter is held, so it sends no report yet: only the notice could wake the root now.
    hold.on = true
    const answeredAt = world.elapsed()
    yield* world.form.reply(subForm, { [subInput.fields[0].key]: "Redis" })
    yield* world.until(() => has(child, LETTER), LIMIT_MS)
    yield* world.advance(1_000)
    yield* rest(root)
    const untold = view(root)
    hold.on = false
    // Past the held command, then the turn's answer.
    yield* world.until(() => atRest(child), HOLD_MS + LIMIT_MS)
    // The root's next turn, on the subagent's second report, reads the notice.
    yield* world.until(() => answeredAfter(view(root), isNotice) && atRest(root), LIMIT_MS)
    yield* world.advance(500)

    const trace = world
      .trace()
      .split("\n")
      .flatMap((text) => Option.toArray(Schema.decodeUnknownOption(TraceLine)(text)))
    const secondReport = trace.filter((entry) => entry.kind === "subagent-report" && entry.childID === child)[1]?.t ?? Number.POSITIVE_INFINITY
    const wokenByNotice = trace
      .filter((entry) => entry.kind === "event" && entry.type === "session.execution.started" && entry.data?.sessionID === root)
      .map((entry) => entry.t)
      .filter((t) => t >= answeredAt && t < secondReport)
    const result: Result = {
      asked: view(session),
      other: view(idle),
      subagent: { field: subInput.fields[0].key, child: view(child), untold, root: view(root), wokenByNotice },
      warnings: world.logs().flatMap((entry) => Option.toArray(Option.liftPredicate(entry.message, () => entry.level === "Warn"))),
    }
    return result
  })

/** A session's messages, as the real test reads `sessions.context`. */
const turns = (messages: ReadonlyArray<{ readonly type?: string }>) => messages.filter((message) => message.type === "assistant").length

seeded("one form submit: one letter in the asking session, no copy of the plugin finds the question closed", ({ seed, expect }) =>
  Effect.gen(function* () {
    const result = yield* run(seed)
    const letters = result.asked.filter((message) => message.metadata?.source === "questions")
    expect(letters).toHaveLength(1)
    expect(line(result.asked)).toContain(LETTER)
    // The letter woke the session, and it read the answer.
    expect(line(result.asked)).toContain(ANSWERED)
    // The other directory's session is untouched.
    expect(result.other.some((message) => message.metadata?.source === "questions")).toBe(false)
    expect(line(result.other)).toContain(IDLE)
    expect(result.warnings.filter((warning) => warning.startsWith("questions:"))).toEqual([])
  }),
)

seeded("a subagent's question, answered in its root's form: the subagent wakes on the answer, the root reads a notice at its next turn", ({ seed, expect }) =>
  Effect.gen(function* () {
    const { subagent, warnings } = yield* run(seed)
    // The root's form keys the subagent's question by the subagent's session.
    expect(subagent.field).toMatch(/^ask_user_async:ses_\w+:q1$/)
    // The letter went to the subagent, which woke and read it.
    expect(subagent.child.filter((message) => message.metadata?.source === "questions")).toHaveLength(1)
    expect(line(subagent.child)).toContain(LETTER)
    expect(line(subagent.child)).toContain(ANSWERED)
    // The notice did not wake the root. The host wakes it with each idle report of the subagent: the run lets the
    // first report's turn end before the answer, and holds the subagent's turn on the letter, so while it is held
    // the notice, sent with the letter, is the only thing that could wake the root, and the root takes no turn:
    // its first turn and the first report's, nothing after.
    const untold = subagent.untold
    expect(untold.filter(isReport)).toHaveLength(1)
    expect(answeredAfter(untold, isReport)).toBe(true)
    expect(turns(untold)).toBe(2)
    expect(answeredAfter(untold, isNotice)).toBe(false)
    // Read off the trace too: no execution of the root starts from the answer to the subagent's second report.
    expect(subagent.wokenByNotice).toEqual([])
    // Its next turn, on the subagent's second report, read it.
    const root = subagent.root
    expect(root.filter(isReport)).toHaveLength(2)
    expect(root.findIndex(isNotice)).toBeGreaterThan(root.findIndex(isReport))
    expect(answeredAfter(root, isNotice)).toBe(true)
    expect(turns(root)).toBe(3)
    expect(line(subagent.root)).toContain(NOTICE)
    expect(line(subagent.root)).toContain(ROOT_TOLD)
    expect(line(subagent.root)).not.toContain(LETTER)
    expect(warnings.filter((warning) => warning.startsWith("questions:"))).toEqual([])
  }),
)
