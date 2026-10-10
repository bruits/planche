// The bug report form on GitHub, filled in with what the app knows of where it runs.

const FORM = "https://github.com/bruits/planche/issues/new";

export interface Running {
  platform: string;
  version?: string | undefined;
  /** The renderer's backend, or why none started. Missing until the first one is tried. */
  renderer?: string | undefined;
  userAgent: string;
}

export function bugReport({ platform, version, renderer, userAgent }: Running): string {
  const environment = [
    `Platform: ${platform}`,
    ...(version === undefined ? [] : [`Version: ${version}`]),
    ...(renderer === undefined ? [] : [`Renderer: ${renderer}`]),
    `User agent: ${userAgent}`,
  ];
  // GitHub fills a form's field from the parameter named after its `id`.
  const query = new URLSearchParams({
    template: "01-bug-report.yml",
    "environment-info": environment.join("\n"),
  });
  return `${FORM}?${query}`;
}
