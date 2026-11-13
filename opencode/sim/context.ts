// A plugin's context on the simulated host: the domains of OpenCode's
// `Plugin.Context` the world models (OPERATIONS), each onto host.ts. Storage
// and the tool editor are typed by the fork's own interfaces, so the compiler
// holds their shapes to the real ones. Anything else a plugin reaches for is
// unmodelled: the reach is recorded, a call of it dies naming it, and the
// world's next operation fails with its name, so a plugin can never pass on a
// host the world made up.
import type { Plugin } from "@opencode/plugin/effect"
import { Provider } from "@opencode/schema/provider"
import { Effect, Option, Order, Predicate, Queue, Schema, type Scope, Stream, type Types } from "effect"
import { type Handler, type Hook, type HookInput, type Host, type HostEvent, type Login, type Subscriber } from "./host.ts"
import { type JsonObject, plain } from "./runtime.ts"

/** A plugin as OpenCode loads it: its definition, where, and its options. */
export interface Loaded {
  readonly plugin: Plugin.Plugin
  readonly directory: string
  readonly options: JsonObject
}

type Storage = Plugin.Context["storage"]
type ToolEditor = Parameters<Parameters<Plugin.Context["tool"]["transform"]>[0]>[0]
type IntegrationEditor = Parameters<Parameters<Plugin.Context["integration"]["transform"]>[0]>[0]
/** A mark an integration reports on a login: `needs_auth` asks its owner to sign in again. */
interface Mark {
  readonly status: "needs_auth"
  readonly message: string
  readonly url?: string
}
type ProviderEditor = Parameters<Parameters<Plugin.Context["provider"]["transform"]>[0]>[0]

/** The operations the world's plugin context offers, by path: the static test holds a law to each one. */
export const OPERATIONS = [
  "options",
  "location",
  "storage.get",
  "storage.set",
  "storage.remove",
  "storage.scan",
  "event.subscribe",
  "tool.transform",
  "tool.list",
  "tool.hook",
  "shell.hook",
  "rpc",
  "rpc.register",
  "session.hook",
  "session.get",
  "session.list",
  "session.context",
  "session.compact",
  "session.synthetic",
  "session.create",
  "session.prompt",
  "session.update",
  "model.list",
  "provider.list",
  "provider.get",
  "agent.list",
  "agent.get",
  "provider.transform",
  "integration.get",
  "integration.transform",
  "integration.connection",
] as const

/** Property names a runtime probes on any object (a promise check, a JSON or inspect hook): not a plugin's reach. */
const PROBES = new Set(["then", "toJSON", "constructor", "asymmetricMatch", "$$typeof", "nodeType", "tagName", "toString", "valueOf"])

/** The context's plain data, not domains: an absent optional field in them (a location's workspace) reads as absent. */
const DATA = new Set(["options", "location"])

const SessionInput = Schema.Struct({ sessionID: Schema.String })
const CompactInput = Schema.Struct({ sessionID: Schema.String, reason: Schema.optional(Schema.Literals(["auto", "manual"])) })
const SyntheticInput = Schema.Struct({
  sessionID: Schema.String,
  id: Schema.optional(Schema.String),
  text: Schema.String,
  description: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
  resume: Schema.optional(Schema.Boolean),
})
const CreateInput = Schema.Struct({
  id: Schema.optional(Schema.String),
  location: Schema.optional(Schema.Struct({ directory: Schema.String })),
  parentID: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
})
const PromptInput = Schema.Struct({ sessionID: Schema.String, id: Schema.optional(Schema.String), text: Schema.String })
const UpdateInput = Schema.Struct({ sessionID: Schema.String, metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)) })
const ListInput = Schema.Struct({
  parentID: Schema.optional(Schema.NullOr(Schema.String)),
  directory: Schema.optional(Schema.String),
  order: Schema.optional(Schema.Literals(["asc", "desc"])),
  limit: Schema.optional(Schema.Number),
})
const ProviderInput = Schema.Struct({ providerID: Schema.String })
const AgentInput = Schema.Struct({ agentID: Schema.String })
const SubscribeInput = Schema.Struct({ types: Schema.optional(Schema.Array(Schema.String)) })

/** A plugin's input to an operation, parsed as the host's schema would: a malformed one is the plugin's defect. */
const parse =
  <S extends Schema.Codec<unknown, unknown>>(schema: S, operation: string) =>
  <I>(input: I): Effect.Effect<S["Type"]> =>
    Schema.decodeUnknownEffect(schema)(plain(input)).pipe(
      Effect.catch((error) => Effect.die(new Error(`sim: ${operation} got an input the host refuses: ${error.message}`))),
    )

/** The context for one copy of a plugin. */
export const contextFor = (host: Host, loaded: Loaded, instance: number, plugin: string) => {
  const namespace = host.storage.get(plugin) ?? new Map<string, Schema.Json>()
  host.storage.set(plugin, namespace)
  host.directories.set(instance, loaded.directory)

  /** An unmodelled reach: recorded for the world to fail on, and a call of it dies naming it. */
  const unmodelled = (path: string) => {
    host.unmodelled.push(path)
    host.record("unmodelled", { path })
    return () => Effect.die(new Error(`sim: the world does not model ${path}; add it with a law in sim/host-laws.ts`))
  }

  /** A view of `value` whose missing members are unmodelled reaches, and whose domains (one level down) are guarded too. */
  const guarded = <A extends { readonly [key: string]: unknown }>(value: A, path: string, depth: number): A =>
    new Proxy(value, {
      get: (target, key) => {
        if (Predicate.isSymbol(key) || PROBES.has(key)) return Object.getOwnPropertyDescriptor(target, key)?.value
        const found = Object.getOwnPropertyDescriptor(target, key)
        if (found === void 0) return unmodelled(`${path}.${key}`)
        if (depth > 0 && !DATA.has(key) && Predicate.isObject(found.value) && !Predicate.isFunction(found.value) && !Effect.isEffect(found.value))
          return guarded(found.value, `${path}.${key}`, depth - 1)
        return found.value
      },
    })

  const storage: Storage = {
    get: (key) => Effect.sync(() => namespace.get(key)),
    set: (key, value) =>
      Effect.sync(() => {
        namespace.set(key, plain(value))
        host.record("store-set", { plugin, key, value })
      }),
    remove: (key) =>
      Effect.sync(() => {
        if (namespace.delete(key)) host.record("store-remove", { plugin, key })
      }),
    scan: (input) =>
      Effect.sync(() => {
        const matching = [...namespace.entries()]
          .filter(([key]) => key.startsWith(input.prefix) && key > (input.after ?? ""))
          .toSorted(([left], [right]) => Order.String(left, right))
        const entries = matching.slice(0, input.limit ?? matching.length).map(([key, value]) => ({ key, value }))
        if (entries.length < matching.length) return { entries, next: entries.at(-1)?.key }
        return { entries }
      }),
  }

  const own = host.tools.get(instance) ?? new Map()
  const gone = host.removed.get(instance) ?? new Set<string>()
  const editor: ToolEditor = {
    list: () => [...own.values()].map((tool) => ({ ...tool, id: tool.name })),
    get: (id) => Option.getOrUndefined(Option.map(Option.fromNullishOr(own.get(id)), (tool) => ({ ...tool, id }))),
    namespace: () => void unmodelled("ctx.tool.transform: editor.namespace"),
    add: (tool) => {
      own.set(tool.name, tool)
      host.record("tool-added", { name: tool.name, instance })
    },
    update: (id) => void unmodelled(`ctx.tool.transform: editor.update(${id})`),
    remove: (id) => {
      gone.add(id)
      host.record("tool-removed", { name: id, instance })
    },
  }

  /** A registration that ends with the copy's scope. */
  const registration = <A>(acquire: () => A, release: (value: A) => void): Effect.Effect<{ readonly dispose: Effect.Effect<void> }, never, Scope.Scope> =>
    Effect.acquireRelease(Effect.sync(acquire), (value) => Effect.sync(() => release(value))).pipe(Effect.as({ dispose: Effect.void }))

  const subscribe = (input: typeof SubscribeInput.Type) =>
    Stream.unwrap(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const subscriber: Subscriber = {
            types: Option.map(Option.fromNullishOr(input.types), (types) => new Set(types)),
            queue: yield* Queue.unbounded<HostEvent>(),
          }
          host.subscribers.add(subscriber)
          return subscriber
        }),
        (subscriber) => Effect.sync(() => void host.subscribers.delete(subscriber)),
      ).pipe(Effect.map((subscriber) => Stream.fromQueue(subscriber.queue))),
    )

  const register = <A>(definition: { readonly id: string }, handlers: { readonly [method: string]: Handler } & A) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        host.rpcs.set(definition.id, handlers)
        host.record("rpc-registered", { id: definition.id, instance })
        /** An event of the RPC: every client subscribed to its name gets its data, as JSON across the wire. */
        const emit = <D>(name: string, data: D) =>
          Effect.gen(function* () {
            host.record("rpc-event", { id: definition.id, name })
            for (const subscriber of host.rpcEvents.get(definition.id) ?? []) if (subscriber.name === name) yield* Queue.offer(subscriber.queue, plain(data))
          })
        return { dispose: Effect.void, events: { emit } }
      }),
      () =>
        Effect.sync(() => {
          if (host.rpcs.get(definition.id) === handlers) host.rpcs.delete(definition.id)
        }),
    )

  /** A client's subscription to one of an RPC's events: its data as they are emitted, for the subscription's life. */
  const rpcEvents = (id: string) => ({
    subscribe: (name: string) =>
      Stream.unwrap(
        Effect.acquireRelease(
          Effect.gen(function* () {
            const subscriber = { name, queue: yield* Queue.unbounded<Schema.Json>() }
            const all = host.rpcEvents.get(id) ?? new Set()
            host.rpcEvents.set(id, all)
            all.add(subscriber)
            return subscriber
          }),
          (subscriber) => Effect.sync(() => void host.rpcEvents.get(id)?.delete(subscriber)),
        ).pipe(Effect.map((subscriber) => Stream.fromQueue(subscriber.queue))),
      ),
  })

  /** A client of an RPC: any method name, answered as the host answers it (a method no plugin registered fails), and its events. */
  const client = (definition: { readonly id: string }) =>
    new Proxy(
      {},
      {
        get: (_target, method) => {
          if (Predicate.isSymbol(method) || PROBES.has(method)) return void 0
          if (method === "events") return rpcEvents(definition.id)
          return <I>(input: I) => host.callRpc(definition.id, method, plain(input))
        },
      },
    )

  /** A login as the integration lists it. */
  const connectionOf = (marks: ReadonlyMap<string, Schema.Json>) => (login: Login) => ({
    type: "credential" as const,
    id: login.id,
    label: login.label,
    method: "oauth" as const,
    ...Option.match(Option.fromNullishOr(marks.get(login.id)), { onNone: () => ({}), onSome: (status) => ({ status }) }),
  })

  const IntegrationInput = Schema.Struct({ integrationID: Schema.String })
  const integrationOf = (integrationID: string) =>
    Effect.fromOption(Option.fromNullishOr(host.integrations.get(integrationID))).pipe(Effect.mapError(() => host.catalogNotFound("integration")))

  const integration = {
    get: <I>(input: I) =>
      parse(
        IntegrationInput,
        "integration.get",
      )(input).pipe(
        Effect.flatMap(({ integrationID }) =>
          integrationOf(integrationID).pipe(
            Effect.map((held) => ({ data: { id: integrationID, name: integrationID, methods: [], connections: held.logins.map(connectionOf(held.marks)) } })),
          ),
        ),
      ),
    transform: (callback: (editor: IntegrationEditor) => void) =>
      registration(
        () =>
          callback({
            list: () => [...host.integrations.keys()].map((id) => ({ id, name: id })),
            get: (id) => Option.getOrUndefined(Option.map(Option.fromNullishOr(host.integrations.get(id)), () => ({ id, name: id }))),
            update: (id) => void unmodelled(`ctx.integration.transform: editor.update(${id})`),
            remove: (id) => void unmodelled(`ctx.integration.transform: editor.remove(${id})`),
            method: {
              list: () => [],
              update: (method) => host.record("integration-method", { integrationID: method.integrationID, method: method.method.type, instance }),
              remove: (integrationID) => void unmodelled(`ctx.integration.transform: editor.method.remove(${integrationID})`),
            },
          }),
        () => void 0,
      ),
    connection: {
      active: (integrationID: string) =>
        Effect.sync(() =>
          Option.getOrUndefined(
            Option.flatMap(Option.fromNullishOr(host.integrations.get(integrationID)), (held) =>
              Option.flatMap(held.active, (id) => Option.map(Option.fromNullishOr(held.logins.find((login) => login.id === id)), connectionOf(held.marks))),
            ),
          ),
        ),
      resolve: (connection: { readonly type: string; readonly id?: string }) =>
        Effect.sync(() => {
          for (const held of host.integrations.values())
            for (const login of held.logins)
              if (connection.type === "credential" && login.id === connection.id)
                return {
                  type: "oauth" as const,
                  methodID: Option.getOrElse(Option.fromNullishOr(login.methodID), () => "claude-max"),
                  access: login.access,
                  refresh: login.refresh,
                  expires: login.expires,
                  ...Option.match(Option.fromNullishOr(login.metadata), { onNone: () => ({}), onSome: (metadata) => ({ metadata }) }),
                }
          return void 0
        }),
      /** A mark on a login, or its clearing: the integration lists it on the connection until it is cleared. */
      status: (input: { readonly integrationID: string; readonly connection: { readonly type: string; readonly id?: string }; readonly status?: Mark }) =>
        Effect.sync(() => {
          const id = input.connection.id ?? ""
          const mark = Option.fromNullishOr(input.status)
          host.record("connection-status", { integrationID: input.integrationID, credentialID: id, status: Option.match(mark, { onNone: () => "", onSome: (set) => set.status }) })
          const held = host.integrations.get(input.integrationID)
          Option.match(mark, { onNone: () => held?.marks.delete(id), onSome: (set) => held?.marks.set(id, plain(set)) })
        }),
    },
  }

  /** A provider as the catalog records it: its activation, no models of its own. */
  const recordOf = (id: string) => ({
    provider: { ...Provider.Info.empty(Provider.ID.make(id)), activation: host.activations.get(id) ?? "auto" },
    models: new Map(),
  })

  /** The catalog's transform: a plugin may turn a provider on (`activation`); nothing else is modelled. */
  const providerTransform = (callback: (editor: ProviderEditor) => void) =>
    registration(
      () =>
        callback({
          list: () => [...host.activations.keys()].map(recordOf),
          get: (id) => Option.getOrUndefined(Option.map(Option.fromNullishOr(host.activations.get(id)), () => recordOf(id))),
          update: (id, change) => {
            const provider: Types.DeepMutable<Provider.Info> = { ...recordOf(id).provider }
            change(provider)
            host.activations.set(id, provider.activation)
            host.record("provider-updated", { id, activation: provider.activation, instance })
          },
          add: (input) => void unmodelled(`ctx.provider.transform: editor.add(${input.info.id})`),
          remove: (id) => void unmodelled(`ctx.provider.transform: editor.remove(${id})`),
          models: {
            set: (id) => void unmodelled(`ctx.provider.transform: editor.models.set(${id})`),
            update: (id, model) => void unmodelled(`ctx.provider.transform: editor.models.update(${id}, ${model})`),
            remove: (id, model) => void unmodelled(`ctx.provider.transform: editor.models.remove(${id}, ${model})`),
          },
        }),
      () => void 0,
    )

  const list = (input: typeof ListInput.Type) => {
    const matching = [...host.sessions.values()].filter((session) => {
      const parent = Option.getOrElse(session.parentID, () => "")
      const parentMatches = input.parentID === void 0 || parent === (input.parentID ?? "")
      return parentMatches && (input.directory === void 0 || session.directory === input.directory)
    })
    // As the fork's store (packages/core/src/session/store.ts `list`): by last update, newest first unless
    // `order: "asc"`, the id string breaking a tie the same way; then `limit`.
    const ascending = Order.combine(
      Order.mapInput(Order.Number, (session: (typeof matching)[number]) => session.updated),
      Order.mapInput(Order.String, (session: (typeof matching)[number]) => session.id),
    )
    const orders = { asc: ascending, desc: Order.flip(ascending) }
    const ordered = matching.toSorted(orders[input.order ?? "desc"])
    return { data: ordered.slice(0, input.limit ?? ordered.length).map(host.infoOf) }
  }

  /**
   * A hook of another domain than the session's, kept in the host's hooks under `prefix:name`: only the names the
   * world runs (`modelled`); registering any other is an unmodelled reach.
   */
  const domainHook =
    (prefix: string, modelled: ReadonlySet<string>) =>
    (name: string, callback: (input: HookInput) => Effect.Effect<void, unknown>): Effect.Effect<{ readonly dispose: Effect.Effect<void> }, never, Scope.Scope> => {
      if (!modelled.has(name)) return unmodelled(`ctx.${prefix}.hook(${name})`)()
      return registration(
        (): Hook => {
          const hook = { instance, directory: loaded.directory, name: `${prefix}:${name}`, callback }
          host.hooks.push(hook)
          return hook
        },
        (hook) => void host.hooks.splice(host.hooks.indexOf(hook), 1),
      )
    }

  const session = {
    hook: (name: string, callback: (input: HookInput) => Effect.Effect<void, unknown>) =>
      registration(
        (): Hook => {
          const hook = { instance, directory: loaded.directory, name, callback }
          host.hooks.push(hook)
          return hook
        },
        (hook) => void host.hooks.splice(host.hooks.indexOf(hook), 1),
      ),
    get: <I>(input: I) =>
      parse(
        SessionInput,
        "session.get",
      )(input).pipe(
        Effect.flatMap(({ sessionID }) => host.sessionOr(sessionID)),
        Effect.map(host.infoOf),
      ),
    list: <I>(input: I) => parse(ListInput, "session.list")(input).pipe(Effect.map(list)),
    context: <I>(input: I) =>
      parse(
        SessionInput,
        "session.context",
      )(input).pipe(
        Effect.flatMap(({ sessionID }) => host.sessionOr(sessionID)),
        Effect.map((found) => host.contextOf(found).map(host.viewOf)),
      ),
    compact: <I>(input: I) =>
      parse(
        CompactInput,
        "session.compact",
      )(input).pipe(
        Effect.flatMap(({ sessionID, reason }) => host.sessionOr(sessionID).pipe(Effect.flatMap((found) => host.compact(found, Option.fromNullishOr(reason))))),
      ),
    synthetic: <I>(input: I) =>
      parse(
        SyntheticInput,
        "session.synthetic",
      )(input).pipe(
        Effect.flatMap((parsed) =>
          host.sessionOr(parsed.sessionID).pipe(
            Effect.flatMap((found) =>
              host.admit(found, {
                id: parsed.id ?? host.mint("msg_"),
                type: "synthetic",
                text: parsed.text,
                description: parsed.description ?? "",
                metadata: parsed.metadata ?? {},
                resume: parsed.resume !== false,
              }),
            ),
          ),
        ),
      ),
    create: <I>(input: I) =>
      parse(
        CreateInput,
        "session.create",
      )(input).pipe(
        Effect.flatMap((parsed) => host.createSession({ ...parsed, directory: parsed.location?.directory ?? loaded.directory })),
        Effect.map(host.infoOf),
      ),
    prompt: <I>(input: I) =>
      parse(
        PromptInput,
        "session.prompt",
      )(input).pipe(
        Effect.flatMap((parsed) =>
          host
            .sessionOr(parsed.sessionID)
            .pipe(Effect.flatMap((found) => host.admit(found, { id: parsed.id ?? host.mint("msg_"), type: "prompt", text: parsed.text, resume: true }))),
        ),
      ),
    update: <I>(input: I) =>
      parse(
        UpdateInput,
        "session.update",
      )(input).pipe(
        Effect.flatMap((parsed) =>
          host.sessionOr(parsed.sessionID).pipe(
            Effect.map((found) => {
              found.metadata = { ...(parsed.metadata ?? found.metadata) }
              host.touch(found)
              host.record("session-updated", { sessionID: found.id, metadata: found.metadata })
              return host.infoOf(found)
            }),
          ),
        ),
      ),
  }

  const agents = [{ id: "build", request: {} }]
  const modelled = {
    options: loaded.options,
    location: { directory: loaded.directory },
    storage,
    event: { subscribe: <I>(input: I) => Stream.unwrap(parse(SubscribeInput, "event.subscribe")(input ?? {}).pipe(Effect.map(subscribe))) },
    tool: {
      transform: (callback: (input: ToolEditor) => void) =>
        registration(
          () => {
            host.tools.set(instance, own)
            host.removed.set(instance, gone)
            callback(editor)
          },
          () => {
            host.tools.delete(instance)
            host.removed.delete(instance)
          },
        ),
      list: () => Effect.sync(() => [...host.toolsOf(loaded.directory).keys()].map((name) => ({ id: name, name }))),
      // `execute.after` is the repair's alone in the world (host.ts `runTool`); a plugin's is not modelled.
      hook: domainHook("tool", new Set(["execute.before"])),
    },
    shell: { hook: domainHook("shell", new Set(["create.before"])) },
    rpc: Object.assign(client, { register }),
    session,
    model: { list: () => Effect.sync(() => ({ data: host.models })) },
    integration,
    provider: {
      transform: providerTransform,
      list: () => Effect.sync(() => ({ data: host.providers() })),
      get: <I>(input: I) =>
        parse(
          ProviderInput,
          "provider.get",
        )(input).pipe(
          Effect.flatMap(({ providerID }) => Effect.fromOption(Option.fromNullishOr(host.providers().find((provider) => provider.id === providerID)))),
          Effect.map((data) => ({ data })),
          Effect.mapError(() => host.catalogNotFound("provider")),
        ),
    },
    agent: {
      list: () => Effect.sync(() => ({ data: agents })),
      get: <I>(input: I) =>
        parse(
          AgentInput,
          "agent.get",
        )(input).pipe(
          Effect.flatMap(({ agentID }) => Effect.fromOption(Option.fromNullishOr(agents.find((agent) => agent.id === agentID)))),
          Effect.map((data) => ({ data })),
          Effect.mapError(() => host.catalogNotFound("agent")),
        ),
    },
  }
  return guarded(modelled, "ctx", 1)
}

export type Modelled = ReturnType<typeof contextFor>

/** Whether the world's context holds every operation it claims: then it stands in for OpenCode's, its other domains unmodelled reaches. */
export const isContext = (value: Modelled): value is Modelled & Plugin.Context =>
  OPERATIONS.every((path) => {
    const [domain = "", operation] = path.split(".")
    const found = Object.getOwnPropertyDescriptor(value, domain)?.value
    if (operation === void 0) return found !== void 0
    const inner: unknown = Object.getOwnPropertyDescriptor(found, operation)?.value
    // `integration.connection` is a domain of its own: its operations are the integration's.
    return Predicate.isFunction(inner) || Predicate.isObject(inner)
  })
