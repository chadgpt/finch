#!/usr/bin/env python3
"""Finch async-task mock agent for both agenton_v0 and finch_v2 wires.

Behavior (per task):
  invoke (contract_test=true) -> accepted; poll sees completed quickly.
  invoke (normal)             -> accepted; first poll returns input_required with one
                                 question; POST messages flips the task to completed
                                 and the final message echoes the buyer's answer.

All responses are HMAC-signed with the request secret:
  canonical = METHOD\nPATH?QUERY\nTIMESTAMP\nNONCE\nsha256(body)
  signature = "v1=" hex(hmac_sha256(secret, canonical))
Incoming platform requests are verified with the X-Platform-* headers; responses carry
X-Agent-* headers. Protocol-agnostic: echoes invocation_id and always answers with
protocol_version 2.0 (optional-but-required-value under agenton_v0, required under finch_v2).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import threading
import time
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

REQUEST_SECRET = base64.b64decode(os.environ["MOCK_REQUEST_SECRET"])
CALLBACK_SECRET = base64.b64decode(os.environ.get("MOCK_CALLBACK_SECRET", os.environ["MOCK_REQUEST_SECRET"]))
KEY_ID = os.environ["MOCK_KEY_ID"]
PORT = int(os.environ.get("MOCK_PORT", "28891"))
AGENT_NAME = os.environ.get("MOCK_AGENT_NAME", "finch-async-mock")

_lock = threading.Lock()
_tasks: dict[str, dict] = {}
_seen_nonces: dict[str, float] = {}


def _sign(secret: bytes, method: str, path: str, timestamp: str, nonce: str, body: bytes) -> str:
  canonical = "\n".join(
    (method.upper(), path, timestamp, nonce, hashlib.sha256(body).hexdigest())
  )
  return "v1=" + hmac.new(secret, canonical.encode(), hashlib.sha256).hexdigest()


def _body_sha256(body: bytes) -> str:
    return hashlib.sha256(body).hexdigest()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:  # noisy in containers
        pass

    def _path_with_query(self) -> str:
        split = urlsplit(self.path)
        return split.path + (f"?{split.query}" if split.query else "")

    def _write_signed(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        timestamp = str(int(time.time()))
        nonce = uuid.uuid4().hex
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Agent-Key-Id", KEY_ID)
        self.send_header("X-Agent-Timestamp", timestamp)
        self.send_header("X-Agent-Nonce", nonce)
        self.send_header(
            "X-Agent-Signature",
            _sign(REQUEST_SECRET, self.command, self._path_with_query(), timestamp, nonce, raw),
        )
        self.end_headers()
        self.wfile.write(raw)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0") or 0)
        if length < 0 or length > 1_048_576:
            raise ValueError("body too large")
        return self.rfile.read(length) if length else b""

    def _verify_platform(self, body: bytes) -> bool:
        timestamp = self.headers.get("X-Platform-Timestamp", "")
        nonce = self.headers.get("X-Platform-Nonce", "")
        presented = self.headers.get("X-Platform-Signature", "")
        try:
            skew = abs(int(time.time()) - int(timestamp))
        except ValueError:
            self._deny(); return False
        if skew > 300 or not nonce:
            self._deny(); return False
        now = time.time()
        with _lock:
            for used, at in list(_seen_nonces.items()):
                if now - at > 600:
                    _seen_nonces.pop(used, None)
            if nonce in _seen_nonces:
                self._write_signed(409, {"code": "nonce_replay"}); return False
        expected = _sign(
            REQUEST_SECRET, self.command, self._path_with_query(), timestamp, nonce, body
        )
        if not hmac.compare_digest(expected, presented):
            self._deny(); return False
        with _lock:
            _seen_nonces[nonce] = now
        return True

    def _deny(self) -> None:
        self._write_signed(401, {"code": "auth_failed"})

    def do_GET(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        if path == "/health":
            if not self._verify_platform(b""):
                return
            self._write_signed(200, {"status": "ready", "service": AGENT_NAME})
            return
        if "/tasks/" in path:
            if not self._verify_platform(b""):
                return
            self._poll(path)
            return
        self._write_signed(404, {"code": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlsplit(self.path).path
        body = self._read_body()
        if not self._verify_platform(body):
            return
        if path.endswith("/invoke"):
            self._invoke(body)
        elif "/messages" in path:
            self._messages(path, body)
        elif "/cancel" in path:
            self._cancel(path, body)
        else:
            self._write_signed(404, {"code": "not_found"})

    def _invoke(self, body: bytes) -> None:
        try:
            payload = json.loads(body or b"{}")
        except ValueError:
            self._write_signed(422, {"code": "request_rejected"}); return
        invocation_id = payload.get("invocation_id")
        if not isinstance(invocation_id, str) or not invocation_id:
            self._write_signed(422, {"code": "invocation_invalid"}); return
        invocation_id = payload.get("invocation_id")
        if not isinstance(invocation_id, str) or not invocation_id:
            self._write_signed(422, {"code": "invocation_invalid"}); return
        mode = payload.get("interaction_mode") or (payload.get("agent") or {}).get("interaction_mode")
        if mode not in {"conversation_turn", "task", "generation"}:
            self._write_signed(422, {"code": "interaction_mode_invalid"}); return
        if mode == "conversation_turn":
            # P1 is synchronous. Echo the latest visible user text so context use is testable.
            messages = ((payload.get("conversation") or {}).get("messages") or [])
            visible = ""
            if messages:
                for part in messages[-1].get("content") or []:
                    if part.get("type") == "text":
                        visible = str(part.get("text", ""))
            self._write_signed(200, {
                "protocol_version": "2.0",
                "invocation_id": invocation_id,
                "status": "completed",
                "message": {"role": "agent", "content": [{
                    "type": "text", "text": f"P1 mock 已完成：{visible}",
                }]},
                "artifacts": [],
            })
            return
        idempotency_key = self.headers.get("Idempotency-Key", "")
        merchant_task_id = "mtk-" + hashlib.sha256(
            f"{invocation_id}:{idempotency_key}".encode()
        ).hexdigest()[:24]
        parameters = (payload.get("input") or {}).get("parameters") or {}
        contract_test = parameters.get("contract_test") is True
        with _lock:
            existing = _tasks.get(merchant_task_id)
            if existing is not None:
                self._write_signed(202, existing["accepted"])
                return
            _tasks[merchant_task_id] = {
                "accepted": {
                    "protocol_version": "2.0",
                    "invocation_id": invocation_id,
                    "status": "accepted",
                    "merchant_task_id": merchant_task_id,
                    "poll_after_ms": 500,
                },
                "state": "working",
                "sequence": 1,
                "contract_test": contract_test,
                "answer": None,
                "ready_at": time.time() + (0.6 if contract_test else 0.5),
                "completed": False,
                "question": "请补充说明你期望的具体安排（时间、范围或约束）。",
                "mode": mode,
                "artifacts": [],
            }
            if mode == "generation":
                _tasks[merchant_task_id]["artifacts"] = self._upload_slots(
                    payload.get("artifact_uploads") or []
                )
        self._write_signed(
            202,
            {
                "protocol_version": "2.0",
                "invocation_id": invocation_id,
                "status": "accepted",
                "merchant_task_id": merchant_task_id,
                "poll_after_ms": 500,
            },
        )

    def _upload_slots(self, slots: list[dict]) -> list[dict]:
        result: list[dict] = []
        content = b"Finch P3 mock generated artifact.\n"
        for index, slot in enumerate(slots):
            allowed = slot.get("allowed_media_types") or []
            media_type = "text/plain" if "text/plain" in allowed else (
                allowed[0] if allowed else "application/octet-stream"
            )
            try:
                request = urllib.request.Request(
                    slot["put_url"], data=content, method="PUT",
                    headers={
                        "Content-Type": media_type,
                        "X-Finch-Artifact-Filename": f"finch-p3-mock-{index + 1}.txt",
                    },
                )
                with urllib.request.urlopen(request, timeout=30) as response:
                    if not 200 <= response.status < 300:
                        continue
            except Exception as error:
                print(f"P3 artifact upload failed: {error}", flush=True)
                continue
            result.append({
                "slot_id": slot["slot_id"],
                "asset_id": slot["asset_id"],
                "sha256": hashlib.sha256(content).hexdigest(),
                "bytes": len(content),
                "filename": f"finch-p3-mock-{index + 1}.txt",
            })
        return result

    def _snapshot(self, task: dict) -> dict:
        common = {"protocol_version": "2.0", "merchant_task_id": task["accepted"]["merchant_task_id"]}
        if task["completed"]:
            answer_text = task["answer"] or "(无补充)"
            if task["mode"] == "generation":
                return {
                    **common,
                    "status": "completed",
                    "sequence": task["sequence"],
                    "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "message": {"role": "agent", "content": [{
                        "type": "text", "text": "P3 mock 已完成生成。",
                    }]},
                    "artifacts": task["artifacts"],
                }
            return {
                **common,
                "status": "completed",
                "sequence": task["sequence"],
                "completed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "message": {"role": "agent", "content": [
                    {"type": "text", "text": f"已收到你的补充说明：「{answer_text}」。任务已完成。"}
                ]},
                "artifacts": [],
            }
        now = time.time()
        if task["state"] == "input_required":
            return {
                **common,
                "status": "input_required",
                "sequence": task["sequence"],
                "questions": [{"id": "detail", "question": task["question"]}],
            }
        if now >= task["ready_at"]:
            if task["contract_test"] or task["mode"] == "generation":
                task["completed"] = True
                task["sequence"] += 1
                return self._snapshot(task)
            task["state"] = "input_required"
            task["sequence"] += 1
            return {
                **common,
                "status": "input_required",
                "sequence": task["sequence"],
                "questions": [{"id": "detail", "question": task["question"]}],
            }
        return {
            **common,
            "status": "working",
            "sequence": task["sequence"],
            "progress": {"percent": 10, "stage": "clarifying"},
        }

    def _poll(self, path: str) -> None:
        merchant_task_id = path.rstrip("/").rsplit("/", 1)[-1]
        with _lock:
            task = _tasks.get(merchant_task_id)
            if task is None:
                self._write_signed(404, {"code": "task_not_found"}); return
            snapshot = self._snapshot(task)
        self._write_signed(200, snapshot)

    def _messages(self, path: str, body: bytes) -> None:
        merchant_task_id = path.rstrip("/").rsplit("/", 2)[-2]
        try:
            payload = json.loads(body or b"{}")
        except ValueError:
            self._write_signed(422, {"code": "request_rejected"}); return
        with _lock:
            task = _tasks.get(merchant_task_id)
            if task is None:
                self._write_signed(404, {"code": "task_not_found"}); return
            if task["completed"] or task["state"] != "input_required":
                self._write_signed(409, {"code": "task_not_awaiting_input"}); return
            answer_text = ""
            for part in (payload.get("message") or {}).get("content") or []:
                if part.get("type") == "text":
                    answer_text = (answer_text + " " + str(part.get("text", ""))).strip()
            task["answer"] = answer_text[:500]
            task["completed"] = True
            task["sequence"] += 1
        self._write_signed(
            202,
            {
                "protocol_version": "2.0",
                "status": "accepted",
                "merchant_task_id": merchant_task_id,
            },
        )

    def _cancel(self, path: str, body: bytes) -> None:
        merchant_task_id = path.rstrip("/").rsplit("/", 2)[-2]
        with _lock:
            task = _tasks.get(merchant_task_id)
            if task is None:
                self._write_signed(404, {"code": "task_not_found"}); return
            if task["completed"]:
                self._write_signed(409, {"code": "task_terminal"}); return
            task["completed"] = True
            task["sequence"] += 1
        self._write_signed(
            200,
            {
                "protocol_version": "2.0",
                "status": "canceled",
                "merchant_task_id": merchant_task_id,
                "sequence": task["sequence"],
            },
        )


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"{AGENT_NAME} listening on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
