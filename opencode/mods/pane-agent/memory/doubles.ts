import { Array as Arr, Effect, Layer, Option, Ref } from "effect"
import {
  Notifier,
  type OutputMatchOptions,
  type PaneLiveness,
  type PaneTarget,
  type QuietOptions,
  ResultFiles,
  RexClient,
  type RexError,
  RexPaneGone,
  type RexUnsupportedRevision,
  type SplitRightInput,
  WakeFailed,
  type WakeLetter,
  WorkerStore,
} from "../service.ts"
import { EMPTY_SNAPSHOT, type StoreSnapshot } from "../worker.ts"

export interface MemoryPane {
  readonly sessionId: string
  readonly blockId: string
  readonly label: string
  readonly command: ReadonlyArray<string>
  readonly cwd: string
  readonly screens: ReadonlyArray<string>
  readonly screenIndex: number
  readonly writes: ReadonlyArray<string>
  readonly alive: boolean
  readonly closed: boolean
}

export interface MemoryRexState {
  readonly nextId: number
  readonly splits: ReadonlyArray<SplitRightInput>
  readonly panes: ReadonlyArray<MemoryPane>
  readonly defaultScreens: ReadonlyArray<string>
  readonly failWith: Option.Option<RexError>
}

export const emptyRexState: MemoryRexState = {
  nextId: 1,
  splits: [],
  panes: [],
  defaultScreens: [""],
  failWith: Option.none(),
}

export const makeMemoryStore = (initial: StoreSnapshot = EMPTY_SNAPSHOT) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initial)
    const layer = Layer.succeed(
      WorkerStore,
      WorkerStore.of({
        read: () => Ref.get(state),
        write: (snapshot) => Ref.set(state, snapshot),
        upsertWorker: (worker) =>
          Ref.updateAndGet(state, (current) => ({
            ...current,
            workers: [...current.workers.filter((item) => item.id !== worker.id), worker],
          })),
        saveAnchor: (sessionID, anchor) =>
          Ref.updateAndGet(state, (current) => ({
            ...current,
            anchors: { ...current.anchors, [sessionID]: anchor },
          })),
      }),
    )
    return { state, layer }
  })

export const makeMemoryRex = (initial: MemoryRexState = emptyRexState) =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initial)

    const findPane = (panes: ReadonlyArray<MemoryPane>, target: PaneTarget): Option.Option<MemoryPane> =>
      Arr.findFirst(panes, (pane) => pane.sessionId === target.sessionId && pane.blockId === target.blockId)

    const updatePane = (
      panes: ReadonlyArray<MemoryPane>,
      target: PaneTarget,
      update: (pane: MemoryPane) => MemoryPane,
    ): ReadonlyArray<MemoryPane> =>
      panes.map((pane) => {
        if (pane.sessionId === target.sessionId && pane.blockId === target.blockId) {
          return update(pane)
        }
        return pane
      })

    const checkFail = Effect.gen(function* () {
      const current = yield* Ref.get(state)
      if (Option.isSome(current.failWith)) {
        return yield* Effect.fail(current.failWith.value)
      }
    })

    const requireLivePane = (operation: string, target: PaneTarget) =>
      Effect.gen(function* () {
        yield* checkFail
        const current = yield* Ref.get(state)
        const pane = findPane(current.panes, target)
        if (Option.isNone(pane) || !pane.value.alive || pane.value.closed) {
          return yield* Effect.fail(new RexPaneGone({ operation, message: `Pane ${target.blockId} is closed or exited.` }))
        }
        return pane.value
      })

    const layer = Layer.succeed(
      RexClient,
      RexClient.of({
        splitRight: Effect.fn("MemoryRex.splitRight")(function* (input: SplitRightInput) {
          yield* checkFail
          return yield* Ref.modify(state, (current) => {
            const blockId = `block:mem-${current.nextId}`
            const pane: MemoryPane = {
              sessionId: input.sessionId,
              blockId,
              label: input.label,
              command: input.command,
              cwd: input.cwd,
              screens: current.defaultScreens,
              screenIndex: 0,
              writes: [],
              alive: true,
              closed: false,
            }
            return [
              blockId,
              {
                ...current,
                nextId: current.nextId + 1,
                splits: [...current.splits, input],
                panes: [...current.panes, pane],
              },
            ]
          })
        }),
        write: Effect.fn("MemoryRex.write")(function* (target: PaneTarget, data: string) {
          yield* requireLivePane("terminals.write", target)
          yield* Ref.update(state, (current) => ({
            ...current,
            panes: updatePane(current.panes, target, (pane) => ({
              ...pane,
              writes: [...pane.writes, data],
            })),
          }))
        }),
        read: Effect.fn("MemoryRex.read")(function* (target: PaneTarget) {
          const found = yield* requireLivePane("terminals.read", target)
          const clamped = Math.min(found.screenIndex, Math.max(0, found.screens.length - 1))
          return Option.getOrElse(Option.fromUndefinedOr(found.screens[clamped]), () => "")
        }),
        readTail: Effect.fn("MemoryRex.readTail")(function* (target: PaneTarget) {
          const found = yield* requireLivePane("terminals.readTail", target)
          const clamped = Math.min(found.screenIndex, Math.max(0, found.screens.length - 1))
          return Option.getOrElse(Option.fromUndefinedOr(found.screens[clamped]), () => "")
        }),
        waitForQuiet: Effect.fn("MemoryRex.waitForQuiet")(function* (target: PaneTarget, _opts: QuietOptions) {
          yield* requireLivePane("terminals.waitForQuiet", target)
          yield* Ref.update(state, (current) => ({
            ...current,
            panes: updatePane(current.panes, target, (pane) => ({
              ...pane,
              screenIndex: Math.min(pane.screenIndex + 1, Math.max(0, pane.screens.length - 1)),
            })),
          }))
          yield* Effect.yieldNow
        }),
        waitForOutput: Effect.fn("MemoryRex.waitForOutput")(function* (target: PaneTarget, opts: OutputMatchOptions) {
          const found = yield* requireLivePane("terminals.waitForOutput", target)
          return found.screens.some((screen) => opts.pattern.test(screen))
        }),
        alive: Effect.fn("MemoryRex.alive")(function* (
          target: PaneTarget,
        ): Effect.fn.Return<PaneLiveness, RexUnsupportedRevision> {
          const current = yield* Ref.get(state)
          if (Option.isSome(current.failWith)) {
            const err = current.failWith.value
            if (err._tag === "RexUnsupportedRevision") return yield* Effect.fail(err)
            if (err._tag === "RexPaneGone") return "gone"
            return "unknown"
          }
          const found = findPane(current.panes, target)
          if (Option.exists(found, (pane) => pane.alive && !pane.closed)) return "alive"
          return "gone"
        }),
        close: Effect.fn("MemoryRex.close")(function* (target: PaneTarget) {
          yield* checkFail
          yield* Ref.update(state, (current) => ({
            ...current,
            panes: updatePane(current.panes, target, (pane) => ({
              ...pane,
              alive: false,
              closed: true,
            })),
          }))
        }),
      }),
    )

    const setScreens = (blockId: string, screens: ReadonlyArray<string>) =>
      Ref.update(state, (current) => ({
        ...current,
        panes: current.panes.map((pane) => {
          if (pane.blockId === blockId) return { ...pane, screens, screenIndex: 0 }
          return pane
        }),
      }))

    const setAlive = (blockId: string, alive: boolean) =>
      Ref.update(state, (current) => ({
        ...current,
        panes: current.panes.map((pane) => {
          if (pane.blockId === blockId) return { ...pane, alive }
          return pane
        }),
      }))

    return { state, layer, setScreens, setAlive }
  })

export const makeMemoryResults = (initial: ReadonlyMap<string, { readonly content: string; readonly mtimeMs: number }> = new Map()) =>
  Effect.gen(function* () {
    const files = yield* Ref.make(initial)
    const layer = Layer.succeed(
      ResultFiles,
      ResultFiles.of({
        readComplete: (path, minMtimeMs) =>
          Ref.get(files).pipe(
            Effect.map((map) =>
              Option.flatMap(Option.fromUndefinedOr(map.get(path)), (entry) => {
                if (entry.mtimeMs < minMtimeMs) return Option.none<string>()
                if (entry.content.trim().length === 0) return Option.none<string>()
                return Option.some(entry.content.trim())
              }),
            ),
          ),
      }),
    )
    const put = (path: string, content: string, mtimeMs: number) =>
      Ref.update(files, (prev) => new Map([...prev, [path, { content, mtimeMs }]]))
    return { files, layer, put }
  })

export interface RecordedWake {
  readonly sessionID: string
  readonly letter: WakeLetter
}

export const makeMemoryNotifier = () =>
  Effect.gen(function* () {
    const wakes = yield* Ref.make<ReadonlyArray<RecordedWake>>([])
    const attempts = yield* Ref.make<ReadonlyArray<RecordedWake>>([])
    const changes = yield* Ref.make<ReadonlyArray<string>>([])
    const failCount = yield* Ref.make(0)

    const layer = Layer.succeed(
      Notifier,
      Notifier.of({
        wake: Effect.fn("MemoryNotifier.wake")(function* (sessionID: string, letter: WakeLetter) {
          yield* Ref.update(attempts, (prev) => [...prev, { sessionID, letter }])
          const remaining = yield* Ref.getAndUpdate(failCount, (n) => Math.max(0, n - 1))
          if (remaining > 0) {
            return yield* Effect.fail(
              new WakeFailed({ sessionID, deliveryId: letter.id, message: "simulated delivery refusal" }),
            )
          }
          // Receiver is idempotent by letter.id (mirrors OpenCode session admission.reconcile).
          yield* Ref.update(wakes, (prev) => {
            if (prev.some((item) => item.letter.id === letter.id)) return prev
            return [...prev, { sessionID, letter }]
          })
        }),
        changed: (sessionID) => Ref.update(changes, (prev) => [...prev, sessionID]),
        sessionDirectory: () => Effect.succeed(Option.some("/tmp/repo")),
      }),
    )

    const failNextWakes = (count: number) => Ref.set(failCount, count)
    return { wakes, attempts, changes, failNextWakes, layer }
  })
