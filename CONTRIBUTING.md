# Contributing Guidelines

## Philosophy

Planche is a fast, open-source board to gather reference images. You drop in pictures from anywhere, lay them out on a canvas, and annotate them with notes, arrows, shapes, drawings, and comments. A board is a folder of plain files that belongs to its user. It moves between machines without loss, diffs well in Git, and needs no account.

The app stays small on purpose. Its core covers what a reference board needs, simple non-destructive image edits included, and plugins will take anything beyond. An optional paid cloud may add live collaboration and sync one day, but the app works fully without it.

Three priorities guide the trade-offs.

- Performance. A board of hundreds of large photos opens quickly and stays smooth to pan and zoom on ordinary hardware.
- Agents. They read and edit a board through the app as people do, and work on its plain files like any other file in a repository.
- Every platform. The browser, Windows, macOS, and Linux first, then iOS and Android, all on the same Rust core.

## Before Opening Issues

- Report a security vulnerability privately, as the [security policy](./SECURITY.md) explains.

## Quality Guidelines

- Write self-documenting, idiomatic code, with clear names, plain logic, small functions, and no hidden state or side effects. Avoid duplication. Comments say why (intent, invariants, trade-offs), and never decorate or separate. `just fmt` and `just lint` settle style.
- In Rust, import standard library types explicitly (e.g. `use std::collections::BTreeMap;`), propagate errors with `?`, and keep `.expect()` and `.unwrap()` for programmer bugs. Library crates have a `thiserror` error enum and a `pub type Result<T>` alias, with concise messages in the core and context added by the shells.
- In TypeScript, stay `strict`-clean with no `any`. Never cast a null check away with `as`, and keep `!` for a programmer bug. An absent value is `undefined`, read with `?.` and `??`, and a failure throws an `Error` whose message a user or an agent can read.
- Every promise is awaited, returned, or marked `void` with its failure reported (e.g. through `report` in `main.ts`), so the user sees it. Import types with `import type`, and the core with `import * as core` so its calls read as the core's.
- Web modules do no work on the page when imported (e.g. a DOM lookup, a page listener, a top-level `await`), so tests can import them. Only `main.ts`, which wires them, and `platform.ts` and `browser.ts`, which set up the shell, do.
- Tests assert observable behaviour, stay deterministic, and share no global state. Web tests sit beside their module (e.g. `save.test.ts`) and run with Vitest in Node, or in happy-dom for the DOM. They drive the real core and fake only what surrounds the unit (e.g. the browser, the shell, timers, the collaborators it is handed). New web behaviour ships with tests, and touched behaviour gains them.
- The core builds for `wasm32-unknown-unknown` with no I/O, and board files are deterministic, so nothing on their path iterates a `HashMap`. See [architecture](./docs/development/architecture.md) and [format](./docs/development/format.md).

## Writing Changesets

[Sampo](https://github.com/bruits/sampo) versions the app and writes its changelog from changesets. A change users meet ships with one, for `desktop`, the package that carries the app's version. Install Sampo with `cargo install sampo`, then run `sampo add -p desktop -b minor -m "Added …"`. A changeset for another crate is never released. A new crate joins `packages.ignore` in `.sampo/config.toml`, or the Release workflow fails trying to publish it.

While Planche is 0.x, a feature or a breaking change is a `minor` bump, and a fix a `patch`.

A description starts with `Added`, `Removed`, `Fixed`, `Changed`, `Deprecated`, or `Improved`, and says in one or two sentences what changed for users, without the implementation. A breaking change opens with `**⚠️ breaking change:**`.

Changesets wait in `.sampo/changesets/`. Sampo gathers them into a release PR, and merging it tags the version, publishes its GitHub release with the desktop app's installers for macOS, Windows, and Linux, and deploys the web app. CI on that PR waits for approval, so approve its run before merging. Running the Release workflow by hand with `deploy` ticked deploys the newest release again, and with `bundle` ticked attaches its installers again, without the commits on `main` since.

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
