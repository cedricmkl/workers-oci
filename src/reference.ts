/**
 * Parsing an image reference, following the grammar in
 * github.com/distribution/reference.
 *
 * `registry/namespace/name:tag@sha256:...` is the fullest form. Tag and digest
 * may appear together, which is what lets one string carry the version a human
 * reads and the identity a machine verifies.
 */

export type Reference = {
  /** Registry host, with a port if one was given. */
  readonly registry: string;
  /** Path under the registry, with no leading slash. */
  readonly repository: string;
  readonly tag?: string;
  readonly digest?: string;
  /** How it was written, minus any defaults filled in. */
  readonly original: string;
};

const DEFAULT_REGISTRY = "registry-1.docker.io";

/**
 * The spellings of Docker Hub that carry no v2 API.
 *
 * `docker.io` and `index.docker.io` are what a person writes and what
 * `docker pull` accepts, and neither serves `/v2/`. A request to `docker.io`
 * follows a 301 to the marketing site and fails on `JSON Parse error:
 * Unrecognized token '<'`, which reads as a broken registry.
 */
const DOCKER_HUB = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/**
 * `sha256:` and 64 lowercase hex, which is the only algorithm this tool computes.
 *
 * The distribution grammar is wider and permits uppercase hex, but `digestOf`
 * produces lowercase and `pullBlob` compares the two strings, so a correctly
 * written uppercase digest failed with "blob digest mismatch" and read as
 * tampering. The old pattern also accepted `sha256:ff`.
 */
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[\w][\w.-]{0,127}$/;

/**
 * One path component of a repository name, per the distribution reference
 * grammar. Lowercase alphanumerics with single separators between them, which
 * is why `GHCR.IO/Example/App` is not a reference: it produces a `/v2/` URL the
 * registry answers with an error that reads as a server fault.
 */
const COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;

/**
 * A first path component is a registry when it carries a dot or a colon, or when
 * it is exactly `localhost`. Everything else is a Docker Hub namespace, which is
 * the rule the Docker CLI uses and the reason `alpine` resolves the way it does.
 */
const looksLikeHost = (part: string): boolean =>
  part === "localhost" || part.includes(".") || part.includes(":");

export const parseReference = (input: string): Reference => {
  const original = input.trim();
  if (original === "") throw new Error("empty reference");

  let rest = original;
  let digest: string | undefined;
  let tag: string | undefined;

  const at = rest.lastIndexOf("@");
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    if (!DIGEST.test(digest)) throw new Error(`not a digest: ${digest}`);
  }

  // Search after the last slash so a port in the registry is not mistaken for a
  // tag separator.
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.indexOf(":", lastSlash + 1);
  if (colon !== -1) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!TAG.test(tag)) throw new Error(`not a tag: ${tag}`);
  }

  const parts = rest.split("/");
  const head = parts[0] ?? "";
  const hasRegistry = parts.length > 1 && looksLikeHost(head);

  // A host is case-insensitive and the API path is not, so the host is lowered
  // and the repository is left exactly as written for the check below.
  const written = hasRegistry ? head.toLowerCase() : DEFAULT_REGISTRY;
  const registry = DOCKER_HUB.has(written) ? DEFAULT_REGISTRY : written;
  let repository = hasRegistry ? parts.slice(1).join("/") : rest;

  if (repository === "") throw new Error(`no repository in reference: ${original}`);
  if (!hasRegistry && !repository.includes("/")) repository = `library/${repository}`;

  for (const component of repository.split("/")) {
    if (!COMPONENT.test(component)) {
      throw new Error(
        `not a repository name: ${repository}. Each component is lowercase alphanumerics with single separators between them, so ${JSON.stringify(component)} does not fit.`,
      );
    }
  }

  if (tag === undefined && digest === undefined) tag = "latest";

  return {
    registry,
    repository,
    ...(tag === undefined ? {} : { tag }),
    ...(digest === undefined ? {} : { digest }),
    original,
  };
};

/** What to address a manifest by: the digest when present, the tag otherwise. */
export const targetOf = (ref: Reference): string => ref.digest ?? ref.tag ?? "latest";

export const formatReference = (ref: Reference): string =>
  `${ref.registry}/${ref.repository}${ref.tag ? `:${ref.tag}` : ""}${ref.digest ? `@${ref.digest}` : ""}`;

/**
 * The scheme to reach a registry on. Plain HTTP only for a loopback host, which
 * is what a local registry in a test usually is.
 */
export const schemeFor = (registry: string): string => {
  const host = registry.split(":")[0] ?? "";
  const plain = host === "localhost" || host === "127.0.0.1" || host === "::1";
  return process.env["WORKERS_OCI_PLAIN_HTTP"] === "1" || plain ? "http" : "https";
};
