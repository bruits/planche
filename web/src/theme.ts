// The app's colours: light or dark, as chosen or as the system has them, in high contrast or not.
// The stylesheet reads them off the root element, where `index.html` sets them first.

import { recall, remember } from "./preferences.js";

const SCHEME = "planche.theme";
const CONTRAST = "planche.contrast";

export type Scheme = "light" | "dark" | "system";

export interface Theme {
  scheme(): Scheme;
  highContrast(): boolean;
  choose(scheme: Scheme): void;
  toggleContrast(): void;
}

/** Calls `changed` once the colours change, whether chosen or following the system. */
export function theme(changed: () => void): Theme {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  const more = matchMedia("(prefers-contrast: more)");
  const storedScheme = recall(SCHEME);
  const storedContrast = recall(CONTRAST);
  let scheme: Scheme =
    storedScheme === "light" || storedScheme === "dark" ? storedScheme : "system";
  /** `undefined` to follow the system's. */
  let contrast = storedContrast === "high" ? true : storedContrast === "normal" ? false : undefined;
  const highContrast = () => contrast ?? more.matches;
  const show = () => {
    const root = document.documentElement;
    root.dataset.theme = scheme === "system" ? (dark.matches ? "dark" : "light") : scheme;
    if (highContrast()) {
      root.dataset.contrast = "high";
    } else {
      delete root.dataset.contrast;
    }
  };
  const apply = () => {
    show();
    changed();
  };
  show();
  dark.addEventListener("change", apply);
  more.addEventListener("change", apply);
  // Forced colours set no attribute here, yet change the colours drawn.
  matchMedia("(forced-colors: active)").addEventListener("change", changed);
  return {
    scheme: () => scheme,
    highContrast,
    choose(next) {
      scheme = next;
      remember(SCHEME, scheme === "system" ? undefined : scheme);
      apply();
    },
    toggleContrast() {
      const next = !highContrast();
      // Following the system's again once they agree.
      contrast = next === more.matches ? undefined : next;
      remember(CONTRAST, contrast === undefined ? undefined : contrast ? "high" : "normal");
      apply();
    },
  };
}
