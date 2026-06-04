import { useState } from "react";
import type { PendingApproval } from "@orca/contracts";
import { submitPermissionDecision } from "../api";

export function PermissionApprovalCard({ goalId, pending }: { goalId: string; pending: PendingApproval }) {
  const [submitting, setSubmitting] = useState(false);
  const [decided, setDecided] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

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

  return (
    <div className="orca-chat-approval">
      <p className="orca-chat-approval-tool">
        <span className="mono">{pending.toolName}</span>
        <span className="orca-chat-approval-summary">{pending.summary}</span>
      </p>
      {pending.detail && pending.detail !== pending.summary && (
        <details className="orca-chat-approval-details" onToggle={(e) => setDetailOpen((e.currentTarget as HTMLDetailsElement).open)}>
          <summary className="workflow-banner-subtitle">Details</summary>
          {detailOpen && <pre className="orca-chat-approval-detail">{pending.detail}</pre>}
        </details>
      )}
      <div className="orca-chat-approval-actions">
        <button type="button" className="submit-button" disabled={locked} onClick={() => void decide("allow")}>
          Allow
        </button>
        <button type="button" className="orca-chat-approval-always" disabled={locked} onClick={() => void decide("allow", true)}>
          Always allow
        </button>
        <button type="button" className="orca-chat-approval-deny" disabled={locked} onClick={() => void decide("deny")}>
          Deny
        </button>
      </div>
      {decided && (
        <p className="orca-chat-approval-status mono">{decided === "allow" ? "✓ Allowed" : "✕ Denied"}</p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
