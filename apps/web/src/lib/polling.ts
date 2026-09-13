"use client";

import { useEffect, useRef, useState } from "react";

export interface PollingState<T> {
  data: T | undefined;
  error: string | undefined;
  refreshing: boolean;
  updatedAt: number | undefined;
}

interface PollingCallbacks<T> {
  data(value: T): void;
  error(error: unknown): void;
  refreshing(value: boolean): void;
}

/** Schedules the next refresh only after the current request has settled. */
export class SequentialPoller<T> {
  private active = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;

  constructor(
    private readonly load: (signal: AbortSignal) => Promise<T>,
    private readonly intervalMs: number,
    private readonly callbacks: PollingCallbacks<T>,
  ) {}

  start(): void {
    if (this.active) return;
    this.active = true;
    this.schedule();
  }

  stop(): void {
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
  }

  private schedule(): void {
    this.timer = setTimeout(() => void this.poll(), this.intervalMs);
  }

  private async poll(): Promise<void> {
    this.controller = new AbortController();
    this.callbacks.refreshing(true);
    try {
      const value = await this.load(this.controller.signal);
      if (this.active) this.callbacks.data(value);
    } catch (error) {
      if (this.active && !(error instanceof Error && error.name === "AbortError")) this.callbacks.error(error);
    } finally {
      if (this.active) {
        this.callbacks.refreshing(false);
        this.schedule();
      }
    }
  }
}

/** Polls sequentially so a slow service can never accumulate overlapping requests. */
export function usePollingResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  initialData: T | undefined,
  intervalMs: number,
): PollingState<T> {
  const loadRef = useRef(load);
  const [state, setState] = useState<PollingState<T>>({
    data: initialData,
    error: undefined,
    refreshing: initialData === undefined,
    updatedAt: initialData === undefined ? undefined : Date.now(),
  });

  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    const poller = new SequentialPoller(
      signal => loadRef.current(signal),
      intervalMs,
      {
        data: data => setState({ data, error: undefined, refreshing: false, updatedAt: Date.now() }),
        error: error => setState(current => ({
          ...current,
          error: error instanceof Error ? error.message : "Unable to refresh dashboard data",
        })),
        refreshing: refreshing => setState(current => ({ ...current, refreshing })),
      },
    );
    poller.start();
    return () => poller.stop();
  }, [intervalMs]);

  return state;
}
