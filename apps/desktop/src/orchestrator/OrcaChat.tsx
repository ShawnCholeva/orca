import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import "./orca-chat.css";

type Message =
  | { id: string; kind: "user"; t: string; text: string }
  | { id: string; kind: "orca"; t: string; text: string };

const INITIAL: Message[] = [
  {
    id: "o0",
    kind: "orca",
    t: "",
    text: "Tell me what you want to coordinate. I will route it to the right sessions and surface what needs your input.",
  },
];

function timestamp(): string {
  return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function OrcaChat() {
  const [messages, setMessages] = useState<Message[]>(INITIAL);
  const [draft, setDraft] = useState("");
  const [thinking, setThinking] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, thinking]);

  useEffect(() => {
    return () => {
      if (replyTimer.current !== null) clearTimeout(replyTimer.current);
    };
  }, []);

  function send(): void {
    const t = draft.trim();
    if (!t) return;
    const stamp = timestamp();
    setMessages((m) => [...m, { id: `u${Date.now()}`, kind: "user", t: stamp, text: t }]);
    setDraft("");
    setThinking(true);
    replyTimer.current = setTimeout(() => {
      setThinking(false);
      setMessages((m) => [
        ...m,
        {
          id: `o${Date.now()}`,
          kind: "orca",
          t: timestamp(),
          text: "I will coordinate that. Delegating to the most relevant active sessions and queueing follow-ups.",
        },
      ]);
    }, 1100);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const canSend = draft.trim().length > 0;

  return (
    <div className="orca-chat">
      <div ref={scrollRef} className="orca-chat-scroll scroll">
        {messages.map((m) => (
          <ChatMessage key={m.id} m={m} />
        ))}
        {thinking && <ThinkingRow />}
      </div>

      <div className="orca-chat-compose">
        <div className="orca-chat-input">
          <CommandIcon />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ask Orca to plan, delegate, escalate, or summarize…"
            rows={2}
            aria-label="Message Orca"
          />
          <div className="orca-chat-input-actions">
            <span className="mono orca-chat-send-hint">↵ send</span>
            <button
              type="button"
              className={`orca-chat-send orca-chat-send--${canSend ? "primary" : "quiet"}`}
              onClick={send}
              disabled={!canSend}
              aria-label="Send message"
            >
              <ArrowRightIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatMessage({ m }: { m: Message }) {
  if (m.kind === "user") {
    return (
      <div className="msg msg--user">
        <div className="mono msg-meta">you · {m.t}</div>
        <div className="msg-bubble msg-bubble--user">{m.text}</div>
      </div>
    );
  }
  return (
    <div className="msg msg--orca">
      <OrcaMark />
      <div className="msg-body">
        <div className="mono msg-meta">orca{m.t ? ` · ${m.t}` : ""}</div>
        <div className="msg-text">{m.text}</div>
      </div>
    </div>
  );
}

function ThinkingRow() {
  return (
    <div className="msg msg--orca">
      <OrcaMark />
      <div className="thinking-bubble">
        <span className="thinking-label">routing</span>
        <span className="thinking-dots">
          <span style={{ animationDelay: "0s" }} />
          <span style={{ animationDelay: "0.18s" }} />
          <span style={{ animationDelay: "0.36s" }} />
        </span>
      </div>
    </div>
  );
}

function OrcaMark() {
  return (
    <div className="orca-mark" aria-hidden>
      <svg width="14" height="14" viewBox="0 0 14 14">
        <circle cx="7" cy="7" r="1.6" fill="#fff" />
        <circle cx="7" cy="7" r="3.5" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="1" />
        <circle cx="7" cy="7" r="5.5" fill="none" stroke="rgba(255,255,255,0.30)" strokeWidth="1" />
      </svg>
    </div>
  );
}

function CommandIcon() {
  return (
    <svg className="orca-chat-input-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M18 3a3 3 0 0 0-3 3v3h3a3 3 0 1 0 0-6Z" />
      <path d="M9 18a3 3 0 1 0 3-3H9v3Z" />
      <path d="M3 6a3 3 0 0 1 3-3v6H3a3 3 0 0 1 0-6Z" />
      <path d="M15 21a3 3 0 0 0 3-3v-3h-3v6Z" />
      <path d="M9 9h6v6H9z" />
    </svg>
  );
}

function ArrowRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 5l7 7-7 7" />
    </svg>
  );
}
