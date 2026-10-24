export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

const SWEEP_INTERVAL_MS = 60_000;

// State is process-local: N instances allow N times the limit.
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweepAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.lastSweepAt = now();
  }

  static perMinute(limit: number, now?: () => number): TokenBucketLimiter {
    return new TokenBucketLimiter(limit, limit / 60_000, now);
  }

  consume(key: string): RateLimitDecision {
    const now = this.now();
    this.sweep(now);

    const tokens = this.tokensAt(this.buckets.get(key), now);
    if (tokens >= 1) {
      this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    this.buckets.set(key, { tokens, updatedAt: now });
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((1 - tokens) / this.refillPerMs / 1000),
      ),
    };
  }

  private tokensAt(bucket: Bucket | undefined, now: number): number {
    if (!bucket) return this.capacity;
    return Math.min(
      this.capacity,
      bucket.tokens + (now - bucket.updatedAt) * this.refillPerMs,
    );
  }

  // A full bucket is indistinguishable from no bucket, so dropping it bounds memory to keys
  // that were active recently.
  private sweep(now: number): void {
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    for (const [key, bucket] of this.buckets) {
      if (this.tokensAt(bucket, now) >= this.capacity) this.buckets.delete(key);
    }
  }

  get trackedKeys(): number {
    return this.buckets.size;
  }
}
