variable "project_prefix" {
  description = "Prefix for all AWS resources"
  type        = string
  default     = "rcoauth2azure"
}

variable "openai_model" {
  description = "OpenAI model name"
  type        = string
  default     = "gpt-5-mini"
}

variable "frontend_allowed_origins" {
  description = "Browser origins allowed by API CORS. Use explicit frontend URLs in production."
  type        = list(string)
  default     = ["*"]
}

variable "enable_lambda_warmup" {
  description = "Enable EventBridge schedule that periodically warms the chat Lambda"
  type        = bool
  default     = true
}

variable "lambda_warmup_interval_minutes" {
  description = "Warmup interval in minutes for the chat Lambda"
  type        = number
  default     = 5
}

variable "azure_ad_tenant_id" {
  description = "Azure AD tenant path used for OIDC discovery (for example common)"
  type        = string
  default     = "common"
}

variable "azure_application_id" {
  description = "Azure AD application ID used as API audience"
  type        = string

  validation {
    condition     = length(trimspace(var.azure_application_id)) > 0
    error_message = "azure_application_id must be provided."
  }
}

variable "azure_required_scope" {
  description = "Delegated scope required in access token scp claim"
  type        = string
  default     = "chat.access"
}
