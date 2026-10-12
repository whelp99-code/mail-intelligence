"""Owned short-lived Price HTTP fixture; never a live service or domain mock."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import sys
from pathlib import Path
from typing import Annotated, ClassVar, Literal, Protocol

from fastapi.testclient import TestClient
from httpx import Response
from price.api import create_app
from price.auth import Actor
from price.db import Database
from price.ingestion import Ingestion
from price.models import CompanyInput
from price.service import Service
from pydantic import BaseModel, ConfigDict, Field, JsonValue, TypeAdapter


class HttpCall(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["http"]
    method: Literal["GET", "POST", "PUT"]
    path: str
    headers: dict[str, str]
    body: str | None = None
    binary: bool = False


class ReadSources(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["reader"]


class Close(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(extra="forbid", frozen=True)
    kind: Literal["close"]


class NativeHttp(Protocol):
    def request(
        self, method: str, url: str, *, headers: dict[str, str] | None = None,
        content: str | bytes | None = None, json: JsonValue | None = None,
    ) -> Response: ...


class NativeLogin(BaseModel):
    model_config: ClassVar[ConfigDict] = ConfigDict(extra="ignore", frozen=True)
    csrf: str


def request(
    http: NativeHttp, method: str, path: str, *, headers: dict[str, str] | None = None,
    content: str | bytes | None = None, body: JsonValue | None = None,
) -> Response:
    return http.request(method, path, headers=headers, content=content, json=body)


class NativeReader(Protocol):
    def run_once(self, company: str) -> JsonValue: ...


def read_sources(reader: NativeReader, company: str) -> JsonValue:
    return reader.run_once(company)


def main() -> None:
    root = Path(sys.argv[1]).resolve()
    source = Path(sys.argv[2]).resolve()
    assert root.is_dir() and root.name.startswith("mail-fp5-mt-")
    pins = {
        "price/source_tables.py": "cbf49a005e5d3c289a4c6e004c5e25c40c67966042d1e1f6a5ce0a8e9c9f5340",
        "price/casework.py": "c029ab04edf024919e89fed53d448c7da9b357f4ef54c4130ac8b8e1ad84d659",
        "price/upload_routes.py": "838c7050492ab36d0f8c7d5535e40d19f666d198f152cb425b2fa60fa883aec9",
    }
    for name, expected in pins.items():
        assert hashlib.sha256((source / name).read_bytes()).hexdigest() == expected
    path = root / "price.sqlite"
    service = Service(Database(path))
    password = secrets.token_urlsafe(32)
    company, owner = service.auth.bootstrap(CompanyInput(name="Explicit synthetic MT company"), "fixture-owner", password)
    assert isinstance(owner, Actor)
    app = create_app(path)
    reader = Ingestion(service)
    message: TypeAdapter[HttpCall | ReadSources | Close] = TypeAdapter(
        Annotated[HttpCall | ReadSources | Close, Field(discriminator="kind")]
    )
    with TestClient(app) as client:
        http: NativeHttp = client
        logged = request(http, "POST", "/api/login", body={"username": owner.username, "password": password})
        assert logged.status_code == 200
        csrf = NativeLogin.model_validate_json(logged.content).csrf
        print(json.dumps({"companyId": company, "csrfToken": csrf, "sourcePins": pins}), flush=True)
        for raw in sys.stdin:
            match message.validate_json(raw):
                case HttpCall() as call:
                    content = base64.b64decode(call.body) if call.binary and call.body is not None else call.body
                    response = request(http, call.method, call.path, headers=call.headers, content=content)
                    result = {
                        "status": response.status_code,
                        "headers": {"content-type": response.headers.get("content-type", "")},
                        "body": base64.b64encode(response.content).decode(),
                    }
                case ReadSources():
                    result = {"reader": read_sources(reader, company)}
                case Close():
                    print(json.dumps({"closed": True}), flush=True)
                    break
            print(json.dumps(result), flush=True)
        for name, expected in pins.items():
            assert hashlib.sha256((source / name).read_bytes()).hexdigest() == expected
    print("MAIL_PRICE_NATIVE_FIXTURE_CLOSED", file=sys.stderr, flush=True)


if __name__ == "__main__":
    main()
