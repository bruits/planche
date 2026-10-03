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
