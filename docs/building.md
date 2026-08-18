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
    "compatibility_flags": ["nodejs_compat"],
    "limits": { "cpu_ms": 200 },
    "placement": { "mode": "smart" }
  },
  "resources": [
    { "binding": "DB", "kind": "d1" },
    { "binding": "CACHE", "kind": "kv", "rebuildable": true },
    { "binding": "UPLOADS", "kind": "r2", "optional": true },
    { "binding": "EVENTS", "kind": "queue" },
    {
      "binding": "ASSETS",
      "kind": "assets",
      "directory": "public",
      "not_found_handling": "single-page-application",
      "html_handling": "auto-trailing-slash"
    }
  ],
  "vars": [
    { "name": "PUBLIC_URL", "description": "Where this instance answers." },
    { "name": "LOG_LEVEL", "optional": true, "default": "info" },
    { "name": "FEATURE_FLAGS", "type": "json", "optional": true }
  ],
  "secrets": [
    { "name": "API_KEY" },
    { "name": "COOKIE_SECRET", "generate": { "bytes": 32, "encoding": "base64url" } }
  ],
  "workers": [
    {
      "name": "api",
      "main": "dist/api.js",
      "modules": [{ "path": "dist/_headers", "content_type": "text/plain" }],
      "crons": ["0 3 * * *"]
    },
    {
      "name": "consumer",
      "main": "dist/consumer.js",
      "bindings": ["DB", "EVENTS"],
      "consumes": [{ "binding": "EVENTS", "dead_letter": true, "max_batch_size": 10 }],
      "routable": false
    }
  ],
  "migrations": [{ "binding": "DB", "directory": "migrations" }]
}
```

Check it before committing:

```
workers-oci verify worker-app.json
```

### Marking a resource

`optional` means the code runs without it and a deployment may leave it unbound.

`rebuildable` states that losing the contents costs time and nothing else. It is
a claim in the document that a deployment may act on. Nothing in the two
Terraform modules reads it. `workers-oci inspect` prints it. A cache is
rebuildable, the table holding people's accounts is not.

Twelve kinds:

| kind | |
|---|---|
| `d1`, `kv`, `r2`, `queue` | the four `terraform/resources` creates |
| `queue` | `produces`, default true. A queue this app only reads from, filled by something else, sets it false. |
| `assets` | requires `directory`. Takes `not_found_handling`, `html_handling` and `run_worker_first`. One per artifact, and the files ride in the content layer. |
| `ratelimit` | requires `limit` and `period`. `period` is 10 or 60 seconds. |
| `hyperdrive`, `vectorize`, `analytics_engine` | the deployment supplies the id or name |
| `ai`, `browser`, `version_metadata` | no account-level resource behind them |

Every binding except `assets` needs a value at deploy time, or `optional: true`
here.

### Marking a var

`type: "json"` uploads the value as a JSON binding, which is how a var carries an
object or a list. The default is `string`.

`default` is a build-time fallback. A value from the deployment wins over it, and
a var with a default is never missing at plan time.

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

`modules` names files the script needs uploaded beyond its entry: WebAssembly,
text and data blobs, and the `_headers` and `_redirects` files, which Cloudflare
treats as modules rather than as files in the assets directory. `content_type` is
inferred from the extension when you leave it out. Chunks emitted next to the
entry module are found without being listed, so this is for files a bundler did
not write.

`consumes` lists the queues this script reads. A bare binding name takes the
platform defaults. The object form carries the subscription's settings:

```json
"consumes": [
  {
    "binding": "EVENTS",
    "dead_letter": true,
    "max_batch_size": 10,
    "max_batch_timeout": 5,
    "max_retries": 3,
    "max_concurrency": 4,
    "retry_delay": 30
  }
]
```

`max_batch_timeout` and `retry_delay` are seconds. `dead_letter` sits here rather
than on the queue resource: two scripts reading one queue can send their failures
to different places, and the deployment names the queue they go to.

`routable: false` says a script has no HTTP entry point worth publishing, which
makes a hostname pointed at it a validation error rather than a live endpoint
nobody meant to expose.

## Bundling

workers-oci ships what your bundler produced. Nothing rebuilds at deploy time, so
the digest you pin is the code that runs.

Any bundler works as long as it emits ES modules. With esbuild:

```
bunx esbuild src/api.ts src/consumer.ts \
  --bundle --format=esm --platform=neutral \
  --outdir=dist --splitting
```

The build reads the directory holding each entry module, records the chunks the
bundler wrote beside it in that worker's `modules`, and then ships what the
document names: the entry, its chunks, the assets, the migrations, and anything
`--include` adds. Code splitting names its own output, so listing those chunks by
hand is wrong on the next build: esbuild writes `chunk-QW7T4A3B.js`, under a name
that moves whenever the input does.

Nothing else in that directory ships. A worker version uploads `main` plus
`modules`, so a file that is neither was carried in every pull and used by
nothing, and the digest moved when it changed. `dist/index.js.map` is the usual
one, commonly three times the size of the bundle it maps.

Discovery is an allowlist of the extensions the runtime has a module type for:
`js`, `mjs`, `cjs`, `wasm`, `json`, `txt`, `bin`. A path is skipped when it is:

- outside the entry module's directory, unless the entry sits at the layer root
- another worker's entry module, since two workers built into one directory share
  their chunks without either being a module of the other
- under an assets `directory` or a migrations `directory`
- already in `modules`, where its `content_type` is kept
- the config document itself

The result is sorted, because the config document is part of the digest.

Ship anything else on purpose with `--include`, a source map included:

```
workers-oci build --config worker-app.json --out .artifact --include LICENSE
```

## In CI

Two composite actions. They are steps, so the job stays yours: federate into AWS,
install a private dependency, bundle however you like, then call them.

```yaml
- uses: cedricmkl/workers-oci/build@v1
  id: build
  with:
    version: ${{ github.ref_name }}

- uses: cedricmkl/workers-oci/push@v1
  id: push
  with:
    reference: ghcr.io/${{ github.repository }}:${{ github.ref_name }}
    password: ${{ secrets.GITHUB_TOKEN }}
```

`push` outputs `digest` and `reference`, and writes the reference and what the
artifact declares into the run summary.

The CLI runs from the action's own checkout, so the tool and the action that
documents it are the same commit and no package registry is involved.

`.github/workflows/release.yml` wraps both as a whole job for the case they cover
completely: one bundle command, a registry that takes a username and a password.

## Building

```
workers-oci build --config worker-app.json --out .artifact --version v1.2.3
```

Paths in the document are relative to the config document's directory. Pass
`--root` when they are relative to something else, such as a repository root
holding the document in a subdirectory.

Provenance comes from git: the revision from `HEAD`, the source from the `origin`
remote, and the `created` annotation from the commit timestamp. Override any of
them with `--revision`, `--source` and `--created`.

The output directory holds the three files a push needs:

```
.artifact/
  config.json       the config document, as the bytes that get uploaded
  content.tar       the files
  manifest.json     the OCI manifest, as the bytes that get uploaded
```

`sha256sum .artifact/manifest.json` gives the digest a deployment pins.

## Reproducibility

Two builds of one commit produce one digest. Check it:

```
workers-oci build --config worker-app.json --out /tmp/a --print-digest
workers-oci build --config worker-app.json --out /tmp/b --print-digest
```

The `created` annotation is the input that most often breaks this. It comes from
`--created`, then `SOURCE_DATE_EPOCH` as seconds since the Unix epoch, then the
commit timestamp, then the epoch itself. Set `SOURCE_DATE_EPOCH` when there is no
commit to read, such as a build from an exported tree. Passing
`--created "$(date)"` gives every rebuild a new digest.

## Publishing

```
workers-oci push .artifact ghcr.io/example/app:v1.2.3 --tag latest
```

The digest is printed on stdout and the full reference on stderr, so a script can
capture one without parsing the other.

Credentials come from `~/.docker/config.json` and any credential helper it names,
so `docker login`, `podman login`, `oras login` and
`aws ecr get-login-password | docker login --password-stdin` all work. Set
`DOCKER_CONFIG` to read the config from another directory. Override with
`WORKERS_OCI_REGISTRY_USER` and `WORKERS_OCI_REGISTRY_PASSWORD`, or with
`--username` and either `--password-stdin` or `--password`.

Registries are reached over HTTPS, except `localhost`, `127.0.0.1` and `::1`. Set
`WORKERS_OCI_PLAIN_HTTP=1` for a plain-HTTP registry on another host.

Read back what you published:

```
workers-oci inspect ghcr.io/example/app:v1.2.3 --json
```

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
