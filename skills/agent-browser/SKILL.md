---
name: agent-browser
description: Headless Chrome automation CLI, for the cases the browse skill (the owner's real Chrome) cannot cover. Use for an Electron desktop app (VS Code, Slack desktop, Discord, Figma, Notion, Spotify); a cloud or sandbox browser (Vercel Sandbox microVMs, AWS Bedrock AgentCore); a clean, isolated or headless profile when the owner's Chrome must stay untouched, or several users with separate cookies at once; CI; a page that must play muted; or a Vercel deployment that needs an OIDC or bypass header. Every other web task (open a site, click, fill, screenshot, scrape, log in, test, QA, Slack web, record, derive a client) uses the browse skill.
allowed-tools: Bash(agent-browser:*)
hidden: true
---

# agent-browser

Fast browser automation CLI for AI agents. Chrome/Chromium via CDP with accessibility-tree snapshots and compact `@eN` element refs.

Install: `npm i -g agent-browser && agent-browser install`

## When to use it

Use the **browse** skill for web pages: it drives the owner's logged-in Chrome, and its `references/from-agent-browser.md` translates every command below. Reach for agent-browser only for an Electron app, a cloud or sandbox browser, an isolated or headless profile (the owner's Chrome must stay untouched, parallel users, muted audio), CI, or a header-authenticated Vercel deployment.

## Start here

This file is a discovery stub, not the usage guide. Before running any `agent-browser` command, load the actual workflow content from the CLI:

```bash
agent-browser skills get core             # start here — workflows, common patterns, troubleshooting
agent-browser skills get core --full      # include full command reference and templates
```

The CLI serves skill content that always matches the installed version, so instructions never go stale. The content in this stub cannot change between releases, which is why it just points at `skills get core`.

## Specialized skills

Load a specialized skill when the task falls outside browser web pages:

```bash
agent-browser skills get electron          # Electron desktop apps (VS Code, Slack, Discord, Figma, ...)
agent-browser skills get slack             # Slack workspace automation
agent-browser skills get dogfood           # Exploratory testing / QA / bug hunts
agent-browser skills get derive-client     # Record a HAR, derive a standalone API client for a site
agent-browser skills get vercel-sandbox    # agent-browser inside Vercel Sandbox microVMs
agent-browser skills get protected-vercel-deployments  # Access protected Vercel deployments
agent-browser skills get agentcore         # AWS Bedrock AgentCore cloud browsers
```

Run `agent-browser skills list` to see everything available on the installed version.

## Why agent-browser

- Fast native Rust CLI, not a Node.js wrapper
- Works with any AI agent (Cursor, Claude Code, Codex, Continue, Windsurf, etc.)
- Chrome/Chromium via CDP with no Playwright or Puppeteer dependency
- Accessibility-tree snapshots with element refs for reliable interaction
- Sessions, authentication vault, state persistence, video recording
- Specialized skills for Electron apps, Slack, exploratory testing, cloud providers

## Observability Dashboard

The dashboard runs independently of browser sessions on port 4848 and can also be opened through a proxied or forwarded URL such as `https://dashboard.agent-browser.localhost`. Agents should stay on the dashboard origin: session tabs, status, and stream traffic are proxied internally, so session ports do not need to be exposed.
