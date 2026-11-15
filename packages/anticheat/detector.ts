interface Window {
  start: number;
  total: number;
  consecutive: number;
}

/** Score completed, contiguous one-second samples; ignore gaps between samples. */
export class WindowDetector {
  private readonly windows = new Map<string, Window>();

  clear(key: string) { this.windows.delete(key); }

  sample(key: string, amount: number, now: number, limit: number, repeat = 2) {
    const current = this.windows.get(key);
    if (!current || now < current.start || now - current.start >= 2200) {
      this.windows.set(key, { start: now, total: amount, consecutive: 0 });
      return null;
    }
    const elapsed = now - current.start;
    if (elapsed < 1000) {
      current.total += amount;
      return null;
    }
    const rate = current.total * 1000 / elapsed;
    const consecutive = rate >= limit ? current.consecutive + 1 : 0;
    this.windows.set(key, { start: now, total: amount, consecutive });
    return consecutive >= repeat ? { rate, consecutive } : null;
  }
}
