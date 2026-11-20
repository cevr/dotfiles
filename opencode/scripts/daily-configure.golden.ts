// The golden of scripts/daily-configure.test.ts: what `daily --configure` writes over `EXISTING` with the test's
// facts, every path into this checkout's `opencode/` written `<opencode>`. Written once by the function the
// test runs, at the change that made the plugin lists data; a change to it is a change to every host's configs.
import { pluginDir } from "./daily.ts"

const ROOT = pluginDir("pool").slice(0, -"/cmd/pool".length)

/** The configs before: a foreign plugin and keys, an old role model, our old rift entry and the retired names. */
export const EXISTING = {
  server: {
    "plugins": [
      "/x/foreign",
      {
        "package": "/y/other",
        "options": {
          "a": 1
        }
      },
      `${ROOT}/cmd/rift`,
      "-opencode.tool.schedule"
    ],
    "agents": {
      "planner": {
        "model": "old/x",
        "temperature": 0.3
      }
    },
    "keepme": true,
    "experimental": {
      "background_compaction": true,
      "other": 1
    },
    "providers": {
      "openai": {
        "settings": {
          "x": 1
        }
      }
    }
  },
  cli: {
    "plugins": [
      "/x/foreign-tui",
      `${ROOT}/mods/prime`
    ],
    "theme": {
      "name": "x",
      "mode": "dark"
    },
    "other": 2
  },
}

export const SERVER = `{
  "plugins": [
    "<opencode>/cmd/anthropic-auth",
    {
      "package": "<opencode>/cmd/pool",
      "options": {
        "cacheLifeMs": 3600000,
        "sources": [
          {
            "kind": "store",
            "dir": "/home/golden/.local/share/opencode-prime/pool-auth"
          }
        ],
        "paced": {
          "openai": "openai"
        },
        "fleet": {
          "host": "cristians-macbook-pro",
          "peers": [
            {
              "name": "workbox",
              "ssh": "bite-workbox"
            }
          ]
        }
      }
    },
    {
      "package": "<opencode>/cmd/orchestrate",
      "options": {
        "codex": {
          "pool": true
        },
        "fleet": {
          "dotfiles": "/home/golden/dotfiles",
          "fork": "/home/golden/fork"
        },
        "planner": {
          "model": "anthropic/claude-fable-5-2"
        }
      }
    },
    "<opencode>/cmd/guard",
    "<opencode>/cmd/kernel",
    "<opencode>/cmd/status",
    "<opencode>/cmd/queue",
    "<opencode>/cmd/git",
    "<opencode>/cmd/idle-compact",
    "<opencode>/cmd/model-next",
    "<opencode>/cmd/auto-title",
    {
      "package": "<opencode>/cmd/mail",
      "options": {
        "listen": {
          "hostname": "100.64.0.7"
        }
      }
    },
    "<opencode>/cmd/questions",
    "<opencode>/cmd/wake",
    "<opencode>/cmd/image",
    "<opencode>/cmd/skills",
    "<opencode>/cmd/work",
    "<opencode>/cmd/tool-names",
    "<opencode>/cmd/cache",
    "<opencode>/cmd/prime",
    "<opencode>/cmd/memory",
    "<opencode>/cmd/stall",
    "<opencode>/cmd/rex",
    "<opencode>/cmd/escape",
    {
      "package": "<opencode>/cmd/update",
      "options": {
        "host": "cristians-macbook-pro",
        "checkout": "/home/golden/dotfiles",
        "mode": "ff",
        "fork": "/home/golden/fork",
        "bun": "/home/golden/.bun/bin/bun",
        "launcher": "/home/golden/.local/bin/opencode",
        "resident": "/home/golden/.local/state/opencode-prime/resident",
        "record": "/home/golden/.local/state/opencode/installed.json",
        "config": [
          "/home/golden/.config/opencode/opencode.json",
          "/home/golden/.config/opencode/cli.json"
        ],
        "notice": "/home/golden/.local/state/opencode-daily/upstream.json",
        "state": "/home/golden/.local/state/opencode-update"
      }
    },
    "-opencode.tool.automation",
    "/x/foreign",
    {
      "package": "/y/other",
      "options": {
        "a": 1
      }
    }
  ],
  "agents": {
    "planner": {
      "model": "anthropic/claude-opus-5-5",
      "temperature": 0.3
    },
    "implementor": {
      "model": "anthropic/claude-opus-5-5"
    },
    "verifier": {
      "model": "anthropic/claude-opus-5-5"
    },
    "worker": {
      "model": "anthropic/claude-opus-5-5"
    }
  },
  "keepme": true,
  "providers": {
    "openai": {
      "settings": {
        "x": 1
      }
    },
    "anthropic": {
      "settings": {
        "cache": {
          "ttl": "1h"
        }
      }
    }
  },
  "experimental": {
    "other": 1
  },
  "autoupdate": false
}
`

export const CLI = `{
  "plugins": [
    "<opencode>/cmd/prime",
    "<opencode>/cmd/status",
    "<opencode>/cmd/herdr",
    "<opencode>/cmd/rex",
    "<opencode>/cmd/git",
    "<opencode>/cmd/cache",
    "<opencode>/cmd/questions",
    "<opencode>/cmd/model-next",
    "<opencode>/cmd/btw",
    "<opencode>/cmd/skills",
    "<opencode>/cmd/recover",
    "<opencode>/cmd/orchestrate",
    "<opencode>/cmd/escape",
    "<opencode>/cmd/queue",
    "-opencode.btw",
    "/x/foreign-tui"
  ],
  "theme": {
    "name": "prime",
    "mode": "dark"
  },
  "other": 2,
  "tabs": {
    "scope": "window"
  }
}
`
