# Contributing Guidelines

## Philosophy

Planche is a fast, open-source board to gather reference images. You drop in pictures from anywhere, lay them out on a canvas, and annotate them with notes, arrows, and shapes. A board is a folder of plain files that belongs to its user: it moves between machines without loss, diffs well in Git, and needs no account.

The app stays small on purpose. Its core covers what a reference board needs, including simple non-destructive edits (crop, rotation, flip, and greyscale), and anything beyond goes into plugins. An optional, paid cloud may add live collaboration and sync one day, but the app works fully without it.

Three priorities guide the trade-offs. Performance: a board of hundreds of large photos opens quickly and stays smooth to pan and zoom on ordinary hardware, and the rendering choices in the [foundation](./docs/technical/foundation.md#rendering) follow from this. Agentic workflows: an embedded MCP server lets agents read and edit a board as people do, and plain files let them work on it like any other file in a repository. Every platform: the browser, Windows, macOS, and Linux first, then iOS and Android, all running the same Rust core behind thin shells. The core does no I/O, so the same code builds natively and for the browser.

## Quality Guidelines

- Prefer self-documenting code first, with expressive names and straightforward logic. Comments should explain *why* (intent, invariants, trade-offs), not *how*, and are never used as decorations or separators.
- Variable and function names should be clear and descriptive, not cryptic abbreviations. Avoid hidden state and side effects.
- Explicit `use` imports for standard library types (e.g. `use std::collections::BTreeMap;`).
- Prefer `?` propagation when possible, and reserve `.expect()`/`.unwrap()` for cases where failure is a programmer bug.
- For errors, use typed error enums in library crates (derived with `thiserror`), with a per-crate `pub type Result<T>` alias. Add context at the boundary (the shells) rather than deep in the core, and keep library error messages concise.
- We deeply value idiomatic, easy-to-maintain Rust code. Avoid code duplication when possible. Prefer clarity over cleverness, and small focused functions over dark magic.
- Tests should assert observable behaviour, not internal implementation details. Keep tests deterministic and independent of global state.
- The core builds for `wasm32-unknown-unknown`. `board` and `format` do no I/O and read no clock or randomness source: the caller passes them in (e.g. the bits of a new `ElementId`).
- Board files are deterministic. The same board always writes the same bytes, and an edit to one element rewrites one file, so nothing on that path iterates a `HashMap`.

## Getting Started

Planche is a Rust monorepo using [Cargo workspaces](https://doc.rust-lang.org/book/ch14-03-cargo-workspaces.html). The core needs [rustup](https://rustup.rs/), which installs the toolchain and the WASM target pinned in `rust-toolchain.toml`, and [just](https://github.com/casey/just) for the recipes listed in [AGENTS.md](./AGENTS.md). The app also needs [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/), then `just setup`, Python 3 for `just serve`, and on Linux the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows, `just` runs its recipes with the `sh` of [Git for Windows](https://gitforwindows.org/).

The app is one web app in `web/`, in TypeScript without a framework, which runs the core as WASM on every platform: in a browser, and in the desktop shell's webview. Dependencies only point inward: `bindings` → `format` → `board`, and `desktop` → `folder`, which know nothing of boards. The crates live in `crates/`:

### board

The board as plain data: elements (images, notes, shapes, arrows, and groups), their geometry, their stacking, and non-destructive image edits. Element ids are drawn by the caller, and assets are named by the SHA-256 digest of their bytes. Each element stacks among its siblings by a fractional z-index, so restacking one rewrites one file, and a board that Git merged into a group cycle is repaired on read. Edits go through an `Editor`, whose undo history keeps every touched element as it was, in memory only.

### format

The board as a folder of files, keyed by path, and back: a `board.json` manifest holding the format version, one JSON file per element in `elements/`, image bytes in `assets/`, and a `.gitattributes`, written when the board is created, that keeps Git from converting line endings and sends assets to Git LFS. The same files also travel as a single ZIP file, which the core reads and writes without I/O, so that a shell moves it a slice at a time. `samples/demo/` holds a board to try the shells on, and `samples/demo.zip` its ZIP file, which every platform must write byte for byte. Assets never change once named, so the caller writes each one once and checks it against its digest when loading it, which catches a board cloned without Git LFS. It implements the file format decided in the [foundation](./docs/technical/foundation.md): until the first release, it can change freely; from then on, any change to its shape bumps `FORMAT_VERSION`, and earlier versions are migrated on read.

### bindings

The core for the web app, through [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen): an `Editor` holds the board being edited, elements cross as JSON, ids as strings, and files as paths and bytes. Its CLI must match the crate's version in `Cargo.lock`, which `just setup` installs.

### desktop

The desktop shell, on [Tauri 2](https://v2.tauri.app/): a window around the web app, and the file system that a browser lacks, limited to the folders and ZIP files the user picks, and writing only into folders that were empty and to files picked to export to. It asks before closing a window loses changes. It is the Tauri track from the [foundation](./docs/technical/foundation.md), under test in the prototype.

### renderer

The renderer, on wgpu: images as textured quads, on WebGPU or WebGL2, for the web only so far. See the [foundation](./docs/technical/foundation.md#rendering).

### folder

A folder on disk as the desktop shell reads and writes it: paths with `/` between segments, atomic writes, and nothing that leads out of it, neither links nor dot folders such as `.git/`. A single picked file, such as a ZIP file, is read in ranges and written in parts, just as atomically. It needs no Tauri, so its tests run on every platform.
