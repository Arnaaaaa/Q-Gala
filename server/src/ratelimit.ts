import { TUNABLES } from '../../shared/tunables.ts';

/** Token bucket per message type, one instance per connection. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  allow(type: string, now = Date.now()): boolean {
    const rule = TUNABLES.rate[type];
    if (!rule) return false;
    const b = this.buckets.get(type) ?? { tokens: rule.burst, last: now };
    b.tokens = Math.min(rule.burst, b.tokens + ((now - b.last) / 1000) * rule.perSec);
    b.last = now;
    this.buckets.set(type, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
}
