import { describe, expect, it } from '@jest/globals';
import { backoffSeconds } from './backoff.js';

describe('backoffSeconds', () => {
  it('doubles from 2 seconds per run', () => {
    expect([1, 2, 3, 4, 5].map((run) => backoffSeconds(run, 300))).toEqual([
      2, 4, 8, 16, 32,
    ]);
  });

  it('never exceeds the configured maximum', () => {
    expect(backoffSeconds(9, 300)).toBe(300);
    expect(backoffSeconds(60, 300)).toBe(300);
  });

  it('treats a first or unclaimed run as the base delay', () => {
    expect(backoffSeconds(0, 300)).toBe(2);
  });
});
