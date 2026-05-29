export interface MarkDoneConfirmCardProps {
  summary: string;
  onConfirm: () => void;
  onDecline: () => void;
}

export function MarkDoneConfirmCard({ summary, onConfirm, onDecline }: MarkDoneConfirmCardProps) {
  return (
    <div className="orca-mark-done-confirm">
      <p className="orca-mark-done-summary">{summary}</p>
      <p className="orca-mark-done-prompt">Ready to mark this run complete?</p>
      <div className="orca-mark-done-actions">
        <button type="button" className="orca-mark-done-confirm-btn" onClick={onConfirm}>Confirm done</button>
        <button type="button" className="orca-mark-done-decline-btn" onClick={onDecline}>Not yet</button>
      </div>
    </div>
  );
}
