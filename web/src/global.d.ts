// Host APIs missing from TypeScript's DOM library.

interface Window {
  /** Chromium only. */
  showDirectoryPicker?(options?: { mode?: "read" | "readwrite" }): Promise<FileSystemDirectoryHandle>;
  /** The desktop shell's API, which `withGlobalTauri` exposes. */
  __TAURI__?: TauriApi;
}

interface TauriApi {
  core: {
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
