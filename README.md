# AWS + Azure AD OAuth2 Chat Example

This project is a serverless chat app with a Next.js frontend on AWS and a Python Lambda backend protected by Microsoft Entra ID (Azure AD) delegated access tokens.

Goal: give new developers and coding agents a fast mental model of architecture, auth flow, and identity configuration.

Demo URL

```text
https://d2aqs0exh7ehxw.cloudfront.net/
```

## ASCII Diagrams

### High-Level Architecture

```text
 +-------------------+         +---------------------------+
 |      Browser      |  HTTPS  |   CloudFront + S3 Static |
 |   (Next.js SPA)   +-------->+      Frontend Hosting     |
 +---------+---------+         +-------------+-------------+
     |                                     |
     | OAuth2 (PKCE)                       | API calls (Bearer token)
     v                                     v
 +---------------------------+         +---------------------------+
 | Microsoft Entra ID (AAD) |         | API Gateway (HTTP API)   |
 |  authorize/token + JWKS  |         +-------------+-------------+
 +-------------+-------------+                       |
      |                                     v
      | OIDC metadata/JWKS       +---------------------------+
      +-------------------------->+ Python Lambda            |
            | - JWT validation          |
            | - scope check chat.access |
            | - OpenAI chat logic       |
            +------+------+-------------+
             |      |
             |      +----------------------+
             v                             v
           +-------------------+      +-------------------------+
           | DynamoDB (chat)   |      | Secrets Manager (OpenAI)|
           +-------------------+      +-------------------------+
```

### OAuth2 + API Authorization Flow

```text
 User/Browser                Entra ID                    Frontend Callback            Backend API
  |                          |                               |                         |
 1) Click Sign In              |                               |                         |
  |---- authorize + PKCE --->|                               |                         |
  |<--- login/consent -------|                               |                         |
  |<--- code (redirect) -----|----> /auth/callback -------->|                         |
  |                          |                               |                         |
 2) Exchange code for tokens    |                               |                         |
  |---- token + verifier ---->|                               |                         |
  |<--- access_token,id_token|                               |                         |
  |                          |                               |                         |
 3) Call protected API          |                               |                         |
  |-------------------------------------------------------- Authorization: Bearer --->|
  |                          |                               |                         |
 4) Validate + enforce scope    |                               |                         |
  |                          |<--- fetch OIDC/JWKS as needed --------------------------|
  |                          |                               |                         |
  |<------------------------------ 200 OK (or 401/403) -------------------------------|
```

### CI/CD and Infra Flow

```text
   GitHub Actions
      |
   +-----------+-----------+
   |                       |
   v                       v
  frontend.yml            backend.yml
   |                       |
  Terraform apply        Build Lambda zip
  (infra/frontend)       Terraform apply (infra/backend)
   |                       |
  S3 + CloudFront + SSM   API GW + Lambda + DynamoDB + Secrets + SSM
   |                       |
   +-----------+-----------+
      |
      v
   Deployed Full Stack
```

   ## Mermaid Diagrams

   ### High-Level Architecture (Mermaid)

   ```mermaid
   flowchart LR
      B[Browser\nNext.js SPA] -->|HTTPS| CF[CloudFront + S3\nFrontend Hosting]
      B -->|OAuth2 PKCE| AAD[Microsoft Entra ID\nAuthorize/Token + JWKS]
      B -->|Bearer Access Token| APIGW[API Gateway\nHTTP API]

      APIGW --> L[Python Lambda\nJWT validation + scope check + chat logic]
      L --> DDB[(DynamoDB\nchat data)]
      L --> SM[(Secrets Manager\nOpenAI key)]
      L -.->|OIDC metadata + JWKS| AAD
   ```

   ### OAuth2 + API Authorization Flow (Mermaid)

   ```mermaid
   sequenceDiagram
      autonumber
      participant U as User/Browser
      participant A as Entra ID
      participant F as Frontend Callback
      participant B as Backend API

      U->>A: Authorize request (PKCE, openid profile email chat.access)
      A-->>U: Login + consent, then authorization code
      U->>F: Redirect to /auth/callback with code
      F->>A: Token request (code + code_verifier)
      A-->>F: access_token + id_token
      F->>B: API call with Bearer access_token
      B->>A: Fetch/refresh OIDC metadata + JWKS (as needed)
      B-->>F: 200 OK (or 401/403 on auth failure)
   ```

   ### CI/CD and Infra Flow (Mermaid)

   ```mermaid
   flowchart TB
      GHA[GitHub Actions] --> FW[frontend.yml]
      GHA --> BW[backend.yml]

      FW --> TF1[Terraform apply\ninfra/frontend]
      TF1 --> FE[S3 + CloudFront + SSM]

      BW --> PKG[Build Lambda artifact]
      PKG --> TF2[Terraform apply\ninfra/backend]
      TF2 --> BE[API Gateway + Lambda + DynamoDB + Secrets + SSM]

      FE --> APP[Deployed Full Stack]
      BE --> APP
   ```

## Architecture At A Glance

### Frontend

- Next.js app (static export) in `frontend/`
- Hosted on S3, delivered through CloudFront
- Uses OAuth 2.0 Authorization Code Flow with PKCE directly against Microsoft identity platform

### Backend

- Python Lambda in `backend/src/handler.py`
- Exposed via API Gateway HTTP API
- Persists chat data in DynamoDB
- Reads OpenAI API key from AWS Secrets Manager
- Validates Azure AD JWT access tokens (signature, issuer, audience, scope)

### Infrastructure

- Terraform for frontend in `infra/frontend/`
- Terraform for backend in `infra/backend/`
- Runtime/discovery values are published to AWS SSM Parameter Store
- CI/CD via GitHub Actions workflows in `.github/workflows/`

## Auth Flow (End To End)

1. User opens login page and clicks Microsoft sign-in.
2. Frontend creates PKCE verifier/challenge and redirects to Azure authorize endpoint.
3. Requested scopes include OpenID scopes plus API delegated scope (`chat.access`).
4. Azure returns an authorization code to frontend callback.
5. Frontend exchanges code for tokens at Azure token endpoint (PKCE, no client secret).
6. Frontend stores tokens in browser session storage.
7. Frontend calls backend with `Authorization: Bearer <access_token>`.
8. Backend validates token using Azure OIDC metadata + JWKS.
9. Backend enforces:

- Expected audience for this API
- Delegated user token (not app-only token)
- Required scope `chat.access` in `scp` claim

10. If valid, backend serves chat APIs; otherwise returns 401/403.

## Azure AD Setup (What Was Configured)

No IDs, tenant names, or credentials are documented here.

### 1. App Registration For OAuth2 SPA Login

- Redirect URI configured for SPA callback path (`/auth/callback`)
- Post-logout redirect URI configured
- OAuth2 Authorization Code + PKCE flow used from browser

### 2. Expose API Scope

- Application ID URI set to `api://<application-id>`
- Delegated scope created and enabled:
- Scope name: `chat.access`
- Consent display name/description configured
- Who can consent: **Admins and users**

### 3. API Permissions

- Client app requests delegated permission to the exposed API scope (`chat.access`)
- OpenID scopes requested for sign-in profile claims (`openid`, `profile`, `email`)
- Tenant admin consent can be granted when organization policy requires it

### 4. Supported Account Types

- Must match intended users (single-tenant vs multi-tenant vs personal accounts)
- Current flow is compatible with common endpoint usage when app registration policy allows it

## Runtime Configuration (Conceptual)

Frontend requires:

- Azure tenant path/id
- Azure application (client) id
- Redirect and logout URLs
- API scope string in the shape `api://<application-id>/chat.access`
- Backend API base URL

Backend requires:

- Azure tenant path/id
- Azure application id used as expected audience
- Required scope (`chat.access`)
- DynamoDB table name
- OpenAI secret ARN

## CI/CD And Deployment

- Frontend workflow builds static assets, deploys to S3, invalidates CloudFront
- Backend workflow builds Lambda artifact, applies Terraform, updates secret value, and runs health smoke test
- Terraform bootstrap workflows create/destroy remote state prerequisites

## Repo Map

- `frontend/`: Next.js UI and OAuth client flow
- `backend/`: Lambda source and packaging
- `infra/frontend/`: S3 + CloudFront + SSM outputs
- `infra/backend/`: API Gateway + Lambda + DynamoDB + Secrets + SSM outputs
- `local/`: local notes and operational docs

## Security Notes

- Never commit secrets, app IDs, tenant IDs, tokens, or key material.
- Keep least-privilege IAM and Azure permissions.
- Use delegated scope checks on backend for every protected route.
- Rotate secrets and review token validation assumptions regularly.

## Troubleshooting Quick Checks

If login or API auth fails, verify in order:

1. Scope exists and is enabled in Azure (`chat.access`).
2. Application ID URI matches the requested scope prefix (`api://<application-id>`).
3. Frontend is requesting the exact scope string.
4. Access token `aud` matches backend expected audience.
5. Access token `scp` contains `chat.access`.
6. Redirect URI in Azure exactly matches deployed callback URL.
7. Tenant/account-type and consent policy align with the user account being tested.
