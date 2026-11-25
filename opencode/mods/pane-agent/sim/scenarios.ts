import { Option } from "effect"
import type { Boundary, Fault, PlannedFault } from "./faults.ts"
import { Action, Command, defaultConfig, type SimConfig, type Step } from "./driver.ts"
import { DEFAULT_WORLD, type ScreenKind, type WorldConfig, WorldEvent } from "./world.ts"

/** A named, scripted run, with the triggers (findings) it reproduces at each old head. */
export interface Scenario {
  readonly name: string
  readonly what: string
  readonly triggers: Readonly<Partial<Record<Head, ReadonlyArray<string>>>>
  readonly world: Partial<WorldConfig>
  readonly steps: ReadonlyArray<Step>
}

export type Head = "48b4a22b" | "fca6400f" | "44f5ed09"

export const start = (worker: string, token: string, proc = 1): Command => Command.Start({ worker, token, proc, skipPermissions: Option.none(), named: false })
export const startOpts = (worker: string, token: string, skipPermissions: boolean): Command =>
  Command.Start({ worker, token, proc: 1, skipPermissions: Option.some(skipPermissions), named: false })
export const followUp = (worker: string, token: string, proc = 1, ownFile = false): Command => Command.FollowUp({ worker, token, proc, steer: false, ownFile })
export const steer = (worker: string, token: string, proc = 1): Command => Command.FollowUp({ worker, token, proc, steer: true, ownFile: false })
export const status = (worker: string, proc = 1): Command => Command.Status({ worker, proc })
export const stop = (worker: string, close: boolean, proc = 1): Command => Command.Stop({ worker, proc, close })
export const restart = (worker: string, token: string, proc = 1): Command => Command.Restart({ worker, token, proc })
export const reattach = (proc = 1): Command => Command.Reattach({ proc })
export const spawn = (proc: number): Command => Command.Spawn({ proc })
export const wait = (ms: number): Step => Action.Wait({ ms })
export const waitScreen = (worker: string, screen: ScreenKind, ms = 600): Step => Action.WaitScreen({ worker, screen, ms })
export const next = (boundary: Boundary, fault: Fault, nth = 0): Step => Action.Faults({ faults: [{ boundary, nth, fault }] })
export const faults = (list: ReadonlyArray<PlannedFault>): Step => Action.Faults({ faults: list })
export const paneExits: Step = Action.World({ event: WorldEvent.PaneExits({ blockId: Option.none() }) })
export const clearPrompt: Step = Action.World({ event: WorldEvent.ClearPrompt({ blockId: Option.none() }) })
/** Another prompt appears in the pane (a sign-in or confirmation dialog), until the owner clears it. */
export const otherPrompt: Step = Action.World({ event: WorldEvent.ShowPrompt({ blockId: Option.none(), screen: "prompt" }) })
export const humanTypes = (text: string): Step => Action.World({ event: WorldEvent.HumanTypes({ blockId: Option.none(), text }) })
export const crash = (proc = 1): Step => Action.Crash({ proc })
export const atAwait = (boundary: Boundary, detail: Option.Option<string>, commands: ReadonlyArray<Command>): Step => Action.GateNext({ boundary, detail, commands })

/** The happy trace: two turns, a stop without close, a restart, a stop with close. Crashes are enumerated over its effects. */
export const HAPPY: ReadonlyArray<Step> = [
  start("w1", "TK-w1-1"),
  waitScreen("w1", "done"),
  wait(100),
  followUp("w1", "TK-w1-2", 1, true),
  waitScreen("w1", "done"),
  wait(100),
  status("w1"),
  stop("w1", false),
  restart("w1", "TK-w1-3"),
  waitScreen("w1", "done"),
  wait(100),
  stop("w1", true),
]

/** The trigger scenarios: each reproduces named findings of the reviews and the diagnosis at the heads it lists. */
export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: "happy",
    what: "two turns, stop, restart, stop with close; no fault",
    triggers: {},
    world: {},
    steps: HAPPY,
  },
  {
    name: "B1-placeholder-result-file",
    what: "the agent writes a placeholder to the result file while the pane still works, then the final answer",
    triggers: { "48b4a22b": ["B1"] },
    world: { fileModes: ["partial"] },
    steps: [start("w1", "TK-w1-1"), wait(400)],
  },
  {
    name: "B2-follow-up-and-steer-into-trust-prompt",
    what: "the new pane shows the workspace trust prompt; follow_up and steer arrive before the owner answers it",
    triggers: { "48b4a22b": ["B2"] },
    world: { splitScreens: ["trust"] },
    steps: [start("w1", "TK-w1-1"), followUp("w1", "TK-w1-2"), steer("w1", "TK-w1-3"), wait(50), clearPrompt, wait(600)],
  },
  {
    name: "B2-follow-up-and-steer-into-permission-prompt",
    what: "the turn stops at a command permission prompt; follow_up and steer arrive before the owner answers it",
    triggers: { "48b4a22b": ["B2"] },
    world: { permissionRuns: [1] },
    steps: [start("w1", "TK-w1-1"), waitScreen("w1", "permission"), followUp("w1", "TK-w1-2"), steer("w1", "TK-w1-3"), wait(50), clearPrompt, wait(600)],
  },
  {
    name: "B3-one-transient-read",
    what: "one terminals.read times out once while the turn works",
    triggers: { "48b4a22b": ["B3"] },
    world: {},
    steps: [start("w1", "TK-w1-1"), next("pane.read", "transient"), wait(400)],
  },
  {
    name: "R1-crash-between-settle-and-wake",
    what: "the server crashes at the first wake, after the turn's settle was persisted",
    triggers: { "48b4a22b": ["R1"] },
    world: {},
    steps: [start("w1", "TK-w1-1"), next("notifier.wake", "crash"), wait(500)],
  },
  {
    name: "R3-follow-up-queued-during-turn",
    what: "a follow_up (same result file) arrives while turn 1 still works",
    triggers: { "48b4a22b": ["R3"] },
    world: {},
    steps: [start("w1", "TK-w1-1"), followUp("w1", "TK-w1-2"), wait(700)],
  },
  {
    name: "H-alive-never-answers",
    what: "one blocks.alive never answers during an idle follow_up; Rex is healthy again for the next status",
    triggers: { "48b4a22b": ["H"], fca6400f: ["H"], "44f5ed09": ["H"] },
    world: {},
    steps: [start("w1", "TK-w1-1"), waitScreen("w1", "done"), wait(100), next("pane.alive", "hang"), followUp("w1", "TK-w1-2"), status("w1"), wait(300)],
  },
  {
    name: "I-read-defect-in-watcher",
    what: "one terminals.read dies (a defect) in the background watcher while turn 2 works",
    triggers: { "48b4a22b": ["I"], fca6400f: ["I"], "44f5ed09": ["I"] },
    world: {},
    steps: [
      start("w1", "TK-w1-1"),
      waitScreen("w1", "done"),
      wait(100),
      followUp("w1", "TK-w1-2"),
      waitScreen("w1", "working"),
      wait(10),
      next("pane.read", "defect"),
      wait(600),
    ],
  },
  {
    name: "E1-follow-up-inside-idle-confirm",
    what: "a follow_up lands while the watcher waits for quiet on the done screen",
    triggers: { fca6400f: ["E1"] },
    world: {},
    steps: [start("w1", "TK-w1-1"), atAwait("pane.waitForQuiet", Option.some(":done"), [followUp("w1", "TK-w1-2")]), wait(700)],
  },
  {
    name: "Q1-restart-keeps-queued-turns",
    what: "a follow_up is queued, the pane's process exits, the caller restarts the worker",
    triggers: { fca6400f: ["Q1"] },
    world: {},
    steps: [start("w1", "TK-w1-1"), followUp("w1", "TK-w1-2"), wait(10), paneExits, wait(300), restart("w1", "TK-w1-3"), wait(900)],
  },
  {
    name: "Q2-undelivered-done-wake-survives-gone",
    what: "the done wake is refused a few times, the pane's process exits, status probes it",
    triggers: { fca6400f: ["Q2"] },
    world: {},
    steps: [
      start("w1", "TK-w1-1"),
      faults([
        { boundary: "notifier.wake", nth: 0, fault: "transient" },
        { boundary: "notifier.wake", nth: 1, fault: "transient" },
        { boundary: "notifier.wake", nth: 2, fault: "transient" },
      ]),
      waitScreen("w1", "done"),
      paneExits,
      status("w1"),
      status("w1"),
      wait(800),
    ],
  },
  {
    name: "G-write-fails-during-idle-follow-up",
    what: "turn 1 settled and woke; one terminals.write times out during the idle follow_up",
    triggers: { fca6400f: ["G"], "44f5ed09": ["G"] },
    world: {},
    steps: [start("w1", "TK-w1-1"), waitScreen("w1", "done"), wait(100), next("pane.write", "transient"), followUp("w1", "TK-w1-2"), wait(400)],
  },
  {
    name: "F1-changed-defect",
    what: "one notifier.changed dies (a defect) while a follow_up is handled",
    triggers: { "44f5ed09": ["F1"] },
    world: {},
    steps: [start("w1", "TK-w1-1"), waitScreen("w1", "done"), wait(100), next("notifier.changed", "defect"), followUp("w1", "TK-w1-2"), status("w1"), wait(400)],
  },
  {
    name: "Qa-conflict-reload-second-process",
    what: "a second server on the same store takes a follow_up; the first server's next commands meet a newer revision",
    triggers: { "44f5ed09": ["Q-a reload"] },
    world: {},
    steps: [
      start("w1", "TK-w1-1"),
      waitScreen("w1", "done"),
      wait(100),
      spawn(2),
      followUp("w1", "TK-w1-2", 2),
      waitScreen("w1", "done"),
      wait(200),
      followUp("w1", "TK-w1-3", 1),
      wait(400),
    ],
  },
  {
    name: "usage-limit",
    what: "turn 1 ends at the usage-limit screen (SPEC v2 addition)",
    triggers: {},
    world: { limitRuns: [1] },
    steps: [start("w1", "TK-w1-1"), wait(1_800)],
  },
]

export const configOf = (scenario: Scenario, seed = 1): SimConfig => ({
  ...defaultConfig(scenario.name, seed),
  world: { ...DEFAULT_WORLD, ...scenario.world },
})
