export type Clock = {
  nowMs(): number;
};

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}

export class TestClock implements Clock {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  nowMs(): number {
    return this.value;
  }
  set(value: number): void {
    this.value = value;
  }
  add(deltaMs: number): void {
    this.value += deltaMs;
  }
}
