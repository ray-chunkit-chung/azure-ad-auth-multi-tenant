import base64
import json
import logging
import os
import re
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3
import jwt
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from openai import OpenAI
from jwt.algorithms import RSAAlgorithm

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

TABLE_NAME = os.environ["CHAT_TABLE_NAME"]
OPENAI_SECRET_ARN = os.environ["OPENAI_SECRET_ARN"]
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini")
SYSTEM_PROMPT = os.getenv("OPENAI_SYSTEM_PROMPT", "You are a helpful assistant.")
MAX_INPUT_CHARACTERS = int(os.getenv("MAX_INPUT_CHARACTERS", "4000"))

AZURE_AD_TENANT_ID = os.getenv("AZURE_AD_TENANT_ID", "common").strip() or "common"
AZURE_APPLICATION_ID = os.environ["AZURE_APPLICATION_ID"]
AZURE_REQUIRED_SCOPE = os.getenv("AZURE_REQUIRED_SCOPE", "chat.access")
AZURE_ALLOWED_AUDIENCES = {
    AZURE_APPLICATION_ID,
    f"api://{AZURE_APPLICATION_ID}",
}
AZURE_OIDC_CONFIG_URL = (
    f"https://login.microsoftonline.com/{AZURE_AD_TENANT_ID}/v2.0/.well-known/openid-configuration"
)
AZURE_ISSUER_PATTERN = re.compile(
    r"^https://login\.microsoftonline\.com/[0-9a-fA-F-]{36}/v2\.0$"
)

AUTH_CACHE_TTL_SECONDS = int(os.getenv("AUTH_CACHE_TTL_SECONDS", "3600"))

DYNAMODB = boto3.resource("dynamodb")
TABLE = DYNAMODB.Table(TABLE_NAME)
SECRETS_MANAGER = boto3.client("secretsmanager")

OPENAI_CLIENT: OpenAI | None = None
OIDC_CONFIG_CACHE: dict[str, Any] = {"expires_at": 0, "value": None}
JWKS_CACHE: dict[str, dict[str, Any]] = {}


class ApiError(Exception):
    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _json_response(status_code: int, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "statusCode": status_code,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps(payload),
    }


def _read_body(event: dict[str, Any]) -> dict[str, Any]:
    body = event.get("body")
    if body is None:
        return {}

    if event.get("isBase64Encoded"):
        body = base64.b64decode(body).decode("utf-8")

    try:
        parsed = json.loads(body)
    except json.JSONDecodeError as exc:
        raise ApiError(400, "Request body must be valid JSON") from exc

    if not isinstance(parsed, dict):
        raise ApiError(400, "Request body must be a JSON object")

    return parsed


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _now_epoch_ms() -> int:
    return int(time.time() * 1000)


def _user_pk(user_sub: str) -> str:
    return f"USER#{user_sub}"


def _session_sk(session_id: str) -> str:
    return f"SESS#{session_id}"


def _message_sk(session_id: str, created_at_epoch: int, message_id: str) -> str:
    return f"MSG#{session_id}#{created_at_epoch:013d}#{message_id}"


def _as_int(value: Any, default: int = 0) -> int:
    if isinstance(value, Decimal):
        return int(value)
    if isinstance(value, (float, int)):
        return int(value)
    return default


def _as_str(value: Any, default: str = "") -> str:
    return value if isinstance(value, str) else default


def _clean_message(value: str) -> str:
    return " ".join(value.strip().split())


def _generate_title(first_message: str) -> str:
    cleaned = _clean_message(first_message)
    if not cleaned:
        return "New chat"

    max_title_chars = 72
    if len(cleaned) <= max_title_chars:
        return cleaned

    truncated = cleaned[:max_title_chars]
    if " " in truncated:
        truncated = truncated.rsplit(" ", 1)[0]

    return f"{truncated}..."


def _serialize_session(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _as_str(item.get("sessionId")),
        "title": _as_str(item.get("title"), "New chat"),
        "createdAt": _as_str(item.get("createdAt")),
        "updatedAt": _as_str(item.get("updatedAt")),
        "lastMessagePreview": _as_str(item.get("lastMessagePreview")),
        "messageCount": _as_int(item.get("messageCount")),
    }


def _serialize_message(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": _as_str(item.get("messageId")),
        "role": _as_str(item.get("role")),
        "content": _as_str(item.get("content")),
        "createdAt": _as_str(item.get("createdAt")),
    }


def _extract_user_sub_from_claims(claims: dict[str, Any]) -> str:
    # Azure AD delegated tokens usually contain oid for users.
    # sub is used as fallback so personal accounts still work.
    user_sub = claims.get("oid") or claims.get("sub")
    if not isinstance(user_sub, str) or not user_sub:
        raise ApiError(401, "Unauthorized")
    return user_sub


def _http_get_json(url: str) -> dict[str, Any]:
    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=5) as response:
            payload = response.read().decode("utf-8")
    except urllib.error.URLError as exc:
        LOGGER.exception("Failed to fetch auth metadata from %s", url)
        raise ApiError(503, "Authentication service unavailable") from exc

    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise ApiError(503, "Authentication metadata is invalid") from exc

    if not isinstance(parsed, dict):
        raise ApiError(503, "Authentication metadata is invalid")

    return parsed


def _get_oidc_configuration() -> dict[str, Any]:
    now = int(time.time())
    cached = OIDC_CONFIG_CACHE.get("value")
    expires_at = int(OIDC_CONFIG_CACHE.get("expires_at") or 0)
    if isinstance(cached, dict) and expires_at > now:
        return cached

    config = _http_get_json(AZURE_OIDC_CONFIG_URL)
    issuer = config.get("issuer")
    jwks_uri = config.get("jwks_uri")
    if not isinstance(issuer, str) or not isinstance(jwks_uri, str):
        raise ApiError(503, "Authentication metadata missing issuer or jwks")

    OIDC_CONFIG_CACHE["value"] = config
    OIDC_CONFIG_CACHE["expires_at"] = now + AUTH_CACHE_TTL_SECONDS
    return config


def _get_jwks(jwks_uri: str) -> dict[str, Any]:
    now = int(time.time())
    cached = JWKS_CACHE.get(jwks_uri)
    if cached and int(cached.get("expires_at", 0)) > now:
        value = cached.get("value")
        if isinstance(value, dict):
            return value

    jwks = _http_get_json(jwks_uri)
    keys = jwks.get("keys")
    if not isinstance(keys, list):
        raise ApiError(503, "Authentication key set is invalid")

    JWKS_CACHE[jwks_uri] = {
        "value": jwks,
        "expires_at": now + AUTH_CACHE_TTL_SECONDS,
    }
    return jwks


def _extract_bearer_token(event: dict[str, Any]) -> str:
    headers = event.get("headers") or {}
    if not isinstance(headers, dict):
        raise ApiError(401, "Missing Authorization header")

    authorization = ""
    for key, value in headers.items():
        if isinstance(key, str) and key.lower() == "authorization" and isinstance(value, str):
            authorization = value
            break

    if not authorization:
        raise ApiError(401, "Missing Authorization header")

    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer" or not parts[1].strip():
        raise ApiError(401, "Invalid Authorization header")

    return parts[1].strip()


def _parse_scope_claim(claims: dict[str, Any]) -> set[str]:
    scp = claims.get("scp")
    if not isinstance(scp, str) or not scp.strip():
        return set()
    return {part for part in scp.split(" ") if part}


def _signing_key_from_jwks(token: str, jwks: dict[str, Any]) -> Any:
    try:
        header = jwt.get_unverified_header(token)
    except jwt.InvalidTokenError as exc:
        raise ApiError(401, "Invalid token header") from exc

    kid = header.get("kid")
    if not isinstance(kid, str) or not kid:
        raise ApiError(401, "Token signing key is missing")

    keys = jwks.get("keys")
    if not isinstance(keys, list):
        raise ApiError(503, "Authentication key set is invalid")

    for key in keys:
        if isinstance(key, dict) and key.get("kid") == kid:
            try:
                return RSAAlgorithm.from_jwk(json.dumps(key))
            except Exception as exc:  # pylint: disable=broad-except
                raise ApiError(401, "Unsupported signing key") from exc

    raise ApiError(401, "Token signing key not recognized")


def _validate_issuer(issuer: Any) -> None:
    if not isinstance(issuer, str) or not AZURE_ISSUER_PATTERN.match(issuer):
        raise ApiError(401, "Token issuer is invalid")


def _validate_access_token(token: str) -> dict[str, Any]:
    oidc = _get_oidc_configuration()
    jwks_uri = oidc.get("jwks_uri")
    if not isinstance(jwks_uri, str) or not jwks_uri:
        raise ApiError(503, "Authentication metadata is incomplete")

    jwks = _get_jwks(jwks_uri)
    key = _signing_key_from_jwks(token, jwks)

    try:
        claims = jwt.decode(
            token,
            key=key,
            algorithms=["RS256"],
            audience=list(AZURE_ALLOWED_AUDIENCES),
            options={
                "require": ["exp", "iss", "aud"],
                "verify_signature": True,
                "verify_aud": True,
                "verify_exp": True,
                "verify_iss": False,
            },
        )
    except jwt.ExpiredSignatureError as exc:
        raise ApiError(401, "Token is expired") from exc
    except jwt.InvalidAudienceError as exc:
        raise ApiError(401, "Token audience is invalid") from exc
    except jwt.InvalidTokenError as exc:
        raise ApiError(401, "Token is invalid") from exc

    _validate_issuer(claims.get("iss"))

    scope_set = _parse_scope_claim(claims)
    if not scope_set:
        raise ApiError(403, "Delegated user token is required")

    if AZURE_REQUIRED_SCOPE not in scope_set:
        raise ApiError(403, f"Token is missing required scope: {AZURE_REQUIRED_SCOPE}")

    if claims.get("idtyp") == "app":
        raise ApiError(403, "Application tokens are not allowed")

    return claims


def _extract_secret_value(secret_string: str) -> str:
    secret_string = secret_string.strip()
    if not secret_string:
        raise ApiError(500, "OpenAI secret is empty")

    if secret_string.startswith("{"):
        try:
            payload = json.loads(secret_string)
        except json.JSONDecodeError:
            return secret_string

        if not isinstance(payload, dict):
            raise ApiError(500, "OpenAI secret payload is invalid")

        for key in ("OPENAI_API_KEY", "openai_api_key", "api_key"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()

        raise ApiError(500, "OpenAI secret JSON does not contain an API key")

    return secret_string


def _get_openai_client() -> OpenAI:
    global OPENAI_CLIENT

    if OPENAI_CLIENT is not None:
        return OPENAI_CLIENT

    try:
        secret_response = SECRETS_MANAGER.get_secret_value(SecretId=OPENAI_SECRET_ARN)
    except ClientError as exc:
        LOGGER.exception("Failed to read OpenAI secret")
        raise ApiError(500, "Failed to load OpenAI configuration") from exc

    secret_raw = secret_response.get("SecretString")
    if not isinstance(secret_raw, str):
        raise ApiError(500, "OpenAI secret string is missing")

    api_key = _extract_secret_value(secret_raw)
    OPENAI_CLIENT = OpenAI(api_key=api_key)
    return OPENAI_CLIENT


def _list_sessions(user_sub: str) -> dict[str, Any]:
    response = TABLE.query(
        KeyConditionExpression=Key("pk").eq(_user_pk(user_sub))
        & Key("sk").begins_with("SESS#")
    )

    items = response.get("Items", [])
    sessions = [_serialize_session(item) for item in items]
    sessions.sort(key=lambda s: s.get("updatedAt") or "", reverse=True)

    return {"sessions": sessions}


def _get_session_item(user_sub: str, session_id: str) -> dict[str, Any]:
    result = TABLE.get_item(
        Key={"pk": _user_pk(user_sub), "sk": _session_sk(session_id)}
    )
    item = result.get("Item")
    if not item:
        raise ApiError(404, "Session not found")
    return item


def _list_session_messages(user_sub: str, session_id: str) -> dict[str, Any]:
    session_item = _get_session_item(user_sub, session_id)

    response = TABLE.query(
        KeyConditionExpression=Key("pk").eq(_user_pk(user_sub))
        & Key("sk").begins_with(f"MSG#{session_id}#")
    )
    messages = [_serialize_message(item) for item in response.get("Items", [])]

    return {
        "session": _serialize_session(session_item),
        "messages": messages,
    }


def _query_session_message_keys(user_sub: str, session_id: str) -> list[dict[str, str]]:
    keys: list[dict[str, str]] = []
    exclusive_start_key: dict[str, Any] | None = None

    while True:
        query_args: dict[str, Any] = {
            "KeyConditionExpression": Key("pk").eq(_user_pk(user_sub))
            & Key("sk").begins_with(f"MSG#{session_id}#"),
            "ProjectionExpression": "pk, sk",
        }
        if exclusive_start_key:
            query_args["ExclusiveStartKey"] = exclusive_start_key

        response = TABLE.query(**query_args)
        for item in response.get("Items", []):
            pk = _as_str(item.get("pk"))
            sk = _as_str(item.get("sk"))
            if pk and sk:
                keys.append({"pk": pk, "sk": sk})

        exclusive_start_key = response.get("LastEvaluatedKey")
        if not exclusive_start_key:
            break

    return keys


def _delete_session(user_sub: str, session_id: str) -> dict[str, Any]:
    _get_session_item(user_sub, session_id)
    message_keys = _query_session_message_keys(user_sub, session_id)

    with TABLE.batch_writer() as batch:
        for key in message_keys:
            batch.delete_item(Key=key)

        batch.delete_item(Key={"pk": _user_pk(user_sub), "sk": _session_sk(session_id)})

    return {
        "sessionId": session_id,
        "deletedMessageCount": len(message_keys),
    }


def _create_session(user_sub: str, first_message: str) -> dict[str, Any]:
    session_id = str(uuid.uuid4())
    now_iso = _now_iso()

    session_item = {
        "pk": _user_pk(user_sub),
        "sk": _session_sk(session_id),
        "entityType": "session",
        "sessionId": session_id,
        "title": _generate_title(first_message),
        "createdAt": now_iso,
        "updatedAt": now_iso,
        "updatedAtEpoch": _now_epoch_ms(),
        "messageCount": 0,
        "lastMessagePreview": "",
    }

    TABLE.put_item(
        Item=session_item,
        ConditionExpression="attribute_not_exists(pk) AND attribute_not_exists(sk)",
    )
    return session_item


def _preview_text(value: str, max_chars: int = 120) -> str:
    cleaned = _clean_message(value)
    if len(cleaned) <= max_chars:
        return cleaned

    truncated = cleaned[:max_chars]
    if " " in truncated:
        truncated = truncated.rsplit(" ", 1)[0]

    return f"{truncated}..."


def _query_session_messages_for_model(
    user_sub: str, session_id: str
) -> list[dict[str, str]]:
    response = TABLE.query(
        KeyConditionExpression=Key("pk").eq(_user_pk(user_sub))
        & Key("sk").begins_with(f"MSG#{session_id}#")
    )

    messages: list[dict[str, str]] = []
    for item in response.get("Items", []):
        role = _as_str(item.get("role"))
        content = _as_str(item.get("content"))
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})

    return messages[-40:]


def _call_openai(message_history: list[dict[str, str]]) -> str:
    try:
        client = _get_openai_client()
        input_items: list[dict[str, str]] = [
            {"role": "system", "content": SYSTEM_PROMPT}
        ]
        input_items.extend(message_history)

        response = client.responses.create(
            model=OPENAI_MODEL,
            input=input_items,
        )
    except Exception as exc:  # pylint: disable=broad-except
        LOGGER.exception("OpenAI request failed")
        raise ApiError(502, "Assistant provider request failed") from exc

    output_text = getattr(response, "output_text", "")
    if isinstance(output_text, str) and output_text.strip():
        return output_text.strip()

    raise ApiError(502, "Assistant returned an empty response")


def _save_message(
    user_sub: str, session_id: str, role: str, content: str
) -> dict[str, Any]:
    message_id = str(uuid.uuid4())
    created_at_epoch = _now_epoch_ms()
    message_item = {
        "pk": _user_pk(user_sub),
        "sk": _message_sk(session_id, created_at_epoch, message_id),
        "entityType": "message",
        "sessionId": session_id,
        "messageId": message_id,
        "role": role,
        "content": content,
        "createdAt": _now_iso(),
    }
    TABLE.put_item(Item=message_item)
    return message_item


def _update_session_after_reply(
    user_sub: str,
    session_id: str,
    assistant_reply: str,
) -> dict[str, Any]:
    now_iso = _now_iso()
    now_epoch = _now_epoch_ms()

    TABLE.update_item(
        Key={"pk": _user_pk(user_sub), "sk": _session_sk(session_id)},
        UpdateExpression=(
            "SET updatedAt = :updated_at, updatedAtEpoch = :updated_at_epoch, "
            "lastMessagePreview = :last_preview, "
            "messageCount = if_not_exists(messageCount, :zero) + :increment"
        ),
        ExpressionAttributeValues={
            ":updated_at": now_iso,
            ":updated_at_epoch": now_epoch,
            ":last_preview": _preview_text(assistant_reply),
            ":zero": 0,
            ":increment": 2,
        },
    )

    refreshed = _get_session_item(user_sub, session_id)
    return refreshed


def _post_message(user_sub: str, event: dict[str, Any]) -> dict[str, Any]:
    body = _read_body(event)
    message_raw = body.get("message")
    if not isinstance(message_raw, str):
        raise ApiError(400, "message is required and must be a string")

    message = message_raw.strip()
    if not message:
        raise ApiError(400, "message must not be empty")

    if len(message) > MAX_INPUT_CHARACTERS:
        raise ApiError(400, f"message exceeds {MAX_INPUT_CHARACTERS} characters")

    session_id = body.get("sessionId")
    if session_id is not None and not isinstance(session_id, str):
        raise ApiError(400, "sessionId must be a string when provided")

    if isinstance(session_id, str) and session_id.strip():
        session_id = session_id.strip()
        _get_session_item(user_sub, session_id)
    else:
        new_session = _create_session(user_sub, message)
        session_id = _as_str(new_session.get("sessionId"))

    user_message_item = _save_message(user_sub, session_id, "user", message)

    message_history = _query_session_messages_for_model(user_sub, session_id)
    assistant_text = _call_openai(message_history)
    assistant_message_item = _save_message(
        user_sub, session_id, "assistant", assistant_text
    )

    session_item = _update_session_after_reply(user_sub, session_id, assistant_text)

    return {
        "session": _serialize_session(session_item),
        "userMessage": _serialize_message(user_message_item),
        "assistantMessage": _serialize_message(assistant_message_item),
    }


def _read_session_id_path_parameter(event: dict[str, Any]) -> str:
    path_parameters = event.get("pathParameters", {})
    session_id = path_parameters.get("sessionId")
    if not isinstance(session_id, str) or not session_id:
        raise ApiError(400, "sessionId path parameter is required")
    return session_id


def lambda_handler(event: dict[str, Any], _context: Any) -> dict[str, Any]:
    route_key = event.get("routeKey", "")

    try:
        if route_key == "GET /chat/health":
            return _json_response(200, {"ok": True})

        protected_routes = {
            "GET /chat/sessions",
            "GET /chat/sessions/{sessionId}",
            "DELETE /chat/sessions/{sessionId}",
            "POST /chat/messages",
        }
        if route_key not in protected_routes:
            return _json_response(404, {"message": "Not Found"})

        access_token = _extract_bearer_token(event)
        claims = _validate_access_token(access_token)
        user_sub = _extract_user_sub_from_claims(claims)

        if route_key == "GET /chat/sessions":
            return _json_response(200, _list_sessions(user_sub))

        if route_key == "GET /chat/sessions/{sessionId}":
            session_id = _read_session_id_path_parameter(event)
            return _json_response(200, _list_session_messages(user_sub, session_id))

        if route_key == "DELETE /chat/sessions/{sessionId}":
            session_id = _read_session_id_path_parameter(event)
            return _json_response(200, _delete_session(user_sub, session_id))

        if route_key == "POST /chat/messages":
            response = _post_message(user_sub, event)
            return _json_response(200, response)
    except ApiError as exc:
        return _json_response(exc.status_code, {"message": exc.message})
    except Exception:  # pylint: disable=broad-except
        LOGGER.exception("Unhandled backend error")
        return _json_response(500, {"message": "Internal server error"})
