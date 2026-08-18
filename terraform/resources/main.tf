# Creates the stateful resources a worker-app declares, and hands back binding
# objects for them.
#
# Optional. A caller that already has its databases and buckets, or that creates
# them somewhere else, can skip this module and build the `bindings` map for
# terraform/deploy by hand. Nothing in deploy depends on the resources having
# come from here.
#
# ── On destroying ────────────────────────────────────────────────────────────
#
# Everything here carries `prevent_destroy`, unconditionally. There is no
# variable for it, because `prevent_destroy` will not take one: it must be a
# literal, so a variable can only be implemented as two copies of every resource
# at two addresses, and flipping it then MOVES the resource between them. Turning
# such a flag on destroys the database it claims to protect, and turning it off
# afterwards is refused, which wedges the configuration. A knob whose two
# positions are "data loss" and "stuck" is worse than no knob.
#
# To take a resource down on purpose: remove it from `names`, then
# `tofu state rm` the address, then delete it by hand. Slower on purpose.

terraform {
  required_version = ">= 1.3.0"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.19.0"
    }
  }
}

variable "account_id" {
  description = "Cloudflare account the resources are created in."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "A Cloudflare account id is 32 hexadecimal characters."
  }
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

variable "d1" {
  description = <<-EOT
    Per D1 binding, settings the artifact has no view on.

    `read_replication` is stated rather than left out on purpose: the provider
    records null while the API returns an object, so an omitted value makes every
    later plan send `read_replication: null` and the API answer 400.

    `disabled` is the default because replicas are eventually consistent, and a
    row read back immediately after being written is the common shape in a
    Worker. Set `auto` where the reads can tolerate it.
  EOT
  type = map(object({
    read_replication      = optional(string, "disabled")
    primary_location_hint = optional(string)
  }))
  default = {}
}

variable "r2" {
  description = <<-EOT
    Per R2 binding. `location` and `jurisdiction` are fixed when the bucket is
    created and cannot be changed afterwards.
  EOT
  type = map(object({
    location      = optional(string)
    storage_class = optional(string)
    jurisdiction  = optional(string)
  }))
  default = {}
}

variable "queues" {
  description = "Per queue binding: message_retention_period and delivery_delay, in seconds."
  type = map(object({
    message_retention_period = optional(number)
    delivery_delay           = optional(number)
  }))
  default = {}
}

locals {
  declared = { for r in try(var.artifact.resources, []) : r.binding => r }

  mine = { for k, name in var.names : k => local.declared[k] if contains(keys(local.declared), k) }

  by_kind = {
    for kind in ["d1", "kv", "r2", "queue"] : kind => {
      for k, r in local.mine : k => r if r.kind == kind
    }
  }

  # A dead letter queue is declared per CONSUMER rather than per queue, because
  # two scripts reading one queue can legitimately send failures to different
  # places. This collects the queues that any consumer asked for one on.
  dlq = {
    for k in distinct(flatten([
      for w in try(var.artifact.workers, []) : [
        for c in try(w.consumes, []) : try(c.binding, c)
        if try(c.dead_letter, false)
      ]
    ])) : k => "${var.names[k]}-dlq"
    if contains(keys(local.by_kind.queue), k)
  }

  unknown = setsubtract(keys(var.names), keys(local.declared))

  # A binding this module has no resource for. Naming one in `names` would
  # otherwise pass every check and create nothing.
  uncreatable = [
    for k in keys(var.names) : k
    if contains(keys(local.declared), k) && !contains(["d1", "kv", "r2", "queue"], local.declared[k].kind)
  ]
}

resource "terraform_data" "validate" {
  input = try(var.artifact.name, "")

  lifecycle {
    precondition {
      condition     = length(local.unknown) == 0
      error_message = "`names` covers bindings the artifact does not declare: ${join(", ", local.unknown)}."
    }

    precondition {
      condition     = length(local.uncreatable) == 0
      error_message = "`names` covers bindings with no resource to create: ${join(", ", local.uncreatable)}. This module creates d1, kv, r2 and queue. An assets binding is part of the worker version, and the rest carry no account-level resource."
    }
  }
}

# ── D1 ───────────────────────────────────────────────────────────────────────

resource "cloudflare_d1_database" "this" {
  for_each = local.by_kind.d1

  account_id            = var.account_id
  name                  = var.names[each.key]
  read_replication      = { mode = try(var.d1[each.key].read_replication, "disabled") }
  primary_location_hint = try(var.d1[each.key].primary_location_hint, null)

  lifecycle {
    # A D1 database cannot be renamed, so a rename plans as a replace, and a
    # replace is an empty database under the same name.
    prevent_destroy = true
  }
}

# ── KV ───────────────────────────────────────────────────────────────────────

resource "cloudflare_workers_kv_namespace" "this" {
  for_each = local.by_kind.kv

  account_id = var.account_id
  title      = var.names[each.key]

  lifecycle {
    # `title` is an in-place update, so a rename is safe here. This guards the
    # other direction: a namespace removed from `names` is a namespace whose
    # contents are not recoverable from state.
    prevent_destroy = true
  }
}

# ── R2 ───────────────────────────────────────────────────────────────────────

resource "cloudflare_r2_bucket" "this" {
  for_each = local.by_kind.r2

  account_id    = var.account_id
  name          = var.names[each.key]
  location      = try(var.r2[each.key].location, null)
  storage_class = try(var.r2[each.key].storage_class, null)
  jurisdiction  = try(var.r2[each.key].jurisdiction, null)

  lifecycle {
    prevent_destroy = true
  }
}

# ── Queues ───────────────────────────────────────────────────────────────────

resource "cloudflare_queue" "this" {
  for_each = local.by_kind.queue

  account_id = var.account_id
  queue_name = var.names[each.key]

  settings = try(var.queues[each.key], null) == null ? null : {
    message_retention_period = try(var.queues[each.key].message_retention_period, null)
    delivery_delay           = try(var.queues[each.key].delivery_delay, null)
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_queue" "dlq" {
  for_each = local.dlq

  account_id = var.account_id
  queue_name = each.value

  lifecycle {
    # A dead letter queue holds the messages that already failed. Dropping
    # `dead_letter` from an artifact would otherwise delete them along with it.
    prevent_destroy = true
  }
}

# ── Outputs ──────────────────────────────────────────────────────────────────

output "bindings" {
  description = <<-EOT
    Binding objects for everything created here, keyed by binding name. Pass
    straight to terraform/deploy, merged with anything you built yourself.
  EOT
  value = merge(
    { for k, v in cloudflare_d1_database.this : k => { type = "d1", name = k, id = v.id } },
    { for k, v in cloudflare_workers_kv_namespace.this : k => { type = "kv_namespace", name = k, namespace_id = v.id } },
    # `jurisdiction` rides along when the bucket has one. A bucket created in a
    # jurisdiction lives in a separate namespace, so a binding that names only
    # the bucket resolves against the default one and does not find it.
    { for k, v in cloudflare_r2_bucket.this : k => merge(
      { type = "r2_bucket", name = k, bucket_name = v.name },
      try(var.r2[k].jurisdiction, null) == null ? {} : { jurisdiction = var.r2[k].jurisdiction },
    ) },
    { for k, v in cloudflare_queue.this : k => { type = "queue", name = k, queue_name = v.queue_name } },
  )
}

output "queue_ids" {
  description = "Queue id per binding. terraform/deploy needs these to attach consumers."
  value       = { for k, v in cloudflare_queue.this : k => v.id }
}

output "dead_letter_queues" {
  description = "Dead letter queue name per binding, for the bindings a consumer asked for one on."
  value       = { for k, v in cloudflare_queue.dlq : k => v.queue_name }
}

output "resources" {
  description = "Everything created here, by binding: kind, name and id."
  value = merge(
    { for k, v in cloudflare_d1_database.this : k => { kind = "d1", name = v.name, id = v.id } },
    { for k, v in cloudflare_workers_kv_namespace.this : k => { kind = "kv", name = v.title, id = v.id } },
    { for k, v in cloudflare_r2_bucket.this : k => { kind = "r2", name = v.name, id = v.name } },
    { for k, v in cloudflare_queue.this : k => { kind = "queue", name = v.queue_name, id = v.id } },
  )
}
