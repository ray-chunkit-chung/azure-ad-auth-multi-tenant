"use client";

import { useState } from "react";

interface User {
  name: string | null;
  email: string | null;
  image: string | null;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

interface StoredSession {
  idToken: string;
  accessToken: string;
  expiresAt: number;
}

interface PkceState {
  state: string;
  codeVerifier: string;
}

const SESSION_STORAGE_KEY = "oauth2.azuread.session";
const PKCE_STORAGE_KEY = "oauth2.azuread.pkce";

function getConfig() {
  const tenantId = (process.env.NEXT_PUBLIC_AZURE_TENANT_ID ?? "").trim();
  const clientId = (process.env.NEXT_PUBLIC_AZURE_APPLICATION_ID ?? "").trim();
  const redirectUri = (process.env.NEXT_PUBLIC_AZURE_REDIRECT_URI ?? "").trim();
  const logoutUri = (process.env.NEXT_PUBLIC_AZURE_LOGOUT_URI ?? "").trim();
  const apiScope = (process.env.NEXT_PUBLIC_AZURE_API_SCOPE ?? "").trim();

  if (!tenantId || !clientId || !redirectUri || !logoutUri || !apiScope) {
    throw new Error(
      "Missing Azure env vars. Set NEXT_PUBLIC_AZURE_TENANT_ID, NEXT_PUBLIC_AZURE_APPLICATION_ID, NEXT_PUBLIC_AZURE_REDIRECT_URI, NEXT_PUBLIC_AZURE_LOGOUT_URI, and NEXT_PUBLIC_AZURE_API_SCOPE.",
    );
  }

  return { tenantId, clientId, redirectUri, logoutUri, apiScope };
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chars = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");

  return btoa(chars).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createRandomString(length: number): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => chars[byte % chars.length]).join("");
}

async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64UrlEncode(digest);
}

function parseJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("Invalid token format");
  }

  const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return JSON.parse(atob(padded)) as Record<string, unknown>;
}

function clearSession(): void {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
  sessionStorage.removeItem(PKCE_STORAGE_KEY);
}

function readSession(): StoredSession | null {
  const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as StoredSession;
  } catch {
    clearSession();
    return null;
  }
}

function sessionToUser(session: StoredSession): User | null {
  try {
    const payload = parseJwtPayload(session.idToken);
    return {
      name: typeof payload.name === "string" ? payload.name : null,
      email:
        typeof payload.preferred_username === "string"
          ? payload.preferred_username
          : typeof payload.email === "string"
            ? payload.email
            : null,
      image: null,
    };
  } catch {
    return null;
  }
}

function buildInitialAuthState(): AuthState {
  if (typeof window === "undefined") {
    return {
      user: null,
      isAuthenticated: false,
      isLoading: true,
    };
  }

  const session = readSession();
  if (!session) {
    return {
      user: null,
      isAuthenticated: false,
      isLoading: false,
    };
  }

  if (Date.now() >= session.expiresAt * 1000) {
    clearSession();
    return {
      user: null,
      isAuthenticated: false,
      isLoading: false,
    };
  }

  return {
    user: sessionToUser(session),
    isAuthenticated: true,
    isLoading: false,
  };
}

export function useAuth(): AuthState {
  const [state] = useState<AuthState>(() => buildInitialAuthState());
  return state;
}

export async function signIn() {
  const { tenantId, clientId, redirectUri, apiScope } = getConfig();

  const codeVerifier = createRandomString(96);
  const codeChallenge = await createPkceChallenge(codeVerifier);
  const state = createRandomString(48);

  const pkceState: PkceState = { state, codeVerifier };
  sessionStorage.setItem(PKCE_STORAGE_KEY, JSON.stringify(pkceState));

  const authorizeUrl = new URL(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
  );
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_mode", "query");
  authorizeUrl.searchParams.set("scope", `openid profile email ${apiScope}`);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);

  window.location.assign(authorizeUrl.toString());
}

export async function completeSignInFromCallback(): Promise<{
  ok: boolean;
  error?: string;
}> {
  const { tenantId, clientId, redirectUri, apiScope } = getConfig();
  const params = new URLSearchParams(window.location.search);

  const oauthError = params.get("error");
  if (oauthError) {
    const desc = params.get("error_description") ?? "OAuth callback failed";
    return { ok: false, error: `${oauthError}: ${desc}` };
  }

  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) {
    return { ok: false, error: "Missing code/state from callback" };
  }

  const rawPkce = sessionStorage.getItem(PKCE_STORAGE_KEY);
  if (!rawPkce) {
    return { ok: false, error: "Missing PKCE verifier in browser session" };
  }

  let pkceState: PkceState;
  try {
    pkceState = JSON.parse(rawPkce) as PkceState;
  } catch {
    return { ok: false, error: "Corrupt PKCE state in browser session" };
  }

  if (pkceState.state !== state) {
    return { ok: false, error: "OAuth state mismatch" };
  }

  const tokenBody = new URLSearchParams({
    client_id: clientId,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: pkceState.codeVerifier,
    scope: `openid profile email ${apiScope}`,
  });

  const tokenRes = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: tokenBody.toString(),
    },
  );

  if (!tokenRes.ok) {
    const rawError = await tokenRes.text();
    return { ok: false, error: `Token exchange failed: ${rawError}` };
  }

  const tokenJson = (await tokenRes.json()) as {
    access_token?: string;
    id_token?: string;
    expires_in?: number;
  };

  if (!tokenJson.access_token || !tokenJson.id_token) {
    return { ok: false, error: "Token exchange returned missing tokens" };
  }

  const nowEpoch = Math.floor(Date.now() / 1000);
  const expiresAt =
    typeof tokenJson.expires_in === "number"
      ? nowEpoch + tokenJson.expires_in
      : (() => {
          const payload = parseJwtPayload(tokenJson.access_token ?? "");
          const exp = payload.exp;
          return typeof exp === "number" ? exp : nowEpoch + 3600;
        })();

  const session: StoredSession = {
    accessToken: tokenJson.access_token,
    idToken: tokenJson.id_token,
    expiresAt,
  };

  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  sessionStorage.removeItem(PKCE_STORAGE_KEY);
  return { ok: true };
}

export function signOut() {
  const { tenantId, clientId, logoutUri } = getConfig();
  clearSession();

  const logoutUrl = new URL(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/logout`,
  );
  logoutUrl.searchParams.set("client_id", clientId);
  logoutUrl.searchParams.set("post_logout_redirect_uri", logoutUri);

  window.location.assign(logoutUrl.toString());
}

export function getAccessToken(): string | null {
  const session = readSession();
  if (!session) {
    return null;
  }

  if (Date.now() >= session.expiresAt * 1000) {
    clearSession();
    return null;
  }

  return session.accessToken;
}
