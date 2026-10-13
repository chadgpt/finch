#!/usr/bin/env python3
"""Run the copied mock with ephemeral keys and local signed P1/P2/P3 probes."""

import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def sign(key, method, path, timestamp, nonce, body):
    canonical = "\n".join((method, path, timestamp, nonce, hashlib.sha256(body).hexdigest()))
    return "v1=" + hmac.new(key, canonical.encode(), hashlib.sha256).hexdigest()


def main():
    request_key = secrets.token_bytes(32)
    callback_key = secrets.token_bytes(32)
    key_id = "ephemeral-self-test-key"
    uploads = []

    class UploadSink(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_PUT(self):
            body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            uploads.append((body, self.headers.get("X-Finch-Artifact-Filename")))
            self.send_response(204)
            self.end_headers()

    sink = ThreadingHTTPServer(("127.0.0.1", 0), UploadSink)
    sink_thread = threading.Thread(target=sink.serve_forever, daemon=True)
    sink_thread.start()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    env = {
        **os.environ,
        "MOCK_REQUEST_SECRET": base64.b64encode(request_key).decode(),
        "MOCK_CALLBACK_SECRET": base64.b64encode(callback_key).decode(),
        "MOCK_KEY_ID": key_id,
        "MOCK_PORT": str(port),
        "MOCK_AGENT_NAME": "self-test",
    }
    child = subprocess.Popen(
        [sys.executable, "-u", str(Path(__file__).with_name("app.py"))],
        env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    origin = f"http://127.0.0.1:{port}"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def call(method, path, payload=None, expected=200, signing_key=request_key):
        body = b"" if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        timestamp, nonce = str(int(time.time())), uuid.uuid4().hex
        request = urllib.request.Request(
            origin + path, data=body if method == "POST" else None, method=method,
            headers={
                "Content-Type": "application/json",
                "X-Platform-Key-Id": key_id,
                "X-Platform-Timestamp": timestamp,
                "X-Platform-Nonce": nonce,
                "X-Platform-Signature": sign(signing_key, method, path, timestamp, nonce, body),
                "Idempotency-Key": uuid.uuid4().hex,
            },
        )
        try:
            response = opener.open(request, timeout=3)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            raw = response.read()
            assert response.status == expected, (path, response.status, raw)
            assert response.headers["X-Agent-Key-Id"] == key_id
            calculated = sign(
                request_key, method, path, response.headers["X-Agent-Timestamp"],
                response.headers["X-Agent-Nonce"], raw,
            )
            assert hmac.compare_digest(calculated, response.headers["X-Agent-Signature"])
            return json.loads(raw)

    def invoke(mode="task", contract_test=True, slots=None):
        invocation_id = str(uuid.uuid4())
        payload = {
            "protocol_version": "2.0", "invocation_id": invocation_id,
            "interaction_mode": mode,
            "input": {"content": [{"type": "text", "text": "Mock probe"}],
                      "parameters": {"contract_test": contract_test}},
            "conversation": {"messages": [{"role": "user", "content": [
                {"type": "text", "text": "P1 probe"}]}]},
            "artifact_uploads": slots or [],
        }
        receipt = call("POST", "/invoke", payload, 200 if mode == "conversation_turn" else 202)
        assert receipt["invocation_id"] == invocation_id
        return receipt

    def poll(task_id, status):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            snapshot = call("GET", f"/tasks/{task_id}")
            assert snapshot["merchant_task_id"] == task_id
            if snapshot["status"] == status:
                return snapshot
            time.sleep(0.1)
        raise AssertionError(f"Task never reached {status}")

    try:
        deadline = time.monotonic() + 5
        while True:
            if child.poll() is not None:
                raise RuntimeError(child.stderr.read().decode())
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                    break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("Mock startup timed out")
                time.sleep(0.05)

        assert call("GET", "/health")["status"] == "ready"
        assert call("GET", "/health", expected=401, signing_key=secrets.token_bytes(32))["code"] == "auth_failed"
        print("PASS signed health and invalid-signature rejection")
        assert invoke("conversation_turn")["status"] == "completed"
        print("PASS P1 synchronous text completion")
        accepted = invoke()
        task_id = accepted["merchant_task_id"]
        initial = call("GET", f"/tasks/{task_id}")
        assert initial["status"] == "working", initial
        completed = poll(task_id, "completed")
        assert completed["message"]["role"] == "agent"
        assert completed["artifacts"] == []
        print("PASS P2 contract test: accepted -> working -> completed")
        accepted = invoke(contract_test=False)
        task_id = accepted["merchant_task_id"]
        assert poll(task_id, "input_required")["questions"]
        call("POST", f"/tasks/{task_id}/messages", {
            "protocol_version": "2.0", "task_id": str(uuid.uuid4()),
            "message": {"role": "user", "content": [{"type": "text", "text": "self-test-answer"}]},
        }, 202)
        assert "self-test-answer" in poll(task_id, "completed")["message"]["content"][0]["text"]
        print("PASS P2 supplemental input and final answer")
        slot_id, asset_id = str(uuid.uuid4()), str(uuid.uuid4())
        accepted = invoke("generation", slots=[{
            "slot_id": slot_id, "asset_id": asset_id,
            "put_url": f"http://127.0.0.1:{sink.server_port}/upload",
            "allowed_media_types": ["text/plain"], "max_bytes": 1024,
        }])
        artifact = poll(accepted["merchant_task_id"], "completed")["artifacts"][0]
        assert artifact["slot_id"] == slot_id and artifact["asset_id"] == asset_id
        assert artifact["sha256"] == hashlib.sha256(uploads[0][0]).hexdigest()
        assert artifact["bytes"] == len(uploads[0][0]) and uploads[0][1]
        print("PASS P3 local artifact upload and completed snapshot")
        print("All local checks passed; no Finch or merchant endpoints were called.")
    finally:
        child.terminate()
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
        child.stderr.close()
        sink.shutdown()
        sink.server_close()
        sink_thread.join(timeout=2)


if __name__ == "__main__":
    main()
