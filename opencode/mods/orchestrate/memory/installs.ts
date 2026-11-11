// The fleet install held in memory: each request's reason, in the order asked.
import { Effect, Layer } from "effect"
import { Installs } from "../service.ts"

export const layer = (asked: Array<string>) => Layer.succeed(Installs, { request: (reason: string) => Effect.sync(() => void asked.push(reason)) })
