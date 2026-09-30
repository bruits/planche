// The prototype's shell.

import * as core from "./core.js";
import type { Board, Files } from "./core.js";
import { fit, type Camera } from "./bench/camera.js";
import { run, type Options, type Result, type Stats } from "./bench/run.js";
import { fromBoard, stress, type Scene } from "./bench/scene.js";
import { heapInUse, megabytes, milliseconds, timed, watchFrameRate } from "./metrics.js";
import { platform, type Folder } from "./platform.js";
import { candidates, type Candidate, type Renderer } from "./render/renderer.js";

type Row = Result | { candidate: string; scene: string; error: string };

const openButton = byId<HTMLButtonElement>("open");
const saveButton = byId<HTMLButtonElement>("save-as");
const form = byId<HTMLFormElement>("bench");
const status = byId("status");
const viewport = byId("viewport");
const timings = new Map<string, string>();
const rows: Row[] = [];

let opened: { folder: Folder; paths: string[]; board: Board; scene?: Scene } | undefined;
let shown: { renderer: Renderer; camera: Camera } | undefined;

await core.start();
byId("platform").textContent = platform.name;
saveButton.title = platform.cannotSave ?? "";
const choices = byId<HTMLSelectElement>("candidate");
for (const { name, unavailable } of candidates) {
  const option = new Option(unavailable ? `${name}: ${unavailable}` : name, name);
  option.disabled = unavailable !== undefined;
  choices.append(option);
}
openButton.addEventListener("click", () => report(open()));
saveButton.addEventListener("click", () => report(saveAs()));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const picked = candidates.find(({ name }) => name === choices.value)!;
  report(race([picked]));
});
byId("run-all").addEventListener("click", () => report(race(candidates.filter((c) => !c.unavailable))));
byId("copy").addEventListener("click", () => report(navigator.clipboard.writeText(markdown())));
listenToCamera();
watchFrameRate(showMetrics);

async function open(): Promise<void> {
  const folder = await platform.open();
  if (folder === null) {
    return;
  }
  const [paths, listing] = await timed(() => folder.list(core.fileDepth()));
  const [files, reading] = await timed(async () => {
    const files: Files = new Map();
    for (const path of paths.filter(core.isBoardFile)) {
      files.set(path, await folder.read(path));
    }
    return files;
  });
  const [board, parsing] = await timed(() => core.read(files));
  opened = { folder, paths, board };
  saveButton.disabled = platform.cannotSave !== undefined;
  timings.clear();
  timings.set(`list ${paths.length} files`, milliseconds(listing));
  timings.set(`read ${files.size} files`, milliseconds(reading));
  timings.set("parse", milliseconds(parsing));
  status.textContent = `${folder.name}: ${board.draw_order.length} elements`;
}

async function saveAs(): Promise<void> {
  if (opened === undefined) {
    return;
  }
  const { folder, paths, board } = opened;
  const target = await platform.pickTarget();
  if (target === null) {
    return;
  }
  const [count, writing] = await timed(async () => {
    // Assets first, so that no element ever points at a missing one.
    for (const path of paths.filter(core.isAssetFile)) {
      await target.write(path, await folder.read(path));
    }
    const files = [...core.newFiles(), ...core.write(board)];
    for (const [path, bytes] of files) {
      await target.write(path, bytes);
    }
    return files.length;
  });
  timings.set(`save ${count} files and the assets`, milliseconds(writing));
  status.textContent = `Saved as ${target.name}`;
}

async function race(picked: Candidate[]): Promise<void> {
  if (form.inert) {
    return;
  }
  const settings = new FormData(form);
  const options: Options = {
    mode: settings.get("mode") === "stepped" ? "stepped" : "paced",
    cap: Number(settings.get("cap")),
  };
  form.inert = true;
  try {
    status.textContent = "Preparing the images…";
    const scene = await pickScene(String(settings.get("scene")));
    for (const candidate of picked) {
      status.textContent = `Running ${candidate.name} on ${scene.name}…`;
      try {
        const previous = shown;
        shown = undefined;
        previous?.renderer.destroy();
        viewport.replaceChildren();
        const { result, renderer } = await run(candidate, scene, viewport, options);
        rows.push(result);
        shown = { renderer, camera: fit(scene.bounds, size()) };
        // The viewport may have changed during the run.
        renderer.resize(size().width, size().height);
        renderer.draw(shown.camera);
      } catch (error) {
        rows.push({ candidate: candidate.name, scene: scene.name, error: message(error) });
      }
      showResults();
    }
    status.textContent = "Done. Scroll to zoom, drag to pan.";
  } finally {
    form.inert = false;
  }
}

async function pickScene(choice: string): Promise<Scene> {
  if (choice !== "board") {
    return stress(Number(choice));
  }
  if (opened === undefined) {
    throw new Error("Open a board first");
  }
  opened.scene ??= await fromBoard(opened.folder.name, opened.folder, opened.board);
  return opened.scene;
}

function listenToCamera(): void {
  let pending = false;
  const redraw = () => {
    if (!pending) {
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (shown) {
          shown.renderer.draw(shown.camera);
        }
      });
    }
  };
  viewport.addEventListener(
    "wheel",
    (event) => {
      if (!shown) {
        return;
      }
      event.preventDefault();
      const { x, y, zoom } = shown.camera;
      const box = viewport.getBoundingClientRect();
      const [pointerX, pointerY] = [event.clientX - box.left, event.clientY - box.top];
      const zoomed = zoom * Math.exp(-event.deltaY * 0.002);
      shown.camera = {
        x: x + pointerX / zoom - pointerX / zoomed,
        y: y + pointerY / zoom - pointerY / zoomed,
        zoom: zoomed,
      };
      redraw();
    },
    { passive: false },
  );
  viewport.addEventListener("pointerdown", (event) => viewport.setPointerCapture(event.pointerId));
  viewport.addEventListener("pointermove", (event) => {
    if (shown && viewport.hasPointerCapture(event.pointerId)) {
      const { x, y, zoom } = shown.camera;
      shown.camera = { x: x - event.movementX / zoom, y: y - event.movementY / zoom, zoom };
      redraw();
    }
  });
  const resize = () => {
    if (shown) {
      shown.renderer.resize(viewport.clientWidth, viewport.clientHeight);
      redraw();
    }
  };
  new ResizeObserver(resize).observe(viewport);
  // Moving to a display of another density resizes nothing in CSS pixels.
  const watchDensity = () => {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
      "change",
      () => {
        resize();
        watchDensity();
      },
      { once: true },
    );
  };
  watchDensity();
}

function showResults(): void {
  const body = byId<HTMLTableSectionElement>("results");
  body.replaceChildren(
    ...rows.map((row) => {
      const cells =
        "error" in row
          ? [row.candidate, row.scene, `failed: ${row.error}`]
          : [
              row.candidate,
              row.scene,
              frames(row.frames),
              percent(row.slow),
              `${row.draws.p50.toFixed(2)} / ${row.draws.p95.toFixed(2)}`,
              milliseconds(ready(row)),
            ];
      const line = document.createElement("tr");
      line.append(...cells.map((content) => text("td", content)));
      if ("error" in row) {
        line.lastElementChild!.setAttribute("colspan", "4");
      } else {
        line.title = `${row.backend}\n${row.phases.map(([name, duration]) => `${name} ${milliseconds(duration)}`).join(", ")}`;
      }
      return line;
    }),
  );
}

/** With what the numbers depend on. */
function markdown(): string {
  const header =
    "| Renderer | Backend | Images | Cap | Pace | Viewport | Interval | Frame p50 / p95 / p99 / max | Slow | Draw (CPU) p50 / p95 | Phases | Decoded |";
  const lines = rows.map((row) =>
    "error" in row
      ? `| ${row.candidate} | failed: ${cell(row.error)} | ${row.scene} |${" |".repeat(9)}`
      : [
          row.candidate,
          row.backend,
          row.scene,
          `${row.cap} px`,
          row.mode,
          row.viewport,
          `${row.interval.toFixed(1)} ms`,
          `${frames(row.frames)} / ${row.frames.max.toFixed(1)}`,
          percent(row.slow),
          `${row.draws.p50.toFixed(2)} / ${row.draws.p95.toFixed(2)}`,
          row.phases.map(([name, duration]) => `${name} ${milliseconds(duration)}`).join(", "),
          `${row.decodedMegabytes.toFixed(0)} MB`,
        ].reduce((line, content) => `${line} ${cell(content)} |`, "|"),
  );
  const environment = `${platform.name}, ${navigator.userAgent}`;
  return [environment, "", header, `|${" --- |".repeat(12)}`, ...lines].join("\n");
}

/** Errors span lines, and may hold pipes. */
function cell(content: string): string {
  return content.replaceAll("|", "\\|").replaceAll(/\s*\n\s*/g, " ");
}

/** Loading the code aside, which only the first run of a page pays for. */
function ready(result: Result): number {
  return result.phases
    .filter(([name]) => name !== "import")
    .reduce((sum, [, duration]) => sum + duration, 0);
}

function frames({ p50, p95, p99 }: Stats): string {
  return [p50, p95, p99].map((duration) => duration.toFixed(1)).join(" / ");
}

function percent(share: number): string {
  return `${(share * 100).toFixed(1)} %`;
}

function size(): { width: number; height: number } {
  return { width: viewport.clientWidth, height: viewport.clientHeight };
}

function showMetrics(fps: number): void {
  const heap = heapInUse();
  const lines = new Map([
    ["frames", `${fps.toFixed(0)} fps`],
    ["core memory", megabytes(core.coreMemory())],
    ...(heap === undefined ? [] : [["JS heap", megabytes(heap)] as [string, string]]),
    ...timings,
  ]);
  byId("metrics").replaceChildren(
    ...[...lines].flatMap(([name, value]) => [text("dt", name), text("dd", value)]),
  );
}

function report(work: Promise<void>): void {
  work.catch((error: unknown) => {
    status.textContent = message(error);
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function text<K extends keyof HTMLElementTagNameMap>(tag: K, content: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.textContent = content;
  return element;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
