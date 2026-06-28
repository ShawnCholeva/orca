import { useState } from "react";
import type { PendingApproval } from "@orca/contracts";
import { submitPermissionDecision } from "../api";

export function PermissionApprovalCard({ goalId, pending }: { goalId: string; pending: PendingApproval }) {
  const [submitting, setSubmitting] = useState(false);
  const [decided, setDecided] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "allow" | "deny", remember = false) {
    setSubmitting(true);
    setError(null);
    try {
      await submitPermissionDecision(goalId, pending.approvalId, decision, remember);
      setDecided(decision);
    } catch {
      setError("That decision could not be submitted — the request may have expired.");
    } finally {
      setSubmitting(false);
    }
  }

  const locked = submitting || decided !== null;

  // The card is ephemeral: once a decision lands, it disappears (the daemon also
  // drops it from the message so it won't return on reload). A failed decision
  // leaves `decided` null, so the card stays put with its error for a retry.
  if (decided) return null;

  return (
    <div className="orca-chat-approval">
      <div className="orca-chat-approval-header">
        <svg
          className="orca-chat-approval-header-icon"
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span>Permission request</span>
      </div>
      {/* The tool name is already named in the message above ("The agent wants
          to run X."), so the card shows only the concrete command/argument. */}
      <div className="orca-chat-approval-command">
        <svg
          className="orca-chat-approval-command-icon"
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <code className="orca-chat-approval-command-text" title={pending.summary}>{pending.summary}</code>
      </div>
      {pending.detail && pending.detail !== pending.summary ? (
        <div className="orca-chat-approval-detail">{pending.detail}</div>
      ) : null}
      <div className="orca-chat-approval-actions">
        <button type="button" className="orca-chat-approval-allow" disabled={locked} onClick={() => void decide("allow")}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" />
          </svg>
          <span>Allow</span>
        </button>
        {/* Hidden when the provider can't persist a rule (e.g. Codex sets canRemember: false); true/undefined → shown */}
        {pending.canRemember !== false && (
          <button type="button" className="orca-chat-approval-always" disabled={locked} onClick={() => void decide("allow", true)}>
            Always allow
          </button>
        )}
        <button type="button" className="orca-chat-approval-deny" disabled={locked} onClick={() => void decide("deny")}>
          Deny
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
