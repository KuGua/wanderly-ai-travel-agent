"use client";

import { ArrowUp, MessageCircle, Sparkles, X } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type PrototypeMessage = {
  id: number;
  body: string;
};

type TravelAgentChatProps = {
  open: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  selectedPlace?: {
    name: string;
    context: string;
  } | null;
};

export function TravelAgentChat({ open, onOpen, onDismiss, selectedPlace }: TravelAgentChatProps) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<PrototypeMessage[]>([]);
  const panelInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) panelInputRef.current?.focus();
  }, [open]);

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;

    setMessages((current) => [...current, { id: current.length + 1, body }]);
    setDraft("");
    onOpen();
  }

  function closeConversation() {
    setExpanded(false);
    onDismiss();
  }

  function askAboutSelectedPlace() {
    if (selectedPlace) setDraft(`Tell me about ${selectedPlace.name}`);
  }

  if (!open) {
    return (
      <>
      <button type="button" onClick={onOpen} className="absolute bottom-20 right-4 z-40 rounded-full border border-white/80 bg-white/85 px-3 py-1.5 text-[11px] font-bold text-primary shadow-md backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60 md:bottom-24 md:right-6">
        Chat history
      </button>
      <form onSubmit={submitMessage} className="wanderly-liquid-glass absolute inset-x-3 bottom-3 z-40 flex min-h-14 items-center gap-2 rounded-full p-1.5 pl-4 md:inset-x-auto md:bottom-6 md:right-6 md:w-[min(420px,calc(100%-2rem))]" aria-label="Start a conversation with Wanderly Agent">
        <Sparkles aria-hidden="true" className="size-4 shrink-0 text-primary" />
        <input value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Ask Wanderly" placeholder="Where do you want to go?" className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:outline-none" />
        <button type="submit" aria-label="Send message" className="grid size-11 shrink-0 place-items-center rounded-full bg-sidebar text-white shadow-[0_8px_24px_rgb(8_47_63/28%)] transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70">
          <ArrowUp aria-hidden="true" className="size-5" />
        </button>
      </form>
      </>
    );
  }

  const conversation = (
    <aside role="dialog" aria-label="Wanderly Agent conversation" data-expanded={expanded ? "true" : "false"} className={`flex flex-col overflow-hidden shadow-[0_28px_90px_rgb(8_47_63/28%)] transition-[inset,height,border-radius] duration-300 ${expanded ? "fixed inset-0 z-[100] h-dvh rounded-none" : "absolute inset-x-3 bottom-3 z-50 h-[43dvh] min-h-[300px] rounded-[28px] md:inset-y-6 md:left-auto md:right-6 md:h-auto md:min-h-0 md:w-[min(420px,calc(100%-2rem))]"}`}>
      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden border-x border-t border-white/80 bg-white md:border ${expanded ? "rounded-none" : "rounded-t-[28px] md:rounded-[28px]"}`}>
        <header className="relative flex items-center gap-2.5 border-b border-[#dbe8e5] px-3 pb-1 pt-2.5">
          <button type="button" onClick={() => setExpanded((current) => !current)} aria-label={expanded ? "Collapse conversation" : "Expand conversation"} className="absolute left-1/2 top-1 -translate-x-1/2 rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
            {expanded ? "Collapse" : "Expand"}
          </button>
          <span className="grid size-7 place-items-center rounded-[10px] bg-sidebar text-white shadow-sm">
            <MessageCircle aria-hidden="true" className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-black tracking-[-0.025em] text-sidebar">Wanderly Agent</p>
          </div>
          <button type="button" onClick={closeConversation} aria-label="Close conversation" className="grid size-7 place-items-center rounded-full bg-sidebar text-white transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar/25">
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto bg-[linear-gradient(180deg,#ffffff_0%,#f6fbf9_100%)] px-5 py-5" aria-live="polite">
          <div className="max-w-[86%] rounded-[20px] rounded-tl-[6px] bg-[#e2f3ee] px-4 py-3 text-sm leading-6 text-foreground">
            <p className="font-bold text-primary">Let&apos;s plan somewhere memorable.</p>
            <p className="mt-1 text-muted-foreground">This is a visual prototype. Agent responses will connect here in the next step.</p>
          </div>
          {messages.map((message) => (
            <p key={message.id} className="ml-auto max-w-[86%] rounded-[20px] rounded-tr-[6px] bg-sidebar px-4 py-3 text-sm leading-6 text-white shadow-sm">
              {message.body}
            </p>
          ))}
        </div>
      </div>

      <form onSubmit={submitMessage} className="bg-white px-3 pb-3 pt-2">
        {selectedPlace ? (
          <button type="button" onClick={askAboutSelectedPlace} className="mb-1.5 flex h-5 max-w-full items-center rounded-full border border-white/80 bg-[#dff3ed]/90 px-2.5 text-[10px] font-bold text-primary shadow-sm backdrop-blur hover:bg-[#d2eee6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">
            <span className="truncate">Ask about {selectedPlace.name} · {selectedPlace.context}</span>
          </button>
        ) : null}
        <div className="wanderly-liquid-glass flex min-h-14 items-center gap-2 rounded-full p-1.5 pl-4">
          <input ref={panelInputRef} value={draft} onChange={(event) => setDraft(event.target.value)} aria-label="Message Wanderly Agent" placeholder="Ask about your next trip…" className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:outline-none" />
          <button type="submit" aria-label="Send message" className="grid size-11 shrink-0 place-items-center rounded-full bg-sidebar text-white shadow-md transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70">
            <ArrowUp aria-hidden="true" className="size-5" />
          </button>
        </div>
      </form>
    </aside>
  );

  return expanded && typeof document !== "undefined"
    ? createPortal(conversation, document.body)
    : conversation;
}
