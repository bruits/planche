// WebGL2 with nothing on top: the floor every other GPU candidate has to justify itself
// against.

import { canvas, gpuName, lose, size, type Renderer } from "./renderer.js";

const VERTEX = `#version 300 es
uniform vec4 rect;
uniform float degrees;
uniform vec3 camera;
uniform vec2 viewport;
out vec2 uv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 local = (corner - 0.5) * rect.zw;
  float angle = radians(degrees);
  vec2 turned = vec2(local.x * cos(angle) - local.y * sin(angle), local.x * sin(angle) + local.y * cos(angle));
  vec2 screen = (rect.xy + rect.zw * 0.5 + turned - camera.xy) * camera.z;
  gl_Position = vec4(screen.x / viewport.x * 2.0 - 1.0, 1.0 - screen.y / viewport.y * 2.0, 0.0, 1.0);
  uv = corner;
}`;

const FRAGMENT = `#version 300 es
precision mediump float;
uniform sampler2D image;
in vec2 uv;
out vec4 color;
void main() {
  color = texture(image, uv);
}`;

export async function create(host: HTMLElement, width: number, height: number): Promise<Renderer> {
  const output = canvas(host, width, height);
  const gl = output.getContext("webgl2", { antialias: false, premultipliedAlpha: false })!;
  const program = link(gl);
  const uniform = (name: string) => gl.getUniformLocation(program, name);
  const [rect, degrees, camera, viewport] = [uniform("rect"), uniform("degrees"), uniform("camera"), uniform("viewport")];
  gl.useProgram(program);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  let images: { texture: WebGLTexture; frame: number[]; rotation: number }[] = [];
  return {
    backend: `WebGL2, ${gpuName(gl)}`,
    async load(quads) {
      for (const { bitmap, frame, rotation } of quads) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        bitmap.close();
        images.push({ texture, frame: [frame.x, frame.y, frame.width, frame.height], rotation });
      }
    },
    draw({ x, y, zoom }) {
      gl.viewport(0, 0, output.width, output.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform3f(camera, x, y, zoom * devicePixelRatio);
      gl.uniform2f(viewport, output.width, output.height);
      for (const image of images) {
        gl.bindTexture(gl.TEXTURE_2D, image.texture);
        gl.uniform4fv(rect, image.frame);
        gl.uniform1f(degrees, image.rotation);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    },
    resize(width, height) {
      size(output, width, height);
    },
    destroy() {
      images.forEach(({ texture }) => gl.deleteTexture(texture));
      images = [];
      lose(gl);
      output.remove();
    },
  };
}

function link(gl: WebGL2RenderingContext): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX],
    [gl.FRAGMENT_SHADER, FRAGMENT],
  ] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "the shaders do not link");
  }
  return program;
}
