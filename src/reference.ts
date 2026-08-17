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
const DIGEST = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/;
const TAG = /^[\w][\w.-]{0,127}$/;

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

  const registry = hasRegistry ? head : DEFAULT_REGISTRY;
  let repository = hasRegistry ? parts.slice(1).join("/") : rest;

  if (repository === "") throw new Error(`no repository in reference: ${original}`);
  if (!hasRegistry && !repository.includes("/")) repository = `library/${repository}`;

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
