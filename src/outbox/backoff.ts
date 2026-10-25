const BACKOFF_BASE_SECONDS = 2;

// Exponential in the number of runs so far: 2s, 4s, 8s, ... capped at maxSeconds.
export function backoffSeconds(runCount: number, maxSeconds: number): number {
  const exponent = Math.max(0, runCount - 1);
  return Math.min(maxSeconds, BACKOFF_BASE_SECONDS * 2 ** exponent);
}
