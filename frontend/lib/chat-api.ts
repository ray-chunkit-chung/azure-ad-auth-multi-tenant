"use client";

import { getAccessToken } from "../hooks/use-auth";

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  lastMessagePreview: string;
  messageCount: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface ListSessionsResponse {
  sessions: ChatSession[];
}

interface SessionMessagesResponse {
  session: ChatSession;
  messages: ChatMessage[];
}

interface PostMessageResponse {
  session: ChatSession;
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
}

interface DeleteSessionResponse {
  sessionId: string;
  deletedMessageCount: number;
}

const CHAT_API_BASE_URL = process.env.NEXT_PUBLIC_CHAT_API_BASE_URL ?? "";

function ensureApiBaseUrl(): string {
  const base = CHAT_API_BASE_URL.trim().replace(/\/$/, "");
  if (!base) {
    throw new Error(
      "Missing NEXT_PUBLIC_CHAT_API_BASE_URL. Configure frontend environment for API access.",
    );
  }
  return base;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const accessToken = getAccessToken();
  if (!accessToken) {
    throw new Error("Not authenticated");
  }

  const response = await fetch(`${ensureApiBaseUrl()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(init?.headers ?? {}),
    },
  });

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  if (text) {
    try {
      payload = JSON.parse(text) as Record<string, unknown>;
    } catch {
      payload = {};
    }
  }

  if (!response.ok) {
    const message =
      typeof payload.message === "string"
        ? payload.message
        : `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

export function listChatSessions(): Promise<ListSessionsResponse> {
  return request<ListSessionsResponse>("/chat/sessions", {
    method: "GET",
  });
}

export function getChatSession(
  sessionId: string,
): Promise<SessionMessagesResponse> {
  return request<SessionMessagesResponse>(`/chat/sessions/${sessionId}`, {
    method: "GET",
  });
}

export function postChatMessage(input: {
  message: string;
  sessionId?: string;
}): Promise<PostMessageResponse> {
  return request<PostMessageResponse>("/chat/messages", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export function deleteChatSession(
  sessionId: string,
): Promise<DeleteSessionResponse> {
  return request<DeleteSessionResponse>(`/chat/sessions/${sessionId}`, {
    method: "DELETE",
  });
}
