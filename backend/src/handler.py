import base64
import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError
from openai import OpenAI

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

TABLE_NAME = os.environ["CHAT_TABLE_NAME"]
OPENAI_SECRET_ARN = os.environ["OPENAI_SECRET_ARN"]
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini")
SYSTEM_PROMPT = os.getenv("OPENAI_SYSTEM_PROMPT", "You are a helpful assistant.")
MAX_INPUT_CHARACTERS = int(os.getenv("MAX_INPUT_CHARACTERS", "4000"))

DYNAMODB = boto3.resource("dynamodb")
TABLE = DYNAMODB.Table(TABLE_NAME)
SECRETS_MANAGER = boto3.client("secretsmanager")

OPENAI_CLIENT: OpenAI | None = None


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


def _extract_user_sub(event: dict[str, Any]) -> str:
    claims = (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )

    # Azure AD typically includes "sub" and often "oid".
    # Prefer sub when present and fall back to oid for stable per-user partitioning.
    user_sub = claims.get("sub") or claims.get("oid")
    if not isinstance(user_sub, str) or not user_sub:
        raise ApiError(401, "Unauthorized")
    return user_sub


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

        user_sub = _extract_user_sub(event)

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

        return _json_response(404, {"message": "Not Found"})
    except ApiError as exc:
        return _json_response(exc.status_code, {"message": exc.message})
    except Exception:  # pylint: disable=broad-except
        LOGGER.exception("Unhandled backend error")
        return _json_response(500, {"message": "Internal server error"})
