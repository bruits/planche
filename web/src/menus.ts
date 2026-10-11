// The app's menus of commands: the toolbar's, the zoom's, and the one a right-click or its keys
// open, with the finder's list of every command.

import { BACKGROUNDS, SCHEMES, type Actions } from "./actions.js";
import type { Command } from "./commands.js";
import type { Point } from "./core.js";
import type { Edits } from "./edit.js";
import type { ExportCard } from "./exportcard.js";
import type { Listed } from "./finder.js";
import { openMenu, type Entry, type Item } from "./menu.js";
import type { Measurements } from "./metrics.js";
import type { Platform } from "./platform.js";
import type { Titles } from "./titles.js";
import type { View } from "./view.js";

/** What the zoom's menu zooms to at once. */
const ZOOMS = [0.25, 0.5, 1, 2, 4];
/** How many test photos the measurements offer to add at once, each about 17 MB of textures. */
const TEST_PHOTOS = [10, 50, 100];
/** As their assets would stay in the board's folder or file once undone. */
const NOT_FOR_TEST_PHOTOS = "Only on a board not saved in a folder or a ZIP file";

export interface Host {
  platform: Pick<
    Platform,
    "keepOnTop" | "titleBar" | "agent" | "errorLog" | "updater" | "desktopApp"
  >;
  viewport: Pick<View, "zoom" | "centre" | "client">;
  editing: Pick<Edits, "centre" | "unlock">;
  groupTitles: Pick<Titles, "write">;
  measurements: Pick<Measurements, "shown">;
  pictureCard(): Pick<ExportCard, "isOpen">;
  savesToFiles(): boolean;
  /** Opens the picker of images to add around `at`. */
  addPicked(at: Point | undefined): void;
  addTestPhotos(count: number): Promise<void>;
  report(work: Promise<unknown>): void;
}

export interface Menus {
  toolbar(): Entry[];
  zooms(): Entry[];
  /**
   * About the selection when `onSelection`, or else the board, opened at `place` over the board's
   * point `at`, offering to unlock what is `locked` there, or to rename the group `titled` there.
   */
  context(
    onSelection: boolean,
    at: Point,
    place: { x: number; y: number },
    locked?: string,
    titled?: string,
  ): void;
  /** Over the selection's centre, or the viewport's, as the keys point nowhere. */
  fromKeys(): void;
  listed(): Listed[];
}

export function percent(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

export function menus(
  actions: Pick<
    Actions,
    | "commands"
    | "colours"
    | "stated"
    | "zoomTo"
    | "pasteAt"
    | "noneShown"
    | "fewImages"
    | "compact"
    | "leaveCompact"
  >,
  host: Host,
): Menus {
  const { commands, colours, stated } = actions;
  const { platform, viewport, editing } = host;
  /** The menu each sits in, which the finder names where theirs would not tell alone. */
  const within = new Map<Command, string>(
    (
      [
        ["Align", [commands.alignLeft, commands.alignCentre, commands.alignRight]],
        ["Align", [commands.alignTop, commands.alignMiddle, commands.alignBottom]],
        [
          "Arrange",
          [
            commands.arrangeByName,
            commands.arrangeBySize,
            commands.arrangeByColour,
            commands.arrangeRandomly,
            commands.sameHeight,
            commands.sameWidth,
          ],
        ],
        [
          "Grid",
          [commands.plain, commands.grid, commands.dots, commands.snap, commands.snapNeighbours],
        ],
        ["Theme", [commands.light, commands.dark, commands.system, commands.highContrast]],
        [
          "View",
          [
            commands.greyBoard,
            commands.mirrorBoard,
            commands.annotations,
            commands.hints,
            commands.measurements,
            commands.alwaysOnTop,
            commands.compact,
          ],
        ],
        [
          "Settings",
          [
            commands.hoverPlay,
            commands.keepStyle,
            commands.agentAccess,
            commands.checkUpdates,
            commands.errorLog,
          ],
        ],
        ["Colour", colours],
      ] satisfies [string, Command[]][]
    ).flatMap(([name, members]) => members.map((member): [Command, string] => [member, name])),
  );
  /** What only answers keys, or opens the finder. */
  const unlisted = new Set<Command>([
    commands.escape,
    commands.contextMenu,
    commands.find,
    // The export card's own button, which says its keys.
    commands.savePng,
    ...(platform.desktopApp === undefined ? [commands.desktopApp] : []),
  ]);

  function grids(): Entry {
    return {
      ...commands.nextBackground,
      options: [
        ...BACKGROUNDS.map((background) => stated(commands[background])),
        "separator",
        stated(commands.snap),
        stated(commands.snapNeighbours),
      ],
    };
  }

  function themes(): Entry {
    return submenu("Theme", [
      ...SCHEMES.map((scheme) => stated(commands[scheme])),
      "separator",
      stated(commands.highContrast),
    ]);
  }

  function views(): Entry {
    return submenu(
      "View",
      sectioned([
        [stated(commands.greyBoard), stated(commands.mirrorBoard), stated(commands.annotations)],
        [
          stated(commands.hints),
          stated(commands.measurements),
          ...(platform.keepOnTop ? [stated(commands.alwaysOnTop)] : []),
          ...(platform.titleBar ? [stated(commands.compact)] : []),
        ],
        host.measurements.shown() ? TEST_PHOTOS.map(testPhotosItem) : [],
      ]),
    );
  }

  function settings(): Entry {
    return submenu("Settings", [
      stated(commands.hoverPlay),
      stated(commands.keepStyle),
      ...(platform.agent ? [stated(commands.agentAccess)] : []),
      ...(platform.updater ? [stated(commands.checkUpdates)] : []),
      ...(platform.errorLog ? [commands.errorLog] : []),
    ]);
  }

  function testPhotosItem(count: number): Item {
    return {
      label: `Add ${count} test photos`,
      unavailable: () =>
        actions.noneShown() ?? (host.savesToFiles() ? NOT_FOR_TEST_PHOTOS : undefined),
      run: () => host.report(host.addTestPhotos(count)),
    };
  }

  /**
   * About the selection, or else the board, with its images landing where it opens. Each keeps to
   * three groups, and each submenu to two, so that it stays quick to scan. What the style card and
   * the keys already reach, such as colours, mostly stays out.
   */
  function context(
    onSelection: boolean,
    at: Point,
    place: { x: number; y: number },
    locked?: string,
    titled?: string,
  ): void {
    const paste = { ...commands.paste, run: () => actions.pasteAt(at) };
    // The title right-clicked, which may be a group's within the one selected.
    const rename =
      titled === undefined
        ? commands.rename
        : { label: "Rename", run: () => host.groupTitles.write(titled) };
    // What the right-click landed on, though the selection's box may hold it.
    const unlock =
      locked === undefined ? [] : [{ label: "Unlock", run: () => editing.unlock([locked]) }];
    const entries: Entry[] = onSelection
      ? [
          commands.cut,
          commands.copy,
          commands.copyPng,
          paste,
          commands.duplicate,
          {
            ...commands.exportPng,
            label: () => (host.pictureCard().isOpen() ? "Hide export" : "Export as PNG…"),
          },
          commands.remove,
          "separator",
          commands.write,
          rename,
          commands.openSource,
          relevantSubmenu("Playback", [
            commands.play,
            commands.sound,
            "separator",
            commands.previousFrame,
            commands.nextFrame,
            commands.slower,
            commands.faster,
          ]),
          {
            ...submenu(
              "Style",
              sectioned([
                [commands.style, commands.copyStyle, commands.pasteStyle],
                relevant([
                  commands.crop,
                  commands.resetCrop,
                  stated(commands.ellipticalCrop),
                  stated(commands.greyscale),
                  stated(commands.bold),
                  stated(commands.italic),
                ]),
              ]),
            ),
            unavailable: commands.style.unavailable,
          },
          relevantSubmenu("Transform", [
            commands.rotateLeft,
            commands.rotateRight,
            commands.straighten,
            commands.actualSize,
            "separator",
            commands.flipHorizontally,
            commands.flipVertically,
          ]),
          "separator",
          commands.group,
          commands.ungroup,
          commands.goInside,
          commands.lock,
          ...unlock,
          relevantSubmenu("Select", [
            { ...commands.selectAll, label: "All" },
            { ...commands.invertSelection, label: "Invert" },
            { ...commands.selectSameType, label: "Same type" },
          ]),
          relevantSubmenu("Order", [
            commands.front,
            commands.forward,
            commands.backward,
            commands.back,
          ]),
          // By the axis they move along.
          relevantSubmenu("Align", [
            commands.alignLeft,
            commands.alignCentre,
            commands.alignRight,
            commands.distributeHorizontally,
            "separator",
            commands.alignTop,
            commands.alignMiddle,
            commands.alignBottom,
            commands.distributeVertically,
          ]),
          {
            ...submenu("Arrange", [
              commands.arrangeByName,
              commands.arrangeBySize,
              commands.arrangeByColour,
              commands.arrangeRandomly,
              "separator",
              commands.sameHeight,
              commands.sameWidth,
            ]),
            unavailable: actions.fewImages,
          },
        ]
      : [
          { ...commands.addImages, run: () => host.addPicked(at) },
          paste,
          commands.selectAll,
          // Which the lock command does too, as nothing is selected then.
          ...unlock.map((entry) => ({ ...entry, keys: commands.lock.keys })),
          "separator",
          commands.fit,
          grids(),
        ];
    const shown = onSelection ? relevant(entries) : entries;
    // First, as the menu may not fit a small window.
    if (actions.compact()) {
      shown.unshift(actions.leaveCompact, "separator");
    }
    openMenu(shown, { label: onSelection ? "Selection" : "Board", place });
  }

  return {
    toolbar: () => [
      commands.find,
      ...(platform.desktopApp ? [commands.desktopApp] : []),
      commands.reportBug,
      "separator",
      commands.newBoard,
      commands.open,
      commands.openZip,
      commands.save,
      commands.saveAs,
      commands.exportZip,
      "separator",
      grids(),
      themes(),
      views(),
      settings(),
    ],
    zooms() {
      const now = viewport.zoom();
      return [
        commands.zoomIn,
        commands.zoomOut,
        commands.fit,
        commands.fitSelection,
        "separator",
        ...ZOOMS.map((zoom) => ({
          ...actions.zoomTo(percent(zoom), zoom, zoom === 1 ? commands.zoomActual.keys : undefined),
          checked: now !== undefined && percent(now) === percent(zoom),
        })),
      ];
    },
    context,
    fromKeys() {
      const selection = editing.centre();
      const at = selection ?? viewport.centre();
      const place = at && viewport.client(at);
      if (at && place) {
        context(selection !== undefined, at, { x: place.clientX, y: place.clientY });
      }
    },
    listed: () =>
      Object.values(commands)
        .filter((command) => !unlisted.has(command))
        .map((command) => ({ ...stated(command), within: within.get(command) })),
  };
}

/** One that only opens its options, so never runs. */
function submenu(label: string, options: Entry[]): Item {
  return { label, run() {}, options };
}

/** Of the options that apply to the selection, and left out of it when none does. */
function relevantSubmenu(label: string, options: Entry[]): Item {
  const shown = relevant(options);
  return {
    ...submenu(label, shown),
    unavailable: () => (shown.length > 0 ? undefined : "None applies"),
  };
}

function sectioned(sections: Entry[][]): Entry[] {
  return sections
    .filter((section) => section.length > 0)
    .flatMap((section, at) => (at > 0 ? ["separator", ...section] : section));
}

/**
 * Leaves out what does not apply to the selection, and the separators that would stand alone. Every
 * reason the entries give must be about what is selected, as one that passes would hide them for a
 * while.
 */
function relevant(entries: Entry[]): Entry[] {
  const kept: Entry[] = [];
  let parted = false;
  for (const entry of entries) {
    if (entry === "separator") {
      parted = kept.length > 0;
    } else if (entry.unavailable?.() === undefined) {
      if (parted) {
        kept.push("separator");
      }
      kept.push(entry);
      parted = false;
    }
  }
  return kept;
}
