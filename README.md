# Planche

A free and open-source alternative to [PureRef](https://www.pureref.com/), for collecting reference images on a board 📌

> [!IMPORTANT]
> Planche is a working title. Nothing is released yet, and the tech stack awaits a prototype, see the [technical foundation](./docs/technical/foundation.md).

## Scope

- A minimal canvas, between PureRef and Excalidraw: images, groups, notes, arrows, and shapes, with simple image edits (crop, rotation, flip, and greyscale).
- An embedded MCP server, so that agents can read and edit a board.
- A plugin API for anything else.
- Boards are plain files: they move between machines without loss, and diff well in Git.
- An optional, paid cloud for live collaboration and sync. The app works fully without it.
- Browser, Windows, macOS, and Linux first; iOS and Android later.

## Project Structure

- `crates/board/` — the board as plain data: elements, groups, and image edits
- `crates/format/` — the board as a folder of files, and back
- `docs/technical/` — technical design, starting with the [foundation](./docs/technical/foundation.md)
- [CONTRIBUTING.md](./CONTRIBUTING.md) — contributing guidelines and project philosophy
