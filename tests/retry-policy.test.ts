import { describe, it, expect } from "vitest";
import { RetryPolicy, computeNextDelay } from "../src/retry-policy";

describe("computeNextDelay — backoff math", () => {
  it("first failure (attempts=0) is bounded by baseMs", () => {
    // With deterministic RNG = 1, jittered = ceiling. ceiling = base.
    const d = computeNextDelay(0, undefined, { baseMs: 1000 }, () => 1);
    expect(d).toBe(1000);
  });

  it("scales exponentially with attempts", () => {
    const r = () => 1; // deterministic ceiling
    expect(computeNextDelay(0, undefined, { baseMs: 1000, factor: 2 }, r)).toBe(1000);
    expect(computeNextDelay(1, undefined, { baseMs: 1000, factor: 2 }, r)).toBe(2000);
    expect(computeNextDelay(2, undefined, { baseMs: 1000, factor: 2 }, r)).toBe(4000);
    expect(computeNextDelay(3, undefined, { baseMs: 1000, factor: 2 }, r)).toBe(8000);
  });

  it("clamps at maxMs", () => {
    const d = computeNextDelay(10, undefined, { baseMs: 1000, factor: 2, maxMs: 5000 }, () => 1);
    expect(d).toBe(5000);
  });

  it("full jitter randomises between 0 and ceiling", () => {
    // With RNG = 0.5, result = ceiling * 0.5.
    const d = computeNextDelay(3, undefined, { baseMs: 1000, factor: 2 }, () => 0.5);
    expect(d).toBe(4000); // 8000 * 0.5
  });

  it("Retry-After overrides when larger than computed window", () => {
    const d = computeNextDelay(0, 30_000, { baseMs: 1000 }, () => 1);
    expect(d).toBe(30_000);
  });

  it("Retry-After is honoured ABOVE maxMs (server is the authority on its own pressure)", () => {
    // Pre-fix the policy clamped server-supplied Retry-After to maxMs
    // (60s default) — a "Retry-After: 120" got truncated to 60s and we
    // hammered an already-rate-limited endpoint twice as fast as it
    // asked. New contract honours the server delay as-is. Audit P1 #8.
    const d = computeNextDelay(0, 120_000, { baseMs: 1000, maxMs: 60_000 }, () => 1);
    expect(d).toBe(120_000);
  });

  it("Retry-After is capped at an absolute 24h sanity guard", () => {
    // Defence against server bugs / HTTP-date clock-skew that could
    // wedge the queue for years. 24h is the upper bound; anything
    // beyond truncates.
    const day = 24 * 60 * 60 * 1000;
    const d = computeNextDelay(0, day * 10, { baseMs: 1000, maxMs: 60_000 }, () => 1);
    expect(d).toBe(day);
  });

  it("Retry-After at exactly maxMs still honoured (boundary check)", () => {
    const d = computeNextDelay(0, 60_000, { baseMs: 1000, maxMs: 60_000 }, () => 1);
    expect(d).toBe(60_000);
  });

  it("ignores Retry-After when smaller than computed window (we wait longer)", () => {
    const d = computeNextDelay(4, 100, { baseMs: 1000, factor: 2 }, () => 1);
    // 1000 * 2^4 = 16000 > 100
    expect(d).toBe(16000);
  });

  it("never returns negative or NaN", () => {
    const d = computeNextDelay(0, undefined, undefined, () => 0);
    expect(d).toBe(0);
    expect(Number.isFinite(d)).toBe(true);
  });

  it("attempts past 30 don't overflow Infinity", () => {
    const d = computeNextDelay(1000, undefined, { baseMs: 1, maxMs: 60_000 }, () => 1);
    expect(d).toBe(60_000);
  });
});

describe("RetryPolicy", () => {
  it("tracks consecutive failures", () => {
    const p = new RetryPolicy({ baseMs: 100 });
    expect(p.consecutiveFailures).toBe(0);
    p.nextDelay(undefined, () => 1);
    p.nextDelay(undefined, () => 1);
    expect(p.consecutiveFailures).toBe(2);
  });

  it("recordSuccess resets the counter", () => {
    const p = new RetryPolicy({ baseMs: 100 });
    p.nextDelay(undefined, () => 1);
    p.nextDelay(undefined, () => 1);
    p.recordSuccess();
    expect(p.consecutiveFailures).toBe(0);
  });

  it("flips isWarning past the failuresBeforeWarn threshold", () => {
    const p = new RetryPolicy({ baseMs: 1, failuresBeforeWarn: 3 });
    p.nextDelay(undefined, () => 1);
    p.nextDelay(undefined, () => 1);
    expect(p.isWarning).toBe(false);
    p.nextDelay(undefined, () => 1);
    expect(p.isWarning).toBe(true);
  });
});
