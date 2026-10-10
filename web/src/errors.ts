// Failures as the user or an agent reads them.

export function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function clipped(text: string, most: number): string {
  if (text.length <= most) {
    return text;
  }
  // Never between the halves of a character, which the shell could not read back.
  const last = text.charCodeAt(most - 1);
  const end = last >= 0xd800 && last <= 0xdbff ? most - 1 : most;
  return `${text.slice(0, end)}…`;
}

/** All there is to tell of `error`, its stack too, for a report. */
export function described(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const head = `${error.name}: ${error.message}`;
  const stack = error.stack ?? "";
  // V8 opens the stack with the name and the message, which WebKit leaves out.
  return stack.startsWith(head) ? stack : [head, stack].filter(Boolean).join("\n");
}

/** A WASM module's panic, telling where it happened, after which the module is unusable. */
export class Panic extends Error {
  override name = "Panic";
}

/** Why neither WebGPU nor WebGL2 could draw here, in wgpu's own words. */
export class NoRenderer extends Error {
  override name = "NoRenderer";
}

export class GpuLost extends Error {
  override name = "GpuLost";
}
