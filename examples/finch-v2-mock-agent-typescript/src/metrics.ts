/**
 * Lightweight in-process metrics for the provider.
 *
 * Captures what `self_test` cannot prove: that a *real* Finch platform
 * (not the in-process test harness) is actually calling the provider.
 *
 * Three classes of signals:
 *
 *   1. HMAC verify counters
 *        - verifySuccess / verifyFail (broken down by reason)
 *        - reason lets you tell "skew" from "bad signature" from
 *          "replay" from "missing header" at a glance.
 *
 *   2. Recent-event ring buffer
 *        - last N request lines, each with: timestamp, method, path,
 *          remote_addr, status_code, verify_outcome, invocation_id
 *          (when present in the body). Bounded so it can't leak memory.
 *
 *   3. P2 poll tracking
 *        - lastPollAt + lastPollTaskId. P2 is async, so the *only*
 *          proof the platform is talking to you is that it GETs
 *          /tasks/{id} back. If this stays null after you've been
 *          invoked, the platform isn't polling (and your async work
 *          is invisible to the merchant).
 *
 * No external deps. All state lives in this module's closure; tests can
 * `reset()` between runs.
 *
 * SECURITY: `__diag` returns potentially sensitive data (HMAC failure
 * reasons, recent invocation_ids, request paths). In a production
 * deployment, gate it behind a network ACL or an admin-only token.
 * This module is intentionally simple — it is *not* a substitute for
 * a real observability stack.
 */

export type VerifyFailureReason =
  | 'missing_header'
  | 'bad_timestamp'
  | 'skew'
  | 'empty_nonce'
  | 'replay'
  | 'bad_signature'
  | 'unknown_key_id';

export interface RecentEvent {
  ts: string; // ISO 8601 UTC
  method: string;
  path: string;
  remote: string; // remote address (or 'unknown')
  status: number; // HTTP status that was sent back
  verify: 'ok' | 'fail' | 'n/a' | string; // 'ok' / 'fail:bad_signature' / 'n/a' (for /__diag) / etc.
  invocation_id?: string;
  task_id?: string;
}

export interface MetricsSnapshot {
  /** Seconds since the provider process started. */
  uptime_sec: number;
  /** ISO 8601 UTC of process start. */
  started_at: string;
  /** Total HTTP requests received (any path, any method). */
  total_requests: number;
  /** /invoke calls that passed HMAC verification. */
  verify_success: number;
  /** /invoke calls that failed HMAC verification, grouped by reason. */
  verify_failure: Record<VerifyFailureReason, number>;
  /** Last time the platform polled a /tasks/{id} endpoint (P2 async). */
  last_p2_poll_at: string | null;
  /** merchant_task_id of the last /tasks/{id} poll. */
  last_p2_poll_task_id: string | null;
  /** The most recent invocation_id we saw (across all /invoke calls). */
  last_invocation_id: string | null;
  /** The most recent /invoke wall-clock timestamp from the platform's X-Platform-Timestamp header. */
  last_platform_ts: number | null;
  /** Ring buffer of the most recent events (newest first). */
  recent: RecentEvent[];
  /** Was a non-127.0.0.1 address ever seen? True if the platform has called you. */
  ever_called_from_remote: boolean;
}

const RECENT_LIMIT = 50;
const recent: RecentEvent[] = [];
let totalRequests = 0;
let verifySuccess = 0;
const verifyFailure: Record<VerifyFailureReason, number> = {
  missing_header: 0,
  bad_timestamp: 0,
  skew: 0,
  empty_nonce: 0,
  replay: 0,
  bad_signature: 0,
  unknown_key_id: 0,
};
let lastP2PollAt: string | null = null;
let lastP2PollTaskId: string | null = null;
let lastInvocationId: string | null = null;
let lastPlatformTs: number | null = null;
let everCalledFromRemote = false;
const startedAtMs = Date.now();
const startedAtIso = new Date(startedAtMs).toISOString();

export function recordRequest(method: string, path: string, remote: string): void {
  totalRequests++;
  if (remote && remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
    everCalledFromRemote = true;
  }
}

export function recordVerifySuccess(): void {
  verifySuccess++;
}

export function recordVerifyFailure(reason: VerifyFailureReason): void {
  verifyFailure[reason]++;
}

export function recordInvocationId(id: string): void {
  if (id) lastInvocationId = id;
}

/**
 * Per-request handle. The HTTP layer sets this when it has parsed an
 * invocation_id off the wire, and the res.on('finish') hook reads it
 * to attach the id to the ring buffer entry. Cleared at the start of
 * every new request so handlers see a clean slate.
 */
export function setLastSeenInvocationId(id: string | undefined): void {
  lastSeenInvocationId = id;
}

let lastSeenInvocationId: string | undefined;

export function recordPlatformTs(ts: number): void {
  if (Number.isFinite(ts)) lastPlatformTs = ts;
}

export function recordP2Poll(taskId: string, now: Date = new Date()): void {
  if (taskId) {
    lastP2PollAt = now.toISOString();
    lastP2PollTaskId = taskId;
  }
}

export function recordEvent(ev: RecentEvent): void {
  recent.unshift(ev);
  if (recent.length > RECENT_LIMIT) recent.length = RECENT_LIMIT;
}

export function getMetrics(): MetricsSnapshot {
  return {
    uptime_sec: Math.floor((Date.now() - startedAtMs) / 1000),
    started_at: startedAtIso,
    total_requests: totalRequests,
    verify_success: verifySuccess,
    verify_failure: { ...verifyFailure },
    last_p2_poll_at: lastP2PollAt,
    last_p2_poll_task_id: lastP2PollTaskId,
    last_invocation_id: lastInvocationId,
    last_platform_ts: lastPlatformTs,
    recent: recent.slice(0, RECENT_LIMIT),
    ever_called_from_remote: everCalledFromRemote,
  };
}

/** Test helper. Resets all in-process state. */
export function resetMetrics(): void {
  totalRequests = 0;
  verifySuccess = 0;
  for (const k of Object.keys(verifyFailure) as VerifyFailureReason[]) {
    verifyFailure[k] = 0;
  }
  lastP2PollAt = null;
  lastP2PollTaskId = null;
  lastInvocationId = null;
  lastPlatformTs = null;
  everCalledFromRemote = false;
  lastSeenInvocationId = undefined;
  recent.length = 0;
}
