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

variable "enable_azure_ad_auth" {
  description = "Enable Azure AD JWT authorizer on protected routes"
  type        = bool
  default     = false
}

variable "azure_ad_tenant_id" {
  description = "Azure AD tenant ID used to build issuer URL"
  type        = string
  default     = ""
}

variable "azure_ad_client_id" {
  description = "Azure AD application client ID used as API audience"
  type        = string
  default     = ""
}
