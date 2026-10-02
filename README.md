# Planche

A fast, open-source board to gather your reference images, kept as plain files you own 📌

> [!IMPORTANT]
> Planche is a working title, and nothing is released yet. The prototype is under way: see the [philosophy](./CONTRIBUTING.md#philosophy) for what it aims at, and the [technical foundation](./docs/technical/foundation.md) for what is decided.

## Project Structure

- `crates/board/` — the board as plain data: elements, groups, and image edits
- `crates/format/` — the board as a folder of files, and back
- `crates/bindings/` — the core for the web app, as WASM
- `crates/desktop/` — the desktop shell, around the web app
- `crates/folder/` — a folder on disk, as the desktop shell reads and writes it
- `crates/renderer/` — the renderer, on wgpu
- `web/` — the app, which runs in a browser and in the desktop shell
- `samples/` — boards to try the app on
- `docs/technical/` — the [technical foundation](./docs/technical/foundation.md), and how boards [save](./docs/technical/saving.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — contributing guidelines and project philosophy
