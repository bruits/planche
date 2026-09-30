# Agents Guide

Planche (working title) is a free and open-source alternative to PureRef, with a Rust core shared by every platform 📌

## Useful Commands

```sh
just fmt                               # format
just lint                              # lint, exactly as CI does
just test                              # test, exactly as CI does
just test lfs                          # only the tests whose name holds lfs
just wasm                              # build the core for the browser, exactly as CI does
just setup                             # install the web app's tools, once
just web                               # build the web app, exactly as CI does
just serve                             # serve the web app on http://localhost:8080
just desktop                           # run the desktop app
just ci                                # everything CI checks, in CI order
```

## Useful Resources

- In [CONTRIBUTING.md](./CONTRIBUTING.md): [Quality Guidelines](./CONTRIBUTING.md#quality-guidelines) applies to agents and humans equally, [Getting Started](./CONTRIBUTING.md#getting-started) helps you understand the project structure, and [Philosophy](./CONTRIBUTING.md#philosophy) is the project's north star.
- [docs/technical/foundation.md](./docs/technical/foundation.md) says what is decided, the renderer and the image pipeline included, and which tracks are still open. Read it before adding a crate or a dependency.

## Agent Guardrails

- **The core runs everywhere.** `board` and `format` build for `wasm32-unknown-unknown`: no I/O, no clock, no randomness source, and no platform crate. The shells pass those in. Check with `just wasm`, not only a native build.
- **Board files are a contract.** A board reads back exactly as written, the same board always writes the same bytes, and an edit rewrites only the files it touches. From the first release on, any change to their shape bumps `FORMAT_VERSION`, `read` migrates every earlier version, and a sample board per version stays as a test fixture.
- **Tracks are not decisions yet.** The prototype is where the foundation's open tracks (Tauri, Loro, and so on) are tried, so building on one is fine there, as long as the core never depends on it and it can be dropped if it loses. A track becomes a decision only once the prototype has measured it and the [foundation](./docs/technical/foundation.md) records it as a rule.
- Do not create new documentation files to explain implementation.
- Do not alter CI/CD configuration unless explicitly instructed.
- Do not add external dependencies without justification. Prefer the standard library and existing utilities.
- Match the current project structure, naming, and style; do not create parallel patterns and avoid duplication.
- All code, comments, documentation, commit messages, and user-facing output must be in English.
