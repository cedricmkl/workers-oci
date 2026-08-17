variable "account_id" {
  type = string
}

variable "artifact_dir" {
  description = <<-EOT
    Directory `workers-oci pull` unpacked an artifact into.

    Read during `plan`. The provider uploads worker modules from a path, so the
    files have to be on disk in any case.
  EOT
  type        = string
}

variable "artifact" {
  description = <<-EOT
    The decoded config document. Defaults to reading worker-app.json out of
    `artifact_dir`.

    Pass it explicitly when it comes from somewhere else: a remote state output,
    a `data` source, a document assembled in the calling configuration.
  EOT
  type        = any
  default     = null
}

variable "name" {
  description = <<-EOT
    Script name. With several workers in the artifact it is the prefix, and each
    worker's own name is appended.

    Defaults to the artifact's name. Set it to run two installations of one
    artifact in an account.
  EOT
  type        = string
  default     = null
}

variable "bindings" {
  description = <<-EOT
    Binding object per binding name, for everything the artifact declares as a
    resource.

        bindings = {
          DB    = { type = "d1", name = "DB", id = cloudflare_d1_database.db.id }
          CACHE = { type = "kv_namespace", name = "CACHE", namespace_id = "..." }
        }

    terraform/resources produces this shape, and so does writing it by hand. The
    objects are passed to the provider unchanged, so anything the Cloudflare
    bindings API accepts works here, including kinds this project has no opinion
    about.
  EOT
  type        = map(any)
  default     = {}
}

variable "vars" {
  description = "Plain text values, by name. The artifact declares which names it reads."
  type        = map(string)
  default     = {}
}

variable "secrets" {
  description = <<-EOT
    Secret values, by name.

    Values reach state: the Cloudflare API never returns a secret, so the
    provider keeps the value to know whether it changed. Use `secrets_store` to
    keep a value out of state, or encrypt state.
  EOT
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "secrets_store" {
  description = <<-EOT
    Secrets held in a Cloudflare Secrets Store, referenced rather than carried.

        secrets_store = {
          API_KEY = { store_id = "...", secret_name = "prod_api_key" }
        }

    The binding holds the reference alone, so no value reaches state or a plan
    file. Writing the value into the store happens elsewhere.

    `secret_name` defaults to the binding name.
  EOT
  type = map(object({
    store_id    = string
    secret_name = optional(string)
  }))
  default = {}
}

variable "generate_secrets" {
  description = <<-EOT
    Create values for the secrets the artifact marks `generate`, for keys whose
    only property is being unguessable and stable.

    Turn it off to supply them through `secrets` or `secrets_store` instead.
  EOT
  type        = bool
  default     = true
}

# ── Routing ──────────────────────────────────────────────────────────────────

variable "zone_id" {
  type    = string
  default = null
}

variable "domains" {
  description = "Worker name from the artifact -> custom hostnames. Requires `zone_id`."
  type        = map(list(string))
  default     = {}
}

variable "routes" {
  description = "Worker name -> route patterns, for a zone already fronted by something else."
  type        = map(list(string))
  default     = {}
}

variable "workers_dev" {
  description = "Give each worker a workers.dev subdomain."
  type        = bool
  default     = false
}

# ── Queues ───────────────────────────────────────────────────────────────────

variable "queue_ids" {
  description = <<-EOT
    Queue id per binding, needed to attach a consumer. terraform/resources
    outputs this.

    A queue binding a worker only produces to needs no entry.
  EOT
  type        = map(string)
  default     = {}
}

variable "dead_letter_queues" {
  description = "Dead letter queue name per queue binding."
  type        = map(string)
  default     = {}
}

variable "consumer_settings" {
  description = "Per queue binding, passed to the consumer as given: batch_size, max_retries, max_wait_time_ms, retry_delay."
  type        = map(any)
  default     = {}
}

# ── Rollout ──────────────────────────────────────────────────────────────────

variable "rollout_percentage" {
  description = <<-EOT
    Share of traffic the new version takes. Below 100 leaves the previous version
    serving the rest, which is useful when something is watching and able to
    change it back.
  EOT
  type        = number
  default     = 100

  validation {
    condition     = var.rollout_percentage > 0 && var.rollout_percentage <= 100
    error_message = "A share of traffic between 1 and 100."
  }
}

variable "limits" {
  description = "CPU and memory limits per worker name, passed to the provider as given."
  type        = map(any)
  default     = {}
}
