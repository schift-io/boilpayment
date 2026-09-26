/**
 * EC:G4 — Clock DI. All module functions take `clock` as a dependency; nothing calls
 * `Date.now()` directly except the SystemClock implementation itself.
 * Mirrors packages/core/py/src/boilpayment_core/clock.py exactly.
 */
import { Clock, IdGen } from './types.js';

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Fixed point in time for tests/repro. `advance(ms)` moves it forward (or back with a negative ms). */
export class FixedClock implements Clock {
  private current: Date;

  constructor(date: Date) {
    this.current = new Date(date.getTime());
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class UuidIdGen implements IdGen {
  newId(): string {
    return crypto.randomUUID();
  }
}

/** Deterministic, human-readable ids for tests/repro: prefix + incrementing counter. */
export class SequentialIdGen implements IdGen {
  private counter = 0;

  constructor(private readonly prefix: string) {}

  newId(): string {
    this.counter += 1;
    return `${this.prefix}${this.counter}`;
  }
}
