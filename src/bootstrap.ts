import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkerApp } from "./types.js";

/**
 * Calling an artifact's bootstrap endpoint.
 *
 * The work happens inside the application, on Cloudflare, where the code already
 * holds the bindings it needs. This only sends the values that belong to the
 * installation and reports what came back.
 *
 * The endpoint is called on every version bump, so it has to be idempotent. That
 * is the artifact's contract, not something checked here.
 */

export type BootstrapOptions = {
  /** Directory `pull` unpacked into, for the artifact's own declaration. */
  readonly dir: string;
  /** Origin the worker answers on, for example https://app.example.com. */
  readonly url: string;
  /** Sent as a bearer token. The endpoint should refuse without it. */
  readonly token?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly attempts?: number;
};

export type BootstrapResult = {
  readonly status: number;
  readonly body: string;
  readonly endpoint: string;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const bootstrap = async (options: BootstrapOptions): Promise<BootstrapResult | null> => {
  const dir = resolve(options.dir);
  const app = JSON.parse(readFileSync(join(dir, "worker-app.json"), "utf8")) as WorkerApp;

  if (app.bootstrap === undefined) return null;

  const supplied = options.env ?? {};
  const missing = (app.bootstrap.env ?? []).filter((k) => supplied[k] === undefined);
  if (missing.length > 0) {
    throw new Error(`the bootstrap endpoint asks for values this call does not supply: ${missing.join(", ")}`);
  }

  const body: Record<string, string> = {};
  for (const key of app.bootstrap.env ?? []) {
    const value = supplied[key];
    if (value !== undefined) body[key] = value;
  }

  const endpoint = new URL(app.bootstrap.endpoint, options.url).toString();
  const attempts = options.attempts ?? 5;

  let last: Response | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 120_000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          ...(options.token !== undefined ? { authorization: `Bearer ${options.token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      last = response;

      if (response.ok) {
        return { status: response.status, body: await response.text(), endpoint };
      }
      // A 4xx is the application saying no, and retrying will not change its
      // mind. Only a 5xx or a network failure is worth another attempt: a
      // freshly deployed version can take a moment to answer.
      if (response.status < 500) break;
    } catch (error) {
      if (attempt === attempts) throw error;
    } finally {
      clearTimeout(timer);
    }

    if (attempt < attempts) await sleep(2000 * attempt);
  }

  const detail = last === null ? "no response" : `${last.status} ${last.statusText}: ${(await last.text()).slice(0, 400)}`;
  throw new Error(`bootstrap failed at ${endpoint}\n  ${detail}`);
};
