// Waits for background work (running worker loops, separate processes) to reach a state, failing
// with a description once the deadline passes. It polls a condition; it never stands in for one.
export async function waitFor(
  condition: () => Promise<boolean>,
  options: { timeoutMs: number; describe: () => Promise<string> },
): Promise<void> {
  const deadline = Date.now() + options.timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error(
        `Condition not met within ${options.timeoutMs} ms.\n${await options.describe()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
