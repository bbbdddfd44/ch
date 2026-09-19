import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verify } from "https://deno.land/x/djwt@v3.0.2/mod.ts";
import {
  canFinalizeWalletDebit,
  getReservationBillingOperation,
  getReservationRefundIdempotencyKey,
  isRefundEligibleReservation,
} from "./billing-utils.ts";
import { filterLiveSessionsForCenter, getSessionCenterId } from "./session-center-utils.ts";
import {
  buildReservationCollectionQuery,
  extractReservationRows,
  filterReservationRows,
  getReservationLookupId,
  reshapeReservationPayload,
} from "./reservation-utils.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-access-token, x-request-id, x-client-info, apikey, content-type, x-t2hub-cookie, x-t2hub-key",
  "Access-Control-Expose-Headers": "x-t2hub-cookie",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

// Code returned in the outer error response when a t2hub-backed route is
// called without x-t2hub-cookie + x-t2hub-key. The booking page detects
// this and triggers a one-time t2hub login bridge to capture the
// caller's own t2hub session material.
export const T2HUB_SESSION_MISSING_CODE = "T2HUB_SESSION_MISSING";

function json(data: unknown, status = 200) {
  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": "application/json",
  };
  if (lastT2HubCookie) headers[T2HUB_RESPONSE_COOKIE_HEADER] = lastT2HubCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

function getSupabase() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

// ΓöÇΓöÇ SVP API helper ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
const SVP_BASE = Deno.env.get("SVP_BASE_URL") || "https://svp-international-api.pacc.sa";
const SVP_LOCALE = "en";
const SVP_ORIGIN = "https://svp-international.pacc.sa";
const SVP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36";
const T2HUB_BASE = "https://t2hub.app";
const T2HUB_APP_PATH = "/takamol";
const ACCESS_JWT_SECRET = Deno.env.get("JWT_ACCESS_SECRET");
if (!ACCESS_JWT_SECRET) throw new Error("JWT_ACCESS_SECRET is required");

async function getAccessJwtKey() {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(ACCESS_JWT_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["verify"],
  );
}

type SvpErrorCode = "CANDIDATE_ACCOUNT_REQUIRED" | "CANDIDATE_LABOR_ID_EXISTS" | "SVP_VALIDATION_ERROR" | "SVP_UPSTREAM_ERROR";

function firstNestedError(data: any): string {
  const laborId = data?.errors?.temporaryseat?.labor_id;
  if (Array.isArray(laborId) && laborId[0]) return String(laborId[0]);
  for (const value of Object.values(data?.errors || {})) {
    if (Array.isArray(value) && value[0]) return String(value[0]);
    if (value && typeof value === "object") {
      for (const item of Object.values(value as Record<string, unknown>)) {
        if (Array.isArray(item) && item[0]) return String(item[0]);
      }
    }
  }
  return "";
}

function normalizeSvpError(statusCode: number, data: any) {
  const rawMessage = String(data?.message || data?.error || firstNestedError(data) || "");
  const normalized = rawMessage.toLowerCase();
  if (normalized.includes("active candidate account is required") || (normalized.includes("candidate account") && normalized.includes("required"))) {
    return { statusCode, code: "CANDIDATE_ACCOUNT_REQUIRED" as SvpErrorCode, message: "Active candidate account is required", details: { upstreamStatus: statusCode } };
  }
  if (normalized.includes("labor_id") && normalized.includes("already been taken")) {
    return { statusCode: 409, code: "CANDIDATE_LABOR_ID_EXISTS" as SvpErrorCode, message: "This candidate labor ID is already registered. Use the existing candidate account.", details: { upstreamStatus: statusCode } };
  }
  return { statusCode, code: (statusCode === 422 ? "SVP_VALIDATION_ERROR" : "SVP_UPSTREAM_ERROR") as SvpErrorCode, message: rawMessage || `SVP request failed: ${statusCode}`, details: { upstreamStatus: statusCode } };
}

async function requireAccessPermission(req: Request, permissionKey: string) {
  const token = req.headers.get("x-access-token")?.trim();
  if (!token) throw { statusCode: 401, message: "Access Portal login is required" };
  let payload: { sub?: string };
  try {
    payload = await verify(token, await getAccessJwtKey()) as { sub?: string };
  } catch {
    throw { statusCode: 401, code: "ACCESS_ACCOUNT_REQUIRED", message: "Access Portal session expired" };
  }
  const supabase = getSupabase();
  const { data: account } = await supabase
    .from("accounts")
    .select("id,role,status,permission_mode,agency_id")
    .eq("id", payload.sub || "")
    .single();
  if (!account || account.status !== "ACTIVE" || account.role !== "USER") {
    throw { statusCode: 403, code: "ACCESS_ACCOUNT_REQUIRED", message: "An active access-portal account with booking permission is required" };
  }
  if (account.permission_mode === "MANAGED") {
    const { data: permission } = await supabase.from("account_permissions")
      .select("allowed").eq("account_id", account.id).eq("permission_key", permissionKey).single();
    if (permission?.allowed !== true) {
      throw { statusCode: 403, message: `${permissionKey} permission is required` };
    }
  }
  return { supabase, account };
}

async function getBookingCreditCost(supabase: ReturnType<typeof getSupabase>, agencyId?: string | null): Promise<number> {
  if (agencyId) {
    const { data: agencySettings, error: agencyError } = await supabase
      .from("agency_billing_settings")
      .select("booking_credit_cost")
      .eq("agency_id", agencyId)
      .maybeSingle();
    if (agencyError) throw { statusCode: 500, message: "Could not load agency booking credit cost", details: agencyError.message };
    if (agencySettings) {
      const agencyAmount = Number(agencySettings.booking_credit_cost);
      if (!Number.isFinite(agencyAmount) || agencyAmount < 0) {
        throw { statusCode: 500, message: "Invalid agency booking credit cost configuration" };
      }
      return agencyAmount;
    }
  }
  const { data, error } = await supabase
    .from("access_billing_settings")
    .select("booking_credit_cost")
    .eq("singleton", true)
    .single();
  if (error) throw { statusCode: 500, message: "Could not load booking credit cost", details: error.message };
  const amount = Number(data?.booking_credit_cost);
  if (!Number.isFinite(amount) || amount < 0) {
    throw { statusCode: 500, message: "Invalid booking credit cost configuration" };
  }
  return amount;
}

function automaticRefundsEnabled(): boolean {
  return Deno.env.get("AUTO_REFUND_ENABLED")?.trim().toLowerCase() === "true";
}

async function reconcileFinalizedReservationRefunds(
  supabase: ReturnType<typeof getSupabase>,
  accountId: string,
  reservationsPayload: any,
) {
  const rows = extractReservationRows(reservationsPayload);
  const results: { reservation_id: string; status: string; action: string; amount?: number }[] = [];
  const { data: walletRows, error: walletError } = await supabase
    .from("wallet_transactions")
    .select("id,amount,direction,transaction_type,reference_id,reference_type,idempotency_key,metadata,created_at")
    .eq("account_id", accountId)
    .order("created_at", { ascending: false })
    .limit(500);
  if (walletError) throw walletError;

  for (const row of rows) {
    const reservationId = String(row?.id || row?.reservation_id || row?.exam_reservation_id || "").trim();
    if (!reservationId) continue;
    const status = String(
      row?.reservation_status || row?.status || row?.state || row?.cbt_exam_status || "",
    ).toLowerCase();
    const cancellationTimestamp = row?.cancelled_at || row?.canceled_at || row?.cancellation_date || row?.cancelledAt;

    // Check if refund-eligible (finalized status OR has cancellation timestamp)
    const eligible = isRefundEligibleReservation(status, cancellationTimestamp);
    // Also check for reservations with NO status (might be failed/missing upstream)
    const noStatus = !status || status === "unknown" || status === "";
    if (!eligible && !noStatus) continue;

    // Skip if status is still active/pending (not yet finalized)
    if (!eligible && noStatus) {
      // For no-status reservations, check if they have a cancellation timestamp
      if (!cancellationTimestamp) continue;
    }

    const debitTx = (walletRows || []).find((tx: any) =>
      tx.direction === "debit" &&
      tx.transaction_type === "booking_debit" &&
      tx.reference_type === "reservation" &&
      String(tx.reference_id || "") === reservationId,
    );
    if (!debitTx) {
      results.push({ reservation_id: reservationId, status, action: "no_debit_found" });
      continue;
    }

    const refundKey = getReservationRefundIdempotencyKey(accountId, reservationId);
    const alreadyRefunded = (walletRows || []).find((tx: any) => tx.idempotency_key === refundKey);
    if (alreadyRefunded) {
      results.push({ reservation_id: reservationId, status, action: "already_refunded", amount: Number(alreadyRefunded.amount) });
      continue;
    }

    const refundAmount = Math.abs(Number(debitTx.amount));
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) {
      results.push({ reservation_id: reservationId, status, action: "invalid_amount" });
      continue;
    }

    const { data: refundTx, error: refundError } = await supabase.rpc("wallet_refund_booking", {
      p_account_id: accountId,
      p_reservation_id: reservationId,
      p_status: status || "unknown",
      p_metadata: { source: "svp-proxy-reconcile", reservation_status: status, cancellation_timestamp: cancellationTimestamp },
    });
    if (refundError) {
      // A concurrent request may have created the deterministic refund between
      // the read above and this RPC. Reconciliation remains retryable and does
      // not hide the failure from the result surface.
      results.push({ reservation_id: reservationId, status, action: "refund_failed", amount: refundAmount });
      continue;
    }
    results.push({ reservation_id: reservationId, status, action: "refunded", amount: Number(refundTx?.amount || refundAmount) });
  }
  return results;
}

/**
 * Check wallet debits that have no matching reservation and auto-refund.
 * This catches cases where:
 * 1. Booking was created (debit happened)
 * 2. Upstream booking failed
 * 3. Reservation was never returned by SVP (or was deleted)
 */
async function reconcileOrphanedDebits(
  supabase: ReturnType<typeof getSupabase>,
  accountId: string,
  reservationsPayload: any,
) {
  const rows = extractReservationRows(reservationsPayload);
  const reservationIds = new Set<string>();
  for (const row of rows) {
    const id = String(row?.id || row?.reservation_id || row?.exam_reservation_id || "").trim();
    if (id) reservationIds.add(id);
  }

  const { data: walletRows, error: walletError } = await supabase
    .from("wallet_transactions")
    .select("id,amount,direction,transaction_type,reference_id,reference_type,idempotency_key,metadata,created_at")
    .eq("account_id", accountId)
    .eq("direction", "debit")
    .eq("transaction_type", "booking_debit")
    .order("created_at", { ascending: false })
    .limit(100);
  if (walletError) throw walletError;

  const results: { reservation_id: string; status: string; action: string; amount?: number }[] = [];
  const now = Date.now();
  const ONE_HOUR_MS = 60 * 60 * 1000;

  // Fetch existing refunds for this account to avoid redundant refund attempts
  const { data: refundRows } = await supabase
    .from("wallet_transactions")
    .select("id,reference_id,idempotency_key")
    .eq("account_id", accountId)
    .eq("direction", "credit")
    .eq("transaction_type", "refund")
    .order("created_at", { ascending: false })
    .limit(200);

  const refundedReservationIds = new Set<string>();
  for (const r of refundRows || []) {
    const rid = String(r.reference_id || "").trim();
    if (rid) refundedReservationIds.add(rid);
  }

  for (const debitTx of (walletRows || [])) {
    const reservationId = String(debitTx.reference_id || "").trim();
    if (!reservationId) continue;

    // Skip if reservation exists in SVP response
    if (reservationIds.has(reservationId)) continue;

    // Skip if already refunded
    if (refundedReservationIds.has(reservationId)) continue;

    // Only refund debits older than 1 hour (give SVP time to process)
    const debitAge = now - new Date(debitTx.created_at).getTime();
    if (debitAge < ONE_HOUR_MS) continue;

    const refundAmount = Math.abs(Number(debitTx.amount));
    if (!Number.isFinite(refundAmount) || refundAmount <= 0) continue;

    const { data: refundTx, error: refundError } = await supabase.rpc("wallet_refund_booking", {
      p_account_id: accountId,
      p_reservation_id: reservationId,
      p_status: "orphaned",
      p_metadata: { source: "svp-proxy-orphan-cleanup", original_debit_created: debitTx.created_at },
    });
    if (refundError) {
      results.push({ reservation_id: reservationId, status: "orphaned", action: "refund_failed", amount: refundAmount });
      continue;
    }
    results.push({ reservation_id: reservationId, status: "orphaned", action: "refunded", amount: Number(refundTx?.amount || refundAmount) });
  }
  return results;
}

function findReservationId(value: any): string {
  // Top-level id (SVP may return { id: 12345 } directly)
  if (value?.id !== undefined && value?.id !== null && value?.id !== "") {
    const v = String(value.id).trim();
    if (v && /^\d+$/.test(v)) return v;
  }
  const direct = value?.exam_reservation?.id || value?.reservation?.id || value?.data?.exam_reservation?.id || value?.data?.reservation?.id;
  if (direct !== undefined && direct !== null && direct !== "") return String(direct);
  // data.id — SVP may wrap response in { data: { id: ... } }
  if (value?.data?.id !== undefined && value?.data?.id !== null && value?.data?.id !== "") {
    const v = String(value.data.id).trim();
    if (v && /^\d+$/.test(v)) return v;
  }
  const queue = [value];
  const seen = new Set<any>();
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    for (const key of ["reservation_id", "exam_reservation_id", "reservationId"]) {
      if (current[key] !== undefined && current[key] !== null && current[key] !== "") return String(current[key]);
    }
    if (current.id !== undefined && current.id !== null && /reservation/i.test(String(current.type || current.resource || ""))) return String(current.id);
    queue.push(...Object.values(current));
  }
  return "";
}

let t2hubSession:
  | {
      keyRaw: string;
      cookie: string;
      csrfToken: string;
      appPath: string;
      expiresAt: number;
    }
  | null = null;

// After every t2hub call we stash the most recent cookies here so the
// response builder can echo them back to the caller in
// `x-t2hub-cookie`. The caller is responsible for keeping its own copy in
// sync ΓÇö these cookies rotate on every t2hub response.
let lastT2HubCookie = "";

// The t2hub landing page, every JSON API call, and the encrypted envelope
// (x-encrypted: 1) all rotate the session and CSRF cookies. We must keep the
// "real" XSRF-TOKEN from the meta tag (URL-encoded) and the Laravel session
// payload from the most recent response. Once a t2_hub_session cookie goes
// stale, the API returns 401/419 even with a fresh key, so this state is the
// most important thing the proxy maintains.
//
// t2hub is a stateful Laravel app ΓÇö a fresh server has no session. Callers
// MUST pass their logged-in t2hub cookies (and the session key from
// `window.__sk`) via the `x-t2hub-cookie` and `x-t2hub-key` request headers
// so we can hit the read-only API on their behalf. After each call we return
// any rotated cookies in the `x-t2hub-cookie` response header so the caller
// can keep its own copy fresh.
const T2HUB_KEY_HEADER = "x-t2hub-key";
const T2HUB_COOKIE_HEADER = "x-t2hub-cookie";
const T2HUB_RESPONSE_COOKIE_HEADER = "x-t2hub-cookie";

function t2HubHeadersFromRequest(req: Request): { keyRaw: string; cookie: string } | null {
  const keyRaw = req.headers.get(T2HUB_KEY_HEADER)?.trim() || "";
  const cookie = req.headers.get(T2HUB_COOKIE_HEADER)?.trim() || "";
  if (!keyRaw || !cookie) return null;
  return { keyRaw, cookie };
}

function parseCookieHeader(header: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(/,(?=\s*[^;,]+=)/)) {
    const [raw] = part.split(";");
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const name = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (name && value) out.set(name, value);
  }
  return out;
}

function mergeCookieHeader(previous: string, additions: string): string {
  const merged = parseCookieHeader(previous);
  for (const [name, value] of parseCookieHeader(additions)) {
    merged.set(name, value);
  }
  return Array.from(merged.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function svpFetch(
  path: string,
  opts: { method?: string; token?: string; body?: unknown } = {}
) {
  const url = `${SVP_BASE}${path}${path.includes("?") ? "&" : "?"}locale=${SVP_LOCALE}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Origin: SVP_ORIGIN,
    Referer: `${SVP_ORIGIN}/`,
    "User-Agent": SVP_UA,
  };
  if (opts.body) headers["Content-Type"] = "application/json;charset=UTF-8";
  if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;

  const res = await fetch(url, {
    method: opts.method || "GET",
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw normalizeSvpError(res.status, data);
  }
  return data;
}

async function svpFetchRaw(
  path: string,
  token: string
) {
  const url = `${SVP_BASE}${path}${path.includes("?") ? "&" : "?"}locale=${SVP_LOCALE}`;
  return fetch(url, {
    method: "GET",
    headers: {
      Accept: "*/*",
      Authorization: `Bearer ${token}`,
      Origin: SVP_ORIGIN,
      Referer: `${SVP_ORIGIN}/`,
      "User-Agent": SVP_UA,
    },
  });
}

function extractT2HubCookie(headers: Headers, previous = ""): string {
  const anyHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const setCookies = anyHeaders.getSetCookie?.() || [];
  const raw = setCookies.length ? setCookies.join(",") : headers.get("set-cookie") || "";
  return mergeCookieHeader(previous, raw);
}

function extractT2HubKey(html: string): string {
  return html.match(/window\.__sk\s*=\s*['"]([^'"]+)['"]/)?.[1] || "";
}

function extractT2HubCsrf(html: string): string {
  return (
    html.match(/<meta\s+name=["']csrf-token["']\s+content=["']([^"']+)["']/)?.[1] || ""
  );
}

async function fetchT2HubSessionPage(appPath: string) {
  const res = await fetch(`${T2HUB_BASE}${appPath}`, {
    headers: {
      Accept: "text/html",
      "User-Agent": SVP_UA,
    },
  });
  const html = await res.text();
  return { res, html, keyRaw: extractT2HubKey(html) };
}

/**
 * Build a t2hub session from the T2HUB_SESSION_KEY and T2HUB_SESSION_COOKIE
 * environment variables. These are set by the refresh-t2hub-session script
 * after a successful Playwright login and capture.
 */
function getEnvSession(): NonNullable<typeof t2hubSession> | null {
  const keyRaw = Deno.env.get("T2HUB_SESSION_KEY") || "";
  const cookie = Deno.env.get("T2HUB_SESSION_COOKIE") || "";
  if (!keyRaw || !cookie) return null;
  return {
    keyRaw,
    cookie,
    csrfToken: Deno.env.get("T2HUB_SESSION_CSRF") || "",
    appPath: T2HUB_APP_PATH,
    expiresAt: Date.now() + 30 * 60 * 1000,
  };
}

async function getT2HubSession() {
  if (t2hubSession && t2hubSession.expiresAt > Date.now()) return t2hubSession;

  // 1. Try caller-provided headers (already handled in t2hubFetch/t2hubPost)
  // 2. Try in-memory cache
  // 3. Try env var session (set by refresh script)
  const envSession = getEnvSession();
  if (envSession) {
    t2hubSession = envSession;
    return t2hubSession;
  }

  // 4. Try fetching landing page (works only if the page exposes __sk)
  const appPaths = [T2HUB_APP_PATH, `${T2HUB_APP_PATH}/`, `${T2HUB_APP_PATH}/agent/login`];
  let lastStatus = 0;
  for (const appPath of appPaths) {
    const { res, html, keyRaw } = await fetchT2HubSessionPage(appPath);
    lastStatus = res.status;
    if (!res.ok || !keyRaw) continue;

    t2hubSession = {
      keyRaw,
      csrfToken: extractT2HubCsrf(html),
      cookie: extractT2HubCookie(res.headers),
      appPath,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    return t2hubSession;
  }

  throw {
    statusCode: 503,
    code: T2HUB_SESSION_MISSING_CODE,
    message: "t2hub session has not been provided. Run the refresh-t2hub-session script or pass x-t2hub-cookie + x-t2hub-key headers.",
    details: { status: lastStatus || undefined },
  };
}

// t2hub uses Laravel's Crypt::encrypt with AES-256-GCM. The encrypted envelope
// has `{p, iv}` where both are base64-encoded. The body is the base64 string
// itself (Content-Encoding: gzip was already inflated by Deno's fetch), so
// decoding must happen before JSON parsing. The landing page also exposes the
// session key in `window.__sk` (also base64), which we use to import the
// AES-GCM key.
async function decryptT2HubEnvelope(envelope: any, keyRaw: string) {
  if (!envelope?.p || !envelope?.iv) return envelope;
  const keyBytes = Uint8Array.from(atob(keyRaw), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const iv = Uint8Array.from(atob(envelope.iv), (c) => c.charCodeAt(0));
  const cipher = Uint8Array.from(atob(envelope.p), (c) => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plain));
}

// Some t2hub endpoints (e.g. /token-status) return a plaintext JSON body when
// the request lacks valid cookies, then flip to encrypted once the session is
// established. We must not try to decrypt plaintext, so the trigger is the
// `x-encrypted: 1` response header.
async function decodeT2HubResponse(res: Response, keyRaw: string) {
  const text = await res.text();
  const isEncrypted = (res.headers.get("x-encrypted") || "").trim() === "1";
  if (!isEncrypted) {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return { raw: text };
    }
  }
  // The encrypted body is a base64 string, not JSON. Parse it as JSON first
  // (Laravel returns it as a quoted string), then unwrap the envelope.
  let envelope: any = text;
  try {
    envelope = JSON.parse(text);
  } catch {
    // Body may already be a raw base64 string, not JSON-encoded.
  }
  if (typeof envelope === "string") {
    try {
      envelope = JSON.parse(envelope);
    } catch {
      /* not JSON ΓÇö keep as raw */
    }
  }
  return await decryptT2HubEnvelope(envelope, keyRaw);
}

async function fetchT2HubJson(path: string, session: NonNullable<typeof t2hubSession>) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${T2HUB_BASE}${path}`, {
      signal: controller.signal,
      headers: {
        Accept: "application/json, */*",
        Referer: `${T2HUB_BASE}${session.appPath}`,
        "User-Agent": SVP_UA,
        ...(session.cookie ? { Cookie: session.cookie } : {}),
      },
    });
    session.cookie = extractT2HubCookie(res.headers, session.cookie);
    if (!res.ok) {
      const details = await decodeT2HubResponse(res, session.keyRaw).catch(() => null);
      throw { statusCode: res.status, message: `t2hub request failed: ${res.status}`, details };
    }
    return await decodeT2HubResponse(res, session.keyRaw);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchT2HubJsonPost(path: string, body: unknown, session: NonNullable<typeof t2hubSession>) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${T2HUB_BASE}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Accept: "application/json, */*",
        "Content-Type": "application/json",
        Referer: `${T2HUB_BASE}${session.appPath}`,
        "User-Agent": SVP_UA,
        // Confirmed from live traffic: this endpoint is Laravel-CSRF-protected ΓÇö
        // POSTing without a matching X-CSRF-TOKEN (bound to the session cookie)
        // fails with 419. The XSRF-TOKEN cookie value is URL-encoded while the
        // header value is the raw meta-tag value, and Laravel compares them
        // after a decode. Send the latest value from the most recent response.
        ...(session.csrfToken ? { "X-CSRF-TOKEN": session.csrfToken } : {}),
        ...(session.cookie ? { Cookie: session.cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    session.cookie = extractT2HubCookie(res.headers, session.cookie);
    if (!res.ok) {
      const details = await decodeT2HubResponse(res, session.keyRaw).catch(() => null);
      throw { statusCode: res.status, message: `t2hub request failed: ${res.status}`, details };
    }
    return await decodeT2HubResponse(res, session.keyRaw);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function t2hubFetch(path: string, req: Request): Promise<any> {
  const provided = t2HubHeadersFromRequest(req);
  if (provided) {
    const session: NonNullable<typeof t2hubSession> = {
      keyRaw: provided.keyRaw,
      cookie: provided.cookie,
      csrfToken: "",
      appPath: T2HUB_APP_PATH,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    const data = await fetchT2HubJson(path, session);
    lastT2HubCookie = session.cookie;
    return data;
  }
  // Fallback: server-side cached session. Only works if a previous caller
  // bootstrapped the proxy by providing their cookies once.
  const session = await getT2HubSession();
  try {
    const data = await fetchT2HubJson(path, session);
    lastT2HubCookie = session.cookie;
    return data;
  } catch (err: any) {
    if (err?.message?.includes("OperationError") || err?.message?.includes("decrypt")) {
      t2hubSession = null;
      const fresh = await getT2HubSession();
      const data = await fetchT2HubJson(path, fresh);
      lastT2HubCookie = fresh.cookie;
      return data;
    }
    throw err;
  }
}

async function t2hubPost(path: string, body: unknown, req: Request): Promise<any> {
  const provided = t2HubHeadersFromRequest(req);
  if (provided) {
    const session: NonNullable<typeof t2hubSession> = {
      keyRaw: provided.keyRaw,
      cookie: provided.cookie,
      csrfToken: "",
      appPath: T2HUB_APP_PATH,
      expiresAt: Date.now() + 10 * 60 * 1000,
    };
    const data = await fetchT2HubJsonPost(path, body, session);
    lastT2HubCookie = session.cookie;
    return data;
  }
  const session = await getT2HubSession();
  try {
    const data = await fetchT2HubJsonPost(path, body, session);
    lastT2HubCookie = session.cookie;
    return data;
  } catch (err: any) {
    if (err?.message?.includes("OperationError") || err?.message?.includes("decrypt")) {
      t2hubSession = null;
      const fresh = await getT2HubSession();
      const data = await fetchT2HubJsonPost(path, body, fresh);
      lastT2HubCookie = fresh.cookie;
      return data;
    }
    throw err;
  }
}

function jsonWithT2HubCookie(data: unknown, status = 200) {
  const headers: Record<string, string> = {
    ...corsHeaders,
    "Content-Type": "application/json",
  };
  if (lastT2HubCookie) headers[T2HUB_RESPONSE_COOKIE_HEADER] = lastT2HubCookie;
  return new Response(JSON.stringify(data), { status, headers });
}

function t2hubQuery(path: string, params: URLSearchParams) {
  const queryString = params.toString();
  return `${T2HUB_APP_PATH}/api${path}${queryString ? `?${queryString}` : ""}`;
}

function normalizeT2HubSession(item: any, centerByName: Map<string, any>) {
  const centerName = String(item?.center_name || item?.test_center_name || "").trim();
  const center = centerByName.get(centerName.toLowerCase());
  const siteId = String(center?.id || center?.center || item?.site_id || item?.test_center_id || "");
  const encryptedId = String(item?.encrypted_session_id || item?.id || item?.exam_session_id || "");
  return {
    ...item,
    id: encryptedId || String(item?.session_id || ""),
    exam_session_id: encryptedId || String(item?.session_id || ""),
    numeric_session_id: item?.session_id ?? null,
    site_id: siteId || undefined,
    site_city: item?.center_city || center?.raw_city || center?.division || "",
    test_center: {
      ...(item?.test_center || {}),
      ...(siteId ? { id: siteId, site_id: siteId, test_center_id: siteId } : {}),
      ...(centerName ? { name: centerName, test_center_name: centerName } : {}),
      test_center_city: item?.center_city || center?.raw_city || center?.division || "",
      city: item?.center_city || center?.raw_city || center?.division || "",
    },
  };
}

// ΓöÇΓöÇ Crypto ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function getEncKey(): Promise<Uint8Array> {
  const raw = Deno.env.get("SESSION_ENC_KEY_BASE64") || "";
  if (raw) {
    try {
      const decoded = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0));
      if (decoded.length === 32) return decoded;
    } catch { /* fall through */ }
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
    return new Uint8Array(hash);
  }
  const fallback = Deno.env.get("JWT_REFRESH_SECRET") || "dev";
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fallback));
  return new Uint8Array(hash);
}

async function decryptString(b64: string): Promise<string> {
  const buf = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const iv = buf.slice(0, 12);
  const data = buf.slice(12);
  const key = await crypto.subtle.importKey("raw", await getEncKey(), "AES-GCM", false, ["decrypt"]);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
  return new TextDecoder().decode(decrypted);
}

// ΓöÇΓöÇ JWT verify ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function verifyJwt(token: string): Promise<Record<string, unknown>> {
  const secret = Deno.env.get("JWT_ACCESS_SECRET")!;
  const parts = token.split(".");
  if (parts.length !== 3) throw { statusCode: 401, message: "Invalid token" };

  const keyData = new TextEncoder().encode(secret);
  const cryptoKey = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const input = `${parts[0]}.${parts[1]}`;

  const sigB64 = parts[2].replace(/-/g, "+").replace(/_/g, "/");
  const padded = sigB64 + "=".repeat((4 - (sigB64.length % 4)) % 4);
  const sig = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));

  const valid = await crypto.subtle.verify("HMAC", cryptoKey, sig, new TextEncoder().encode(input));
  if (!valid) throw { statusCode: 401, message: "Invalid signature" };

  const claimsB64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const claimsPadded = claimsB64 + "=".repeat((4 - (claimsB64.length % 4)) % 4);
  const claims = JSON.parse(atob(claimsPadded));

  if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) {
    throw { statusCode: 401, message: "Token expired" };
  }

  return claims;
}

// ΓöÇΓöÇ Auth middleware ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
async function requireAuth(req: Request): Promise<{ user: Record<string, unknown>; svpToken: string }> {
  const hdr = req.headers.get("authorization") || "";
  const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : null;
  if (!token) throw { statusCode: 401, code: "CANDIDATE_ACCOUNT_REQUIRED", message: "An active candidate SVP session is required" };

  let user: Record<string, unknown>;
  try {
    user = await verifyJwt(token);
  } catch {
    throw { statusCode: 401, code: "CANDIDATE_ACCOUNT_REQUIRED", message: "Candidate SVP session expired" };
  }
  const sessionId = user.sid as string;
  if (!sessionId) throw { statusCode: 401, code: "CANDIDATE_ACCOUNT_REQUIRED", message: "Candidate SVP session is invalid" };

  const supabase = getSupabase();
  const { data: session } = await supabase.from("svp_sessions").select("*").eq("id", sessionId).single();
  if (!session || session.revoked_at || (session.refresh_expires_at && new Date(session.refresh_expires_at).getTime() <= Date.now())) {
    throw { statusCode: 401, code: "CANDIDATE_ACCOUNT_REQUIRED", message: "Candidate SVP session is inactive or expired" };
  }
  if (!session.svp_access_enc) throw { statusCode: 401, code: "CANDIDATE_ACCOUNT_REQUIRED", message: "Candidate SVP token is unavailable" };

  const svpToken = await decryptString(session.svp_access_enc);
  return { user, svpToken };
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

// ΓöÇΓöÇ Route definitions ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
interface RouteEntry {
  method: string;
  pattern: RegExp;
  svpPath: string | ((match: RegExpMatchArray, query: string) => string);
  bodyForward?: boolean;
}

const routes: RouteEntry[] = [
  { method: "GET", pattern: /^\/permissions$/, svpPath: "/api/v1/individual_labor_space/permissions" },
  { method: "GET", pattern: /^\/occupations$/, svpPath: "/api/v1/individual_labor_space/occupations" },
  { method: "GET", pattern: /^\/exam-constraints$/, svpPath: "/api/v1/individual_labor_space/exam_constraints" },
  // exam-sessions list is handled as a custom route below (to enrich with available_seats)
  { method: "GET", pattern: /^\/exam-session\/([^/]+)$/, svpPath: (m) => `/api/v1/individual_labor_space/exam_sessions/${m[1]}` },
  { method: "GET", pattern: /^\/exam-sessions\/([^/]+)$/, svpPath: (m) => `/api/v1/individual_labor_space/exam_sessions/${m[1]}` },
  { method: "GET", pattern: /^\/exam-reservations$/, svpPath: "/api/v1/individual_labor_space/exam_reservations" },
  { method: "GET", pattern: /^\/exam-reservations\/([^/]+)$/, svpPath: (m) => `/api/v1/individual_labor_space/exam_reservations/${m[1]}` },
  { method: "POST", pattern: /^\/temporary-seats$/, svpPath: "/api/v1/individual_labor_space/temporary_seats", bodyForward: true },
  { method: "POST", pattern: /^\/exam-reservations$/, svpPath: "/api/v1/individual_labor_space/exam_reservations", bodyForward: true },
  { method: "POST", pattern: /^\/reservation-credits\/use$/, svpPath: "/api/v1/individual_labor_space/reservation_credits/use", bodyForward: true },
  { method: "GET", pattern: /^\/certificate-price$/, svpPath: "/api/v1/individual_labor_space/certificate_price" },
  { method: "GET", pattern: /^\/payments-validate-pending$/, svpPath: "/api/v1/individual_labor_space/payments/validate_pending" },
  { method: "GET", pattern: /^\/payments$/, svpPath: "/api/v1/individual_labor_space/payments" },
  { method: "POST", pattern: /^\/payments$/, svpPath: "/api/v1/individual_labor_space/payments", bodyForward: true },
  { method: "GET", pattern: /^\/payments\/([^/]+)$/, svpPath: (m) => `/api/v1/individual_labor_space/payments/${m[1]}` },
  { method: "PUT", pattern: /^\/payments\/([^/]+)$/, svpPath: (m) => `/api/v1/individual_labor_space/payments/${m[1]}`, bodyForward: true },
  { method: "GET", pattern: /^\/feature-flags$/, svpPath: "/api/v1/individual_labor_space/feature_flags" },
  { method: "GET", pattern: /^\/notifications$/, svpPath: "/api/v1/individual_labor_space/notifications" },
  { method: "GET", pattern: /^\/user-balance\/([^/]+)$/, svpPath: (m) => `/api/v1/individual_labor_space/user_balance/${m[1]}` },
  { method: "DELETE", pattern: /^\/exam-reservations\/([^/]+)$/, svpPath: (m) => `/api/v1/individual_labor_space/exam_reservations/${m[1]}` },
  { method: "POST", pattern: /^\/exam-reservations\/([^/]+)\/reschedule$/, svpPath: (m) => `/api/v1/individual_labor_space/exam_reservations/${m[1]}/reschedule`, bodyForward: true },
];

function buildPath(basePath: string, queryString: string): string {
  const params = new URLSearchParams(queryString);
  params.delete("locale");
  const suffix = params.toString();
  return suffix ? `${basePath}?${suffix}` : basePath;
}

const SVP_COUNTRY_ID = "78";

function normalizeCityName(value: unknown): string {
  return String(value || "").trim();
}

function extractSessionCenterIds(value: any): string[] {
  // Primary: check the well-known paths matching the frontend's getSessionSiteId
  const candidates = [
    value,
    value?.exam_session,
    value?.data,
    value?.data?.exam_session,
  ].filter(Boolean);
  const ids = candidates.map((session: any) => String(
    session?.site_id ||
    session?.test_center_id ||
    session?.test_center?.site_id ||
    session?.test_center?.test_center_id ||
    session?.test_center?.id ||
    session?.site?.id ||
    ""
  ).trim()).filter(Boolean);

  // Fallback: walk the full response tree for deeply nested center IDs
  if (!ids.length) {
    const seen = new Set<any>();
    const queue = [value];
    while (queue.length) {
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      const sid = String(
        node?.site_id ||
        node?.test_center_id ||
        node?.test_center?.site_id ||
        node?.test_center?.test_center_id ||
        node?.test_center?.id ||
        node?.site?.id ||
        ""
      ).trim();
      if (sid) ids.push(sid);
      if (ids.length) break;
      queue.push(...(Array.isArray(node) ? node : Object.values(node)));
    }
  }

  return Array.from(new Set(ids));
}

async function assertSvpSessionMatchesCenter(token: string, sessionId: string | number, expectedCenterId: string | number) {
  const expected = String(expectedCenterId || "").trim();
  if (!expected) throw { statusCode: 400, code: "CENTER_BINDING_REQUIRED", message: "Selected test centre is required" };
  const detail = await svpFetch(
    `/api/v1/individual_labor_space/exam_sessions/${encodeURIComponent(String(sessionId))}`,
    { method: "GET", token },
  );
  const actualIds = extractSessionCenterIds(detail);
  if (!actualIds.length) {
    // SVP may not return center info for t2hub-sourced encrypted session IDs.
    // Fail open: SVP's own reservation endpoint will reject if there's a real mismatch.
    return;
  }
  if (actualIds.some((id) => id !== expected)) {
    throw {
      statusCode: 409,
      code: "CENTER_MISMATCH",
      message: `Selected session belongs to site ${actualIds[0]}, not selected site ${expected}`,
      details: { expected_center_id: expected, actual_center_ids: actualIds },
    };
  }
}

function normalizeTestCenter(center: any) {
  const id = center?.test_center_id ?? center?.id ?? center?.site_id ?? center?.site?.id ?? "";
  const name = center?.test_center_name || center?.name || center?.site?.name || "";
  const city = normalizeCityName(
    center?.city || center?.test_center_city || center?.address?.locality || center?.address?.city
  );
  return {
    ...center,
    id: id === "" ? "" : String(id),
    test_center_id: id === "" ? "" : String(id),
    name: String(name || "").trim(),
    test_center_name: String(name || "").trim(),
    city,
    test_center_city: city,
  };
}

function extractTestCenters(payload: any): any[] {
  const values = payload?.test_centers || payload?.centers || payload?.data?.test_centers || payload?.data?.centers || payload?.data;
  return Array.isArray(values) ? values : [];
}

function extractCities(payload: any): string[] {
  const values = payload?.cities || payload?.data?.cities || payload?.data || [];
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.map((item: any) => normalizeCityName(
    typeof item === "string" ? item : item?.city || item?.name || item?.english_name
  )).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function extractSessions(payload: any): any[] {
  const values = payload?.exam_sessions || payload?.sessions || payload?.data?.exam_sessions || payload?.data?.sessions || payload?.data;
  return Array.isArray(values) ? values : [];
}

function enrichSessionsForCenter(sessions: any[], center: any, testCenterId: string, city: string) {
  const normalizedCenter = normalizeTestCenter(center || { id: testCenterId, city });
  return sessions.map((session: any) => ({
    ...session,
    site_id: normalizedCenter.test_center_id || testCenterId,
    test_center_id: normalizedCenter.test_center_id || testCenterId,
    test_center_name: normalizedCenter.test_center_name || session?.test_center_name || "",
    site_city: normalizedCenter.city || session?.site_city || city,
    test_center: {
      ...(session?.test_center || {}),
      id: normalizedCenter.id || session?.test_center?.id || testCenterId,
      test_center_id: normalizedCenter.test_center_id || session?.test_center?.test_center_id || testCenterId,
      name: normalizedCenter.name || session?.test_center?.name || session?.test_center?.test_center_name || "",
      test_center_name: normalizedCenter.test_center_name || session?.test_center?.test_center_name || session?.test_center?.name || "",
      city: normalizedCenter.city || session?.test_center?.city || session?.test_center?.test_center_city || city,
      test_center_city: normalizedCenter.city || session?.test_center?.test_center_city || session?.test_center?.city || city,
    },
  }));
}

function rawSessionMatchesCenter(session: any, testCenterId: string): boolean {
  return Boolean(getSessionCenterId(session)) &&
    String(getSessionCenterId(session)) === String(testCenterId);
}

async function fetchOfficialCenterSessions(
  categoryId: string,
  city: string,
  examDate: string,
  testCenterId: string,
  token: string,
): Promise<any[]> {
  const params = new URLSearchParams({
    category_id: categoryId,
    city,
    exam_date: examDate,
    test_center_id: testCenterId,
    country_id: SVP_COUNTRY_ID,
    available_seats: "greater_than::0",
    status: "scheduled",
    per_page: "10000",
  });
  const payload = await svpFetch(
    buildPath("/api/v1/individual_labor_space/exam_sessions", params.toString()),
    { method: "GET", token },
  );
  return extractSessions(payload).filter((session: any) => rawSessionMatchesCenter(session, testCenterId));
}

// ΓöÇΓöÇ Main handler ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const rawPath = url.pathname.replace(/^\/svp-proxy/, "");
  // Keep provider-specific naming out of the browser-facing API contract.
  // The internal handlers still use the existing upstream integration paths.
  const path = rawPath.replace(/^\/booking-data(?=\/|$)/, "/t2hub");
  const query = url.search.replace(/^\?/, "");

  try {
    // ═══ t2hub session health check (no auth required) ═══
    if (req.method === "GET" && path === "/t2hub/session-status") {
      const envKey = Deno.env.get("T2HUB_SESSION_KEY") || "";
      const envCookie = Deno.env.get("T2HUB_SESSION_COOKIE") || "";
      const cached = t2hubSession;
      return json({
        env: { hasKey: !!envKey, hasCookie: !!envCookie, keyLen: envKey.length, cookieLen: envCookie.length },
        cache: cached ? { hasKey: !!cached.keyRaw, hasCookie: !!cached.cookie, expiresAt: new Date(cached.expiresAt).toISOString() } : null,
        status: envKey && envCookie ? "ok" : cached ? "cached" : "missing",
      });
    }

    // ═══ t2hub data routes (no SVP auth required — uses t2hub session only) ═══
    if (req.method === "GET" && path === "/t2hub/test-centers") {
      const params = new URLSearchParams(query);
      params.delete("locale");
      const city = params.get("city") || params.get("division") || "";
      if (!city) throw { statusCode: 400, message: "Missing city or division" };
      params.delete("city");
      params.set("division", city);
      const data = await t2hubFetch(t2hubQuery("/test-centers", params), req);
      return json(data);
    }

    if (req.method === "GET" && path === "/t2hub/occupations") {
      const params = new URLSearchParams(query);
      // The upstream currently returns 250 records (count === total), but use
      // a high internal page size so future catalog growth is loaded in full.
      params.set("per_page", "10000");
      return json(await t2hubFetch(t2hubQuery("/pacc/occupations", params), req));
    }

    if (req.method === "GET" && path === "/t2hub/exam-available-dates") {
      return json(await t2hubFetch(t2hubQuery("/exam-available-dates", new URLSearchParams(query)), req));
    }

    if (req.method === "GET" && path === "/t2hub/exam-sessions-bulk") {
      return json(await t2hubFetch(t2hubQuery("/exam-sessions-bulk", new URLSearchParams(query)), req));
    }

    if (req.method === "POST" && path === "/t2hub/exam-sessions-bulk") {
      const body = await req.json().catch(() => ({}));
      const requests = body?.requests;
      if (!Array.isArray(requests) || !requests.length) {
        throw { statusCode: 400, message: "Missing requests array" };
      }
      const data = await t2hubPost(`${T2HUB_APP_PATH}/api/exam-sessions-bulk`, { requests }, req);
      return json(data);
    }

    if (req.method === "GET" && path === "/t2hub/pacc-exam-sessions") {
      const params = new URLSearchParams(query);
      params.delete("locale");
      const city = params.get("city") || "";
      const categoryId = params.get("category_id") || "";
      const examDate = params.get("exam_date") || "";
      if (!city || !categoryId || !examDate) {
        throw { statusCode: 400, message: "Missing city, category_id, or exam_date" };
      }

      const centersData = await t2hubFetch(t2hubQuery("/test-centers", new URLSearchParams({ division: city })), req);
      const sessionsData = await t2hubFetch(t2hubQuery("/pacc-exam-sessions", params), req);
      const centers: any[] = Array.isArray(centersData?.sites) ? centersData.sites : [];
      const centerByName = new Map(
        centers.map((center: any) => [String(center?.name || "").trim().toLowerCase(), center])
      );
      const sessions = (Array.isArray(sessionsData?.sessions) ? sessionsData.sessions : [])
        .map((item: any) => normalizeT2HubSession(item, centerByName));

      const requestedCenterId = params.get("test_center_id") || "";
      const activeCenterIds = new Set(
        sessions.map((s: any) => String(
          s?.site_id ||
          s?.test_center?.site_id ||
          s?.test_center?.id ||
          s?.test_center_id ||
          s?.test_center?.test_center_id ||
          ""
        ).trim()).filter(Boolean)
      );
      const filteredSites = requestedCenterId
        ? centers.filter((c: any) => String(c.id || c.test_center_id || "") === requestedCenterId)
        : centers.filter((c: any) => {
            const id = String(c.id || c.test_center_id || "").trim();
            if (!id) return false;
            return activeCenterIds.has(id);
          });

      return json({ ...sessionsData, sessions, exam_sessions: sessions, sites: filteredSites });
    }

    // Keep SVP validation parameters out of the browser URL. The client sends
    // them as JSON to this proxy; only the server builds the upstream query.
    if (req.method === "POST" && path === "/exam-reservations/validate") {
      const { svpToken } = await requireAuth(req);
      const body = await req.json().catch(() => ({}));
      const categoryId = String(body?.category_id ?? body?.categoryId ?? "").trim();
      const condition = String(body?.condition || "booking_availability_condition").trim();
      const locale = String(body?.locale || "en").trim();
      if (!categoryId) {
        throw { statusCode: 400, message: "Missing category_id" };
      }
      const upstreamQuery = new URLSearchParams({
        category_id: categoryId,
        condition,
        locale,
      });
      return json(await svpFetch(
        `/api/v1/individual_labor_space/exam_reservations/validate?${upstreamQuery.toString()}`,
        { method: "GET", token: svpToken },
      ));
    }

    // Public discovery routes do not require a candidate account. Keep these
    // before requireAuth so the booking page can load its initial catalog.
    if (req.method === "GET" && path === "/occupations") {
      return json(await svpFetch(
        buildPath("/api/v1/visitor_space/occupations", query),
      ));
    }

    if (req.method === "GET" && path === "/test-centers") {
      const params = new URLSearchParams(query);
      params.delete("locale");
      params.delete("category_id");
      params.set("country_id", params.get("country_id") || SVP_COUNTRY_ID);
      params.set("per_page", params.get("per_page") || "10000");
      const requestedCity = normalizeCityName(params.get("city"));
      params.delete("city");
      const data = await svpFetch(buildPath("/api/v1/visitor_space/test_centers", params.toString()));
      const centers = extractTestCenters(data)
        .map(normalizeTestCenter)
        .filter((center: any) => !requestedCity || String(center.city).toLowerCase() === requestedCity.toLowerCase())
        .filter((center: any) => center.test_center_id && center.test_center_name);
      return json({ test_centers: centers, centers, city: requestedCity });
    }

    if (req.method === "GET" && path === "/cities") {
      const params = new URLSearchParams(query);
      params.delete("locale");
      params.set("country_id", params.get("country_id") || SVP_COUNTRY_ID);
      params.set("per_page", params.get("per_page") || "10000");
      const data = await svpFetch(buildPath("/api/v1/visitor_space/test_centers", params.toString()));
      const cities = extractCities({ cities: extractTestCenters(data) });
      return json({ cities, data: cities });
    }

    const { user, svpToken } = await requireAuth(req);

    // ΓöÇΓöÇ Available dates (with fallbacks) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    if (req.method === "GET" && path === "/available-dates") {
      const paths = [
        "/api/v1/individual_labor_space/exam_sessions/available_dates",
        "/api/v1/individual_labor_space/available_dates",
        "/api/v1/individual_labor_space/available-dates",
      ];
      const params = new URLSearchParams(query);
      params.delete("locale");
      params.set("country_id", params.get("country_id") || SVP_COUNTRY_ID);
      params.set("per_page", params.get("per_page") || "10000");
      for (let i = 0; i < paths.length; i++) {
        try {
          const data = await svpFetch(buildPath(paths[i], params.toString()), { method: "GET", token: svpToken });
          return json(data);
        } catch (err: any) {
          if (err?.statusCode !== 404) throw err;
        }
      }

      // The official SVP date routes are not consistently available. Use the
      // corresponding t2hub calendar endpoint when all of them return 404.
      return json(await t2hubFetch(t2hubQuery("/exam-available-dates", params), req));
    }

    // Keep the existing `/occupations` client contract. SVP's public
    // visitor_space endpoint doesn't require a token; fall back to t2hub's
    // PACC list when the upstream route is missing.
    if (req.method === "GET" && path === "/occupations") {
      try {
        return json(await svpFetch(
          buildPath("/api/v1/visitor_space/occupations", query),
        ));
      } catch (err: any) {
        if (err?.statusCode !== 404) throw err;
      }
      try {
        const params = new URLSearchParams(query);
        params.delete("locale");
        return json(await t2hubFetch(t2hubQuery("/pacc/occupations", params), req));
      } catch {
        // final fallback: try individual_labor_space (authenticated)
        return json(await svpFetch(
          buildPath("/api/v1/individual_labor_space/occupations", query),
          { method: "GET", token: svpToken },
        ));
      }
    }

    // ΓöÇΓöÇ Live SVP cities and test centers ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    if (req.method === "GET" && path === "/cities") {
      const params = new URLSearchParams(query);
      params.delete("locale");
      params.set("country_id", params.get("country_id") || SVP_COUNTRY_ID);
      params.set("per_page", params.get("per_page") || "10000");
      const data = await svpFetch(buildPath("/api/v1/individual_labor_space/test_centers/cities", params.toString()), {
        method: "GET",
        token: svpToken,
      });
      const cities = extractCities(data);
      return json({ cities, data: cities });
    }

    if (req.method === "GET" && path === "/test-centers") {
      const params = new URLSearchParams(query);
      params.delete("locale");
      // A test-centre roster is city/country scoped. Occupation/category
      // filtering belongs to exam-session availability, not centre discovery;
      // forwarding category_id here can incorrectly hide valid centres.
      params.delete("category_id");
      params.set("country_id", params.get("country_id") || SVP_COUNTRY_ID);
      params.set("per_page", params.get("per_page") || "10000");
      const requestedCity = normalizeCityName(params.get("city"));
      params.delete("city");
      const data = await svpFetch(buildPath("/api/v1/visitor_space/test_centers", params.toString()), {
        method: "GET",
        token: svpToken,
      });
      const centers = extractTestCenters(data)
        .map(normalizeTestCenter)
        .filter((center: any) => !requestedCity || String(center.city).toLowerCase() === requestedCity.toLowerCase())
        .filter((center: any) => center.test_center_id && center.test_center_name);
      return json({ test_centers: centers, centers, city: requestedCity });
    }

    // ΓöÇΓöÇ Date-scoped centre availability ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    // The SVP available-dates endpoint is city-level. This route deliberately
    // checks every real centre for the selected date so the UI never offers a
    // centre that has no scheduled session on that date.
    if (req.method === "GET" && path === "/center-session-availability") {
      const params = new URLSearchParams(query);
      const categoryId = params.get("category_id") || "";
      const requestedCity = normalizeCityName(params.get("city"));
      const examDate = params.get("exam_date") || params.get("test_date") || "";
      if (!categoryId || !requestedCity || !examDate) {
        throw { statusCode: 400, message: "Missing category_id, city, or exam_date" };
      }

      const centerPayload = await svpFetch(buildPath("/api/v1/visitor_space/test_centers", new URLSearchParams({
        category_id: categoryId,
        country_id: SVP_COUNTRY_ID,
        per_page: "10000",
      }).toString()), { method: "GET", token: svpToken });
      const centers = extractTestCenters(centerPayload)
        .map(normalizeTestCenter)
        .filter((center: any) => String(center.city).toLowerCase() === requestedCity.toLowerCase())
        .filter((center: any) => center.test_center_id && center.test_center_name);

      const availability = await Promise.all(centers.map(async (center: any) => {
        const siteId = String(center.test_center_id);
        try {
          const sessions = await fetchOfficialCenterSessions(categoryId, requestedCity, examDate, siteId, svpToken);
          return {
            ...center,
            session_count: sessions.length,
            lookup_status: "ok",
          };
        } catch {
          // An unverified centre is not offered for booking. Returning zero
          // keeps the UI safe instead of guessing that the city has a session.
          return {
            ...center,
            session_count: 0,
            lookup_status: "error",
          };
        }
      }));

      return json({
        city: requestedCity,
        category_id: categoryId,
        exam_date: examDate,
        centers: availability,
        available_centers: availability.filter((center: any) => center.session_count > 0 && center.lookup_status === "ok"),
      });
    }

    if (req.method === "GET" && path === "/exam-sessions") {
      const params = new URLSearchParams(query);
      const categoryId = params.get("category_id") || "";
      const city = normalizeCityName(params.get("city"));
      const examDate = params.get("exam_date") || params.get("test_date") || "";
      const testCenterId = params.get("test_center_id") || "";
      if (categoryId && city && examDate && testCenterId) {
        params.delete("locale");
        params.delete("test_date");
        params.set("exam_date", examDate);
        params.set("country_id", params.get("country_id") || SVP_COUNTRY_ID);
        params.set("available_seats", "greater_than::0");

        const [sessionPayload, centerPayload] = await Promise.all([
          svpFetch(buildPath("/api/v1/individual_labor_space/exam_sessions", params.toString()), {
            method: "GET",
            token: svpToken,
          }),
          svpFetch(buildPath("/api/v1/visitor_space/test_centers", new URLSearchParams({
            category_id: categoryId,
            country_id: SVP_COUNTRY_ID,
            per_page: "10000",
          }).toString()), { method: "GET", token: svpToken }),
        ]);

        const centers = extractTestCenters(centerPayload).map(normalizeTestCenter);
        const selectedCenter = centers.find((center: any) =>
          String(center.test_center_id) === String(testCenterId) &&
          (!center.city || center.city.toLowerCase() === city.toLowerCase())
        );
        const rawSessions = extractSessions(sessionPayload);
        const sessions = rawSessions
          .filter((session: any) => {
            const sessionCenterId = session?.test_center_id ?? session?.test_center?.test_center_id ?? session?.test_center?.id ?? session?.site_id;
            return sessionCenterId == null || String(sessionCenterId) === String(testCenterId);
          })
          .map((session: any) => enrichSessionsForCenter(rawSessions.length ? [session] : [], selectedCenter, testCenterId, city)[0]);

        return json({
          ...((sessionPayload && typeof sessionPayload === "object" && !Array.isArray(sessionPayload)) ? sessionPayload : {}),
          exam_sessions: sessions,
          sessions,
          test_center: selectedCenter || null,
          test_center_id: String(testCenterId),
          test_center_name: selectedCenter?.test_center_name || "",
          city,
          exam_date: examDate,
        });
      }
    }

    // ΓöÇΓöÇ Exam sessions (enriched with available_seats) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    if (req.method === "GET" && path === "/exam-sessions") {
      const sessionParams = new URLSearchParams(query);
      const city = sessionParams.get("city") || "";
      const categoryId = sessionParams.get("category_id") || "";
      const examDate = sessionParams.get("exam_date") || "";
      if (city && categoryId && examDate) {
        try {
          sessionParams.delete("locale");
          const [centersData, sessionsData] = await Promise.all([
            t2hubFetch(t2hubQuery("/test-centers", new URLSearchParams({ division: city })), req),
            t2hubFetch(t2hubQuery("/exam-sessions-bulk", sessionParams), req),
          ]);
          const centers: any[] = Array.isArray(centersData?.sites) ? centersData.sites : [];
          const centerByName = new Map(
            centers.map((center: any) => [String(center?.name || "").trim().toLowerCase(), center])
          );
          const requestedCenterId = String(sessionParams.get("test_center_id") || "").trim();
          const normalizedSessions = (Array.isArray(sessionsData?.sessions) ? sessionsData.sessions : [])
            .map((item: any) => normalizeT2HubSession(item, centerByName));
          const sessions = requestedCenterId
            ? filterLiveSessionsForCenter(normalizedSessions, requestedCenterId)
            : normalizedSessions.filter((session: any) => Boolean(getSessionCenterId(session)));
          return json({
            ...sessionsData,
            sessions,
            exam_sessions: sessions,
            sites: centers,
            ...(requestedCenterId ? { test_center_id: requestedCenterId } : {}),
          });
        } catch {
          // Fall back to the official SVP endpoint below if t2hub is unavailable.
        }
      }

      const listData: any = await svpFetch(
        buildPath("/api/v1/individual_labor_space/exam_sessions", query),
        { method: "GET", token: svpToken }
      );
      const sessions: any[] = listData?.exam_sessions || [];

      // If list doesn't include available_seats, fetch each detail in parallel
      if (sessions.length > 0 && sessions[0]?.available_seats === undefined) {
        const enriched = await Promise.all(
          sessions.map(async (s: any) => {
            try {
              const detail: any = await svpFetch(
                `/api/v1/individual_labor_space/exam_sessions/${s.id}`,
                { method: "GET", token: svpToken }
              );
              const d = detail?.exam_session || detail;
              return {
                ...s,
                available_seats: d?.available_seats ?? d?.seats_available ?? null,
                total_seats: d?.total_seats ?? d?.seats_total ?? null,
              };
            } catch {
              return s;
            }
          })
        );
        listData.exam_sessions = enriched;
      }

      return json(listData);
    }

    // ΓöÇΓöÇ User balance (auto-detect SVP user ID) ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    if (req.method === "GET" && path === "/user-balance") {
      const supabase = getSupabase();
      const { data: session } = await supabase
        .from("svp_sessions")
        .select("*, svp_users(*)")
        .eq("id", user.sid as string)
        .single();

      const svpUser = (session as any)?.svp_users;
      const tokenPayload = decodeJwtPayload(svpToken);
      const svpUserId = Number(
        svpUser?.svp_user_id || tokenPayload?.user_id || tokenPayload?.userId || tokenPayload?.uid || 0
      );
      if (!svpUserId) throw { statusCode: 400, message: "Missing svpUserId" };

      try {
        return json(await svpFetch(buildPath(`/api/v1/users/${svpUserId}/balance`, query), { method: "GET", token: svpToken }));
      } catch (err: any) {
        if (err?.statusCode === 404) {
          return json(await svpFetch(buildPath(`/api/v1/individual_labor_space/user_balance/${svpUserId}`, query), { method: "GET", token: svpToken }));
        }
        throw err;
      }
    }

    // ΓöÇΓöÇ Ticket PDF ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    const pdfMatch = path.match(/^\/tickets\/([^/]+)\/show-pdf$/);
    if (req.method === "GET" && pdfMatch) {
      await requireAccessPermission(req, "reservation.manage");
      const upstream = await svpFetchRaw(
        buildPath(`/api/v1/individual_labor_space/tickets/${pdfMatch[1]}/show_pdf`, query),
        svpToken
      );
      if (!upstream.ok) {
        const text = await upstream.text();
        let details;
        try { details = JSON.parse(text); } catch { details = { raw: text }; }
        throw { statusCode: upstream.status, message: `SVP request failed: ${upstream.status}`, details };
      }
      const contentType = upstream.headers.get("content-type") || "application/pdf";
      const disposition = upstream.headers.get("content-disposition");
      const headers: Record<string, string> = { ...corsHeaders, "Content-Type": contentType };
      if (disposition) headers["Content-Disposition"] = disposition;
      return new Response(await upstream.arrayBuffer(), { status: 200, headers });
    }

    // ΓöÇΓöÇ Auto-verify reservation status & refund credits ΓöÇΓöÇ
    if (req.method === "POST" && path === "/auto-verify-reservations") {
      const accessCtx = await requireAccessPermission(req, "booking.create");
      const reservationsData = await svpFetch("/api/v1/individual_labor_space/exam_reservations?locale=en", {
        method: "GET", token: svpToken,
      });
      if (!automaticRefundsEnabled()) {
        return json({ enabled: false, verified: 0, results: [], message: "Automatic reservation refunds are disabled" }, 409);
      }
      const results = await reconcileFinalizedReservationRefunds(
        accessCtx.supabase,
        accessCtx.account.id,
        reservationsData,
      );
      const orphanResults = await reconcileOrphanedDebits(
        accessCtx.supabase,
        accessCtx.account.id,
        reservationsData,
      );
      return json({ verified: results.length + orphanResults.length, results: [...results, ...orphanResults], account_id: accessCtx.account.id });
    }

    // ΓöÇΓöÇ Center-bound temporary seat hold ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    if (req.method === "POST" && path === "/temporary-seats") {
      const body = await req.json().catch(() => ({}));
      const examSessionId = body?.exam_session_id;
      const testCenterId = body?.test_center_id;
      if (examSessionId === undefined || examSessionId === null || examSessionId === "") {
        throw { statusCode: 400, message: "Missing exam_session_id" };
      }
      if (testCenterId === undefined || testCenterId === null || testCenterId === "") {
        throw { statusCode: 400, message: "Missing test_center_id" };
      }
      try {
        const data = await svpFetch("/api/v1/individual_labor_space/temporary_seats", {
          method: "POST",
          token: svpToken,
          body: {
            exam_session_id: examSessionId,
            test_center_id: testCenterId,
          },
        });
        return json(data);
      } catch (holdErr: any) {
        const msg = String(holdErr?.message || holdErr?.error || "").toLowerCase();
        if (msg.includes("already been taken") || msg.includes("already taken")) {
          const reservations: any = await svpFetch("/api/v1/individual_labor_space/exam_reservations?locale=en", {
            method: "GET",
            token: svpToken,
          });
          const rows = Array.isArray(reservations) ? reservations
            : Array.isArray(reservations?.exam_reservations) ? reservations.exam_reservations
              : Array.isArray(reservations?.data?.exam_reservations) ? reservations.data.exam_reservations
                : [];
          const match = rows.find((r: any) => {
            const rSid = String(r?.exam_session_id || r?.exam_session?.id || "");
            return rSid === String(examSessionId);
          });
          if (match) return json(match);
          const pendingMatch = rows.find((r: any) => {
            const st = String(r?.status || r?.state || "").toLowerCase();
            return st.includes("hold") || st.includes("pending") || st.includes("reserved") || st === "";
          });
          if (pendingMatch) return json(pendingMatch);
          throw { statusCode: 409, code: "CANDIDATE_LABOR_ID_EXISTS", message: "Session already held but no active reservation found. Try a different session or contact support." };
        }
        throw holdErr;
      }
    }

    // ΓöÇΓöÇ Standard routes ΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇΓöÇ
    for (const route of routes) {
      if (req.method !== route.method) continue;
      const match = path.match(route.pattern);
      if (!match) continue;

      const svpPath = typeof route.svpPath === "function" ? route.svpPath(match, query) : route.svpPath;
      const body = route.bodyForward ? await req.json().catch(() => ({})) : undefined;
      const isReservationWrite = req.method === "POST" &&
        (path === "/exam-reservations" || /^\/exam-reservations\/[^/]+\/reschedule$/.test(path));
      if (isReservationWrite) {
        const requestedSessionId = body?.exam_session_id;
        const requestedCenterId = body?.test_center_id;
        if (requestedSessionId === undefined || requestedSessionId === null || requestedSessionId === "") {
          throw { statusCode: 400, code: "SESSION_BINDING_REQUIRED", message: "Selected exam session is required" };
        }
        await assertSvpSessionMatchesCenter(svpToken, requestedSessionId, requestedCenterId);
      }

      const billingOperation = getReservationBillingOperation(req.method, path);
      const isBookingCreate = billingOperation === "booking";
      const isBookingReschedule = billingOperation === "reschedule";
      const isChargeableBooking = billingOperation !== null;
      const isBookingPreparation = req.method === "POST" && (path === "/temporary-seats" || path === "/reservation-credits/use");
      const isPaymentCreate = req.method === "POST" && path === "/payments";
      const isReservationManagement =
        (req.method === "GET" && /^\/exam-reservations(?:\/[^/]+)?$/.test(path)) ||
        (req.method === "DELETE" && /^\/exam-reservations\/[^/]+$/.test(path)) ||
        isBookingReschedule;
      let accessContext: Awaited<ReturnType<typeof requireAccessPermission>> | null = null;
      let walletHoldId = "";
      let bookingCreditCost = 0;

      if (isReservationManagement) {
        accessContext = await requireAccessPermission(req, "reservation.manage");
      } else if (isBookingCreate || isBookingPreparation) {
        accessContext = await requireAccessPermission(req, "booking.create");
      } else if (isPaymentCreate) {
        accessContext = await requireAccessPermission(req, "payment.create");
      }

      if (isChargeableBooking && accessContext?.account.permission_mode === "MANAGED") {
        bookingCreditCost = await getBookingCreditCost(accessContext.supabase, accessContext.account.agency_id);
        if (bookingCreditCost > 0) {
          const requestId = req.headers.get("x-request-id") || crypto.randomUUID();
          const { data: holdId, error: holdError } = await accessContext.supabase.rpc("wallet_place_booking_hold", {
            p_account_id: accessContext.account.id,
            p_amount: bookingCreditCost,
            p_idempotency_key: `${billingOperation}-request:${accessContext.account.id}:${requestId}`,
          });
          if (holdError) throw { statusCode: 402, message: holdError.message || "Insufficient wallet balance" };
          walletHoldId = String(holdId || "");
        }
      }

      try {
        const reservationLookupId = route.method === "GET" && /^\/exam-reservations(?:\/[^/]+)?$/.test(path)
          ? getReservationLookupId(path, query)
          : "";
        const isReservationRead = route.method === "GET" && /^\/exam-reservations(?:\/[^/]+)?$/.test(path);
        let data: any;
        let walletReconciliation: { reservation_id: string; status: string; action: string; amount?: number }[] = [];
        if (route.method === "GET" && /^\/exam-reservations(?:\/[^/]+)?$/.test(path) && reservationLookupId) {
          const collectionPayload = await svpFetch(
            buildPath(svpPath, buildReservationCollectionQuery(query)),
            { method: route.method, token: svpToken },
          );
          const matchingRows = filterReservationRows(collectionPayload, reservationLookupId);
          if (!matchingRows.length) {
            throw {
              statusCode: 404,
              message: "Reservation not found",
              details: { reservation_id: reservationLookupId },
            };
          }
          data = reshapeReservationPayload(collectionPayload, matchingRows);
        } else {
          data = await svpFetch(buildPath(svpPath, query), {
            method: route.method,
            token: svpToken,
            body,
          });
        }
        if (automaticRefundsEnabled() && isReservationRead && accessContext?.account.permission_mode === "MANAGED") {
          // Reservation status changes happen upstream, so reconcile on every
          // normal reservation read. The database RPC is deterministic and
          // idempotent; a transient wallet error must not hide the booking list.
          try {
            walletReconciliation = await reconcileFinalizedReservationRefunds(
              accessContext.supabase,
              accessContext.account.id,
              data,
            );
            // Also check for orphaned debits (debits with no matching reservation)
            const orphanResults = await reconcileOrphanedDebits(
              accessContext.supabase,
              accessContext.account.id,
              data,
            );
            if (orphanResults.length) {
              walletReconciliation.push(...orphanResults);
            }
          } catch (reconciliationError) {
            console.error("automatic reservation refund reconciliation failed", reconciliationError);
          }
        }
        if (isChargeableBooking && accessContext?.account.permission_mode === "MANAGED") {
          const reservationId = findReservationId(data) ||
            (isBookingReschedule ? String(match[1]) : "");
          if (!canFinalizeWalletDebit(billingOperation, reservationId)) {
            throw {
              statusCode: 502,
              code: "WALLET_DEBIT_BLOCKED_NO_RESERVATION_ID",
              message: "Reservation completed without a reservation ID; wallet debit was not finalized",
              details: { operation: billingOperation, wallet_hold_id: walletHoldId },
            };
          }
          let walletTransaction: any = null;
          if (walletHoldId) {
            const { data: completedTransaction, error: completeError } = await accessContext.supabase.rpc("wallet_complete_booking_hold", {
              p_hold_id: walletHoldId,
              p_reservation_id: reservationId,
              p_metadata: {
                source: "svp-proxy",
                operation: billingOperation,
                svp_success: true,
                configured_credit_cost: bookingCreditCost,
              },
            });
            if (completeError) {
              throw { statusCode: 500, message: "Reservation completed but wallet finalization failed", details: { reservationId, reason: completeError.message } };
            }
            walletTransaction = completedTransaction;
          }
          if (data && typeof data === "object" && !Array.isArray(data)) {
            // Check if the reservation is already in a finalized (refund-eligible) state
            const reservationStatus = String(
              data?.reservation_status || data?.status || data?.state || data?.cbt_exam_status || "",
            ).toLowerCase();
            const cancellationTimestamp = data?.cancelled_at || data?.canceled_at || data?.cancellation_date;
            const isFinalized = isRefundEligibleReservation(reservationStatus, cancellationTimestamp);

            // Auto-refund if booking succeeded but reservation is already finalized
            if (automaticRefundsEnabled() && isFinalized && reservationId && walletTransaction) {
              try {
                const refundResult = await accessContext.supabase.rpc("wallet_refund_booking", {
                  p_account_id: accessContext.account.id,
                  p_reservation_id: reservationId,
                  p_status: reservationStatus,
                  p_metadata: { source: "svp-proxy-auto-refund", operation: billingOperation },
                });
                if (!refundResult.error) {
                  return json({
                    ...data,
                    access_wallet: {
                      charged: bookingCreditCost,
                      refunded: true,
                      refund_amount: Number(refundResult.data?.amount || bookingCreditCost),
                      balance_after: Number(refundResult.data?.balance_after || walletTransaction.balance_after),
                      transaction_id: walletTransaction.id,
                      refund_transaction_id: refundResult.data?.id,
                    },
                  });
                }
              } catch (autoRefundErr) {
                console.error("auto-refund after booking failed", autoRefundErr);
              }
            }

            return json({ ...data, access_wallet: { charged: bookingCreditCost, balance_after: walletTransaction?.balance_after, transaction_id: walletTransaction?.id } });
          }
        }
        if (isReservationRead && data && typeof data === "object" && !Array.isArray(data) && accessContext?.account.permission_mode === "MANAGED") {
          return json({ ...data, access_wallet: { reconciliation: walletReconciliation } });
        }
        return json(data);
      } catch (error) {
        if (walletHoldId && accessContext) {
          await accessContext.supabase.rpc("wallet_release_booking_hold", { p_hold_id: walletHoldId });
        }
        throw error;
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (err: any) {
    const status = Number(err?.statusCode || 500);
    const code = err?.code || (status === 401 ? "AUTH_REQUIRED" : "SVP_PROXY_ERROR");
    const message = err?.message || "Server error";
    // Surface both the nested and flat shape so legacy client code that
    // reads data.message keeps working alongside new code that reads
    // data.code (e.g. the booking page's t2hub-missing bridge trigger).
    return json(
      {
        message,
        code,
        error: {
          code,
          message,
          request_id: req.headers.get("x-request-id") || null,
        },
        request_id: req.headers.get("x-request-id") || null,
      },
      status,
    );
  }
});
