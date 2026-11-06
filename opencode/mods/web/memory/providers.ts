// SearchProviders held in memory: OpenCode's (opencode/providers.ts) over a
// record of providers, each answering with its results or failing with an
// error shaped as the host wraps one (a request error whose cause carries the
// message and an HTTP response). Each query is recorded by provider.
import { Effect } from "effect"
import * as OpenCodeProviders from "../opencode/providers.ts"
import type { Hit } from "../service.ts"

export type Answer = ReadonlyArray<Hit> | { readonly fail: string; readonly status?: number }

/** Each provider by id, to what it answers; `asked` collects the providers queried, in order. */
export const layer = (world: Readonly<Record<string, Answer>>, asked: string[] = []) =>
  OpenCodeProviders.layer({
    providers: () => Effect.succeed({ data: Object.keys(world).map((id) => ({ id })) }),
    query: ({ providerID }) => {
      asked.push(providerID)
      const answer = world[providerID]
      if (answer === undefined) return Effect.fail({ _tag: "WebSearch.ProviderNotFound", message: "", providerID })
      if ("fail" in answer)
        return Effect.fail({
          _tag: "WebSearch.Request",
          message: "",
          cause: { message: answer.fail, ...(answer.status === undefined ? {} : { response: { status: answer.status } }) },
        })
      return Effect.succeed({ data: { results: answer } })
    },
  })
