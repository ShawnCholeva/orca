import { useState } from "react";

export interface AgentParaphrasedMessageProps {
  body: string;
  rawAgentText?: string | null;
  whyRationale?: string | null;
}

export function AgentParaphrasedMessage({ body, rawAgentText, whyRationale }: AgentParaphrasedMessageProps) {
  const [showRaw, setShowRaw] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  return (
    <div className="orca-agent-paraphrased">
      <div className="orca-agent-paraphrased-body">{body}</div>
      <div className="orca-agent-paraphrased-meta">
        {rawAgentText ? (
          <button type="button" className="orca-paraphrased-toggle" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? "▾" : "▸"} Show raw agent transcript
          </button>
        ) : null}
        {whyRationale ? (
          <button type="button" className="orca-why" onClick={() => setShowWhy((v) => !v)}>ⓘ Why?</button>
        ) : null}
      </div>
      {showRaw && rawAgentText ? <pre className="orca-agent-raw">{rawAgentText}</pre> : null}
      {showWhy && whyRationale ? <div className="orca-why-body">{whyRationale}</div> : null}
    </div>
  );
}
