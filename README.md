<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/logo_light.svg" />
  <img alt="Planche" src="./.github/assets/logo.svg" />
</picture>

A cross-platform board for your references and visual research. Fast, open source, agent-ready, and stored as plain files.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/screenshot_dark.webp" />
  <img alt="A board comparing two abbeys in the south of France, with photos, notes, drawings, and a sticky note's style card open" src="./.github/assets/screenshot.webp" />
</picture>

## Getting Planche

Planche runs in the browser at [planche.bruits.org](https://planche.bruits.org), and as a desktop app for macOS, Windows, and Linux from the [latest release](https://github.com/bruits/planche/releases/latest). The desktop app needs macOS 13, Windows 10, or a Linux as recent as Ubuntu 22.04 or Debian 12. It is not signed yet, so macOS asks you to allow it in System Settings, under Privacy & Security, and Windows SmartScreen warns when you run the installer.

## Documentation

- [Boards](./docs/usage/boards.md), [editing](./docs/usage/editing.md), [shortcuts](./docs/usage/shortcuts.md), [images and videos](./docs/usage/media.md), [settings](./docs/usage/settings.md), and [agents](./docs/usage/agents.md) explain how to use Planche. So far Planche has run for real in Chromium and in the macOS app, so what these pages say of other browsers and systems is still to be tried.
- [CONTRIBUTING.md](./CONTRIBUTING.md) covers setup, the project's layout, and its philosophy, and [docs/development/](./docs/development/) what is decided and how the parts work.

## Acknowledgements

Planche builds on the work of several open-source projects:

- [wgpu](https://wgpu.rs/), the GPU API in Rust that draws every board, in browsers through WebGPU and WebGL2
- [Tauri](https://v2.tauri.app/), which wraps the web app into a desktop app
- [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen), through which the web app runs the Rust core
- [rmcp](https://github.com/modelcontextprotocol/rust-sdk), the official Rust SDK for MCP, which lets agents in
- [Inter](https://rsms.me/inter/) by Rasmus Andersson, the typeface of every text on a board, and [Tabler Icons](https://tabler.io/icons) by Paweł Kuna, the icons of the toolbar

Thank you to everyone who contributes, or would like to. [CONTRIBUTING.md](./CONTRIBUTING.md) is the place to start, and the [docs](./docs/) explain the choices behind the code.

Planche is an open-source project born from [Bruits](https://bruits.org/), a Rust-focused collective 💛
