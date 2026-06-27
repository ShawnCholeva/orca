import type { CommittedLedger } from "@orca/contracts";

type Props = {
  committed: CommittedLedger;
  versionCount: number;
};

export function LedgerPanel({ committed, versionCount }: Props) {
  return (
    <section className="workflow-panel-card" aria-label="Workflow ledger">
      <div className="workflow-panel-card-header">
        <h4 className="workflow-panel-card-title">Ledger · v{versionCount}</h4>
        <span className="workflow-panel-card-meta">{committed.records.length} records</span>
      </div>

      {committed.records.length === 0 ? (
        <p className="workflow-panel-empty">No ledger records yet.</p>
      ) : (
        <ul className="workflow-ledger-list">
          {committed.records.map((record) => (
            <li key={record.id} className="workflow-ledger-item">
              <div className="workflow-ledger-item-head">
                <span className="workflow-ledger-record-type">{record.recordType}</span>
                <span className="workflow-ledger-status">{record.status}</span>
              </div>
              <p className="workflow-ledger-note">{record.note}</p>
              {record.evidenceRefs.length > 0 && (
                <ul className="workflow-ledger-evidence" aria-label="Evidence">
                  {record.evidenceRefs.map((ref) => (
                    <li key={ref}>{ref}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
