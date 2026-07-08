import { randomUUID } from "node:crypto";

export interface BackgroundFailureNotice {
  id: string;
  label: string;
  incident: number;
}

export interface BackgroundFailureReporter {
  report(label: string, options?: { episode?: string; notifyAfter?: number }): void;
  resolve(episode: string): void;
}

export interface FailureCycle {
  succeeded(): void;
  failed(): void;
  inconclusive(): void;
  finish(): void;
}

interface EpisodeState {
  label: string;
  notifyAfter: number;
  attempts: number;
  notified: boolean;
}

export function createBackgroundFailureReporter(options: {
  runId?: string;
  onOperational(label: string): void;
  onDurable(notice: BackgroundFailureNotice): void;
}): BackgroundFailureReporter {
  const runId = options.runId ?? randomUUID();
  if (!/^[A-Za-z0-9-]+$/u.test(runId)) throw new Error("invalid background failure run id");
  const episodes = new Map<string, EpisodeState>();
  let incident = 0;

  function notify(label: string, state?: EpisodeState): void {
    incident += 1;
    try {
      options.onDurable({ id: `background-failure:${runId}:${incident}`, label, incident });
      if (state) state.notified = true;
    } catch { /* Durable reporting is retried by a later episode attempt. */ }
  }

  return {
    report(label, reportOptions = {}) {
      const notifyAfter = reportOptions.notifyAfter ?? 1;
      if (!Number.isSafeInteger(notifyAfter) || notifyAfter < 1) throw new Error("invalid background failure notification threshold");
      try { options.onOperational(label); }
      catch { /* Operational reporting cannot block durable reporting. */ }
      if (!reportOptions.episode) {
        notify(label);
        return;
      }
      let state = episodes.get(reportOptions.episode);
      if (!state) {
        state = { label, notifyAfter, attempts: 0, notified: false };
        episodes.set(reportOptions.episode, state);
      } else if (state.label !== label || state.notifyAfter !== notifyAfter) {
        throw new Error("background failure episode configuration changed");
      }
      state.attempts += 1;
      if (!state.notified && state.attempts >= state.notifyAfter) notify(label, state);
    },
    resolve(episode) { episodes.delete(episode); },
  };
}

export function createFailureCycle(options: { onFailed(): void; onResolved(): void }): FailureCycle {
  let hasFailure = false;
  let hasInconclusive = false;
  let finished = false;
  const ensureActive = () => {
    if (finished) throw new Error("background failure cycle already finished");
  };
  return {
    succeeded() { ensureActive(); },
    failed() { ensureActive(); hasFailure = true; },
    inconclusive() { ensureActive(); hasInconclusive = true; },
    finish() {
      ensureActive();
      finished = true;
      if (hasFailure) options.onFailed();
      else if (!hasInconclusive) options.onResolved();
    },
  };
}
