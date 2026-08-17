# Building an artifact

## The config document

Write `worker-app.json` beside your `package.json`. It describes what the build
is and what it needs.

```json
{
  "schema_version": 1,
  "name": "example",
  "description": "An example worker-app.",
  "runtime": {
    "compatibility_date": "2026-07-14",
    "compatibility_flags": ["nodejs_compat"]
  },
  "resources": [
    { "binding": "DB", "kind": "d1" },
    { "binding": "CACHE", "kind": "kv", "rebuildable": true },
    { "binding": "UPLOADS", "kind": "r2", "optional": true },
    { "binding": "EVENTS", "kind": "queue", "dead_letter": true },
    {
      "binding": "ASSETS",
      "kind": "assets",
      "directory": "public",
      "not_found_handling": "single-page-application"
    }
  ],
  "vars": [
    { "name": "PUBLIC_URL", "description": "Where this instance answers." },
    { "name": "LOG_LEVEL", "optional": true, "default": "info" }
  ],
  "secrets": [
    { "name": "API_KEY" },
    { "name": "COOKIE_SECRET", "generate": { "bytes": 32, "encoding": "base64url" } }
  ],
  "workers": [
    { "name": "api", "main": "dist/api.js", "crons": ["0 3 * * *"] },
    {
      "name": "consumer",
      "main": "dist/consumer.js",
      "bindings": ["DB", "EVENTS"],
      "consumes": ["EVENTS"],
      "routable": false
    }
  ],
  "migrations": { "binding": "DB", "directory": "migrations" }
}
```

Check it before committing:

```
workers-oci verify worker-app.json
```

### Marking a resource

`optional` means the code runs without it and a deployment may leave it unbound.

`rebuildable` means losing the contents costs time and nothing else, which is
what lets a deployment decide whether to guard the resource against replacement.
A cache is rebuildable; the table holding people's accounts is not.

### Marking a secret

`generate` says a deployment may create the value rather than being given one.
It suits a key whose only property is being unguessable and consistent, such as a
cookie or CSRF key, where losing it logs everybody out and costs nothing else.
Anything another system also knows needs a real value.

`optional` means the code has a path that works without it.

`one_of` lists alternative names satisfying the same requirement, which is how a
credential migrates from one shape to another without a moment where both are
required.

### Marking a worker

`bindings` narrows what a script receives. Omit it and the script gets
everything.

`routable: false` says a script has no HTTP entry point worth publishing, which
makes a hostname pointed at it a validation error rather than a live endpoint
nobody meant to expose.

## Bundling

workers-oci ships what your bundler produced. Nothing rebuilds at deploy time,
which is the point of pinning a digest.

Any bundler works as long as it emits ES modules. With esbuild:

```
bunx esbuild src/api.ts src/consumer.ts \
  --bundle --format=esm --platform=neutral \
  --outdir=dist --splitting
```

The whole directory holding an entry module is shipped, so chunks emitted by
code splitting are included without being named in the document.

Ship anything else with `--include`:

```
workers-oci build --config worker-app.json --out .artifact --include LICENSE
```

## Building

```
workers-oci build --config worker-app.json --out .artifact --version v1.2.3
```

Provenance comes from git: the revision from `HEAD`, the source from the `origin`
remote, and the `created` annotation from the commit timestamp. Override any of
them with `--revision`, `--source` and `--created`.

The output directory holds the three files a push needs:

```
.artifact/
  config.json       the config document, as the bytes that get uploaded
  content.tar.gz    the files
  manifest.json     the OCI manifest, as the bytes that get uploaded
```

`sha256sum .artifact/manifest.json` gives the digest a deployment pins.

## Reproducibility

Two builds of one commit produce one digest, which is what makes pinning a digest
worth doing. Check it:

```
workers-oci build --config worker-app.json --out /tmp/a --print-digest
workers-oci build --config worker-app.json --out /tmp/b --print-digest
```

The `created` annotation is the input that most often breaks this. It defaults to
the commit timestamp for that reason, and passing `--created "$(date)"` would
give every rebuild a new digest.

## Publishing

```
workers-oci push .artifact ghcr.io/example/app:v1.2.3 --tag latest
```

The digest is printed on stdout and the full reference on stderr, so a script can
capture one without parsing the other.

Credentials come from `~/.docker/config.json` and any credential helper it names,
so `docker login`, `podman login`, `oras login` and
`aws ecr get-login-password | docker login --password-stdin` all work. Override
with `WORKERS_OCI_REGISTRY_USER` and `WORKERS_OCI_REGISTRY_PASSWORD`, or with
`--username` and `--password-stdin`.

## In CI

A reusable workflow does the whole sequence:

```yaml
name: release
on:
  push:
    tags: ["v*"]

jobs:
  release:
    uses: cedricmkl/workers-oci/.github/workflows/release.yml@v0.1.0
    permissions:
      contents: read
      packages: write
    with:
      registry: ghcr.io
      repository: ${{ github.repository }}
```

It checks out full history, installs, builds, publishes, and writes the reference
into the run summary ready to paste into whatever pins the release.

## The bootstrap endpoint

An artifact can carry installation work: minting a first signing key, writing a
realm's issuer, seeding the one administrator who can admit everybody else.

```json
"bootstrap": {
  "worker": "api",
  "endpoint": "/_bootstrap",
  "env": ["ADMIN_EMAIL"]
}
```

Expose that path in the Worker. It receives a JSON body with the names under
`env`, and a bearer token in the `authorization` header that the caller supplies.
Refuse without the token.

The endpoint is called on every version bump, so it has to be idempotent.
Applying migrations belongs here for the same reason: the Worker already holds
the D1 binding, and the alternative is a database credential on whichever machine
ran the apply.

```
workers-oci bootstrap --dir .artifact/v1 \
  --url https://app.example.com \
  --token "$TOKEN" \
  --env ADMIN_EMAIL=ops@example.com
```
