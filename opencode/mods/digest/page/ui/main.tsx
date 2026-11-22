// The digest's page (prototype r3's shape on live data): projects, a project's messages opening in place, and the
// scrubbing timeline. Wide: three columns. Phone: projects, then a project with its timeline at the bottom.
// Everything it shows comes from /view.json; it keeps the last view through a server restart and says so.
import "./style.css"
import { render } from "@solidjs/web"
import { Match, Show, Switch } from "solid-js"
import { Messages, PairPrompt } from "./messages.tsx"
import { ProjectsHome, ProjectsSide } from "./projects.tsx"
import { locked, marksLocked, problem, project, start, view, wide } from "./state.ts"
import { Timeline } from "./timeline.tsx"

function Banner() {
  return (
    <Show when={problem()}>
      {(said) => (
        <p class="banner" role="status">
          {view() === undefined ? `The digest is not answering: ${said()}` : `Server restarting, or not answering (${said()}). This is the last view; it updates when the server is back.`}
        </p>
      )}
    </Show>
  )
}

function App() {
  return (
    <>
      <Banner />
      <Show when={marksLocked() && !locked()}>
        <section class="marking">
          <PairPrompt need="mark" />
        </section>
      </Show>
      <Switch>
        <Match when={locked()}>
          <section class="locked">
            <h1>Digest</h1>
            <PairPrompt need="read" />
          </section>
        </Match>
        <Match when={view() === undefined && problem() === undefined}>
          <p class="loading" role="status">
            Loading the digest…
          </p>
        </Match>
        <Match when={view() !== undefined && wide()}>
          <div class="shell">
            <ProjectsSide />
            <Show when={project()} fallback={<p class="none">No projects yet. A run's first lane makes one.</p>}>
              {(entered) => (
                <>
                  <Messages project={entered()} />
                  <Timeline project={entered()} />
                </>
              )}
            </Show>
          </div>
        </Match>
        <Match when={view() !== undefined}>
          <Show when={project()} fallback={<ProjectsHome />}>
            {(entered) => (
              <div class="phone">
                <Messages project={entered()} />
                <Timeline project={entered()} />
              </div>
            )}
          </Show>
        </Match>
      </Switch>
    </>
  )
}

render(() => <App />, document.getElementById("main") ?? document.body)
start()
