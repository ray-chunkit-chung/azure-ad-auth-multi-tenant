"use client";

// Runtime values loaded from /config.json at browser runtime.
// This lets deployments update selected config without rebuilding JS bundles.
type RuntimeConfig = {
  chatApiBaseUrl?: string;
};

// Static path served from CloudFront/S3.
const CONFIG_PATH = "/config.json";
// Retry a few times for transient CDN/network failures.
const MAX_FETCH_ATTEMPTS = 3;
// Linear retry backoff base (attempt * RETRY_BACKOFF_MS).
const RETRY_BACKOFF_MS = 300;

// Thrown when config loads but required values are missing.
export class RuntimeConfigMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigMissingError";
  }
}

// Thrown when config cannot be fetched or parsed.
export class RuntimeConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigLoadError";
  }
}

// Shared in-memory promise so multiple callers reuse one fetch.
let runtimeConfigPromise: Promise<RuntimeConfig> | null = null;

// Small delay helper used by retry backoff.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// One fetch + parse attempt for runtime config.
async function fetchRuntimeConfigOnce(): Promise<RuntimeConfig> {
  // no-store prevents stale config from browser cache.
  const response = await fetch(CONFIG_PATH, { cache: "no-store" });

  if (!response.ok) {
    throw new RuntimeConfigLoadError(
      `Failed to load ${CONFIG_PATH} (HTTP ${response.status}).`,
    );
  }

  try {
    return (await response.json()) as RuntimeConfig;
  } catch {
    throw new RuntimeConfigLoadError(`Invalid JSON returned from ${CONFIG_PATH}.`);
  }
}

// Load config with retries and cache successful result in memory.
async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = (async () => {
      let lastError: unknown;

      for (let attempt = 1; attempt <= MAX_FETCH_ATTEMPTS; attempt += 1) {
        try {
          return await fetchRuntimeConfigOnce();
        } catch (error) {
          lastError = error;
          if (attempt < MAX_FETCH_ATTEMPTS) {
            await sleep(RETRY_BACKOFF_MS * attempt);
          }
        }
      }

      if (lastError instanceof Error) {
        throw lastError;
      }

      throw new RuntimeConfigLoadError(`Failed to load ${CONFIG_PATH}.`);
    })().catch((error) => {
      // If loading fails, clear cache so a later retry can fetch again.
      runtimeConfigPromise = null;
      throw error;
    });
  }

  return runtimeConfigPromise;
}

// Public accessor used by API client code.
// Normalizes trailing slash and validates required value.
export async function getChatApiBaseUrl(): Promise<string> {
  const runtimeConfig = await loadRuntimeConfig();
  const baseUrl = (runtimeConfig.chatApiBaseUrl ?? "").trim();

  if (!baseUrl) {
    throw new RuntimeConfigMissingError(
      "Missing chat API base URL in /config.json.",
    );
  }

  return baseUrl.replace(/\/$/, "");
}