<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./.github/assets/logo_light.svg" />
  <img alt="Planche" src="./.github/assets/logo.svg" />
</picture>

A cross-platform board for your references and visual research. Fast, open source, agent-ready, and stored as plain files.

## Project Structure

- `crates/board/` and `crates/format/` — the core, a board as plain data and as a folder of files, with no I/O so that it builds for every platform, the browser included
- `crates/desktop/` — the desktop shell, which wraps the web app and reads and writes boards on disk through `crates/folder/`
- `crates/mcp/` — the MCP server through which agents read and edit the board open in the desktop app
- `web/` — the app, in TypeScript, which runs the core as WASM through `crates/bindings/` and draws boards with `crates/renderer/`, on wgpu
- `samples/` — boards to try the app on
- [CONTRIBUTING.md](./CONTRIBUTING.md) — setup, each crate in detail, and the project's philosophy
