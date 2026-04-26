"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { completeSignInFromCallback } from "../../../hooks/use-auth";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function run() {
      const result = await completeSignInFromCallback();
      if (!isMounted) {
        return;
      }

      if (result.ok) {
        router.replace("/");
        return;
      }

      setError(result.error ?? "Sign-in failed");
    }

    void run();

    return () => {
      isMounted = false;
    };
  }, [router]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 px-6 dark:bg-black">
      <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="text-xl font-semibold text-zinc-900 dark:text-zinc-50">
          Completing sign in...
        </h1>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Please wait while we finish Microsoft authentication.
        </p>

        {error && (
          <div className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
