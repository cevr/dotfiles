# Desktop Client (Tauri)

Tauri desktop wrapper around the web client with native capabilities.

## Project Structure

```
apps/desktop/
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── capabilities/
│       └── default.json
├── src/                    # Reuses web client
│   └── platform.ts         # Desktop-specific platform adapter
├── package.json
└── vite.config.ts
```

## Package Setup

```json
// apps/desktop/package.json
{
  "name": "@my-app/desktop",
  "type": "module",
  "scripts": {
    "dev": "tauri dev",
    "build": "tauri build",
    "tauri": "tauri"
  },
  "dependencies": {
    "@my-app/web": "workspace:*",
    "@tauri-apps/api": "^2.0.0",
    "@tauri-apps/plugin-shell": "^2.0.0",
    "@tauri-apps/plugin-dialog": "^2.0.0",
    "@tauri-apps/plugin-fs": "^2.0.0",
    "@tauri-apps/plugin-notification": "^2.0.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "vite": "^6.0.0"
  }
}
```

## Tauri Configuration

```json
// apps/desktop/src-tauri/tauri.conf.json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "My App",
  "version": "0.1.0",
  "identifier": "com.myapp.desktop",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:5173",
    "beforeDevCommand": "bun run --cwd ../web dev",
    "beforeBuildCommand": "bun run --cwd ../web build"
  },
  "app": {
    "windows": [
      {
        "title": "My App",
        "width": 1200,
        "height": 800,
        "minWidth": 800,
        "minHeight": 600,
        "resizable": true,
        "fullscreen": false,
        "decorations": true,
        "transparent": false
      }
    ],
    "security": {
      "csp": "default-src 'self'; connect-src 'self' http://localhost:3000 ws://localhost:3000"
    }
  },
  "plugins": {
    "shell": {
      "open": true
    },
    "fs": {
      "scope": ["$APPDATA/*", "$DOCUMENT/*"]
    },
    "notification": {}
  }
}
```

## Tauri Capabilities

```json
// apps/desktop/src-tauri/capabilities/default.json
{
  "$schema": "https://schemas.tauri.app/2/capability",
  "identifier": "default",
  "description": "Default capabilities for the app",
  "windows": ["main"],
  "permissions": [
    "shell:allow-open",
    "dialog:allow-open",
    "dialog:allow-save",
    "fs:allow-read",
    "fs:allow-write",
    "notification:default"
  ]
}
```

## Rust Backend

```rust
// apps/desktop/src-tauri/src/main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    myapp_desktop_lib::run()
}

// apps/desktop/src-tauri/src/lib.rs
use tauri::Manager;

#[tauri::command]
async fn get_system_info() -> Result<SystemInfo, String> {
    Ok(SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
    })
}

#[derive(serde::Serialize)]
struct SystemInfo {
    os: String,
    arch: String,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![get_system_info])
        .setup(|app| {
            // Window customization
            let window = app.get_webview_window("main").unwrap();
            #[cfg(debug_assertions)]
            window.open_devtools();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Cargo Configuration

```toml
# apps/desktop/src-tauri/Cargo.toml
[package]
name = "myapp-desktop"
version = "0.1.0"
edition = "2021"

[lib]
name = "myapp_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-shell = "2"
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-notification = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
```

## Platform Adapter

```typescript
// apps/desktop/src/platform.ts
import { invoke } from "@tauri-apps/api/core"
import { open, save } from "@tauri-apps/plugin-dialog"
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs"
import { sendNotification } from "@tauri-apps/plugin-notification"
import type { Platform } from "@my-app/web"

export const desktopPlatform: Platform = {
  platform: "desktop",

  async openFile() {
    const path = await open({
      multiple: false,
      filters: [{ name: "Text", extensions: ["txt", "md", "json"] }],
    })
    if (!path) return null
    const content = await readTextFile(path as string)
    return { path: path as string, content }
  },

  async saveFile(content: string, defaultPath?: string) {
    const path = await save({
      defaultPath,
      filters: [{ name: "Text", extensions: ["txt", "md", "json"] }],
    })
    if (!path) return null
    await writeTextFile(path, content)
    return path
  },

  async notify(title: string, body: string) {
    await sendNotification({ title, body })
  },

  async getSystemInfo() {
    return invoke<{ os: string; arch: string }>("get_system_info")
  },

  storage: {
    async get(key: string) {
      try {
        const content = await readTextFile(`$APPDATA/myapp/${key}.json`)
        return JSON.parse(content)
      } catch {
        return null
      }
    },
    async set(key: string, value: unknown) {
      await writeTextFile(`$APPDATA/myapp/${key}.json`, JSON.stringify(value))
    },
    async remove(key: string) {
      // Use Tauri fs remove
    },
  },
}
```

## Desktop-Specific Entry

```typescript
// apps/desktop/src/main.tsx
import { render } from "solid-js/web"
import { Router } from "@solidjs/router"
import { App, PlatformProvider } from "@my-app/web"
import { desktopPlatform } from "./platform"
import "./index.css"

render(
  () => (
    <PlatformProvider platform={desktopPlatform}>
      <Router>
        <App />
      </Router>
    </PlatformProvider>
  ),
  document.getElementById("root")!
)
```

## Web Client Platform Interface

```typescript
// apps/web/src/platform/index.ts
import { createContext, useContext, type JSX } from "solid-js"

export interface Platform {
  platform: "web" | "desktop" | "mobile"
  openFile?: () => Promise<{ path: string; content: string } | null>
  saveFile?: (content: string, defaultPath?: string) => Promise<string | null>
  notify?: (title: string, body: string) => Promise<void>
  getSystemInfo?: () => Promise<{ os: string; arch: string }>
  storage: {
    get: <T>(key: string) => Promise<T | null>
    set: <T>(key: string, value: T) => Promise<void>
    remove: (key: string) => Promise<void>
  }
}

// Default web platform
export const webPlatform: Platform = {
  platform: "web",
  storage: {
    get: async (key) => {
      const value = localStorage.getItem(key)
      return value ? JSON.parse(value) : null
    },
    set: async (key, value) => {
      localStorage.setItem(key, JSON.stringify(value))
    },
    remove: async (key) => {
      localStorage.removeItem(key)
    },
  },
}

const PlatformContext = createContext<Platform>(webPlatform)

export function PlatformProvider(props: {
  platform: Platform
  children: JSX.Element
}) {
  return (
    <PlatformContext.Provider value={props.platform}>
      {props.children}
    </PlatformContext.Provider>
  )
}

export function usePlatform() {
  return useContext(PlatformContext)
}
```

## Using Platform in Components

```typescript
// apps/web/src/components/file-picker.tsx
import { Show } from "solid-js"
import { usePlatform } from "../platform"

export function FilePicker(props: { onFile: (content: string) => void }) {
  const platform = usePlatform()

  const handlePick = async () => {
    if (platform.openFile) {
      const result = await platform.openFile()
      if (result) props.onFile(result.content)
    }
  }

  return (
    <Show
      when={platform.openFile}
      fallback={
        <input
          type="file"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) {
              file.text().then(props.onFile)
            }
          }}
        />
      }
    >
      <button onClick={handlePick} class="btn">
        Open File
      </button>
    </Show>
  )
}
```

## Menu and Shortcuts (Desktop-specific)

```typescript
// apps/desktop/src/menu.ts
import { Menu, MenuItem, Submenu } from "@tauri-apps/api/menu"
import { getCurrentWindow } from "@tauri-apps/api/window"

export async function setupMenu() {
  const menu = await Menu.new({
    items: [
      await Submenu.new({
        text: "File",
        items: [
          await MenuItem.new({
            text: "New Session",
            accelerator: "CmdOrCtrl+N",
            action: () => {
              // Dispatch to app
              window.dispatchEvent(new CustomEvent("menu:new-session"))
            },
          }),
          await MenuItem.new({
            text: "Open...",
            accelerator: "CmdOrCtrl+O",
            action: () => {
              window.dispatchEvent(new CustomEvent("menu:open"))
            },
          }),
          await MenuItem.new({
            text: "Save",
            accelerator: "CmdOrCtrl+S",
            action: () => {
              window.dispatchEvent(new CustomEvent("menu:save"))
            },
          }),
        ],
      }),
      await Submenu.new({
        text: "Edit",
        items: [
          await MenuItem.new({ text: "Undo", accelerator: "CmdOrCtrl+Z" }),
          await MenuItem.new({ text: "Redo", accelerator: "CmdOrCtrl+Shift+Z" }),
          await MenuItem.new({ text: "Cut", accelerator: "CmdOrCtrl+X" }),
          await MenuItem.new({ text: "Copy", accelerator: "CmdOrCtrl+C" }),
          await MenuItem.new({ text: "Paste", accelerator: "CmdOrCtrl+V" }),
        ],
      }),
    ],
  })

  await menu.setAsAppMenu()
}
```

## Auto-Update (Optional)

```rust
// apps/desktop/src-tauri/src/lib.rs
use tauri_plugin_updater::{UpdaterExt};

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Some(update) = handle.updater().check().await.ok().flatten() {
                    // Notify user about update
                    update.download_and_install(|_, _| {}, || {}).await.ok();
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

## Key Points

1. **Reuse web client**: Desktop wraps existing web code
2. **Platform adapter**: Inject native capabilities via context
3. **Tauri v2**: Modern Rust-based desktop framework
4. **Native features**: File dialogs, notifications, system info
5. **Capabilities**: Security model for native API access
6. **Same codebase**: Web and desktop share 90%+ code
7. **Menu integration**: Native menus with keyboard shortcuts
