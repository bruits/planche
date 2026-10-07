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
