import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * Registry credentials, from the places a registry credential already lives.
 *
 * Order: explicit argument, then the environment, then the Docker config and any
 * credential helper it names. Logging in with docker, podman, oras or
 * `aws ecr get-login-password | ... login` is therefore enough, and nothing here
 * needs its own login command.
 */

export type Credential = {
  readonly username: string;
  readonly password: string;
  /**
   * A refresh token, when the registry issued one instead of a password.
   *
   * ACR, Quay and GitLab write `auth` as base64 of a placeholder UUID and an
   * empty password, with the real credential under `identitytoken`. The token
   * endpoint takes it as `grant_type=refresh_token` rather than as Basic auth,
   * so it travels separately.
   */
  readonly identityToken?: string;
};

export type CredentialSource = {
  readonly username?: string | undefined;
  readonly password?: string | undefined;
};

type DockerConfig = {
  auths?: Record<string, { auth?: string; username?: string; password?: string; identitytoken?: string }>;
  credHelpers?: Record<string, string>;
  credsStore?: string;
};

const configPath = (): string =>
  process.env["DOCKER_CONFIG"] !== undefined
    ? join(process.env["DOCKER_CONFIG"], "config.json")
    : join(homedir(), ".docker", "config.json");

const readConfig = (): DockerConfig => {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as DockerConfig;
  } catch {
    return {};
  }
};

/**
 * Docker Hub is stored under a legacy URL rather than under its API host, so a
 * lookup for `registry-1.docker.io` has to try that spelling too.
 */
const keysFor = (registry: string): string[] =>
  registry === "registry-1.docker.io" || registry === "docker.io" || registry === "index.docker.io"
    ? ["https://index.docker.io/v1/", "index.docker.io", "docker.io", "registry-1.docker.io"]
    : [registry, `https://${registry}`, `${registry}/`];

/**
 * A credential helper is a program name and nothing else.
 *
 * It comes from a file, and `execFile` resolves a name holding a slash against
 * the working directory rather than against PATH. That needs an already-hostile
 * `~/.docker/config.json` to matter, so this is depth rather than a hole, and it
 * is one line.
 */
const HELPER = /^[A-Za-z0-9._-]+$/;

const fromHelper = (helper: string, registry: string): Credential | null => {
  if (!HELPER.test(helper)) return null;
  try {
    const out = execFileSync(`docker-credential-${helper}`, ["get"], {
      input: registry,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out) as { Username?: string; Secret?: string };
    if (parsed.Username === undefined || parsed.Secret === undefined) return null;
    return { username: parsed.Username, password: parsed.Secret };
  } catch {
    return null;
  }
};

export const credentialFor = (registry: string, explicit?: CredentialSource): Credential | null => {
  if (explicit?.username !== undefined && explicit.password !== undefined) {
    return { username: explicit.username, password: explicit.password };
  }

  const envUser = process.env["WORKERS_OCI_REGISTRY_USER"];
  const envPass = process.env["WORKERS_OCI_REGISTRY_PASSWORD"];
  if (envUser !== undefined && envPass !== undefined) {
    return { username: envUser, password: envPass };
  }

  const config = readConfig();

  for (const key of keysFor(registry)) {
    const helper = config.credHelpers?.[key];
    if (helper !== undefined) {
      const found = fromHelper(helper, key);
      if (found !== null) return found;
    }
  }

  /*
   * THE STORE BEFORE `auths`, which is the order Docker resolves in and the
   * reverse of what this did. It is invisible in the common case, because
   * `docker login` writes an empty `"auths": {"ghcr.io": {}}` entry beside a
   * configured store and the empty entry falls through. It stops being
   * invisible when an `auth` blob written before the store was configured, or
   * one podman or oras left behind, sits next to a live keychain: the stale
   * value won here and the push 401d while `docker push` to the same registry
   * worked.
   */
  if (config.credsStore !== undefined) {
    for (const key of keysFor(registry)) {
      const found = fromHelper(config.credsStore, key);
      if (found !== null) return found;
    }
  }

  for (const key of keysFor(registry)) {
    const entry = config.auths?.[key];
    if (entry === undefined) continue;

    /*
     * An `identitytoken` is a REFRESH TOKEN and not a password. ACR, Quay and
     * GitLab write `auth` as base64 of the placeholder UUID and an empty
     * password, with the real credential beside it under this key. Returning
     * the UUID gets a 401 that reads as a wrong password, so the token is
     * carried through and `registry.ts` exchanges it at the token endpoint.
     */
    if (entry.identitytoken !== undefined && entry.identitytoken !== "") {
      return { username: "<token>", password: "", identityToken: entry.identitytoken };
    }

    if (entry.auth !== undefined && entry.auth !== "") {
      const decoded = Buffer.from(entry.auth, "base64").toString("utf8");
      const at = decoded.indexOf(":");
      if (at !== -1) {
        return { username: decoded.slice(0, at), password: decoded.slice(at + 1) };
      }
    }
    if (entry.username !== undefined && entry.password !== undefined) {
      return { username: entry.username, password: entry.password };
    }
  }

  return null;
};
