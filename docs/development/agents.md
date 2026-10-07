# Agents

`crates/mcp` lets agents read and edit the board open in the desktop app, over MCP with rmcp. What users see of it is in [agents](../usage/agents.md).

## Connection

An agent's client spawns the app's own binary as `desktop mcp`, a gateway that passes bytes between its standard streams and the running app. The app listens on a loopback port. Both sides prove themselves before any byte passes, the gateway with a token, which keeps a page in a browser from using the port, and the app with an answer. They find each other, the port, and both secrets in `agent.json` in the app's data folder, which only the user can read and which exists only while agent access is on. One app at a time can turn access on, and it takes eight connections.

The app answers each tool call by asking the web app, which holds the board. `crates/mcp` needs no Tauri, so its tests run on every platform.

## Edits

Each edit waits up to 10 seconds for the user to finish a drag, a text, or a crop, as it would otherwise join the gesture. It then lands as one edit, which undoes in one step and saves like the user's. `web/src/arguments.ts` declares the edit tools' arguments for the web app. A test in `crates/mcp` fails when the file falls behind, and `PLANCHE_DECLARE=1 cargo test -p mcp` writes it again. `web/src/arguments.test.ts` checks its words against the board's, which `crates/mcp` does not depend on.

## Risks

- Text and pictures on a board can carry a prompt injection, and so can the names of the files it left out and the reasons, which quote their keys. The server's instructions call them data, and an agent that follows them anyway may edit a board that saves itself, so only undo or Git takes an edit back.
- The app reads the image files an agent adds by path, so an agent can add, and so see, any image file the user can read, even from a sandboxed client.
