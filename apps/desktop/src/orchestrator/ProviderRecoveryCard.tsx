import { useEffect, useRef, useState } from "react";
import type { AdapterId, ProviderRecoveryCheckpoint } from "@orca/contracts";
import {
  refreshProviderRecovery,
  retryProviderRecovery,
  switchProviderRecovery,
  waitForProviderRecovery,
} from "../api";

export interface ProviderRecoveryCardProps {
  runId: string;
  recovery: ProviderRecoveryCheckpoint;
  onChanged(): void;
}

const MAX_TIMEOUT = 2_147_483_647;

export function ProviderRecoveryCard({ runId, recovery, onChanged }: ProviderRecoveryCardProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // clockReady: true when we know resetAt has passed (or reset is unknown).
  const [clockReady, setClockReady] = useState(() => {
    if (!recovery.resetAt) return true;
    return Date.now() >= Date.parse(recovery.resetAt);
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (clockReady) return;
    if (!recovery.resetAt) {
      setClockReady(true);
      return;
    }
    const resetMs = Date.parse(recovery.resetAt);

    function scheduleNext() {
      const remaining = resetMs - Date.now();
      if (remaining <= 0) {
        setClockReady(true);
        return;
      }
      const delay = Math.min(remaining, MAX_TIMEOUT);
      timerRef.current = setTimeout(() => {
        if (resetMs - Date.now() <= 0) {
          setClockReady(true);
        } else {
          scheduleNext();
        }
      }, delay);
    }

    scheduleNext();
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, [recovery.resetAt, clockReady]);

  // Re-evaluate clockReady when recovery prop changes (e.g. after refresh).
  useEffect(() => {
    if (!recovery.resetAt) {
      setClockReady(true);
      return;
    }
    const ready = Date.now() >= Date.parse(recovery.resetAt);
    setClockReady(ready);
  }, [recovery.resetAt]);

  const retryLocked =
    recovery.mode === "waiting" &&
    recovery.retryKind === "preserved_session" &&
    recovery.resetAt !== null &&
    !clockReady;

  const isBusy = recovery.mode === "retrying" || recovery.mode === "switching";

  function currentProviderActionLabel(): string {
    switch (recovery.mode) {
      case "choose":
        return `Wait for ${recovery.currentProviderName}`;
      case "waiting":
        if (recovery.retryKind === "fresh_session") {
          return `Restart ${recovery.currentProviderName} session`;
        }
        return `Retry ${recovery.currentProviderName}`;
      case "retrying":
        return `Retrying ${recovery.currentProviderName}…`;
      case "switching":
        return "Starting replacement provider…";
    }
  }

  async function handleCurrentProvider() {
    if (submitting || isBusy) return;
    setSubmitting(true);
    setError(null);
    try {
      if (recovery.mode === "choose") {
        await waitForProviderRecovery(runId, { checkpointId: recovery.id });
      } else if (recovery.mode === "waiting") {
        await retryProviderRecovery(runId, { checkpointId: recovery.id });
      }
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Action failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSwitch(adapterId: AdapterId) {
    if (submitting || isBusy) return;
    setSubmitting(true);
    setError(null);
    try {
      await switchProviderRecovery(runId, { checkpointId: recovery.id, adapterId });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Switch failed.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleRefresh() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await refreshProviderRecovery(runId, { checkpointId: recovery.id });
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Refresh failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section
      className="provider-recovery-card"
      aria-label="Provider recovery"
      data-mode={recovery.mode}
    >
      <h3 className="provider-recovery-title">
        {recovery.currentProviderName} reached its session limit
      </h3>
      <p className="provider-recovery-reset">
        {recovery.resetTimeText
          ? `Available again at ${recovery.resetTimeText}`
          : "Reset time unavailable"}
      </p>
      <p className="provider-recovery-note">
        The existing agent session and context will be preserved while waiting.
      </p>
      {recovery.lastError ? (
        <p role="alert" className="provider-recovery-error">
          {recovery.lastError}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="provider-recovery-error">
          {error}
        </p>
      ) : null}
      <div className="provider-recovery-actions">
        <button
          type="button"
          className="provider-recovery-primary-btn"
          disabled={submitting || isBusy || retryLocked}
          onClick={() => void handleCurrentProvider()}
        >
          {currentProviderActionLabel()}
        </button>
        {recovery.choices.length > 0 ? (
          <>
            <ul className="provider-recovery-choices">
              {recovery.choices.map((choice) => (
                <li key={choice.adapterId} className="provider-recovery-choice-row">
                  <button
                    type="button"
                    className="provider-recovery-choice-btn"
                    disabled={submitting || isBusy || !choice.enabled}
                    onClick={() => void handleSwitch(choice.adapterId)}
                  >
                    Switch to {choice.displayName}
                  </button>
                  {!choice.enabled && choice.reason ? (
                    <span className="provider-recovery-choice-reason">{choice.reason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="provider-recovery-refresh-btn"
              disabled={submitting}
              onClick={() => void handleRefresh()}
            >
              Refresh providers
            </button>
          </>
        ) : null}
      </div>
    </section>
  );
}
