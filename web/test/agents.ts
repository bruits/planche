// What agents read of the page, and the calls the desktop shell passes on from them.

import type { Reading } from "../src/agent.js";
import type { Writing } from "../src/author.js";
import type { Opened } from "../src/board.js";
import type { AgentCall } from "../src/platform.js";
import { unfakedBy } from "./fakes.js";

const unread = unfakedBy("Page");

/** As far off as the shell's deadline usually is. */
export function later(): number {
  return Date.now() + 60_000;
}

export function call(tool: string, args: unknown = {}, deadline = later()): AgentCall {
  return { id: 1, tool, args, deadline };
}

export function pageOf(
  opened: () => Opened | undefined,
  given: Partial<Reading & Writing> = {},
): Reading & Writing {
  return {
    opened,
    unsaved: () => false,
    selection: () => [],
    entered: () => undefined,
    writing: () => undefined,
    shown: () => undefined,
    halfDrawn: () => false,
    stopped: () => false,
    crossedOut: () => undefined,
    drawNow: unread("drawNow"),
    render: unread("render"),
    background: unread("background"),
    loading: unread("loading"),
    busy: unread("busy"),
    idle: unread("idle"),
    apply: unread("apply"),
    keep: unread("keep"),
    zoom: unread("zoom"),
    centre: unread("centre"),
    select: unread("select"),
    frame: unread("frame"),
    ...given,
  };
}
