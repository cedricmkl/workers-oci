# Composing the two modules.
#
# terraform/resources creates what the artifact declares; terraform/deploy puts
# it live. Either half can be replaced with your own code, since they meet at an
# ordinary map of binding objects.

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.19.0"
    }
  }
}

# Configured here, not in the modules. The token comes from CLOUDFLARE_API_TOKEN
# in this case, and could as easily come from a Vault data source or a file.
provider "cloudflare" {}

variable "account_id" { type = string }
variable "zone_id" { type = string }
variable "api_key" {
  type      = string
  sensitive = true
}

locals {
  dir      = "${path.module}/.artifact/v1"
  artifact = jsondecode(file("${local.dir}/worker-app.json"))
}

module "resources" {
  source = "../../terraform/resources"

  account_id = var.account_id
  artifact   = local.artifact

  # Naming is yours. A convention, a lookup table, whatever the rest of your
  # configuration already does.
  names = {
    DB     = "example-db"
    EVENTS = "example-events"
  }
}

variable "cache_namespace_id" {
  description = "A namespace this configuration already owns, bound without being managed here."
  type        = string
  default     = "0f2ac74b498b48028cb68387c421e279"
}

module "deploy" {
  source = "../../terraform/deploy"

  account_id   = var.account_id
  artifact_dir = local.dir
  artifact     = local.artifact

  bindings = merge(
    module.resources.bindings,
    {
      CACHE = {
        type         = "kv_namespace"
        name         = "CACHE"
        namespace_id = var.cache_namespace_id
      }
    },
  )

  queue_ids          = module.resources.queue_ids
  dead_letter_queues = module.resources.dead_letter_queues

  vars = {
    PUBLIC_URL = "https://app.example.com"
  }

  # From wherever this configuration keeps values.
  secrets = {
    API_KEY = var.api_key
  }

  zone_id = var.zone_id
  domains = {
    api = ["app.example.com"]
  }
}

output "workers" {
  value = module.deploy.workers
}
