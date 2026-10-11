// What the app tells the user, and the work whose failure it would tell, for tests to read.

export function messages() {
  const said: string[] = [];
  const reported: Promise<unknown>[] = [];
  return {
    said,
    say: (text: string) => void said.push(text),
    report: (work: Promise<unknown>) => void reported.push(work),
    settled: () => Promise.all(reported),
  };
}
