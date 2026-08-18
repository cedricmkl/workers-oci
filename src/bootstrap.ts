import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { WorkerApp } from "./types.js";

/**
 * Calling an artifact's bootstrap ENDPOINT steps.
 *
 * The work happens inside the application, on Cloudflare, where the code already
 * holds the bindings it needs. This only sends the values that belong to the
 * installation and reports what came back.
 *
 * `run` STEPS ARE NOT EXECUTED HERE, and that is deliberate rather than
 * unfinished. A `run` step is a program the artifact ships, so honouring one
 * means this tool executing code it pulled from a registry on the machine
 * holding the credentials. That is a decision for the deployer to make
 * explicitly in its own configuration, not one a general-purpose CLI should make
 * on its behalf by default. They are reported and skipped.
 *
 * Every step is called on every version bump, so each has to be idempotent. That
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
  readonly name: string;
  readonly status: number;
  readonly body: string;
  readonly endpoint: string;
};

/** A step this tool will not run, and why, so a caller can act on it. */
export type BootstrapSkipped = {
  readonly name: string;
  readonly run: string;
  readonly reason: "run-steps-are-the-deployer's";
};

export type BootstrapReport = {
  readonly called: readonly BootstrapResult[];
  readonly skipped: readonly BootstrapSkipped[];
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export const bootstrap = async (options: BootstrapOptions): Promise<BootstrapReport | null> => {
  const dir = resolve(options.dir);
  const app = JSON.parse(readFileSync(join(dir, "worker-app.json"), "utf8")) as WorkerApp;

  const steps = app.bootstrap ?? [];
  if (steps.length === 0) return null;

  const supplied = options.env ?? {};
  const called: BootstrapResult[] = [];
  const skipped: BootstrapSkipped[] = [];

  // In declaration order, and `pre` before `post` within it, because the order is
  // the artifact's statement about what depends on what.
  const ordered = [
    ...steps.filter((s) => (s.phase ?? "post") === "pre"),
    ...steps.filter((s) => (s.phase ?? "post") !== "pre"),
  ];

  for (const step of ordered) {
    if (step.run !== undefined) {
      skipped.push({ name: step.name, run: step.run, reason: "run-steps-are-the-deployer's" });
      continue;
    }
    if (step.endpoint === undefined) continue;

    const missing = (step.env ?? []).filter((k) => supplied[k] === undefined);
    if (missing.length > 0) {
      throw new Error(`bootstrap step ${step.name} asks for values this call does not supply: ${missing.join(", ")}`);
    }

    const body: Record<string, string> = {};
    for (const key of step.env ?? []) {
      const value = supplied[key];
      if (value !== undefined) body[key] = value;
    }

    called.push(await call(step.name, step.endpoint, body, options));
  }

  return { called, skipped };
};

const call = async (
  name: string,
  path: string,
  body: Record<string, string>,
  options: BootstrapOptions,
): Promise<BootstrapResult> => {
  const endpoint = new URL(path, options.url).toString();
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
        return { name, status: response.status, body: await response.text(), endpoint };
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
  throw new Error(`bootstrap step ${name} failed at ${endpoint}\n  ${detail}`);
};
