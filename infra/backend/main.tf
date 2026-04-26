locals {
  lambda_zip_path    = "${path.module}/../../backend/dist/lambda.zip"
  openai_secret_name = "${var.project_prefix}/backend/openai-api-key"
}

resource "aws_secretsmanager_secret" "openai_api_key" {
  name                    = local.openai_secret_name
  description             = "OpenAI API key for ${var.project_prefix} backend"
  recovery_window_in_days = 0
}

resource "aws_dynamodb_table" "chat" {
  name         = "${var.project_prefix}-chat"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }
}

resource "aws_iam_role" "chat_lambda" {
  name = "${var.project_prefix}-chat-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
        Action = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "chat_lambda" {
  name = "${var.project_prefix}-chat-lambda-policy"
  role = aws_iam_role.chat_lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "CloudWatchLogs"
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Sid    = "ChatTableAccess"
        Effect = "Allow"
        Action = [
          "dynamodb:BatchWriteItem",
          "dynamodb:DeleteItem",
          "dynamodb:GetItem",
          "dynamodb:PutItem",
          "dynamodb:Query",
          "dynamodb:UpdateItem"
        ]
        Resource = aws_dynamodb_table.chat.arn
      },
      {
        Sid    = "OpenAISecretRead"
        Effect = "Allow"
        Action = ["secretsmanager:GetSecretValue"]
        Resource = aws_secretsmanager_secret.openai_api_key.arn
      }
    ]
  })
}

resource "aws_lambda_function" "chat_api" {
  function_name = "${var.project_prefix}-chat-api"
  role          = aws_iam_role.chat_lambda.arn
  runtime       = "python3.13"
  handler       = "handler.lambda_handler"
  timeout       = 30
  memory_size   = 1024

  filename         = local.lambda_zip_path
  source_code_hash = filebase64sha256(local.lambda_zip_path)

  environment {
    variables = {
      CHAT_TABLE_NAME      = aws_dynamodb_table.chat.name
      OPENAI_SECRET_ARN    = aws_secretsmanager_secret.openai_api_key.arn
      OPENAI_MODEL         = var.openai_model
      OPENAI_SYSTEM_PROMPT = "You are a helpful assistant."
      MAX_INPUT_CHARACTERS = "4000"
      AZURE_AD_TENANT_ID   = var.azure_ad_tenant_id
      AZURE_APPLICATION_ID = var.azure_application_id
      AZURE_REQUIRED_SCOPE = var.azure_required_scope
    }
  }
}

resource "aws_cloudwatch_log_group" "chat_api" {
  name              = "/aws/lambda/${aws_lambda_function.chat_api.function_name}"
  retention_in_days = 14
}

resource "aws_apigatewayv2_api" "chat" {
  name          = "${var.project_prefix}-chat-http-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = var.frontend_allowed_origins
    allow_methods = ["GET", "POST", "DELETE", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 3600
  }
}

resource "aws_apigatewayv2_integration" "chat_lambda" {
  api_id                 = aws_apigatewayv2_api.chat.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.chat_api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "health" {
  api_id    = aws_apigatewayv2_api.chat.id
  route_key = "GET /chat/health"
  target    = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
}

resource "aws_apigatewayv2_route" "list_sessions" {
  api_id    = aws_apigatewayv2_api.chat.id
  route_key = "GET /chat/sessions"
  target    = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
}

resource "aws_apigatewayv2_route" "get_session" {
  api_id    = aws_apigatewayv2_api.chat.id
  route_key = "GET /chat/sessions/{sessionId}"
  target    = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
}

resource "aws_apigatewayv2_route" "delete_session" {
  api_id    = aws_apigatewayv2_api.chat.id
  route_key = "DELETE /chat/sessions/{sessionId}"
  target    = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
}

resource "aws_apigatewayv2_route" "post_message" {
  api_id    = aws_apigatewayv2_api.chat.id
  route_key = "POST /chat/messages"
  target    = "integrations/${aws_apigatewayv2_integration.chat_lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.chat.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "allow_apigw" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.chat_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.chat.execution_arn}/*/*"
}

resource "aws_cloudwatch_event_rule" "lambda_warmup" {
  count = var.enable_lambda_warmup ? 1 : 0

  name                = "${var.project_prefix}-chat-lambda-warmup"
  description         = "Periodic warmup for ${aws_lambda_function.chat_api.function_name}"
  schedule_expression = "rate(${var.lambda_warmup_interval_minutes} minutes)"
}

resource "aws_cloudwatch_event_target" "lambda_warmup" {
  count = var.enable_lambda_warmup ? 1 : 0

  rule      = aws_cloudwatch_event_rule.lambda_warmup[0].name
  target_id = "chat-lambda-warmup"
  arn       = aws_lambda_function.chat_api.arn

  input = jsonencode({
    routeKey = "GET /chat/health"
  })
}

resource "aws_lambda_permission" "allow_eventbridge_warmup" {
  count = var.enable_lambda_warmup ? 1 : 0

  statement_id  = "AllowExecutionFromEventBridgeWarmup"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.chat_api.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.lambda_warmup[0].arn
}

resource "aws_ssm_parameter" "chat_api_url" {
  name  = "/${var.project_prefix}/backend/chat-api-url"
  type  = "String"
  value = aws_apigatewayv2_api.chat.api_endpoint
}

resource "aws_ssm_parameter" "openai_secret_arn" {
  name  = "/${var.project_prefix}/backend/openai-secret-arn"
  type  = "String"
  value = aws_secretsmanager_secret.openai_api_key.arn
}

resource "aws_ssm_parameter" "chat_table_name" {
  name  = "/${var.project_prefix}/backend/chat-table-name"
  type  = "String"
  value = aws_dynamodb_table.chat.name
}
