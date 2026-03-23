/**
 * Simple token-bucket rate limiter for browser automation safety.
 * Tracks action counts per platform and enforces per-hour limits.
 */

interface BucketState {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, BucketState>();

const LIMITS: Record<string, { maxPerHour: number }> = {
  linkedin: { maxPerHour: 30 },
  twitter: { maxPerHour: 120 },
  reddit: { maxPerHour: 30 },
};

export function canAct(platform: string): boolean {
  const limit = LIMITS[platform.toLowerCase()];
  if (!limit) return true;

  const now = Date.now();
  const bucket = buckets.get(platform) ?? { count: 0, windowStart: now };

  if (now - bucket.windowStart > 3_600_000) {
    buckets.set(platform, { count: 0, windowStart: now });
    return true;
  }

  return bucket.count < limit.maxPerHour;
}

export function recordAction(platform: string): void {
  const now = Date.now();
  const bucket = buckets.get(platform) ?? { count: 0, windowStart: now };

  if (now - bucket.windowStart > 3_600_000) {
    buckets.set(platform, { count: 1, windowStart: now });
  } else {
    buckets.set(platform, { ...bucket, count: bucket.count + 1 });
  }
}

export function getActionCount(platform: string): number {
  const now = Date.now();
  const bucket = buckets.get(platform);
  if (!bucket || now - bucket.windowStart > 3_600_000) return 0;
  return bucket.count;
}

/**
 * Returns a random delay in ms between min and max for human-like pacing.
 */
export function randomDelay(minMs = 2000, maxMs = 8000): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}
