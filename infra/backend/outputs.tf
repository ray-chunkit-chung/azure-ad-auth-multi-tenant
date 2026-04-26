output "chat_api_url" {
  description = "HTTP API base URL (default execute-api endpoint)"
  value       = aws_apigatewayv2_api.chat.api_endpoint
}

output "chat_table_name" {
  description = "DynamoDB table name for chat history"
  value       = aws_dynamodb_table.chat.name
}

output "openai_secret_arn" {
  description = "Secrets Manager ARN for OpenAI API key"
  value       = aws_secretsmanager_secret.openai_api_key.arn
}
