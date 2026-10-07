# Agents

The desktop app lets AI agents read and edit the open board over [MCP](https://modelcontextprotocol.io/). Agent access is off until you turn it on in Settings, and then stays as you left it from one launch to the next. It stays on this machine, and Planche sends nothing anywhere.

## Connecting a client

The agent's client starts Planche's executable with the argument `mcp`, which connects it to the Planche that is running. In the macOS app, the executable is `Planche.app/Contents/MacOS/Planche`, and in a build of this repository, `target/debug/desktop`. Most clients take a server like this:

```json
{
  "mcpServers": {
    "planche": { "command": "/path/to/desktop", "args": ["mcp"] }
  }
}
```

Only one running Planche can let agents in, and it takes eight connections at most.

## What agents can do

Agents read the board, its elements, and the selection, and see images, the window's view, or any part of the board drawn at the size they ask. They add images from files or from their bytes, add and edit every kind of element, group, align, restack, lock, and remove them, and select elements to point you to them. A locked element refuses agents' edits as it refuses yours, and Planche tells agents to unlock only what you ask them to. The client lists the tools with what each takes.

Each edit waits up to 10 seconds for you to finish a drag, a text, or a crop. It then undoes in one step and saves like your own edits. Agents have no tool to save, open, or close a board.

An agent adds at most 12 images at a time, 25 MB each and 50 MB in all.

## Risks

- Text and pictures on a board can carry instructions aimed at the agent. Planche tells agents to treat them as data, but an agent may still follow them.
- An agent's edits save at once, so take one back with Undo, or with Git when the board lives in a repository.
- An agent can add, and so see, any image file you can read, even when its client runs sandboxed.

## Errors

| Message | What to do |
| --- | --- |
| Planche is not running, or its agent access is off | Start Planche and turn on Agent access in Settings |
| Agent access stays off, as another Planche has it on already | Turn agent access off in the other Planche, or quit it |
| Planche closed the connection before it answered | Close another agent's session and try again |
| Planche does not answer on port … | Planche stopped unexpectedly, so open it again |
