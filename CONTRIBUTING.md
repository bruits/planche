# Contributing Guidelines

## Philosophy

Planche is a fast, open-source board to gather reference images. You drop in pictures from anywhere, lay them out on a canvas, and annotate them with notes, arrows, shapes, drawings, and comments. A board is a folder of plain files that belongs to its user. It moves between machines without loss, diffs well in Git, and needs no account.

The app stays small on purpose. Its core covers what a reference board needs, simple non-destructive image edits included, and plugins will take anything beyond. An optional paid cloud may add live collaboration and sync one day, but the app works fully without it.

Three priorities guide the trade-offs.

- Performance. A board of hundreds of large photos opens quickly and stays smooth to pan and zoom on ordinary hardware.
- Agents. They read and edit a board through the app as people do, and work on its plain files like any other file in a repository.
- Every platform. The browser, Windows, macOS, and Linux first, then iOS and Android, all on the same Rust core.

## Quality Guidelines

- Write self-documenting code, with clear names and straightforward logic, and no cryptic abbreviations, hidden state, or hidden side effects. Comments explain why, such as intent, invariants, and trade-offs, and never serve as decoration or separators.
- Write idiomatic, maintainable Rust and TypeScript. Avoid duplication, and prefer small, clear functions to clever ones.
- Import standard library types explicitly, such as `use std::collections::BTreeMap;`.
- Propagate errors with `?`, and keep `.expect()` and `.unwrap()` for failures that would be a programmer bug.
- Library crates use typed error enums derived with `thiserror`, with a per-crate `pub type Result<T>` alias. Keep the core's error messages concise, and add context in the shells.
- Keep the web app's TypeScript `strict`-clean. Honour null checks without casting them away with `!` or `as`, and never use `any`. Return `undefined` for something absent and read it with `?.` and `??`. Keep `!` for what would be a programmer bug, and throw an `Error` with a message a user or an agent can read for a failure.
- Every promise is awaited, returned, or marked `void` with its failure reported, such as through `report` in `main.ts`, so that the failure reaches the user.
- Import types with `import type`, and the core as a namespace with `import * as core`, so its calls read as the core's. `just fmt` and `just lint` settle style, with oxfmt and oxlint for the web app.
- Tests assert observable behaviour, stay deterministic, and depend on no global state.
- Web tests sit next to their module, such as `save.test.ts`, and run with Vitest in Node, or in happy-dom when they need the DOM. They drive the real core, which they never mock, and fake only what surrounds the unit, such as the browser, the shell, timers, and the collaborators it is handed. New web behaviour ships with tests, and touched behaviour gains them.
- Web modules do no work on the page when imported, such as a DOM lookup, a page listener, or a top-level `await`, so tests can import them. Only `main.ts`, which wires them together, and `platform.ts` and `browser.ts`, which set up the shell, do. A test that reaches them runs in happy-dom.
- The core builds for `wasm32-unknown-unknown` and does no I/O, see [architecture](./docs/development/architecture.md).
- Board files are deterministic, so nothing on their path iterates a `HashMap`, see [format](./docs/development/format.md).

## Getting Started

Planche is a Rust monorepo using [Cargo workspaces](https://doc.rust-lang.org/book/ch14-03-cargo-workspaces.html). The core needs [rustup](https://rustup.rs/), which installs the toolchain and WASM target pinned in `rust-toolchain.toml`, and [just](https://github.com/casey/just) for the recipes in [AGENTS.md](./AGENTS.md). The web app also needs [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/). Run `just setup` once, which installs the web app's tools and the wasm-bindgen CLI at the version `Cargo.lock` pins. `just serve` needs Python 3, and the desktop app on Linux needs the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows, `just` runs its recipes with the `sh` of [Git for Windows](https://gitforwindows.org/).

| Path | What it holds |
| --- | --- |
| `crates/board` | The board as plain data, its edits and locks, and what each element draws |
| `crates/format` | The board as a folder of files or a ZIP file, and how a save writes it |
| `crates/bindings` | The core for the web app, through [wasm-bindgen](https://github.com/wasm-bindgen/wasm-bindgen) |
| `crates/renderer` | The renderer, on wgpu |
| `crates/desktop` | The desktop shell, on [Tauri 2](https://v2.tauri.app/), with the file system a browser lacks |
| `crates/folder` | A folder on disk as the desktop shell reads and writes it |
| `crates/mcp` | Agent access to the board open in the desktop app, whose locks refuse agents' edits as they refuse the user's |
| `web/` | The app, in TypeScript, for browsers and the desktop webview |
| `samples/` | Boards to try the app on |
| `docs/development/` | What is decided, and how the parts work |
| `docs/usage/` | How Planche behaves, for users and support |

Each crate's `lib.rs`, or `main.rs`, and each web module opens with a comment on what it holds. Dependencies point inward. `bindings` depends on `format`, which depends on `board`. `desktop` depends on `folder`, `mcp`, and `format`, which tells it which of a board's files the page may write. `folder`, `mcp`, and `renderer` know nothing of boards.
