#!/usr/bin/env python3
"""End-to-end test: send a signed P1 invocation to the running server."""
import base64
import hmac
import hashlib
import json
import os
import sys
import time
import uuid
import urllib.error
import urllib.request

key_b64 = os.environ['MOCK_REQUEST_SECRET']
# base64url decode without padding requires adding '=' to multiple of 4
key = base64.urlsafe_b64decode(key_b64 + '=' * (-len(key_b64) % 4))
body = json.dumps({
    "protocol_version": "2.0",
    "invocation_id": str(uuid.uuid4()),
    "interaction_mode": "conversation_turn",
    "input": {"content": [{"type": "text", "text": "Reply with exactly the word HELLO and nothing else."}]},
}).encode()
ts = str(int(time.time()))
nonce = uuid.uuid4().hex
canonical = f"POST\n/invoke\n{ts}\n{nonce}\n{hashlib.sha256(body).hexdigest()}"
sig = "v1=" + hmac.new(key, canonical.encode(), hashlib.sha256).hexdigest()
req = urllib.request.Request(
    "http://127.0.0.1:28894/invoke",
    data=body,
    method="POST",
    headers={
        "Content-Type": "application/json",
        "Idempotency-Key": uuid.uuid4().hex,
        "X-Platform-Key-Id": os.environ["MOCK_KEY_ID"],
        "X-Platform-Timestamp": ts,
        "X-Platform-Nonce": nonce,
        "X-Platform-Signature": sig,
    },
)
print("sending...")
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        print(f"status: {r.status}")
        data = json.loads(r.read())
        text = data.get('message', {}).get('content', [{}])[0].get('text', '')
        print(f"text: {text!r}")
        sys.exit(0)
except urllib.error.HTTPError as e:
    print(f"http {e.code}: {e.read().decode()[:300]}")
    sys.exit(1)
except Exception as e:
    print(f"err: {type(e).__name__}: {e}")
    sys.exit(2)
