# The artifact states what it needs. These checks run during `plan`, which is the
# last point where a gap is a message rather than a 500 on the first request that
# hit it.

locals {
  # `assets` is part of the worker version rather than a binding the caller
  # supplies, and the kinds in `self_bound` carry no deployment input at all, so
  # this module binds them itself. Demanding either from the caller would make a
  # binding it already knows how to make look like a missing one.
  missing_bindings = [
    for k, r in local.declared : k
    if r.kind != "assets"
    && !contains(keys(local.self_bound), k)
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
  #
  # Read off the NORMALISED `local.consumes`, not the raw entry. A `consumes`
  # entry is either a bare binding name or an object carrying the consumer's
  # settings, and interpolating the object form into this message aborted the
  # whole plan with a type error before any precondition was reached.
  unattached = flatten([
    for w in local.workers : [
      for c in local.consumes[w.name] : "${w.name} -> ${c.binding}"
      if !contains(keys(var.queue_ids), c.binding)
    ]
  ])

  # A worker's `bindings` list naming something the artifact never declared.
  # `local.uses` filters it out silently, so without this the script deploys
  # missing a binding its author believed it had.
  unknown_uses = flatten([
    for w in local.workers : [
      for k in try(w.bindings, []) : "${w.name} -> ${k}"
      if !contains(keys(local.declared), k)
    ]
  ])

  # Two modules of one worker that reduce to the same name. `modules` is a set on
  # the version, so a collision either drops one silently or reaches the API as
  # two modules sharing a name.
  duplicate_modules = flatten([
    for w, ms in local.modules : [
      for n in distinct([for m in ms : m.name]) : "${w} -> ${n}"
      if length([for m in ms : m if m.name == n]) > 1
    ]
  ])

  do_classes = [
    for r in try(local.artifact.resources, []) : r.binding
    if try(r.kind, "") == "durable_object"
  ]

  # `features` names extensions the artifact RELIES on, so an unrecognised one
  # has to be refused rather than ignored: ignoring it deploys a configuration
  # that is missing whatever the feature was for, and nothing later says so. This
  # module implements no feature, so every entry is unrecognised.
  unknown_features = try(local.artifact.features, [])

  # A module the artifact names and `artifact_dir` does not hold. Without this
  # the plan is clean and the upload fails on apply, after the account already
  # has the workers this run created. `try`, because `fileexists` raises on a
  # path that turned out to be a directory, which is equally not a module.
  missing_files = flatten([
    for w, ms in local.modules : [
      for m in ms : "${w} -> ${m.content_file}"
      if !try(fileexists(m.content_file), false)
    ]
  ])
}

resource "terraform_data" "validate" {
  input = local.app

  lifecycle {
    precondition {
      condition     = try(local.artifact.schema_version, 0) == 1
      error_message = "Artifact declares schema_version ${try(local.artifact.schema_version, "none")}. This module reads version 1."
    }

    precondition {
      condition     = length(local.unknown_features) == 0
      error_message = "The artifact relies on features this module does not implement: ${join(", ", local.unknown_features)}. A deployer that does not recognise a feature has to refuse rather than deploy part of the configuration."
    }

    precondition {
      condition     = length(local.missing_files) == 0
      error_message = "Modules the artifact names are not under `artifact_dir`: ${join(", ", local.missing_files)}. Pull the artifact into that directory, or point `artifact_dir` at the one that holds it."
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

    precondition {
      condition     = length(local.unknown_uses) == 0
      error_message = "A worker binds a resource the artifact does not declare: ${join(", ", local.unknown_uses)}. It declares: ${join(", ", keys(local.declared))}."
    }

    precondition {
      condition     = length(local.duplicate_modules) == 0
      error_message = "Two modules of one worker upload under the same name: ${join(", ", local.duplicate_modules)}. Module names are relative to the entry module's directory, so a file beside the entry and one at the layer root can collide."
    }

    # Rejected at build time too, so this only fires on an artifact built by
    # something else.
    precondition {
      condition     = length(local.do_classes) == 0
      error_message = "The artifact declares Durable Objects (${join(", ", local.do_classes)}), which the versions API refuses to create. See docs/artifact.md."
    }
  }
}
