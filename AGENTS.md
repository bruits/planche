# Agents Guide

Planche (working title) is a free and open-source alternative to PureRef, with a Rust core shared by every platform 📌

## Useful Commands

```sh
just fmt                               # format
just lint                              # lint, exactly as CI does
just test                              # test, exactly as CI does
just test lfs                          # only the tests whose name holds lfs
just wasm                              # build the core for the browser, exactly as CI does
just ci                                # all four, in CI order
```

## Useful Resources

- In [CONTRIBUTING.md](./CONTRIBUTING.md): [Quality Guidelines](./CONTRIBUTING.md#quality-guidelines) applies to agents and humans equally, [Getting Started](./CONTRIBUTING.md#getting-started) helps you understand the project structure, and [Philosophy](./CONTRIBUTING.md#philosophy) is the project's north star.
- [docs/technical/foundation.md](./docs/technical/foundation.md) lists the technical tracks, with their limits and alternatives. Read it before adding a crate or a dependency.

## Agent Guardrails

- **The core runs everywhere.** `board` and `format` build for `wasm32-unknown-unknown`: no I/O, no clock, no randomness source, and no platform crate. The shells pass those in. Check with `just wasm`, not only a native build.
- **Board files are a contract.** A board reads back exactly as written, the same board always writes the same bytes, and an edit rewrites only the files it touches. From the first release on, any change to their shape bumps `FORMAT_VERSION`, `read` migrates every earlier version, and a sample board per version stays as a test fixture.
- **Tracks are not decisions.** Do not build on a track from the foundation (Tauri, wgpu, Vello, Loro, and so on) until the prototype has settled it. `format` is the one exception, so that the core has something to test, and its layout may still change.
- Do not create new documentation files to explain implementation.
- Do not alter CI/CD configuration unless explicitly instructed.
- Do not add external dependencies without justification. Prefer the standard library and existing utilities.
- Match the current project structure, naming, and style; do not create parallel patterns and avoid duplication.
- All code, comments, documentation, commit messages, and user-facing output must be in English.
