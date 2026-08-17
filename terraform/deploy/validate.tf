# The artifact states what it needs. These checks run during `plan`, which is the
# last point where a gap is a message rather than a 500 on the first request that
# hit it.

locals {
  missing_bindings = [
    for k, r in local.declared : k
    if r.kind != "assets"
    && !try(r.optional, false)
    && !contains(keys(var.bindings), k)
  ]

  missing_vars = [
    for k, v in local.vars_decl : k
    if !try(v.optional, false)
    && try(v.default, null) == null
    && !contains(keys(var.vars), k)
  ]

  missing_secrets = [
    for k, s in local.sec_decl : k
    if !try(s.optional, false)
    && !contains(keys(local.generated), k)
    && !contains(local.supplied, k)
    && !contains(keys(var.secrets_store), k)
    && length([
      for alt in try(s.one_of, []) : alt
      if contains(local.supplied, alt) || contains(keys(var.secrets_store), alt)
    ]) == 0
  ]

  # A binding the artifact never declared. Usually a typo, and it would upload
  # cleanly and confuse the next person reading the config.
  extra_bindings = setsubtract(keys(var.bindings), keys(local.declared))

  routed         = concat(keys(var.domains), keys(var.routes))
  unknown_routed = setsubtract(local.routed, local.names)

  unroutable = [
    for w in local.workers : w.name
    if !try(w.routable, true) && contains(local.routed, w.name)
  ]

  # A worker declaring `consumes` for a queue with no id cannot be attached, and
  # the messages would pile up with nothing reading them.
  unattached = flatten([
    for w in local.workers : [
      for b in try(w.consumes, []) : "${w.name} -> ${b}"
      if !contains(keys(var.queue_ids), b)
    ]
  ])

  do_classes = [
    for r in try(local.artifact.resources, []) : r.binding
    if try(r.kind, "") == "durable_object"
  ]
}

resource "terraform_data" "validate" {
  input = local.app

  lifecycle {
    precondition {
      condition     = try(local.artifact.schema_version, 0) == 1
      error_message = "Artifact declares schema_version ${try(local.artifact.schema_version, "none")}. This module reads version 1."
    }

    precondition {
      condition     = length(local.missing_bindings) == 0
      error_message = "The artifact binds resources this deployment does not supply: ${join(", ", local.missing_bindings)}. Add them to `bindings`."
    }

    precondition {
      condition     = length(local.extra_bindings) == 0
      error_message = "`bindings` covers names the artifact does not declare: ${join(", ", local.extra_bindings)}."
    }

    precondition {
      condition     = length(local.missing_vars) == 0
      error_message = "The artifact reads variables this deployment does not set: ${join(", ", local.missing_vars)}."
    }

    precondition {
      condition     = length(local.missing_secrets) == 0
      error_message = "The artifact needs secrets with nowhere to come from: ${join(", ", local.missing_secrets)}. Each needs an entry in `secrets`, an entry in `secrets_store`, or a `generate` block in the artifact."
    }

    precondition {
      condition     = length(local.routed) == 0 || var.zone_id != null
      error_message = "`domains` or `routes` is set, so `zone_id` is required."
    }

    precondition {
      condition     = length(local.unknown_routed) == 0
      error_message = "Routing is configured for workers this artifact does not ship: ${join(", ", local.unknown_routed)}. It ships: ${join(", ", local.names)}."
    }

    precondition {
      condition     = length(local.unroutable) == 0
      error_message = "A hostname is configured for ${join(", ", local.unroutable)}, which the artifact marks `routable: false`."
    }

    precondition {
      condition     = length(local.unattached) == 0
      error_message = "A worker consumes a queue with no id in `queue_ids`: ${join(", ", local.unattached)}."
    }

    # Rejected at build time too, so this only fires on an artifact built by
    # something else.
    precondition {
      condition     = length(local.do_classes) == 0
      error_message = "The artifact declares Durable Objects (${join(", ", local.do_classes)}), which the versions API refuses to create. See docs/artifact.md."
    }
  }
}
