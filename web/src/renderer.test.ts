// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { Point } from "./core.js";
import { GpuLost, NoRenderer, Panic } from "./errors.js";
import { create, packed, type Placed } from "./renderer.js";
import start, { create as createWgpu, reportPanics } from "./wasm/renderer.js";

// The wasm renderer is not the core, and has no place in Node, so the module is faked.
vi.mock("./wasm/renderer.js", () => {
  const renderer = {
    backend: "fake",
    maxTextureSide: 1,
    textureBytes: 0,
    free() {},
    resize() {},
  };
  return {
    default: vi.fn<() => Promise<void>>(async () => {}),
    reportPanics: vi.fn<(report: (text: string) => void) => void>(),
    create: vi.fn<
      (
        canvas: HTMLCanvasElement,
        webgpu: boolean,
        gone: (why: string) => void,
      ) => Promise<typeof renderer>
    >(async () => renderer),
    Animation: function () {},
  };
});

/** Floats per item, its kind first, its extra then its opacity last. */
const STRIDE = 15;

function pen(points: Point[], opacity: number): Placed {
  return { kind: "stroke", points, width: 2, paint: "ink", opacity };
}

function items(placed: Placed[]): number[][] {
  const floats = packed(placed, new Map(), new Map(), () => [0, 0, 0]);
  return Array.from({ length: floats.length / STRIDE }, (_, at) => [
    ...floats.subarray(at * STRIDE, (at + 1) * STRIDE),
  ]);
}

describe("the pen strokes the renderer takes", () => {
  const bent = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
  ];

  it("draw see-through ones once, each apart from the next, and opaque ones as other strokes", () => {
    const [first, second, third, fourth, ...opaque] = items([
      pen(bent, 0.5),
      pen(bent, 0.5),
      pen(bent, 1),
    ]);
    // One line from each point to the next.
    expect(opaque).toHaveLength(2);
    expect([first, second, third, fourth].map((item) => item![0])).toEqual([3, 3, 3, 3]);
    expect(opaque.map((item) => item[0])).toEqual([1, 1]);
    expect(first![STRIDE - 2]).toBe(second![STRIDE - 2]);
    expect(third![STRIDE - 2]).not.toBe(second![STRIDE - 2]);
    expect([first, fourth, ...opaque].map((item) => item![STRIDE - 1])).toEqual([0.5, 0.5, 1, 1]);
  });

  it("draw a dot as one line from its point to itself", () => {
    const [dot, ...rest] = items([pen([{ x: 4, y: 5 }], 1)]);
    expect(rest).toEqual([]);
    expect(dot!.slice(3, 7)).toEqual([4, 5, 4, 5]);
  });
});

function outline(shape: Extract<Placed, { kind: "outline" }>["shape"], corners: number): Placed {
  return {
    kind: "outline",
    shape,
    corners,
    frame: { x: 0, y: 0, width: 10, height: 10 },
    rotation: 0,
    width: 2,
    paint: "ink",
    dashed: false,
    fill: 1,
    opacity: 1,
  };
}

describe("the outlines the renderer takes", () => {
  it("tell a polygon or a star by how many corners it goes round, then its fill", () => {
    const [star, triangle, rectangle] = items([
      outline("star", 7),
      outline("triangle", 3),
      outline("rectangle", 0),
    ]);
    // Its shape after its kind and texture, its corners and its fill before its opacity.
    expect([star![2], star![STRIDE - 3], star![STRIDE - 2]]).toEqual([8, 7, 1]);
    expect([triangle![2], triangle![STRIDE - 3]]).toEqual([7, 3]);
    expect([rectangle![2], rectangle![STRIDE - 3]]).toEqual([1, 0]);
  });
});

function fill(light: boolean): Placed {
  return {
    kind: "fill",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    paint: "ink",
    opacity: 1,
    light,
  };
}

describe("the colours the renderer takes", () => {
  it("are the light theme's for what draws light, whatever the theme", () => {
    const floats = packed(
      [fill(false), fill(true)],
      new Map(),
      new Map(),
      () => [1, 1, 1],
      () => [0, 0, 0],
    );
    // Its colour after its kind, texture, shape, frame, rotation, and width.
    expect([...floats.subarray(9, 12)]).toEqual([1, 1, 1]);
    expect([...floats.subarray(STRIDE + 9, STRIDE + 12)]).toEqual([0, 0, 0]);
  });
});

describe("the board in greys the renderer takes", () => {
  const image: Placed = {
    kind: "image",
    asset: "a",
    frame: { x: 0, y: 0, width: 1, height: 1 },
    texture: { x: 0, y: 0, width: 1, height: 1 },
    rotation: 0,
    greyscale: false,
    elliptical: false,
    opacity: 1,
  };
  const both = (grey: boolean) =>
    packed([fill(false), image], new Map([["a", 0]]), new Map(), () => [1, 0, 0], undefined, grey);

  it("draws each colour as its grey, and each image in greyscale", () => {
    const floats = both(true);
    const [red, green, blue] = floats.subarray(9, 12);
    expect(red).toBeCloseTo(127 / 255, 2);
    expect([green, blue]).toEqual([red, red]);
    // Its flag after its kind, texture, frame, rotation, and the part of its texture it shows.
    expect(floats[STRIDE + 11]).toBe(1);
  });

  it("keeps their own colours otherwise", () => {
    const floats = both(false);
    expect([...floats.subarray(9, 12)]).toEqual([1, 0, 0]);
    expect(floats[STRIDE + 11]).toBe(0);
  });
});

/** A tick of the event loop, which is when a browser fires the event `loseContext` queues. */
const tick = () => new Promise((done) => setTimeout(done));

/** A browser that has WebGPU, whose warning when it fails stays out of the output. */
function withWebGpu(): void {
  Object.defineProperty(navigator, "gpu", { value: {}, configurable: true });
  vi.spyOn(console, "warn").mockImplementation(() => {});
}

describe("a renderer that cannot go on", () => {
  let lost: Mock<(why: unknown) => void>;
  let host: HTMLElement;

  beforeEach(() => {
    lost = vi.fn<(why: unknown) => void>();
    vi.mocked(createWgpu).mockClear();
    vi.mocked(reportPanics).mockClear();
    host = document.body.appendChild(document.createElement("div"));
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    // happy-dom has no `navigator.gpu`, so `create` takes the WebGL2 path.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(function (
      this: HTMLCanvasElement,
      kind: string,
    ) {
      if (kind === "webgl2") {
        // As a browser does, the loss comes as a queued event.
        return {
          getExtension: () => ({
            loseContext: () => {
              setTimeout(() => this.dispatchEvent(new Event("webglcontextlost")));
            },
          }),
        } as unknown as WebGL2RenderingContext;
      }
      // The 2D context `paints` reads colours through.
      return {
        clearRect() {},
        fillRect() {},
        getImageData: () => ({ data: Uint8ClampedArray.from([0, 0, 0, 255]) }),
      } as unknown as CanvasRenderingContext2D;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, "gpu");
    document.body.replaceChildren();
  });

  it("stops the app when no backend can draw here, keeping wgpu's words", async () => {
    const said = "Failed to create surface for any enabled backend";
    vi.mocked(createWgpu).mockRejectedValueOnce(new Error(said));
    await expect(create(host, 100, 100, lost)).rejects.toEqual(new NoRenderer(said));
    expect(lost).toHaveBeenCalledExactlyOnceWith(new NoRenderer(said));
  });

  it("keeps why each backend failed", async () => {
    withWebGpu();
    vi.mocked(createWgpu)
      .mockRejectedValueOnce(new Error("No available adapters."))
      .mockRejectedValueOnce(new Error("canvas.getContext() returned null"));
    await expect(create(host, 100, 100, lost)).rejects.toThrow(
      "WebGPU: No available adapters.; WebGL2: canvas.getContext() returned null",
    );
  });

  it("falls back to WebGL2 without stopping the app, and drops the WebGPU canvas", async () => {
    withWebGpu();
    let first: HTMLCanvasElement | undefined;
    vi.mocked(createWgpu).mockImplementationOnce(async (canvas) => {
      first = canvas;
      throw new Error("No available adapters.");
    });
    const renderer = await create(host, 100, 100, lost);
    expect(vi.mocked(createWgpu).mock.calls.map(([, webgpu]) => webgpu)).toEqual([true, false]);
    expect(first?.isConnected).toBe(false);
    expect([...host.querySelectorAll("canvas")]).toEqual([renderer.canvas]);
    await tick();
    expect(lost).not.toHaveBeenCalled();
  });

  it("stops the app with why its module did not load", async () => {
    const failed = new TypeError("Failed to fetch");
    vi.mocked(start).mockRejectedValueOnce(failed);
    await expect(create(host, 100, 100, lost)).rejects.toBe(failed);
    expect(lost).toHaveBeenCalledExactlyOnceWith(failed);
  });

  it("stops the app with a bug of its own as it is", async () => {
    withWebGpu();
    const bug = new TypeError("getComputedStyle is not a function");
    vi.stubGlobal("getComputedStyle", () => {
      throw bug;
    });
    await expect(create(host, 100, 100, lost)).rejects.toBe(bug);
    expect(createWgpu).not.toHaveBeenCalled();
    expect(lost).toHaveBeenCalledExactlyOnceWith(bug);
  });

  it("stops the app when its module panics, telling its words as a Panic", async () => {
    await create(host, 100, 100, lost);
    // What Rust calls with the panic's text, which names where it happened.
    const panicked = vi.mocked(reportPanics).mock.calls[0]![0];
    panicked("panicked at crates/renderer/src/web.rs:1:1");
    expect(lost).toHaveBeenCalledExactlyOnceWith(
      new Panic("panicked at crates/renderer/src/web.rs:1:1"),
    );
  });

  it("stops the app when WebGPU loses its device, whatever the browser says", async () => {
    withWebGpu();
    await create(host, 100, 100, lost);
    // What Rust calls with the browser's words, which may be none.
    const gone = vi.mocked(createWgpu).mock.calls[0]![2];
    gone("");
    gone("the GPU process crashed");
    expect(lost.mock.calls).toEqual([
      [new GpuLost("no reason given")],
      [new GpuLost("the GPU process crashed")],
    ]);
  });

  it("stops the app when the browser loses the WebGL2 context", async () => {
    const renderer = await create(host, 100, 100, lost);
    renderer.canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(lost).toHaveBeenCalledExactlyOnceWith(new GpuLost("the WebGL2 context is lost"));
  });

  it("does not stop the app for the context that destroy loses on purpose", async () => {
    const renderer = await create(host, 100, 100, lost);
    const canvas = renderer.canvas;
    renderer.destroy();
    // The event `destroy`'s own `loseContext` queued, then one more by hand.
    await tick();
    canvas.dispatchEvent(new Event("webglcontextlost"));
    expect(lost).not.toHaveBeenCalled();
  });
});
