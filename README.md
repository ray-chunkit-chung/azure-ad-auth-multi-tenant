# AWS OAuth2 Azure AD Example

## Current Status

This repository is scaffolded for:

- AWS-hosted frontend (S3 + CloudFront default domain)
- AWS backend (API Gateway HTTP API + Lambda + DynamoDB)
- Azure AD as the planned identity provider
- No Cognito
- No custom domain resources

## Bootstrap Backend

Terraform remote state backend resources are expected to exist:

- S3 bucket: rcoauth2azure-terraform-state
- DynamoDB lock table: rcoauth2azure-terraform-locks

Created by workflows:

- .github/workflows/tf-bootstrap.yml
- .github/workflows/tf-bootstrap-destroy.yml

## Deploy Workflows

- .github/workflows/frontend.yml
- .github/workflows/backend.yml

## Current Terraform Layout

- infra/frontend: S3 + CloudFront + SSM outputs
- infra/backend: Lambda/API/Dynamo/Secrets + optional Azure AD JWT authorizer

## Azure AD Readiness

Azure AD values are only required when turning on route protection in backend Terraform:

- enable_azure_ad_auth = true
- azure_ad_tenant_id = tenant-guid
- azure_ad_client_id = app-client-id

Until then, protected chat routes can remain in bootstrap mode with auth disabled.

## GitHub Secrets

Use the same names already configured:

- AWS_ACCESS_KEY_ID
- AWS_SECRET_ACCESS_KEY
- AWS_REGION
- AWS_ACCOUNT_ID
- OPENAI_API_KEY
