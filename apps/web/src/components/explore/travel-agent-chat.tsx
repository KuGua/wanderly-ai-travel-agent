"use client";

import { ArrowUp, LoaderCircle, MessageCircle, RotateCw, Sparkles, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { ConversationMessage, ConversationPlace, ConversationTurnRequest } from "@/lib/api/contracts";
import { TravelApiError } from "@/lib/api/errors";
import { useCreateThread, useOwnerConversation, useSubmitConversationTurn } from "@/lib/query/hooks";

export const CHAT_THREAD_STORAGE_KEY = "wanderly.privateChatThreadId.v1";

type PendingTurn = ConversationTurnRequest;

type TravelAgentChatProps = {
  open: boolean;
  onOpen: () => void;
  onDismiss: () => void;
  selectedPlace?: { place: ConversationPlace; context: string } | null;
};

export function TravelAgentChat({ open, onOpen, onDismiss, selectedPlace }: TravelAgentChatProps) {
  const t = useTranslations("explore.chat");
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [threadId, setThreadId] = useState<string | null>(readStoredThreadId);
  const [sessionMessages, setSessionMessages] = useState<ConversationMessage[]>([]);
  const [refusalMessageIds, setRefusalMessageIds] = useState<Set<string>>(new Set());
  const [pendingTurn, setPendingTurn] = useState<PendingTurn | null>(null);
  const [requestError, setRequestError] = useState<unknown>(null);
  const panelInputRef = useRef<HTMLInputElement>(null);

  const conversation = useOwnerConversation(threadId);
  const createThread = useCreateThread();
  const submitTurn = useSubmitConversationTurn();
  const isSending = createThread.isPending || submitTurn.isPending;

  const resetThreadSession = useCallback(() => {
    clearStoredThreadId();
    setThreadId(null);
    setSessionMessages([]);
    setRefusalMessageIds(new Set());
    setPendingTurn(null);
    setRequestError(null);
  }, []);

  useEffect(() => {
    if (open) panelInputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (conversation.error instanceof TravelApiError && conversation.error.statusCode === 404) {
      const clearPointer = window.setTimeout(resetThreadSession, 0);
      return () => window.clearTimeout(clearPointer);
    }
  }, [conversation.error, resetThreadSession]);

  const messages = useMemo(
    () => mergeMessages(conversation.data?.messages ?? [], sessionMessages),
    [conversation.data?.messages, sessionMessages],
  );
  const visibleError = requestError ?? (
    conversation.error instanceof TravelApiError && conversation.error.statusCode !== 404
      ? conversation.error
      : null
  );

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || isSending) return;

    const turn: PendingTurn = {
      requestId: crypto.randomUUID(),
      question,
      ...(selectedPlace ? { place: selectedPlace.place } : {}),
    };
    setPendingTurn(turn);
    setRequestError(null);
    setDraft("");
    onOpen();
    void sendTurn(turn);
  }

  async function sendTurn(turn: PendingTurn) {
    setRequestError(null);
    try {
      let targetThreadId = threadId;
      if (!targetThreadId) {
        const created = await createThread.mutateAsync({
          title: selectedPlace ? t("threadTitleWithPlace", { name: selectedPlace.place.name }) : t("threadTitle"),
        });
        targetThreadId = created.id;
        storeThreadId(targetThreadId);
        setThreadId(targetThreadId);
      }

      const response = await submitTurn.mutateAsync({ threadId: targetThreadId, input: turn });
      setSessionMessages((current) => mergeMessages(current, [response.userMessage, response.assistantMessage]));
      if (response.responseMode === "SAFE_REFUSAL") {
        setRefusalMessageIds((current) => new Set(current).add(response.assistantMessage.id));
      }
      setPendingTurn(null);
    } catch (error) {
      if (error instanceof TravelApiError && error.statusCode === 404) {
        resetThreadSession();
        return;
      }
      setRequestError(error);
    }
  }

  function retryPendingTurn() {
    if (!pendingTurn || isSending) return;
    void sendTurn(pendingTurn);
  }

  function closeConversation() {
    setExpanded(false);
    onDismiss();
  }

  function askAboutSelectedPlace() {
    if (selectedPlace) setDraft(t("askQuestion", { name: selectedPlace.place.name }));
  }

  const submitButton = (
    <button type="submit" aria-label={t("sendAria")} disabled={isSending} className="grid size-11 shrink-0 place-items-center rounded-full bg-sidebar text-white shadow-md transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/70">
      {isSending ? <LoaderCircle aria-hidden="true" className="size-5 animate-spin motion-reduce:animate-none" /> : <ArrowUp aria-hidden="true" className="size-5" />}
    </button>
  );

  if (!open) {
    return (
      <>
        <button type="button" onClick={onOpen} className="absolute bottom-20 right-4 z-40 rounded-full border border-white/80 bg-white/85 px-3 py-1.5 text-[11px] font-bold text-primary shadow-md backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-white/60 landscape:bottom-24 landscape:right-6">{t("history")}</button>
        <form onSubmit={submitMessage} className="wanderly-liquid-glass absolute bottom-3 left-1/2 z-40 flex min-h-14 w-[calc(100%-3rem)] -translate-x-1/2 items-center gap-2 rounded-full p-1.5 pl-4 landscape:bottom-6 landscape:left-auto landscape:right-6 landscape:w-[min(calc(40vw-1.5rem),calc(66.667dvh-3.5rem),596px)] landscape:translate-x-0" aria-label={t("startAria")}>
          <Sparkles aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <input value={draft} disabled={isSending} onChange={(event) => setDraft(event.target.value)} aria-label={t("startInputAria")} placeholder={t("startPlaceholder")} className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60" />
          {submitButton}
        </form>
      </>
    );
  }

  const conversationPanel = (
    <aside role="dialog" aria-label={t("dialogAria")} data-expanded={expanded ? "true" : "false"} className={`flex flex-col overflow-hidden shadow-[0_28px_90px_rgb(8_47_63/28%)] transition-[inset,height,width,border-radius] duration-300 ${expanded ? "fixed inset-0 z-[100] h-dvh rounded-none" : "absolute inset-x-3 bottom-3 z-50 h-[60dvh] min-h-[300px] rounded-[28px] landscape:inset-x-auto landscape:bottom-6 landscape:left-auto landscape:right-6 landscape:h-[min(60vw,calc(100dvh-3rem),852px)] landscape:min-h-0 landscape:w-[min(40vw,calc(66.667dvh-2rem),620px)]"}`}>
      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden border-x border-t border-white/80 bg-white landscape:border ${expanded ? "rounded-none" : "rounded-t-[28px] landscape:rounded-[28px]"}`}>
        <header className="relative flex items-center gap-2.5 border-b border-[#dbe8e5] px-3 pb-1 pt-2.5">
          <button type="button" onClick={() => setExpanded((current) => !current)} aria-label={expanded ? t("collapse") : t("expand")} className="absolute left-1/2 top-1 -translate-x-1/2 rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30">{expanded ? t("collapse") : t("expand")}</button>
          <span className="grid size-7 place-items-center rounded-[10px] bg-sidebar text-white shadow-sm"><MessageCircle aria-hidden="true" className="size-4" /></span>
          <p className="min-w-0 flex-1 text-sm font-black tracking-[-0.025em] text-sidebar">{t("agentName")}</p>
          <button type="button" onClick={closeConversation} aria-label={t("close")} className="grid size-7 place-items-center rounded-full bg-sidebar text-white transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-sidebar/25"><X aria-hidden="true" className="size-3.5" /></button>
        </header>

        <div className="flex-1 space-y-4 overflow-y-auto bg-[linear-gradient(180deg,#ffffff_0%,#f6fbf9_100%)] px-5 py-5" aria-live="polite">
          {conversation.isLoading ? <p role="status" className="text-sm text-muted-foreground">{t("restoring")}</p> : null}
          {!conversation.isLoading && messages.length === 0 && !pendingTurn ? (
            <div className="max-w-[86%] rounded-[20px] rounded-tl-[6px] bg-[#e2f3ee] px-4 py-3 text-sm leading-6 text-foreground">
              <p className="font-bold text-primary">{t("introTitle")}</p>
              <p className="mt-1 text-muted-foreground">{t("introBody")}</p>
            </div>
          ) : null}
          {messages.map((message) => (
            <article key={message.id} data-role={message.role} className={message.role === "USER" ? "ml-auto max-w-[86%] rounded-[20px] rounded-tr-[6px] bg-sidebar px-4 py-3 text-sm leading-6 text-white shadow-sm" : "max-w-[86%] rounded-[20px] rounded-tl-[6px] bg-[#e2f3ee] px-4 py-3 text-sm leading-6 text-foreground"}>
              <p>{message.content}</p>
              {refusalMessageIds.has(message.id) ? <p className="mt-2 text-[10px] font-black uppercase tracking-[0.1em] text-primary">{t("verificationRequired")}</p> : null}
            </article>
          ))}
          {pendingTurn ? <p data-role="USER" data-pending="true" className="ml-auto max-w-[86%] rounded-[20px] rounded-tr-[6px] bg-sidebar px-4 py-3 text-sm leading-6 text-white shadow-sm opacity-80">{pendingTurn.question}</p> : null}
          {isSending ? <p role="status" className="inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />{t("sending")}</p> : null}
          {visibleError ? (
            <div role="alert" className="rounded-[16px] border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
              <p className="font-bold">{errorMessage(visibleError, t)}</p>
              {pendingTurn && isRetryable(visibleError) ? <button type="button" onClick={retryPendingTurn} disabled={isSending} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-destructive shadow-sm disabled:opacity-50"><RotateCw aria-hidden="true" className="size-3.5" />{t("retry")}</button> : null}
            </div>
          ) : null}
        </div>
      </div>

      <form onSubmit={submitMessage} className="bg-white px-3 pb-3 pt-2">
        {selectedPlace ? <button type="button" onClick={askAboutSelectedPlace} className="mb-1.5 flex h-5 max-w-full items-center rounded-full border border-white/80 bg-[#dff3ed]/90 px-2.5 text-[10px] font-bold text-primary shadow-sm backdrop-blur hover:bg-[#d2eee6] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"><span className="truncate">{t("askAbout", { name: selectedPlace.place.name, context: selectedPlace.context })}</span></button> : null}
        <div className="wanderly-liquid-glass flex min-h-14 items-center gap-2 rounded-full p-1.5 pl-4">
          <input ref={panelInputRef} value={draft} disabled={isSending} onChange={(event) => setDraft(event.target.value)} aria-label={t("messageInputAria")} placeholder={t("messagePlaceholder")} className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-60" />
          {submitButton}
        </div>
      </form>
    </aside>
  );

  return expanded && typeof document !== "undefined" ? createPortal(conversationPanel, document.body) : conversationPanel;
}

function readStoredThreadId(): string | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage.getItem(CHAT_THREAD_STORAGE_KEY); } catch { return null; }
}

function storeThreadId(threadId: string) {
  try { window.localStorage.setItem(CHAT_THREAD_STORAGE_KEY, threadId); } catch { /* optional pointer */ }
}

function clearStoredThreadId() {
  try { window.localStorage.removeItem(CHAT_THREAD_STORAGE_KEY); } catch { /* optional pointer */ }
}

function mergeMessages(current: ConversationMessage[], incoming: ConversationMessage[]) {
  const messages = new Map(current.map((message) => [message.id, message]));
  incoming.forEach((message) => messages.set(message.id, message));
  return [...messages.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function isRetryable(error: unknown) {
  return !(error instanceof TravelApiError) || error.statusCode === null || [404, 502, 504].includes(error.statusCode);
}

function errorMessage(error: unknown, t: ReturnType<typeof useTranslations>) {
  if (error instanceof TravelApiError) {
    if (error.statusCode === 401 || error.statusCode === 403) return t("authenticationRequired");
    if (error.statusCode === 502 || error.statusCode === 504) return t("providerUnavailable");
    if (error.statusCode === 404) return t("threadMissing");
  }
  return t("genericError");
}
