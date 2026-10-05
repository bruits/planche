// Times the core as the web app calls it, compiled to WASM in release or in debug and run in Node,
// on boards made up the same way at each run: just bench, or just bench debug.
// Usage: node crates/bindings/bench.cjs <the bindings from wasm-bindgen --target nodejs> <label>

const path = require("node:path");

const core = require(path.resolve(process.argv[2], "bindings.js"));
const label = process.argv[3] ?? "";
const SIZES = [500, 3000];
/** As web/src/core.ts's SLICE, the most bytes the app hands the core at once. */
const SLICE = 8 * 2 ** 20;
/** Of a 12 MP JPEG, give or take. */
const ASSET = 12 * 2 ** 20;
/** Each measurement takes about as long, whatever it times. */
const BUDGET = 300;

/** The median of `work`'s runs, in milliseconds, each run after `before`, which is not timed. */
function median(work, before = () => {}) {
  const times = [];
  const until = performance.now() + BUDGET;
  while (times.length < 5 || (times.length < 200 && performance.now() < until)) {
    before();
    const start = process.hrtime.bigint();
    work();
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  return times.sort((a, b) => a - b)[times.length >> 1];
}

/** A stream of numbers in [0, 1) that starts again the same at each run. */
function random(seed) {
  return () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
}

const hex = (digits, n) => n.toString(16).padStart(digits, "0");
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Keys that sort in order, as z-indices must, up to 3906 of them. */
const z = (at) => (at < 62 ? `a${DIGITS[at]}` : `b${DIGITS[Math.floor((at - 62) / 62)]}${DIGITS[(at - 62) % 62]}`);

/**
 * `count` elements, seven in ten of them images, the others notes stuck to an image, shapes, and
 * arrows from one, spread as thinly whatever their count.
 */
function board(count) {
  const next = random(count);
  const side = 400 * Math.sqrt(count);
  const encoder = new TextEncoder();
  const empty = new core.Editor();
  const snapshot = empty.snapshot();
  const written = snapshot.write();
  snapshot.free();
  empty.free();
  const paths = [...written.keys()];
  const contents = [...written.values()];
  const ids = [];
  let image;
  let imageId;
  for (let at = 0; at < count; at++) {
    const id = hex(32, 0x1000 + at * 7919);
    const frame = { x: next() * side, y: next() * side, width: 100 + next() * 300, height: 100 + next() * 300 };
    let kind;
    switch (at % 10) {
      case 7:
        // Stuck to the image before it, on which it lies.
        kind = {
          type: "note",
          frame: { x: image.x + 10, y: image.y + 10, width: image.width / 2, height: image.height / 2 },
          rotation: 0,
          text: { content: `A note of a few words, number ${at}`, font_size: 20 },
          target: imageId,
        };
        break;
      case 8:
        kind = { type: "shape", frame, rotation: 0, shape: "ellipse", text: { content: `Shape ${at}`, font_size: 20 } };
        break;
      case 9:
        // From the middle of the image before it, which it sticks to, to anywhere.
        kind = {
          type: "arrow",
          from: { x: image.x + image.width / 2, y: image.y + image.height / 2 },
          to: { x: frame.x, y: frame.y },
          from_target: imageId,
        };
        break;
      default:
        image = frame;
        imageId = id;
        kind = {
          type: "image",
          asset: hex(64, 0xabc000 + at),
          natural_size: { width: 4000, height: 3000 },
          frame,
          rotation: 0,
          edits: { crop: null, flip_horizontal: false, flip_vertical: false, greyscale: false },
          filename: `photo-${at}.jpg`,
        };
    }
    ids.push(id);
    paths.push(`elements/${id}.json`);
    contents.push(encoder.encode(`${JSON.stringify({ z: z(at), kind }, null, 2)}\n`));
  }
  return { ids, paths, contents };
}

function measure(count) {
  const { ids, paths, contents } = board(count);
  const some = ids.slice(0, 50);
  const images = ids.filter((_, at) => at % 10 < 7);
  const side = 400 * Math.sqrt(count);
  const next = random(1);
  const rows = new Map();
  let editor;
  rows.set(
    "read",
    median(
      () => (editor = core.Editor.read(paths, contents)),
      () => editor?.free(),
    ),
  );
  rows.set("json", median(() => editor.json()));
  rows.set("hit", median(() => editor.hit(next() * side, next() * side, 6)));
  rows.set("touching, a quarter of the board", median(() => editor.touching(0, 0, side / 2, side / 2)));
  // Read again after each edit, as the app draws in that order.
  rows.set("drawOrder", median(() => editor.drawOrder()));
  // As the app reads it once it opens the board, parsed.
  rows.set("drawn", median(() => JSON.parse(editor.drawn(ids, []))));
  for (const [name, selected] of [
    ["50", some],
    ["all", ids],
    ["images", images],
  ]) {
    // As a drag does at each move: from where the gesture began, down onto what it lies on, then
    // each element it touched read again.
    editor.beginGesture();
    const moved = () => {
      editor.rewindGesture();
      editor.translate(selected, 30, 20);
    };
    rows.set(`translate ${name}`, median(moved));
    rows.set(`land ${name}`, median(() => editor.land(selected), moved));
    rows.set(`bounds ${name}`, median(() => editor.bounds(selected)));
    // Each once, as the app will read them: the move done again to learn what it touched.
    const touched = new Set([...editor.rewindGesture(), ...editor.translate(selected, 30, 20), ...editor.land(selected)]);
    rows.set(`element ${name}`, median(() => touched.forEach((id) => editor.element(id))));
    rows.set(`drawn ${name}`, median(() => JSON.parse(editor.drawn([...touched], []))));
    editor.rewindGesture();
    editor.endGesture();
  }
  const snapshot = editor.snapshot();
  rows.set("snapshot.write", median(() => snapshot.write()));
  const known = core.Known.read([], paths, contents);
  editor.beginGesture();
  editor.translate(some, 30, 20);
  editor.endGesture();
  const moved = editor.snapshot();
  let save;
  rows.set(
    "known.save, 50 moved",
    median(
      () => (save = known.save(moved, some)),
      () => save?.free(),
    ),
  );
  save.free();
  for (const freed of [moved, known, snapshot, editor]) {
    freed.free();
  }
  return rows;
}

function hashing() {
  const next = random(2);
  const bytes = Uint8Array.from({ length: ASSET }, () => next() * 256);
  const sliced = (hasher) => {
    for (let at = 0; at < bytes.length; at += SLICE) {
      hasher.update(bytes.subarray(at, at + SLICE));
    }
    return hasher.finish();
  };
  return new Map([
    ["sha256, 12 MB", median(() => sliced(new core.AssetHasher()))],
    ["crc32, 12 MB", median(() => sliced(new core.Crc32()))],
  ]);
}

const columns = SIZES.map(measure);
const names = [...columns[0].keys()];
const width = Math.max(...names.map((name) => name.length));
const cell = (ms) => `${ms.toFixed(3)} ms`.padStart(14);
console.log(`Median times, ${label}\n`);
console.log(`${"".padEnd(width)}${SIZES.map((size) => `${size} elements`.padStart(14)).join("")}`);
for (const name of names) {
  console.log(`${name.padEnd(width)}${columns.map((column) => cell(column.get(name))).join("")}`);
}
console.log("");
for (const [name, ms] of hashing()) {
  console.log(`${name.padEnd(width)}${cell(ms)}`);
}
