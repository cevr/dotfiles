import { Array as Arr, Cause, Context, Duration, Effect, Exit, Layer, Option, Predicate, Ref, Schema, Scope } from "effect"
import {
  REX_API_REVISION,
  RexSdk,
  rexLayout,
  rexSdkLayerFromOptions,
  type IRexSdk,
  type RexConfigOptions,
} from "rex-sdk"
import {
  formatUnsupportedRevision,
  type OutputMatchOptions,
  type PaneTarget,
  type QuietOptions,
  RexCallFailed,
  RexClient,
  type RexError,
  RexUnavailable,
  RexUnsupportedRevision,
  type SplitRightInput,
} from "../service.ts"

const RIGHT_SPLIT_RATIO = 0.45

const UnsupportedRevisionRecord = Schema.Struct({
  _tag: Schema.Literal("RexUnsupportedApiRevision"),
  requiredRevision: Schema.optionalKey(Schema.Int),
  serverRevision: Schema.optionalKey(Schema.Int),
})

const ErrorMessageRecord = Schema.Struct({
  message: Schema.String,
})

const decodeUnsupported = Schema.decodeUnknownOption(UnsupportedRevisionRecord)
const decodeMessage = Schema.decodeUnknownOption(ErrorMessageRecord)

const errorText = (error: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(error)
  const msg = decodeMessage(squashed)
  if (Option.isSome(msg)) return msg.value.message
  return String(squashed)
}

const mapSquashed = (operation: string, error: Cause.Cause<unknown>): RexError => {
  const squashed = Cause.squash(error)
  const rev = decodeUnsupported(squashed)
  if (Option.isSome(rev)) {
    const required = Option.getOrElse(Option.fromUndefinedOr(rev.value.requiredRevision), () => REX_API_REVISION)
    const server = Option.fromUndefinedOr(rev.value.serverRevision)
    return new RexUnsupportedRevision({
      requiredRevision: required,
      serverRevision: server,
      message: formatUnsupportedRevision(required, server),
    })
  }
  if (
    Predicate.isTagged(squashed, "RexConnectionError") ||
    Predicate.isTagged(squashed, "RexConfigurationError") ||
    Predicate.isTagged(squashed, "RexHandshakeError") ||
    Predicate.isTagged(squashed, "RexConnectionClosed")
  ) {
    return new RexUnavailable({ message: errorText(error) })
  }
  return new RexCallFailed({ operation, message: errorText(error) })
}

const isTimeout = Predicate.isTagged("RexRequestTimeout")

const isGone = Predicate.or(
  Predicate.or(Predicate.isTagged("RexBlockClosed"), Predicate.isTagged("RexNotFound")),
  Predicate.isTagged("RexInvalidTarget"),
)

const sdkTarget = (rex: IRexSdk, target: PaneTarget) => ({
  sessionId: rex.ids.session(target.sessionId),
  blockId: rex.ids.block(target.blockId),
})

interface ReadTailArgs {
  readonly maxBytes?: number
}

const readTailOptions = (maxBytes?: number): ReadTailArgs =>
  Option.match(Option.fromUndefinedOr(maxBytes), {
    onNone: (): ReadTailArgs => ({}),
    onSome: (value): ReadTailArgs => ({ maxBytes: value }),
  })

/**
 * The single module in dotfiles that imports `rex-sdk`.
 * Connects lazily on first call so plugin load never fails when Rex is stopped or upgraded.
 */
export const layer = (options: RexConfigOptions = {}) =>
  Layer.effect(
    RexClient,
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const cached = yield* Ref.make<Option.Option<IRexSdk>>(Option.none())

      const sdkOptions: RexConfigOptions = {
        client: { kind: "agent", name: "opencode-pane-agent", version: "0.1.0" },
        ...options,
      }

      const connect = Effect.fn("RexSdkClient.connect")(function* () {
        const existing = yield* Ref.get(cached)
        if (Option.isSome(existing)) return existing.value
        const builtExit = yield* Effect.exit(Layer.buildWithScope(rexSdkLayerFromOptions(sdkOptions), scope))
        if (Exit.isFailure(builtExit)) {
          return yield* Effect.fail(mapSquashed("connect", builtExit.cause))
        }
        const instance = Context.get(builtExit.value, RexSdk)
        yield* Ref.set(cached, Option.some(instance))
        return instance
      })

      const resetOnTransportError = (error: RexError) => {
        if (error._tag === "RexUnavailable") return Ref.set(cached, Option.none())
        return Effect.void
      }

      const withSdk = <A, E>(operation: string, run: (rex: IRexSdk) => Effect.Effect<A, E>): Effect.Effect<A, RexError> =>
        Effect.gen(function* () {
          const rex = yield* connect()
          const exit = yield* Effect.exit(run(rex))
          if (Exit.isSuccess(exit)) return exit.value
          const mapped = mapSquashed(operation, exit.cause)
          yield* resetOnTransportError(mapped)
          return yield* Effect.fail(mapped)
        })

      const splitRight = Effect.fn("RexSdkClient.splitRight")(function* (input: SplitRightInput) {
        return yield* withSdk("blocks.splitBeside", (rex) =>
          rex.blocks
            .splitBeside({
              sessionId: rex.ids.session(input.sessionId),
              anchorId: rex.ids.block(input.anchorBlockId),
              placement: "right",
              ratio: RIGHT_SPLIT_RATIO,
              focus: false,
              layout: rexLayout.terminal({
                command: [...input.command],
                cwd: input.cwd,
                label: input.label,
              }),
            })
            .pipe(
              Effect.flatMap((result) =>
                Option.match(Arr.head(result.blockIds), {
                  onNone: () =>
                    Effect.fail(
                      new RexCallFailed({
                        operation: "blocks.splitBeside",
                        message: "Rex returned no block id for right split",
                      }),
                    ),
                  onSome: (first) => Effect.succeed(String(first)),
                }),
              ),
            ),
        )
      })

      const write = Effect.fn("RexSdkClient.write")(function* (target: PaneTarget, data: string) {
        return yield* withSdk("terminals.write", (rex) =>
          Effect.asVoid(rex.terminals.write(sdkTarget(rex, target), { data })),
        )
      })

      const read = Effect.fn("RexSdkClient.read")(function* (target: PaneTarget) {
        return yield* withSdk("terminals.read", (rex) =>
          rex.terminals.read(sdkTarget(rex, target), { trim: true }),
        )
      })

      const readTail = Effect.fn("RexSdkClient.readTail")(function* (target: PaneTarget, maxBytes?: number) {
        return yield* withSdk("terminals.readTail", (rex) =>
          rex.terminals
            .readTail(sdkTarget(rex, target), readTailOptions(maxBytes))
            .pipe(Effect.map((tail) => tail.lines.join("\n"))),
        )
      })

      const waitForQuiet = Effect.fn("RexSdkClient.waitForQuiet")(function* (target: PaneTarget, opts: QuietOptions) {
        return yield* withSdk("terminals.waitForQuiet", (rex) =>
          rex.terminals
            .waitForQuiet(sdkTarget(rex, target), {
              quietFor: Duration.fromInputUnsafe(opts.quietFor),
              timeout: Duration.fromInputUnsafe(opts.timeout),
            })
            .pipe(Effect.catchIf(isTimeout, () => Effect.void)),
        )
      })

      const waitForOutput = Effect.fn("RexSdkClient.waitForOutput")(function* (target: PaneTarget, opts: OutputMatchOptions) {
        return yield* withSdk("terminals.waitForOutput", (rex) =>
          rex.terminals
            .waitForOutput(sdkTarget(rex, target), opts.pattern, {
              timeout: Duration.fromInputUnsafe(opts.timeout),
            })
            .pipe(
              Effect.as(true),
              Effect.catchIf(isTimeout, () => Effect.succeed(false)),
            ),
        )
      })

      const alive = Effect.fn("RexSdkClient.alive")(function* (target: PaneTarget) {
        return yield* withSdk("terminals.process", (rex) =>
          rex.terminals.process(sdkTarget(rex, target)).pipe(
            Effect.map((state) => Option.isNone(state.lastExit)),
            Effect.catchIf(isGone, () => Effect.succeed(false)),
          ),
        )
      })

      const close = Effect.fn("RexSdkClient.close")(function* (target: PaneTarget) {
        return yield* withSdk("blocks.close", (rex) =>
          rex.blocks.close(sdkTarget(rex, target)).pipe(
            Effect.asVoid,
            Effect.catchIf(isGone, () => Effect.void),
          ),
        )
      })

      return RexClient.of({
        splitRight,
        write,
        read,
        readTail,
        waitForQuiet,
        waitForOutput,
        alive,
        close,
      })
    }),
  )
