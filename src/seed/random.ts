/**
 * Deterministic pseudo-random number generator for synthetic data generation.
 *
 * Seeded and reproducible on purpose. A demo dataset that changes on every run
 * is impossible to reason about: you cannot tell whether retrieval improved
 * because you fixed `summary_text` or because the dice fell differently. Same
 * seed, same 80 cases, every time, on every machine.
 *
 * mulberry32 — small, fast, and statistically fine for generating fake flight
 * delays. Not cryptographic; never use it for anything that needs real entropy.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, max], inclusive. */
  public int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  public float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability `p`. */
  public bool(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform choice from a non-empty array. */
  public pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('Rng.pick: cannot pick from an empty array');
    }
    const item = items[Math.floor(this.next() * items.length)];
    // Unreachable given the bounds above, but noUncheckedIndexedAccess cannot
    // know that and a non-null assertion would just hide a real bug later.
    if (item === undefined) {
      throw new Error('Rng.pick: index out of range');
    }
    return item;
  }

  /** Weighted choice. Weights need not sum to 1. */
  public weighted<T>(entries: ReadonlyArray<readonly [T, number]>): T {
    let total = 0;
    for (const [, weight] of entries) {
      if (weight < 0) throw new RangeError('Rng.weighted: negative weight');
      total += weight;
    }
    if (total <= 0) {
      throw new RangeError('Rng.weighted: weights must sum to more than zero');
    }

    let roll = this.next() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }

    // Floating-point drift can leave `roll` fractionally above zero on the last
    // entry. Fall back to it rather than returning undefined.
    const last = entries[entries.length - 1];
    if (last === undefined) {
      throw new RangeError('Rng.weighted: no entries');
    }
    return last[0];
  }

  /**
   * Integer from a rough normal distribution, clamped to [min, max].
   *
   * Real delay durations cluster rather than spreading uniformly, and clustered
   * data makes for a more convincing similarity demo. Irwin–Hall with n=3 is
   * plenty for that.
   */
  public normalInt(mean: number, spread: number, min: number, max: number): number {
    const unit = (this.next() + this.next() + this.next()) / 3; // ~normal, mean 0.5
    const value = Math.round(mean + (unit - 0.5) * 2 * spread);
    return Math.min(max, Math.max(min, value));
  }

  /** Fisher-Yates shuffle, returning a new array. */
  public shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const a = out[i];
      const b = out[j];
      if (a === undefined || b === undefined) continue;
      out[i] = b;
      out[j] = a;
    }
    return out;
  }
}
