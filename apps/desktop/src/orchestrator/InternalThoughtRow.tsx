import { useState } from "react";

export interface InternalThoughtRowProps {
  body: string;
  kind?: string;
  whyRationale?: string | null;
}

export function InternalThoughtRow({ body, kind, whyRationale }: InternalThoughtRowProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`orca-internal-thought orca-internal-thought--${kind ?? "generic"}`}>
      <span className="orca-internal-thought-icon" aria-hidden="true">⟡</span>
      <span className="orca-internal-thought-body">{body}</span>
      {whyRationale ? (
        <>
          <button type="button" className="orca-why" onClick={() => setOpen((v) => !v)}>ⓘ Why?</button>
          {open ? <div className="orca-why-body">{whyRationale}</div> : null}
        </>
      ) : null}
    </div>
  );
}
