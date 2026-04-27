"use client";

type RuntimeConfig = {
  chatApiBaseUrl?: string;
};

const CONFIG_PATH = "/config.json";
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 300;

export class RuntimeConfigMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigMissingError";
  }
}

export class RuntimeConfigLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigLoadError";
  }
}

let runtimeConfigPromise: Promise<RuntimeConfig> | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchRuntimeConfigOnce(): Promise<RuntimeConfig> {
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
      runtimeConfigPromise = null;
      throw error;
    });
  }

  return runtimeConfigPromise;
}

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