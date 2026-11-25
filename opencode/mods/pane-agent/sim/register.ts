import { Console, Effect, Option } from "effect"

const resultLine = (key: string, report: string): string => {
  if (report.length === 0) return `SIM-RESULT ${key} red=false`
  return `SIM-RESULT ${key} red=true\n${report}`
}

/**
 * The body of one acceptance check, as a function bun can run: it runs the check's Effect (its report is ""
 * when green), prints the report either way, so a run at any head shows each red with its seed or scenario,
 * and rejects when the check is red. The test file registers it (as `test`, or `test.failing` when known red).
 */
export const reportRunner = (key: string, body: Effect.Effect<string>) => (): Promise<void> =>
  Effect.runPromise(
    Effect.flatMap(Effect.tap(body, (report) => Console.log(resultLine(key, report))), (report) =>
      Option.match(Option.liftPredicate(report, (text) => text.length > 0), {
        onNone: () => Effect.void,
        onSome: (text) => Effect.die(`${key} is red\n${text}`),
      }),
    ),
  )
