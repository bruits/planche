// PixiJS, loaded as classic scripts: its ES module needs `unsafe-eval`, which the desktop
// shell's content security policy forbids, and its own workaround needs a bundler.

import type * as Pixi from "pixi.js";
import { gpuName, type Create, type Renderer } from "./renderer.js";

declare global {
  interface Window {
    PIXI?: typeof Pixi;
  }
}

export async function load(webgpu: boolean): Promise<Create> {
  if (!window.PIXI) {
    await script("js/vendor/pixi.min.js");
    await script("js/vendor/unsafe-eval.min.js");
  }
  return (host, width, height) => create(webgpu, host, width, height);
}

async function create(
  webgpu: boolean,
  host: HTMLElement,
  width: number,
  height: number,
): Promise<Renderer> {
  const PIXI = window.PIXI!;
  const app = new PIXI.Application();
  await app.init({
    width,
    height,
    resolution: devicePixelRatio,
    autoDensity: true,
    autoStart: false,
    antialias: false,
    backgroundAlpha: 0,
    preference: webgpu ? "webgpu" : "webgl",
  });
  host.append(app.canvas);
  const world = new PIXI.Container();
  app.stage.addChild(world);
  const gl = app.renderer instanceof PIXI.WebGLRenderer ? app.renderer.gl : undefined;
  // Pixi may upload them again, so they live as long as the renderer.
  const bitmaps: ImageBitmap[] = [];
  return {
    backend: `PixiJS ${app.renderer.name}${gl instanceof WebGL2RenderingContext ? `, ${gpuName(gl)}` : ""}`,
    async load(quads) {
      for (const { bitmap, frame, rotation } of quads) {
        bitmaps.push(bitmap);
        const source = new PIXI.ImageSource({ resource: bitmap, autoGenerateMipmaps: true });
        const sprite = new PIXI.Sprite(new PIXI.Texture({ source }));
        sprite.anchor.set(0.5);
        sprite.position.set(frame.x + frame.width / 2, frame.y + frame.height / 2);
        sprite.setSize(frame.width, frame.height);
        sprite.angle = rotation;
        world.addChild(sprite);
        app.renderer.texture.initSource(source);
      }
    },
    draw({ x, y, zoom }) {
      world.scale.set(zoom);
      world.position.set(-x * zoom, -y * zoom);
      app.render();
    },
    resize(width, height) {
      app.renderer.resize(width, height, devicePixelRatio);
    },
    destroy() {
      app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
      bitmaps.forEach((bitmap) => bitmap.close());
    },
  };
}

function script(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const element = document.createElement("script");
    element.src = src;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error(`${src} did not load`));
    document.head.append(element);
  });
}
