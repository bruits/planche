# Agents Guide

Planche (working title) is a fast, open-source board to gather reference images, with a Rust core shared by every platform 📌

## Useful Commands

```sh
just fmt                               # format
just lint                              # lint, exactly as CI does
just test                              # test, exactly as CI does
just test lfs                          # only the tests whose name holds lfs
just wasm                              # build the core for the browser, exactly as CI does
just setup                             # install the web app's tools, once
just web                               # build the web app, exactly as CI does
just bench                             # time a release build of the core compiled to WASM, by hand and never in CI
just bench debug                       # the same, on a dev build of the core
just serve                             # serve the web app on http://localhost:8080
just desktop                           # run the desktop app
just ci                                # everything CI checks, in CI order
```

## Useful Resources

- In [CONTRIBUTING.md](./CONTRIBUTING.md): [Quality Guidelines](./CONTRIBUTING.md#quality-guidelines) applies to agents and humans equally, [Getting Started](./CONTRIBUTING.md#getting-started) helps you understand the project structure, and [Philosophy](./CONTRIBUTING.md#philosophy) is the project's north star.
- [docs/development/](./docs/development/) says what is decided and how the parts work. Read [architecture](./docs/development/architecture.md) before adding a crate or a dependency, [format](./docs/development/format.md) and [saving](./docs/development/saving.md) before changing what writes a board's files, and [interface](./docs/development/interface.md) before changing what users see or read.
- [docs/usage/](./docs/usage/) says how Planche behaves for users and support. Update it when a change alters what users meet.

## Agent Guardrails

- The core runs everywhere. `board` and `format` build for `wasm32-unknown-unknown` with no I/O, clock, randomness source, or platform crate, which the shells pass in. Check with `just wasm` too.
- Board files are a contract. A board reads back exactly as written, the same board writes the same bytes, and an edit rewrites only the files it touches. [Format](./docs/development/format.md) says when a change to their shape needs a new version.
- Tracks are not decisions yet. Building on an open [track](./docs/development/architecture.md#tracks), such as Loro, is fine in the prototype, as long as the core never depends on it and it can be dropped. A track becomes a decision once the prototype measured it and the docs record it as a rule.
- Match the project's structure, naming, and style, with no parallel pattern or duplication. Add a dependency only with a reason, after the standard library and existing utilities.
- Add no documentation file to explain implementation, and change CI/CD only when asked.
- Code, comments, docs, commit messages, and user-facing output are in English.
- A change users meet ships with a Sampo changeset, see [CONTRIBUTING.md](./CONTRIBUTING.md#writing-changesets).
