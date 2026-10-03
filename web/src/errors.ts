// Failures as the user or an agent reads them.

export function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}
