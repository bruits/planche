// The app around its commands, faked over a real board, for tests of what the commands offer and
// when they cannot run.

import { vi } from "vitest";
import { boardOf } from "./boards.js";
import { messages } from "./messages.js";
import { actions, type Host } from "../src/actions.js";
import type { Card } from "../src/card.js";
import type { Kind } from "../src/core.js";
import type { Edits } from "../src/edit.js";

type Given = Partial<Host> & {
  selected?: string[];
  edits?: Partial<Edits>;
  styled?: Partial<Card>;
};

/**
 * The commands over a board holding `elements`, shown at 100%, in a browser that has no window of
 * its own and lets no agent in. What `given` holds replaces the app's own.
 */
export function around(
  elements: [string, Kind][] = [],
  { selected = [], edits = {}, styled = {}, ...given }: Given = {},
) {
  const opened = boardOf(elements);
  let selection = selected;
  let showing = true;
  const told = messages();
  const editing = {
    selection: () => selection,
    lockedUnder: () => undefined,
    croppedAs: () => undefined,
    cropping: () => undefined,
    writable: () => false,
    writing: () => undefined,
    entered: () => undefined,
    grab: () => undefined,
    loneSegment: () => false,
    idle: async () => {},
    arrange: vi.fn<Edits["arrange"]>(),
    crop: vi.fn<Edits["crop"]>(),
    ...edits,
  } as unknown as Edits;
  const styleCard = {
    common: () => [],
    highlighting: () => false,
    value: () => undefined,
    isOpen: () => false,
    images: () => false,
    canPaste: () => false,
    trimming: () => false,
    keepOpen: vi.fn<Card["keepOpen"]>(),
    ...styled,
  } as unknown as ReturnType<Host["styleCard"]>;
  let tool: ReturnType<Host["tool"]> = "select";
  let snapping = false;
  let annotationsShown = true;
  const host: Host = {
    platform: { openAddress: vi.fn<Host["platform"]["openAddress"]>(async () => {}) },
    opened: () => opened,
    hold: () => ({ board: opened, shows: () => showing }),
    crossedOut: () => new Set(),
    editing,
    viewport: {
      zoom: () => 1,
      zoomBy: () => {},
      look: () => {},
      size: () => ({ width: 800, height: 600 }),
      centre: () => ({ x: 0, y: 0 }),
      mirrored: () => false,
      mirror: () => {},
      greyed: () => false,
      grey: () => {},
    },
    life: {
      loading: () => false,
      newBoard: async () => {},
      openFolder: async () => {},
      openZip: async () => {},
      save: async () => {},
      saveAs: async () => {},
      savesToFiles: () => false,
    },
    media: {
      holds: () => false,
      playing: () => false,
      steps: () => false,
      play: () => {},
      step: () => {},
    },
    films: { holds: () => false, sounding: () => false, sound: () => {}, playOnHover: () => {} },
    appearance: {
      scheme: () => "system",
      highContrast: () => false,
      choose: () => {},
      toggleContrast: () => {},
    },
    groupTitles: { write: () => {} },
    measurements: { shown: () => false, toggle: () => {} },
    agents: { allowed: () => false, allow: async () => {} },
    exports: {
      busy: () => false,
      zip: async () => {},
      png: async () => {},
      copyPng: () => {},
    },
    greeting: { quietsHint: () => false },
    styleCard: () => styleCard,
    pictureCard: () => ({
      isOpen: () => false,
      open: () => {},
      close: () => {},
      options: () => ({ longest: undefined, background: "board", margin: false }),
    }),
    picker: () => ({ sampling: () => undefined, end: () => {} }),
    clip: () => ({ copy: () => {}, paste: async () => {} }),
    tool: () => tool,
    useTool: (next) => void (tool = next),
    spaceHeld: () => false,
    penStyling: () => undefined,
    showsAnnotations: () => annotationsShown,
    showAnnotations: (shown) => void (annotationsShown = shown),
    snapping: () => snapping,
    snap: (on) => void (snapping = on),
    fitTo: () => {},
    addPicked: () => {},
    duplicate: () => {},
    contextMenuFromKeys: () => {},
    listed: () => [],
    openBugReport: async () => {},
    refreshBar: () => {},
    say: told.say,
    report: told.report,
    ...given,
  };
  return {
    app: actions(host),
    host,
    opened,
    editing,
    said: told.said,
    settled: told.settled,
    select: (ids: string[]) => void (selection = ids),
    /** Shows another board in place of this one, as work begun on it still runs. */
    leave: () => void (showing = false),
  };
}
