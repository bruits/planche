// Host APIs missing from TypeScript's DOM library.

interface Window {
  /** Chromium only. */
  showDirectoryPicker?(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  /** The desktop shell's API, which `withGlobalTauri` exposes. */
  __TAURI__?: TauriApi;
}

/** Safari's pinch on a trackpad, which it reports instead of Ctrl-scrolling as others do. */
interface GestureEvent extends UIEvent {
  /** Since the gesture started. */
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface DocumentEventMap {
  gesturestart: GestureEvent;
  gesturechange: GestureEvent;
  gestureend: GestureEvent;
}

interface TauriApi {
  core: {
    Channel: new <T>() => { onmessage: (message: T) => void };
    invoke<T>(
      command: string,
      args?: Record<string, unknown> | Uint8Array,
      options?: { headers: Record<string, string> },
    ): Promise<T>;
  };
  event: {
    /** Resolves to what stops listening. */
    listen<T>(event: string, handler: (event: { payload: T }) => void): Promise<() => void>;
  };
}
