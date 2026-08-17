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

export type Credential = { readonly username: string; readonly password: string };

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
  registry === "registry-1.docker.io" || registry === "docker.io"
    ? ["https://index.docker.io/v1/", "index.docker.io", "docker.io", "registry-1.docker.io"]
    : [registry, `https://${registry}`, `${registry}/`];

const fromHelper = (helper: string, registry: string): Credential | null => {
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

  for (const key of keysFor(registry)) {
    const entry = config.auths?.[key];
    if (entry === undefined) continue;

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

  if (config.credsStore !== undefined) {
    for (const key of keysFor(registry)) {
      const found = fromHelper(config.credsStore, key);
      if (found !== null) return found;
    }
  }

  return null;
};
