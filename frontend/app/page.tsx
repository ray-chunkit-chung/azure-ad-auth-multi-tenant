"use client";

import {
  FormEvent,
  KeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { signOut, useAuth } from "../hooks/use-auth";
import {
  ChatMessage,
  ChatSession,
  deleteChatSession,
  getChatSession,
  listChatSessions,
  postChatMessage,
} from "../lib/chat-api";
import {
  getChatApiBaseUrl,
  RuntimeConfigMissingError,
} from "../lib/runtime-config";

const TEMP_USER_MESSAGE_PREFIX = "temp-user-";
const TEMP_ASSISTANT_MESSAGE_PREFIX = "temp-assistant-";
const SLOW_SEND_HINT_DELAY_MS = 1500;

function sortSessionsByUpdatedAt(a: ChatSession, b: ChatSession): number {
  if (a.updatedAt === b.updatedAt) {
    return 0;
  }
  return a.updatedAt > b.updatedAt ? -1 : 1;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong while contacting the chat API.";
}

export default function Home() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading } = useAuth();
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isDeletingSessionId, setIsDeletingSessionId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [showSlowSendHint, setShowSlowSendHint] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const lastAssistantMessageIdRef = useRef<string | null>(null);
  const slowSendTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [chatConfigStatus, setChatConfigStatus] = useState<
    "loading" | "ready" | "missing" | "unavailable"
  >("loading");
  const [chatConfigError, setChatConfigError] = useState<string | null>(null);
  const [chatConfigAttempt, setChatConfigAttempt] = useState(0);

  const orderedSessions = useMemo(
    () => [...sessions].sort(sortSessionsByUpdatedAt),
    [sessions],
  );

  useEffect(() => {
    let cancelled = false;

    async function checkChatConfig() {
      setChatConfigStatus("loading");
      setChatConfigError(null);

      try {
        await getChatApiBaseUrl();
        if (!cancelled) {
          setChatConfigStatus("ready");
        }
      } catch (configError) {
        if (!cancelled) {
          if (configError instanceof RuntimeConfigMissingError) {
            setChatConfigStatus("missing");
            return;
          }

          setChatConfigStatus("unavailable");
          setChatConfigError(toErrorMessage(configError));
        }
      }
    }

    void checkChatConfig();

    return () => {
      cancelled = true;
    };
  }, [chatConfigAttempt]);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, isLoading, router]);

  useEffect(() => {
    if (isLoading || !isAuthenticated || chatConfigStatus !== "ready") {
      return;
    }

    let cancelled = false;

    async function loadSessions() {
      setIsLoadingSessions(true);
      setError(null);

      try {
        const response = await listChatSessions();
        if (cancelled) {
          return;
        }

        setSessions(response.sessions);
        setActiveSessionId((prev) => {
          if (prev && response.sessions.some((session) => session.id === prev)) {
            return prev;
          }

          if (response.sessions.length > 0) {
            return response.sessions[0].id;
          }

          return null;
        });
      } catch (loadError) {
        if (!cancelled) {
          setError(toErrorMessage(loadError));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSessions(false);
        }
      }
    }

    void loadSessions();

    return () => {
      cancelled = true;
    };
  }, [chatConfigStatus, isAuthenticated, isLoading]);

  useEffect(() => {
    if (
      isLoading ||
      !isAuthenticated ||
      chatConfigStatus !== "ready" ||
      !activeSessionId
    ) {
      return;
    }

    const sessionId = activeSessionId;
    let cancelled = false;

    async function loadMessages() {
      setIsLoadingMessages(true);
      setError(null);

      try {
        const response = await getChatSession(sessionId);
        if (cancelled) {
          return;
        }

        setMessages(response.messages);
      } catch (loadError) {
        if (!cancelled) {
          setError(toErrorMessage(loadError));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingMessages(false);
        }
      }
    }

    void loadMessages();

    return () => {
      cancelled = true;
    };
  }, [activeSessionId, chatConfigStatus, isAuthenticated, isLoading]);

  useEffect(() => {
    const lastAssistantMessage = [...messages]
      .reverse()
      .find((message) => message.role === "assistant");

    if (!lastAssistantMessage) {
      lastAssistantMessageIdRef.current = null;
      return;
    }

    const hasNewAssistantMessage =
      lastAssistantMessage.id !== lastAssistantMessageIdRef.current;
    lastAssistantMessageIdRef.current = lastAssistantMessage.id;

    if (!hasNewAssistantMessage) {
      return;
    }

    messagesEndRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [messages]);

  useEffect(() => {
    if (!isSending) {
      if (slowSendTimerRef.current) {
        clearTimeout(slowSendTimerRef.current);
        slowSendTimerRef.current = null;
      }
      return;
    }

    if (slowSendTimerRef.current) {
      clearTimeout(slowSendTimerRef.current);
    }

    slowSendTimerRef.current = setTimeout(() => {
      setShowSlowSendHint(true);
    }, SLOW_SEND_HINT_DELAY_MS);

    return () => {
      if (slowSendTimerRef.current) {
        clearTimeout(slowSendTimerRef.current);
        slowSendTimerRef.current = null;
      }
    };
  }, [isSending]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const text = draft.trim();
    if (!text || isSending || chatConfigStatus !== "ready") {
      return;
    }

    const requestId = Date.now();

    const optimisticUserMessage: ChatMessage = {
      id: `${TEMP_USER_MESSAGE_PREFIX}${requestId}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    const optimisticAssistantMessage: ChatMessage = {
      id: `${TEMP_ASSISTANT_MESSAGE_PREFIX}${requestId}`,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
    };

    setDraft("");
    setError(null);
    setShowSlowSendHint(false);
    setIsSending(true);
    setMessages((prev) => [
      ...prev,
      optimisticUserMessage,
      optimisticAssistantMessage,
    ]);

    try {
      const response = await postChatMessage({
        message: text,
        sessionId: activeSessionId ?? undefined,
      });

      setActiveSessionId(response.session.id);
      setMessages((prev) => [
        ...prev.filter(
          (item) =>
            item.id !== optimisticUserMessage.id &&
            item.id !== optimisticAssistantMessage.id,
        ),
        response.userMessage,
        response.assistantMessage,
      ]);
      setSessions((prev) => {
        const withoutCurrent = prev.filter(
          (session) => session.id !== response.session.id,
        );
        return [response.session, ...withoutCurrent];
      });
    } catch (sendError) {
      setMessages((prev) =>
        prev.filter(
          (item) =>
            item.id !== optimisticUserMessage.id &&
            item.id !== optimisticAssistantMessage.id,
        ),
      );
      setDraft(text);
      setError(toErrorMessage(sendError));
    } finally {
      setShowSlowSendHint(false);
      setIsSending(false);
    }
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function startNewChat() {
    setActiveSessionId(null);
    setMessages([]);
    setError(null);
  }

  async function handleDeleteSession(sessionId: string) {
    if (isDeletingSessionId) {
      return;
    }

    setError(null);
    setIsDeletingSessionId(sessionId);

    try {
      await deleteChatSession(sessionId);

      const refreshed = await listChatSessions();
      setSessions(refreshed.sessions);
      setActiveSessionId((prev) => {
        if (prev && refreshed.sessions.some((session) => session.id === prev)) {
          return prev;
        }

        const next = [...refreshed.sessions].sort(sortSessionsByUpdatedAt)[0];
        return next ? next.id : null;
      });

      if (activeSessionId === sessionId) {
        setMessages([]);
      }
    } catch (deleteError) {
      setError(toErrorMessage(deleteError));
    } finally {
      setIsDeletingSessionId(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 px-6 text-slate-100">
        <p className="text-sm text-slate-300">Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 px-6 text-slate-100">
        <p className="text-sm text-slate-300">Redirecting to login...</p>
      </div>
    );
  }

  if (chatConfigStatus === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 px-6 text-slate-100">
        <p className="text-sm text-slate-300">Loading chat configuration...</p>
      </div>
    );
  }

  if (chatConfigStatus === "missing") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 px-6 text-slate-100">
        <div className="w-full max-w-lg rounded-2xl border border-amber-400/40 bg-slate-950/80 p-7 shadow-lg shadow-black/30">
          <h1 className="text-xl font-semibold text-amber-300">
            Chat API is not configured
          </h1>
          <p className="mt-3 text-sm text-slate-300">
            Configure /config.json with chatApiBaseUrl.
          </p>
          <button
            type="button"
            onClick={() => signOut()}
            className="mt-6 inline-flex h-10 items-center justify-center rounded-lg border border-slate-600 bg-slate-800 px-4 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  if (chatConfigStatus === "unavailable") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-900 px-6 text-slate-100">
        <div className="w-full max-w-lg rounded-2xl border border-rose-400/40 bg-slate-950/80 p-7 shadow-lg shadow-black/30">
          <h1 className="text-xl font-semibold text-rose-300">
            Unable to load chat configuration
          </h1>
          <p className="mt-3 text-sm text-slate-300">
            {chatConfigError ??
              "Could not load /config.json right now. Please retry."}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setChatConfigAttempt((value) => value + 1)}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-cyan-500/40 bg-cyan-900/30 px-4 text-sm font-medium text-cyan-100 transition-colors hover:bg-cyan-900/50"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={() => signOut()}
              className="inline-flex h-10 items-center justify-center rounded-lg border border-slate-600 bg-slate-800 px-4 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-700"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-900 via-slate-950 to-slate-900 text-slate-100">
      <main className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <div className="grid min-h-[calc(100vh-2rem)] grid-cols-1 gap-4 lg:grid-cols-[300px_1fr]">
          <aside className="flex flex-col rounded-2xl border border-slate-800 bg-slate-950/80 p-4 shadow-xl shadow-black/20">
            <div className="mb-4 flex items-center justify-between gap-2">
              <h1 className="text-base font-semibold tracking-wide text-slate-200">
                Chats
              </h1>
              <button
                type="button"
                onClick={startNewChat}
                className="h-9 rounded-lg border border-slate-700 bg-slate-800 px-3 text-xs font-semibold uppercase tracking-wide text-slate-100 transition-colors hover:bg-slate-700"
              >
                New
              </button>
            </div>

            <div className="space-y-2 overflow-y-auto pr-1">
              {isLoadingSessions && (
                <div className="space-y-2 px-1" aria-hidden="true">
                  {[0, 1, 2, 3].map((index) => (
                    <div
                      key={`session-skeleton-${index}`}
                      className="skeleton-shimmer h-16 rounded-xl border border-slate-800 bg-slate-900/70"
                    />
                  ))}
                </div>
              )}

              {!isLoadingSessions && orderedSessions.length === 0 && (
                <p className="px-2 text-xs text-slate-400">
                  No chat history yet. Start a new conversation.
                </p>
              )}

              {orderedSessions.map((session) => (
                <div
                  key={session.id}
                  className={`w-full rounded-xl border p-3 transition-colors ${
                    session.id === activeSessionId
                      ? "border-cyan-500/60 bg-cyan-500/15"
                      : "border-slate-800 bg-slate-900/60 hover:border-slate-700 hover:bg-slate-900"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setActiveSessionId(session.id)}
                    className="w-full text-left"
                  >
                    <p className="line-clamp-2 text-sm font-medium text-slate-100">
                      {session.title}
                    </p>
                    <p className="mt-1 line-clamp-1 text-xs text-slate-400">
                      {session.lastMessagePreview || "No assistant reply yet"}
                    </p>
                  </button>

                  <div className="mt-2 flex justify-end">
                    <button
                      type="button"
                      onClick={() => void handleDeleteSession(session.id)}
                      disabled={isDeletingSessionId !== null}
                      className="rounded-md border border-rose-500/40 bg-rose-900/20 px-2 py-1 text-[11px] font-medium text-rose-200 transition-colors hover:bg-rose-900/40 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      {isDeletingSessionId === session.id
                        ? "Deleting..."
                        : "Delete"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </aside>

          <section className="flex min-h-0 flex-col rounded-2xl border border-slate-800 bg-slate-950/80 shadow-xl shadow-black/20">
            <header className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-slate-100">
                  {user?.name || "Authenticated user"}
                </p>
                <p className="truncate text-xs text-slate-400">{user?.email}</p>
              </div>

              <button
                type="button"
                onClick={() => signOut()}
                className="h-9 rounded-lg border border-slate-700 bg-slate-900 px-3 text-sm font-medium text-slate-100 transition-colors hover:bg-slate-800"
              >
                Sign out
              </button>
            </header>

            <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
              {isLoadingMessages && (
                <div className="space-y-3" aria-hidden="true">
                  <div className="skeleton-shimmer h-16 w-[72%] rounded-2xl border border-slate-800 bg-slate-900/70" />
                  <div className="skeleton-shimmer ml-auto h-14 w-[55%] rounded-2xl border border-slate-700 bg-cyan-500/20" />
                  <div className="skeleton-shimmer h-20 w-[68%] rounded-2xl border border-slate-800 bg-slate-900/70" />
                </div>
              )}

              {!isLoadingMessages && messages.length === 0 && (
                <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-300">
                  Ask anything to start your first message in this chat.
                </div>
              )}

              {messages.map((message) => {
                const isUser = message.role === "user";
                const isPendingAssistant =
                  !isUser &&
                  message.id.startsWith(TEMP_ASSISTANT_MESSAGE_PREFIX) &&
                  !message.content;
                return (
                  <article
                    key={message.id}
                    className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm shadow ${
                      isUser
                        ? "ml-auto bg-cyan-500 text-slate-950"
                        : isPendingAssistant
                          ? "mr-auto border border-cyan-400/30 bg-slate-900 text-slate-100"
                          : "mr-auto border border-slate-700 bg-slate-900 text-slate-100"
                    }`}
                  >
                    {isPendingAssistant ? (
                      <div className="flex items-center gap-2">
                        <span
                          className="typing-dots"
                          aria-label="Assistant is thinking"
                        >
                          <span />
                          <span />
                          <span />
                        </span>
                        <p className="text-xs uppercase tracking-wide text-slate-400">
                          Assistant is thinking
                        </p>
                      </div>
                    ) : (
                      <>
                        <p className="whitespace-pre-wrap leading-relaxed">
                          {message.content}
                        </p>
                        <p
                          className={`mt-2 text-[11px] ${
                            isUser ? "text-cyan-950/80" : "text-slate-400"
                          }`}
                        >
                          {formatTimestamp(message.createdAt)}
                        </p>
                      </>
                    )}
                  </article>
                );
              })}

              <div ref={messagesEndRef} />
            </div>

            {error && (
              <div className="mx-5 mb-3 rounded-lg border border-rose-500/40 bg-rose-900/20 px-3 py-2 text-sm text-rose-200">
                {error}
              </div>
            )}

            {showSlowSendHint && (
              <div className="mx-5 mb-3 rounded-lg border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-200">
                Waking up assistant. First response after idle may take a few
                seconds.
              </div>
            )}

            <form
              onSubmit={handleSubmit}
              className="border-t border-slate-800 px-4 py-4 sm:px-5"
            >
              <div className="flex items-end gap-3">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleDraftKeyDown}
                  placeholder="Type your question"
                  rows={2}
                  className="min-h-[52px] flex-1 resize-y rounded-xl border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none ring-cyan-400 placeholder:text-slate-500 focus:ring"
                  disabled={isSending}
                />

                <button
                  type="submit"
                  disabled={isSending || !draft.trim()}
                  className="h-11 rounded-xl bg-cyan-400 px-4 text-sm font-semibold text-slate-950 transition-colors hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-300"
                >
                  {isSending ? (
                    <span className="inline-flex items-center gap-2">
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-950/70 border-t-transparent" />
                      Sending...
                    </span>
                  ) : (
                    "Send"
                  )}
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Enter adds a new line. Shift+Enter sends your message.
              </p>
            </form>
          </section>
        </div>
      </main>
    </div>
  );
}
