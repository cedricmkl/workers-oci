# Deploying

Two Terraform modules, meeting at a map of binding objects. Take both, take one,
or read the config document yourself and write the resources by hand.

## Pull first

```
workers-oci pull ghcr.io/example/app:v1.2.3@sha256:... --into .artifact/v1
```

Terraform reads `worker-app.json` during `plan`, and the provider uploads worker
modules from a path, so the artifact is on disk before the plan runs. Put the
pull in whatever wraps your `plan` and `apply`.

## terraform/resources

Creates what the artifact declares and hands back binding objects.

```hcl
module "resources" {
  source = "github.com/cedricmkl/workers-oci//terraform/resources?ref=v0.1.0"

  account_id = var.account_id
  artifact   = jsondecode(file(".artifact/v1/worker-app.json"))

  names = {
    DB     = "example-db"
    EVENTS = "example-events"
  }
}
```

| variable | |
|---|---|
| `account_id` | |
| `artifact` | the decoded config document |
| `names` | binding -> resource name, for the bindings this module should create |
| `prevent_destroy` | guard against replacement, default true |

A binding the artifact declares and `names` omits is left alone. Create it
elsewhere and pass it straight to `deploy`.

| output | |
|---|---|
| `bindings` | binding objects, ready to merge |
| `queue_ids` | queue id per binding, which `deploy` needs to attach a consumer |
| `dead_letter_queues` | dead letter queue name per binding |
| `resources` | kind, name and id per binding |

`prevent_destroy` is on by default because renaming a D1 database or a queue
plans as a replace, and a replaced KV namespace comes back empty. Turn it off for
an environment that is meant to be thrown away.

## terraform/deploy

Uploads each script as a version and puts it live.

```hcl
module "deploy" {
  source = "github.com/cedricmkl/workers-oci//terraform/deploy?ref=v0.1.0"

  account_id   = var.account_id
  artifact_dir = ".artifact/v1"

  bindings  = module.resources.bindings
  queue_ids = module.resources.queue_ids

  vars    = { PUBLIC_URL = "https://app.example.com" }
  secrets = { API_KEY = var.api_key }

  zone_id = var.zone_id
  domains = { api = ["app.example.com"] }
}
```

| variable | |
|---|---|
| `account_id`, `artifact_dir` | |
| `artifact` | the decoded document; read from `artifact_dir` when omitted |
| `name` | script name, or prefix when the artifact ships several workers |
| `bindings` | binding object per binding name |
| `vars` | plain values by name |
| `secrets` | secret values by name, sensitive |
| `secrets_store` | Secrets Store references by name |
| `generate_secrets` | create values for `generate` secrets, default true |
| `zone_id`, `domains`, `routes`, `workers_dev` | routing |
| `queue_ids`, `dead_letter_queues`, `consumer_settings` | queues |
| `rollout_percentage` | share of traffic the new version takes, default 100 |
| `limits` | CPU and memory per worker |

### Binding objects

A binding object is passed to the provider unchanged, so anything the Cloudflare
bindings API accepts works, including kinds workers-oci has no opinion about.

```hcl
bindings = {
  DB      = { type = "d1", name = "DB", id = cloudflare_d1_database.db.id }
  CACHE   = { type = "kv_namespace", name = "CACHE", namespace_id = "..." }
  UPLOADS = { type = "r2_bucket", name = "UPLOADS", bucket_name = "example-uploads" }
  EVENTS  = { type = "queue", name = "EVENTS", queue_name = "example-events" }
}
```

### Checks at plan time

`deploy` refuses to plan when the artifact declares something the deployment does
not supply, and names it:

```
The artifact needs secrets with nowhere to come from: API_KEY.
Each needs an entry in `secrets`, an entry in `secrets_store`, or a `generate`
block in the artifact.
```

It also refuses a `bindings` entry the artifact never declared, a hostname
pointed at a worker marked `routable: false`, a worker consuming a queue with no
id, and an artifact declaring Durable Objects.

## Secrets

| | value in state | |
|---|---|---|
| `secrets` | yes | from a tfvars file, `TF_VAR_`, a Vault or Secrets Manager data source, `sops exec-env`, a CI store |
| `secrets_store` | no | the binding carries a reference; writing the value into the store happens elsewhere |
| `generate` in the artifact | yes | the module creates one |

```hcl
secrets_store = {
  API_KEY = { store_id = var.store_id, secret_name = "prod_api_key" }
}
```

`secret_name` defaults to the binding name. An account has one Secrets Store, so
set it when the store serves several applications.

Values under `secrets` and `generate` reach state, because the Cloudflare API
never returns a secret and the provider keeps the value to know whether it
changed. Encrypt state, or use `secrets_store`.

### Why a secret cannot be left out of Terraform

A worker version lists its bindings exhaustively. A version created by Terraform
drops any secret it does not name, silently: the secret is simply absent from the
new version, with nothing in the plan to say so.

The `inherit` binding type exists for this, and is unusable from Terraform. The
API reports the binding resolved to `secret_text`, which differs from the
configured `inherit` on every read, and `bindings` forces replacement on any
difference. The result is a version and a deployment replaced on every plan, with
a real traffic event each time.

## Providers

Neither module configures a provider. The `cloudflare` provider is inherited from
the calling configuration, so the API token comes from wherever that
configuration already gets it.

```hcl
provider "cloudflare" {}                        # CLOUDFLARE_API_TOKEN
provider "cloudflare" { api_token = var.token }  # or anywhere else
```

## Rollout

`rollout_percentage` below 100 leaves the previous version serving the rest,
which is useful when something is watching and able to change it back. Terraform
has nothing watching, so leave it at 100 unless a separate process owns the
decision.

## A worked example

[examples/compose](../examples/compose) composes both modules, binds one resource
the module does not own, and plans without credentials.
