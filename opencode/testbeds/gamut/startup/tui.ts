// Gamut-only handshake: use the same location-scoped catalog the composer reads.
interface Agent {
  readonly id: string
  readonly mode: string
  readonly hidden?: boolean
  readonly description?: string
}

interface StartupContext {
  readonly options: Readonly<Record<string, unknown>>
  readonly data: { readonly location: { readonly agent: { list(): readonly Agent[] | undefined } } }
  readonly ui: { readonly model: { current(): { readonly providerID: string; readonly modelID: string } | undefined } }
}

export const ready = (agents: readonly Agent[] | undefined, hasModel: boolean, id: string, description: string) => {
  const first = agents?.find((agent) => agent.mode !== "subagent" && !agent.hidden)
  return hasModel && first?.id === id && first.description === description
}

export default {
  id: "dotfiles-gamut.startup",
  setup({ options, data, ui }: StartupContext) {
    const { marker, agent, description } = options
    if (typeof marker !== "string" || typeof agent !== "string" || typeof description !== "string") return
    const probe = () => {
      if (!ready(data.location.agent.list(), ui.model.current() !== undefined, agent, description)) return
      clearInterval(timer)
      // A config-only agent stub does not have the plugin's description.
      void Bun.write(marker, "ready\n").catch(() => console.error("Gamut could not write the composer readiness marker"))
    }
    const timer = setInterval(probe, 20)
    probe()
    return () => clearInterval(timer)
  },
}
