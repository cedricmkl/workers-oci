# Creates the stateful resources a worker-app declares, and hands back binding
# objects for them.
#
# Optional. A caller that already has its databases and buckets, or that creates
# them somewhere else, can skip this module and build the `bindings` map for
# terraform/deploy by hand. Nothing in deploy depends on the resources having
# come from here.

terraform {
  required_version = ">= 1.6.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.19.0"
    }
  }
}

variable "account_id" {
  type = string
}

variable "artifact" {
  description = "The decoded worker-app config document, usually jsondecode(file(\"<dir>/worker-app.json\"))."
  type        = any
}

variable "names" {
  description = <<-EOT
    Name for each binding this module should create, as binding -> name.

    A binding the artifact declares and this map omits is left alone: create it
    elsewhere and pass it straight to terraform/deploy. Naming conventions are
    the caller's business, so there is no template here.
  EOT
  type        = map(string)
  default     = {}
}

variable "prevent_destroy" {
  description = <<-EOT
    Refuse to destroy or replace resources that hold the only copy of something.

    Renaming a D1 database or a queue plans as a replace, and a replaced KV
    namespace comes back empty, so this is on by default.
  EOT
  type        = bool
  default     = true
}

locals {
  declared = { for r in try(var.artifact.resources, []) : r.binding => r }

  mine = { for k, name in var.names : k => local.declared[k] if contains(keys(local.declared), k) }

  by_kind = {
    for kind in ["d1", "kv", "r2", "queue"] : kind => {
      for k, r in local.mine : k => r if r.kind == kind
    }
  }

  dlq = {
    for k, r in local.by_kind.queue : k => "${var.names[k]}-dlq"
    if try(r.dead_letter, false)
  }

  unknown = setsubtract(keys(var.names), keys(local.declared))
}

resource "terraform_data" "validate" {
  input = try(var.artifact.name, "")

  lifecycle {
    precondition {
      condition     = length(local.unknown) == 0
      error_message = "`names` covers bindings the artifact does not declare: ${join(", ", local.unknown)}."
    }
  }
}

# ── D1 ───────────────────────────────────────────────────────────────────────

resource "cloudflare_d1_database" "guarded" {
  for_each = var.prevent_destroy ? local.by_kind.d1 : {}

  account_id       = var.account_id
  name             = var.names[each.key]
  read_replication = { mode = try(each.value.read_replication, "disabled") }

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_d1_database" "plain" {
  for_each = var.prevent_destroy ? {} : local.by_kind.d1

  account_id       = var.account_id
  name             = var.names[each.key]
  read_replication = { mode = try(each.value.read_replication, "disabled") }
}

# ── KV ───────────────────────────────────────────────────────────────────────

resource "cloudflare_workers_kv_namespace" "guarded" {
  for_each = var.prevent_destroy ? local.by_kind.kv : {}

  account_id = var.account_id
  title      = var.names[each.key]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_workers_kv_namespace" "plain" {
  for_each = var.prevent_destroy ? {} : local.by_kind.kv

  account_id = var.account_id
  title      = var.names[each.key]
}

# ── R2 ───────────────────────────────────────────────────────────────────────

resource "cloudflare_r2_bucket" "guarded" {
  for_each = var.prevent_destroy ? local.by_kind.r2 : {}

  account_id = var.account_id
  name       = var.names[each.key]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket" "plain" {
  for_each = var.prevent_destroy ? {} : local.by_kind.r2

  account_id = var.account_id
  name       = var.names[each.key]
}

# ── Queues ───────────────────────────────────────────────────────────────────

resource "cloudflare_queue" "guarded" {
  for_each = var.prevent_destroy ? local.by_kind.queue : {}

  account_id = var.account_id
  queue_name = var.names[each.key]

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "plain" {
  for_each = var.prevent_destroy ? {} : local.by_kind.queue

  account_id = var.account_id
  queue_name = var.names[each.key]
}

resource "cloudflare_queue" "dlq" {
  for_each = local.dlq

  account_id = var.account_id
  queue_name = each.value
}

locals {
  d1    = merge(cloudflare_d1_database.guarded, cloudflare_d1_database.plain)
  kv    = merge(cloudflare_workers_kv_namespace.guarded, cloudflare_workers_kv_namespace.plain)
  r2    = merge(cloudflare_r2_bucket.guarded, cloudflare_r2_bucket.plain)
  queue = merge(cloudflare_queue.guarded, cloudflare_queue.plain)
}

# ── Outputs ──────────────────────────────────────────────────────────────────

output "bindings" {
  description = <<-EOT
    Binding objects for everything created here, keyed by binding name. Pass
    straight to terraform/deploy, merged with anything you built yourself.
  EOT
  value = merge(
    { for k, v in local.d1 : k => { type = "d1", name = k, id = v.id } },
    { for k, v in local.kv : k => { type = "kv_namespace", name = k, namespace_id = v.id } },
    { for k, v in local.r2 : k => { type = "r2_bucket", name = k, bucket_name = v.name } },
    { for k, v in local.queue : k => { type = "queue", name = k, queue_name = v.queue_name } },
  )
}

output "queue_ids" {
  description = "Queue id per binding. terraform/deploy needs these to attach consumers."
  value       = { for k, v in local.queue : k => v.id }
}

output "dead_letter_queues" {
  description = "Dead letter queue name per binding, for the bindings that declared one."
  value       = { for k, v in cloudflare_queue.dlq : k => v.queue_name }
}

output "resources" {
  description = "Everything created here, by binding: kind, name and id."
  value = merge(
    { for k, v in local.d1 : k => { kind = "d1", name = v.name, id = v.id } },
    { for k, v in local.kv : k => { kind = "kv", name = v.title, id = v.id } },
    { for k, v in local.r2 : k => { kind = "r2", name = v.name, id = v.name } },
    { for k, v in local.queue : k => { kind = "queue", name = v.queue_name, id = v.id } },
  )
}
