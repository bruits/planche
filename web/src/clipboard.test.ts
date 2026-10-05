// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboard, type Host } from "./clipboard.js";
import type { Copied } from "./core.js";
import type { View } from "./view.js";

const copied: Copied = {
  elements: {
    ["a".repeat(32)]: { z: "a0", kind: { type: "comment", at: { x: 0, y: 0 }, text: "Here" } },
  },
};
const bytes = new Map([["b".repeat(64), new Blob(["image"])]]);
const centre = { x: 1, y: 2 };

const host = {
  copy: vi.fn<Host["copy"]>(),
  copyable: vi.fn<Host["copyable"]>(),
  bytes: vi.fn<Host["bytes"]>(),
  cut: vi.fn<Host["cut"]>(),
  png: vi.fn<Host["png"]>(),
  failed: vi.fn<Host["failed"]>(),
  pasted: vi.fn<Host["pasted"]>(),
  received: vi.fn<Host["received"]>(),
};
// Once, as its listeners stay on the document.
const clip = clipboard({ centre: () => centre } as unknown as View, host);

function fire(type: string, transfer = new DataTransfer(), target: EventTarget = document.body) {
  const event = new ClipboardEvent(type, {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, text: transfer.getData("text/plain") };
}

function item(type: string, blob: Blob): ClipboardItem {
  return { types: [type], getType: async () => blob } as unknown as ClipboardItem;
}

function holding(text: string): DataTransfer {
  const transfer = new DataTransfer();
  transfer.setData("text/plain", text);
  return transfer;
}

describe("the clipboard", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    host.copy.mockReturnValue(copied);
    host.copyable.mockReturnValue(true);
    host.bytes.mockReturnValue(async () => bytes);
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("copies the selection as text, which a paste in the same window hands back with its images' bytes", async () => {
    const copy = fire("copy");
    expect(copy.prevented).toBe(true);
    expect(host.copy).toHaveBeenCalledWith(false);
    expect(host.cut).not.toHaveBeenCalled();
    expect(fire("paste", holding(copy.text)).prevented).toBe(true);
    expect(host.pasted).toHaveBeenCalledOnce();
    const [pasted, at] = host.pasted.mock.calls[0]!;
    expect(pasted.copied).toEqual(copied);
    expect(at).toEqual(centre);
    expect(await pasted.assets([])).toBe(bytes);
  });

  it("hands a copy made in another window without bytes", async () => {
    const { text } = fire("copy");
    fire("paste", holding(text.replace(/"copy":"\w+"/, '"copy":"elsewhere"')));
    const [pasted] = host.pasted.mock.calls[0]!;
    expect(pasted.copied).toEqual(copied);
    expect(await pasted.assets(["b".repeat(64)])).toEqual(new Map());
  });

  it("removes what a cut copies, but not what it cannot", () => {
    expect(fire("cut").prevented).toBe(true);
    expect(host.copy).toHaveBeenCalledWith(true);
    expect(host.cut).toHaveBeenCalledOnce();
    host.copy.mockReturnValue(undefined);
    expect(fire("cut").prevented).toBe(false);
    expect(host.cut).toHaveBeenCalledOnce();
  });

  it("pastes anything else as images", async () => {
    fire("paste", holding("Some text"));
    expect(host.received).toHaveBeenCalledOnce();
    const [incoming, at] = host.received.mock.calls[0]!;
    expect(await incoming).toEqual([]);
    expect(at).toEqual(centre);
    expect(host.pasted).not.toHaveBeenCalled();
  });

  it("leaves a field to copy and paste its own text, but not a copy's", () => {
    const field = document.body.appendChild(document.createElement("textarea"));
    const { text } = fire("copy");
    host.copy.mockClear();
    expect(fire("copy", new DataTransfer(), field).prevented).toBe(false);
    expect(host.copy).not.toHaveBeenCalled();
    expect(fire("paste", holding("Some text"), field).prevented).toBe(false);
    expect(fire("paste", holding(text), field).prevented).toBe(true);
    expect(host.pasted).not.toHaveBeenCalled();
    expect(host.received).not.toHaveBeenCalled();
  });

  it("lets WebKit offer to copy and cut only when something is selected", () => {
    expect(fire("beforecopy").prevented).toBe(true);
    host.copyable.mockReturnValue(false);
    expect(fire("beforecopy").prevented).toBe(false);
    expect(fire("beforecut").prevented).toBe(false);
  });

  it("pastes from the menu the copy among what the clipboard holds, where the menu was", async () => {
    const { text } = fire("copy");
    const image = item("image/png", new Blob(["image"]));
    vi.spyOn(navigator.clipboard, "read").mockResolvedValue([
      image,
      item("text/plain", new Blob([text])),
    ]);
    const at = { x: 5, y: 6 };
    await clip.paste(at);
    expect(host.pasted).toHaveBeenCalledOnce();
    const [pasted, where] = host.pasted.mock.calls[0]!;
    expect(where).toBe(at);
    expect(await pasted.assets([])).toBe(bytes);
  });

  it("pastes from the menu anything else as images, and fails when the browser forbids it", async () => {
    const png = new Blob(["image"]);
    const read = vi.spyOn(navigator.clipboard, "read");
    read.mockResolvedValue([item("text/plain", new Blob(["Some text"])), item("image/png", png)]);
    await clip.paste(centre);
    expect(host.pasted).not.toHaveBeenCalled();
    expect(await host.received.mock.calls[0]![0]).toEqual([
      { name: "the pasted image", bytes: png },
    ]);
    read.mockRejectedValue(new DOMException("Read permission denied", "NotAllowedError"));
    await expect(clip.paste(centre)).rejects.toThrow("Read permission denied");
  });

  it("copies a lone image as text first, then with a PNG of it, the event writing nothing", async () => {
    host.png.mockReturnValue(Promise.resolve(new Blob(["image"], { type: "image/png" })));
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();
    expect(fire("copy")).toEqual({ prevented: true, text: "" });
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(writeText.mock.invocationCallOrder[0]).toBeLessThan(write.mock.invocationCallOrder[0]!);
    const [written] = writeText.mock.calls[0]!;
    expect(written).toMatch(/^\{"planche":"elements"/);
    const [items] = write.mock.calls[0]!;
    expect(items.map((each) => each.types)).toEqual([["text/plain", "image/png"]]);
    expect(await (await items[0]!.getType("text/plain")).text()).toBe(written);
    expect(await (await items[0]!.getType("image/png")).text()).toBe("image");
  });

  it.each([
    ["written", () => undefined],
    ["refused", () => Promise.reject(new DOMException("", "NotAllowedError"))],
  ])(
    "writes the PNG only once its text is %s, as Firefox cancels a pending write",
    async (_, end) => {
      host.png.mockReturnValue(Promise.resolve(new Blob()));
      let settle: (() => void) | undefined;
      vi.spyOn(navigator.clipboard, "writeText").mockReturnValue(
        new Promise((done) => (settle = () => done(end()))),
      );
      const write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();
      fire("copy");
      await Promise.resolve();
      expect(write).not.toHaveBeenCalled();
      settle?.();
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    },
  );

  it.each([
    ["Chromium", (failure: unknown) => failure],
    ["Safari", () => new DOMException("", "NotAllowedError")],
  ])("keeps the text alone when the PNG fails in %s, and tells why", async (_, failing) => {
    host.png.mockReturnValue(Promise.reject(new Error("Planche could not encode the image")));
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      await items[0]!
        .getType("image/png")
        .catch((error: unknown) => Promise.reject(failing(error)));
    });
    fire("copy");
    await vi.waitFor(() => expect(host.failed).toHaveBeenCalledOnce());
    expect(host.failed).toHaveBeenCalledWith(new Error("Planche could not encode the image"), true);
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("tells the browser's refusal of an image it made", async () => {
    host.png.mockReturnValue(Promise.resolve(new Blob()));
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    vi.spyOn(navigator.clipboard, "write").mockRejectedValue(
      new DOMException("Document is not focused", "NotAllowedError"),
    );
    fire("copy");
    await vi.waitFor(() => expect(host.failed).toHaveBeenCalledOnce());
    expect(host.failed).toHaveBeenCalledWith(
      new Error("The browser did not let Planche copy the image"),
      true,
    );
  });

  it("tells that nothing was copied where the browser refuses its text too", async () => {
    host.png.mockReturnValue(Promise.resolve(new Blob()));
    const denied = new DOMException("Write permission denied.", "NotAllowedError");
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(denied);
    vi.spyOn(navigator.clipboard, "write").mockRejectedValue(denied);
    fire("copy");
    await vi.waitFor(() => expect(host.failed).toHaveBeenCalledOnce());
    expect(host.failed).toHaveBeenCalledWith(
      new Error("The browser did not let Planche write to the clipboard"),
      false,
    );
  });

  describe("in Chromium", () => {
    beforeEach(() => {
      Object.defineProperty(navigator, "userAgentData", { value: {}, configurable: true });
    });

    afterEach(() => {
      Reflect.deleteProperty(navigator, "userAgentData");
    });

    it("keeps the event's text, which a refusal of the clipboard's API leaves copied", async () => {
      host.png.mockReturnValue(Promise.resolve(new Blob()));
      const denied = new DOMException("Write permission denied.", "NotAllowedError");
      vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(denied);
      vi.spyOn(navigator.clipboard, "write").mockRejectedValue(denied);
      expect(fire("copy").text).toMatch(/^\{"planche":"elements"/);
      await vi.waitFor(() => expect(host.failed).toHaveBeenCalledOnce());
      expect(host.failed).toHaveBeenCalledWith(
        new Error("The browser did not let Planche copy the image"),
        true,
      );
    });
  });

  it.each([
    ["Planche's", () => document.body],
    ["a field's", () => document.body.appendChild(document.createElement("textarea"))],
  ])("writes no PNG for a copy %s came after", async (_, placed) => {
    const target = placed();
    let made: ((png: Blob) => void) | undefined;
    host.png.mockReturnValueOnce(new Promise((done) => (made = done)));
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const write = vi.spyOn(navigator.clipboard, "write").mockImplementation(async (items) => {
      await items[0]!.getType("image/png");
    });
    fire("copy");
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    fire("copy", new DataTransfer(), target);
    made?.(new Blob());
    await expect(write.mock.results[0]!.value).rejects.toThrow("Another copy came since");
    expect(host.failed).not.toHaveBeenCalled();
  });

  it("tells nothing of a refused copy another one came after", async () => {
    let made: ((png: Blob) => void) | undefined;
    host.png.mockReturnValueOnce(new Promise((done) => (made = done)));
    vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const write = vi
      .spyOn(navigator.clipboard, "write")
      .mockRejectedValue(new DOMException("", "NotAllowedError"));
    fire("copy");
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    fire("copy");
    made?.(new Blob());
    await new Promise((done) => setTimeout(done));
    expect(host.failed).not.toHaveBeenCalled();
  });

  it("cuts a lone image as text alone, as its file may go with it", () => {
    host.png.mockReturnValue(Promise.resolve(new Blob()));
    expect(fire("cut").text).toMatch(/^\{"planche":"elements"/);
    expect(host.png).not.toHaveBeenCalled();
  });

  it.each([
    ["no ClipboardItem", () => vi.stubGlobal("ClipboardItem", undefined)],
    [
      "no clipboard write",
      () =>
        vi
          .spyOn(navigator, "clipboard", "get")
          .mockReturnValue({ writeText: vi.fn<Clipboard["writeText"]>() } as unknown as Clipboard),
    ],
  ])("copies a lone image as text alone where the browser has %s", (_, lacking) => {
    host.png.mockReturnValue(Promise.resolve(new Blob()));
    lacking();
    expect(fire("copy").text).toMatch(/^\{"planche":"elements"/);
    expect(host.png).not.toHaveBeenCalled();
  });

  it("reads the clipboard when a paste hands nothing, as WebKitGTK's does", async () => {
    const { text } = fire("copy");
    const read = vi
      .spyOn(navigator.clipboard, "read")
      .mockResolvedValue([item("text/plain", new Blob([text]))]);
    expect(fire("paste").prevented).toBe(true);
    await vi.waitFor(() => expect(host.pasted).toHaveBeenCalledOnce());
    expect(read).toHaveBeenCalledOnce();
  });
});
