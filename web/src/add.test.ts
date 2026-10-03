// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { pasted } from "./add.js";

function fromPage(html: string): DataTransfer {
  const transfer = new DataTransfer();
  transfer.items.add(new File(["image"], "image.png", { type: "image/png" }));
  transfer.setData("text/html", html);
  return transfer;
}

describe("pasted", () => {
  it("keeps the web address an image came from", async () => {
    const [image] = await pasted(fromPage('<img src="https://example.com/cat.png">'));
    expect(image).toMatchObject({ name: "image.png", source: "https://example.com/cat.png" });
  });

  it("keeps a signed address's query, needed to fetch it again, but not its credentials", async () => {
    const signed = "https://cdn.example.com/a.png?ex=1&hm=3";
    const [image] = await pasted(fromPage(`<img src="${signed}">`));
    expect(image).toMatchObject({ source: signed });
    const [own] = await pasted(fromPage('<img src="https://user:pass@example.com/cat.png">'));
    expect(own).toMatchObject({ source: "https://example.com/cat.png" });
  });

  it("keeps no address longer than an agent may write", async () => {
    const long = `https://example.com/cat.png?sig=${"a".repeat(2000)}`;
    const [image] = await pasted(fromPage(`<img src="${long}">`));
    expect(image).toMatchObject({ source: undefined });
  });

  it("keeps no address that is no web page's", async () => {
    const [image] = await pasted(fromPage('<img src="data:image/png;base64,AAAA">'));
    expect(image).toMatchObject({ name: "image.png", source: undefined });
  });
});
