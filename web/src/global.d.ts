// Host APIs missing from TypeScript's DOM library.

interface Window {
  /** Chromium only. */
  showDirectoryPicker?(options?: {
    mode?: "read" | "readwrite";
  }): Promise<FileSystemDirectoryHandle>;
  /** The desktop shell's API, which `withGlobalTauri` exposes. */
  __TAURI__?: TauriApi;
}

/** Chromium only. */
interface Navigator {
  readonly keyboard?: {
    /** What each key types without a modifier, by `KeyboardEvent.code`. */
    getLayoutMap(): Promise<ReadonlyMap<string, string>>;
  };
}

/** Chromium only, where a handle the page kept needs the user's leave again after a restart. */
interface FileSystemHandle {
  queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  /** Only right after a click or a key, unless already granted. */
  requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
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
