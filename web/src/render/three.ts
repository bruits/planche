// Three.js's WebGPURenderer, the same code on WebGPU or, forced, on WebGL2.

import * as THREE from "three/webgpu";
import type { Create, Renderer } from "./renderer.js";

export async function load(webgpu: boolean): Promise<Create> {
  return (host, width, height) => create(webgpu, host, width, height);
}

async function create(
  webgpu: boolean,
  host: HTMLElement,
  width: number,
  height: number,
): Promise<Renderer> {
  // With its output in the working colour space, it draws straight to the canvas, as the
  // others do, rather than through a render target and a colour pass.
  const renderer = new THREE.WebGPURenderer({
    antialias: false,
    alpha: true,
    depth: false,
    forceWebGL: !webgpu,
  });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  await renderer.init();
  renderer.setPixelRatio(devicePixelRatio);
  renderer.setSize(width, height);
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  // Its default near plane would clip the images, which lie at z = 0.
  const camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);
  const viewport = { width, height };
  // Board space has y pointing down, and images start at their top row.
  const plane = new THREE.PlaneGeometry(1, 1);
  const uv = plane.getAttribute("uv");
  for (let at = 0; at < uv.count; at += 1) {
    uv.setY(at, 1 - uv.getY(at));
  }
  const textures: THREE.Texture[] = [];
  const bitmaps: ImageBitmap[] = [];
  return {
    backend: `Three.js ${"isWebGPUBackend" in renderer.backend ? "WebGPU" : "WebGL2"}`,
    async load(quads) {
      quads.forEach(({ bitmap, frame, rotation }, order) => {
        bitmaps.push(bitmap);
        const texture = new THREE.Texture(bitmap);
        texture.flipY = false;
        texture.colorSpace = THREE.NoColorSpace;
        texture.needsUpdate = true;
        textures.push(texture);
        const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true });
        material.depthTest = false;
        const mesh = new THREE.Mesh(plane, material);
        mesh.position.set(frame.x + frame.width / 2, -(frame.y + frame.height / 2), 0);
        mesh.scale.set(frame.width, frame.height, 1);
        mesh.rotation.z = (-rotation * Math.PI) / 180;
        mesh.renderOrder = order;
        // No other candidate skips what is out of sight.
        mesh.frustumCulled = false;
        scene.add(mesh);
        renderer.initTexture(texture);
      });
    },
    draw({ x, y, zoom }) {
      camera.left = x;
      camera.right = x + viewport.width / zoom;
      camera.top = -y;
      camera.bottom = -(y + viewport.height / zoom);
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
    },
    resize(width, height) {
      Object.assign(viewport, { width, height });
      renderer.setPixelRatio(devicePixelRatio);
      renderer.setSize(width, height);
    },
    destroy() {
      textures.forEach((texture) => texture.dispose());
      renderer.dispose();
      renderer.domElement.remove();
      bitmaps.forEach((bitmap) => bitmap.close());
    },
  };
}
