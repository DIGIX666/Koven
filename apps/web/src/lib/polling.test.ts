import { afterEach, describe, expect, it, vi } from "vitest";

import { SequentialPoller } from "./polling";

afterEach(() => vi.useRealTimers());

describe("SequentialPoller", () => {
  it("never overlaps slow refresh requests", async () => {
    vi.useFakeTimers();
    let resolveFirst: ((value: string) => void) | undefined;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<string>(resolve => { resolveFirst = resolve; }))
      .mockResolvedValue("second");
    const data = vi.fn();
    const poller = new SequentialPoller(load, 2_000, { data, error: vi.fn(), refreshing: vi.fn() });

    poller.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);

    resolveFirst?.("first");
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    expect(data).toHaveBeenCalledWith("first");
    poller.stop();
  });

  it("aborts an in-flight request when stopped", async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | undefined;
    const load = vi.fn((signal: AbortSignal) => {
      receivedSignal = signal;
      return new Promise<string>(() => undefined);
    });
    const poller = new SequentialPoller(load, 2_000, { data: vi.fn(), error: vi.fn(), refreshing: vi.fn() });

    poller.start();
    await vi.advanceTimersByTimeAsync(2_000);
    poller.stop();
    expect(receivedSignal?.aborted).toBe(true);
  });
});
