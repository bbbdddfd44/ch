import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, idempotency-key, x-ocr-test-mode, x-svp-test-mode, x-registration-confirmation",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const JWT_ACCESS_SECRET = Deno.env.get("JWT_ACCESS_SECRET") || "";
const SUPABASE_JWKS_URL = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;
const SUPABASE_ISSUER = `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1`;
const PII_KEY_B64 = Deno.env.get("REGISTRATION_PII_KEY_BASE64") || "";
const HASH_SECRET = Deno.env.get("REGISTRATION_HASH_SECRET") || "";
const configuredSvpBase = Deno.env.get("SVP_API_BASE_URL") || Deno.env.get("SVP_BASE_URL") || "https://svp-international-api.pacc.sa";
const SVP_API_BASE = `${configuredSvpBase.replace(/\/$/, "")}${/\/api\/v1$/i.test(configuredSvpBase) ? "" : "/api/v1"}`;
const SVP_TENANT = Deno.env.get("SVP_TENANT_NAME") || "svp-international";
const SVP_LOCALE = Deno.env.get("SVP_LOCALE") || "en";
const MOCK_RECAPTCHA_ENABLED = Deno.env.get("SVP_ENABLE_MOCK_RECAPTCHA") === "true";
const MOCK_OCR_ENABLED = Deno.env.get("SVP_ENABLE_MOCK_OCR") === "true";
const BUCKET = "svp-private-documents";
// The official registration UI accepts PNG/JPG/JPEG and caps the upload at 2 MB.
const MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED_MIME = new Set(["image/jpeg", "image/png"]);
const KEY_VERSION = Deno.env.get("REGISTRATION_PII_KEY_VERSION") || "v1";

type Json = Record<string, unknown>;

type AuthAccount = {
  id: string;
  role: "ADMIN" | "AGENCY" | "USER" | string;
  status: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function supabase(): SupabaseClient {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase server configuration is incomplete");
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

function decodeJsonPart(value: string): any {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
}

let jwksCache: { expiresAt: number; keys: JsonWebKey[] } | null = null;

async function getSupabaseJwks(): Promise<JsonWebKey[]> {
  if (jwksCache && jwksCache.expiresAt > Date.now()) return jwksCache.keys;
  console.info(JSON.stringify({ event: "svp.auth.jwks.start", url: SUPABASE_JWKS_URL }));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let response: Response;
  try {
    response = await fetch(SUPABASE_JWKS_URL, { headers: { Accept: "application/json" }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  console.info(JSON.stringify({ event: "svp.auth.jwks.response", status: response.status }));
  if (!response.ok) throw new Error(`Supabase JWKS fetch failed (${response.status})`);
  const payload = await response.json();
  if (!Array.isArray(payload?.keys)) throw new Error("Supabase JWKS response is invalid");
  jwksCache = { keys: payload.keys as JsonWebKey[], expiresAt: Date.now() + 5 * 60_000 };
  return jwksCache.keys;
}

async function verifyAccessToken(token: string): Promise<{ sub: string; email?: string; role?: string; provider: "custom" | "supabase" }> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid access token");
  const header = decodeJsonPart(parts[0]);
  const claims = decodeJsonPart(parts[1]);
  console.info(JSON.stringify({ event: "svp.auth.token.parsed", alg: header.alg, has_kid: Boolean(header.kid), has_email: Boolean(claims.email) }));
  let valid = false;
  let provider: "custom" | "supabase";

  if (header.alg === "ES256") {
    if (claims.iss !== SUPABASE_ISSUER || claims.aud !== "authenticated") {
      throw new Error("Invalid Supabase token issuer or audience");
    }
    const jwk = (await getSupabaseJwks()).find((candidate: any) => candidate.kid === header.kid);
    if (!jwk) throw new Error("Supabase signing key not found");
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64UrlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    provider = "supabase";
  } else if (header.alg === "HS256") {
    if (!JWT_ACCESS_SECRET) throw new Error("JWT_ACCESS_SECRET is not configured");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(JWT_ACCESS_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64UrlDecode(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    provider = "custom";
  } else {
    throw new Error("Unsupported access token algorithm");
  }
  if (!valid) throw new Error("Invalid access token signature");
  if (!claims.sub || (claims.exp && Number(claims.exp) <= Math.floor(Date.now() / 1000))) {
    throw new Error("Expired access token");
  }
  return { sub: String(claims.sub), email: claims.email ? String(claims.email).toLowerCase() : undefined, role: claims.role ? String(claims.role) : undefined, provider };
}

async function requireAccount(req: Request, client: SupabaseClient): Promise<AuthAccount> {
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Bearer ")) throw new Error("Unauthorized");
  console.info(JSON.stringify({ event: "svp.auth.verify.start" }));
  const claims = await verifyAccessToken(header.slice(7));
  console.info(JSON.stringify({ event: "svp.auth.verify.done", provider: claims.provider, sub: claims.sub }));
  console.info(JSON.stringify({ event: "svp.auth.account.query.start", by: "id" }));
  let { data, error } = await client
    .from("accounts")
    .select("id, role, status")
    .eq("id", claims.sub)
    .maybeSingle();
  console.info(JSON.stringify({ event: "svp.auth.account.query.done", found: Boolean(data), error: error?.message || null }));
  // Supabase Auth UUIDs may differ from legacy application account IDs. In
  // that case, map only by the email claim from the already verified JWT.
  if ((!data || error) && claims.email) {
    console.info(JSON.stringify({ event: "svp.auth.account.query.start", by: "email" }));
    const fallback = await client.from("accounts").select("id, role, status").eq("email", claims.email).maybeSingle();
    data = fallback.data;
    error = fallback.error;
    console.info(JSON.stringify({ event: "svp.auth.account.query.done", found: Boolean(data), error: error?.message || null }));
  }
  if (error || !data || data.status !== "ACTIVE") throw new Error("Unauthorized account");
  return data as AuthAccount;
}

function requireCryptoConfig() {
  if (!PII_KEY_B64 || !HASH_SECRET) throw new Error("Registration encryption is not configured");
}

function requireOcrConfig() {
  requireCryptoConfig();
}

async function ensurePrivateDocumentBucket(client: SupabaseClient) {
  const { data, error } = await client.storage.getBucket(BUCKET);
  if (data) return;
  if (error && !/not found|does not exist/i.test(error.message)) {
    throw new Error(`Passport bucket check failed: ${error.message}`);
  }
  const { error: createError } = await client.storage.createBucket(BUCKET, { public: false, fileSizeLimit: `${MAX_BYTES}` });
  if (createError && !/already exists/i.test(createError.message)) {
    throw new Error(`Passport bucket creation failed: ${createError.message}`);
  }
}

function bytesToB64(bytes: Uint8Array): string {
  let output = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) output += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(output);
}

function b64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function encryptionKey(): Promise<CryptoKey> {
  const raw = b64ToBytes(PII_KEY_B64);
  if (raw.length !== 32) throw new Error("REGISTRATION_PII_KEY_BASE64 must decode to 32 bytes");
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
}

async function encryptJson(value: Json): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), plaintext));
  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return bytesToB64(packed);
}

async function hmacPassport(passportNumber: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(HASH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(passportNumber)));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizePassport(value: unknown): string {
  return String(value || "").trim().toUpperCase().replace(/\s+/g, "");
}

function normalizePhone(value: unknown): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("880")) return `+${digits}`;
  if (digits.startsWith("0")) return `+880${digits.slice(1)}`;
  return raw.startsWith("+") ? `+${digits}` : `+${digits}`;
}

function normalizeDate(value: unknown): string {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

function normalizeOcrData(input: any): Json {
  const source = input?.data && typeof input.data === "object" && !Array.isArray(input.data) ? input.data : input;
  const sex = String(source?.sex || "").toLowerCase();
  const mrzValue = source?.mrz_present;
  const mrzPresent = mrzValue === true || ["true", "yes", "present"].includes(String(mrzValue || "").trim().toLowerCase());
  const nationalId = normalizePassport(source?.national_id || source?.personal_number || source?.personal_id || source?.holder_id);
  const personalNumber = normalizePassport(source?.personal_number);
  const personalId = normalizePassport(source?.personal_id);
  const holderId = normalizePassport(source?.holder_id);
  const optionalData = String(source?.optional_data || "").trim();
  const mrzOptionalData = String(source?.mrz_optional_data || "").trim();
  const optional = String(source?.optional || "").trim();
  const mrzText = String(source?.mrz_text || "").trim();
  const rawMrz = String(source?.raw_mrz || "").trim();
  const rawText = String(source?.raw_text || "").trim();
  return {
    passport_number: normalizePassport(source?.passport_number),
    first_name: String(source?.first_name || source?.given_names || "").trim().toUpperCase(),
    last_name: String(source?.last_name || source?.surname || "").trim().toUpperCase(),
    date_of_birth: normalizeDate(source?.date_of_birth),
    passport_expiration_date: normalizeDate(source?.passport_expiration_date || source?.date_of_expiry),
    national_id: nationalId,
    personal_number: personalNumber,
    personal_id: personalId,
    holder_id: holderId,
    optional_data: optionalData,
    mrz_optional_data: mrzOptionalData,
    optional,
    mrz_text: mrzText,
    raw_mrz: rawMrz,
    raw_text: rawText,
    sex: sex === "m" ? "male" : sex === "f" ? "female" : sex,
    nationality_code: String(source?.nationality_code || source?.nationality || "").trim().toUpperCase(),
    country_code: String(source?.country_code || "").trim().toUpperCase(),
    country_id: source?.country?.id ?? source?.country_id ?? null,
    nationality_id: source?.nationality?.id ?? source?.nationality_id ?? null,
    country: source?.country ?? null,
    nationality: source?.nationality ?? null,
    issuing_country: String(source?.issuing_country || source?.issuing_authority || "").trim().toUpperCase(),
    passport_image_hash: String(source?.passport_image_hash || "").trim(),
    confidence: String(source?.confidence || "low").toLowerCase(),
    mrz_present: mrzValue == null ? null : mrzPresent,
  };
}

async function runOcr(file: File): Promise<Json> {
  const form = new FormData();
  // This field name is used by the official SVP SPA client.
  form.append("passport", file, file.name || "passport");
  const headers: Record<string, string> = {
    Accept: "application/json",
    Origin: "https://svp-international.pacc.sa",
    Referer: "https://svp-international.pacc.sa/auth/register",
    "X-Tenant-Name": SVP_TENANT,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  const startedAt = Date.now();
  console.info(JSON.stringify({ event: "svp.ocr.upstream.start", bytes: file.size, mime: file.type }));
  try {
    response = await fetch(`${SVP_API_BASE}/individual_labor_space/registrations/recognize_passport?locale=${encodeURIComponent(SVP_LOCALE)}`, {
      method: "POST",
      headers,
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  console.info(JSON.stringify({ event: "svp.ocr.upstream.response", status: response.status, elapsed_ms: Date.now() - startedAt }));
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = null; }
  if (!response.ok) {
    const providerMessage = String(payload?.message || payload?.error || payload?.detail || (typeof payload?.errors === "string" ? payload.errors : payload?.errors?.[0]?.message || payload?.errors?.message) || "").trim().slice(0, 240);
    console.error(JSON.stringify({ event: "svp.ocr.upstream.error", status: response.status, elapsed_ms: Date.now() - startedAt, message: providerMessage || "upstream response did not include a message" }));
    throw new Error(`SVP passport recognition failed (${response.status})${providerMessage ? `: ${providerMessage}` : ""}`);
  }
  const data = normalizeOcrData(payload?.data ?? payload);
  if (!data.passport_number) throw new Error("OCR could not read a passport number");
  // The official SVP recognizer does not currently return mrz_present, but a
  // successful passport-recognition response means its biodata/MRZ validation
  // accepted the image. Preserve an explicit provider value when available;
  // otherwise mark this successful recognition as MRZ-present.
  if (typeof data.mrz_present !== "boolean") data.mrz_present = true;
  return data;
}

function mockOcrData(): Json {
  return {
    passport_number: "MOCK-PASSPORT-0001",
    first_name: "MOCK",
    last_name: "APPLICANT",
    date_of_birth: "1990-01-01",
    passport_expiration_date: "2030-01-01",
    sex: "male",
    nationality_code: "BGD",
    country_code: "BD",
    country_id: null,
    nationality_id: null,
    country: null,
    nationality: null,
    issuing_country: "BANGLADESH",
    passport_image_hash: "mock-passport-image-hash",
    confidence: "high",
  };
}

async function officialMultipartRequest(path: string, form: FormData): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  let response: Response;
  try {
    response = await fetch(`${SVP_API_BASE}${path}${path.includes("?") ? "&" : "?"}locale=${encodeURIComponent(SVP_LOCALE)}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Origin: "https://svp-international.pacc.sa",
        Referer: "https://svp-international.pacc.sa/auth/register",
        "X-Tenant-Name": SVP_TENANT,
      },
      body: form,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  let payload: unknown;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 2000) }; }
  return { ok: response.ok, status: response.status, payload };
}

async function handleOfficialMultipart(req: Request, client: SupabaseClient, account: AuthAccount, path: string) {
  requireCryptoConfig();
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) return json({ error: "multipart/form-data required" }, 415);
  const form = await req.formData();
  const recaptcha = form.get("recaptcha_response") || form.get("recaptchaResponse") || form.get("recaptcha_token") || form.get("recaptchaToken");
  if (!form.get("recaptcha_response") && recaptcha) form.set("recaptcha_response", String(recaptcha));
  if (!recaptcha && MOCK_RECAPTCHA_ENABLED && req.headers.get("x-svp-test-mode") === "mock") {
    form.set("recaptcha_response", "mock-recaptcha-token");
    console.warn(JSON.stringify({ event: "svp.recaptcha.mock_used", path }));
  }
  if (path === "/individual_labor_space/registrations" && req.headers.get("x-registration-confirmation") !== "CONFIRMED") {
    return json({ error: "Explicit X-Registration-Confirmation: CONFIRMED header required for final account registration" }, 428);
  }
  const result = await officialMultipartRequest(path, form);
  await client.from("svp_registration_events").insert({
    registration_id: String(form.get("registration_id") || form.get("local_registration_id") || crypto.randomUUID()),
    actor_account_id: account.id,
    event_type: path.endsWith("/validate") ? "official.validation.requested" : path.endsWith("/resend_otp") ? "official.otp_resent" : "official.registration.requested",
    metadata: { official_path: path, http_status: result.status },
  }).then(() => undefined).catch(() => undefined);
  return json(result.payload, result.ok ? 200 : result.status);
}

function extensionFor(mime: string): string {
  return mime === "application/pdf" ? "pdf" : mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
}

function safeFileName(kind: string, mime: string): string {
  return `${kind.toLowerCase()}-${crypto.randomUUID()}.${extensionFor(mime)}`;
}

async function audit(client: SupabaseClient, registrationId: string, actorId: string, eventType: string, metadata: Json = {}, toStatus?: string, fromStatus?: string) {
  await client.from("svp_registration_events").insert({
    registration_id: registrationId,
    actor_account_id: actorId,
    event_type: eventType,
    from_status: fromStatus || null,
    to_status: toStatus || null,
    metadata,
  });
}

async function handleOcrScan(req: Request, client: SupabaseClient, account: AuthAccount) {
  requireOcrConfig();
  await ensurePrivateDocumentBucket(client);
  const contentType = req.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) return json({ error: "multipart/form-data required" }, 415);
  const form = await req.formData();
  const uploaded = form.get("file");
  if (!(uploaded instanceof File)) return json({ error: "Passport file is required" }, 400);
  if (!ALLOWED_MIME.has(uploaded.type)) return json({ error: "Unsupported file type" }, 415);
  if (uploaded.size <= 0 || uploaded.size > MAX_BYTES) return json({ error: "File must be between 1 byte and 2 MB" }, 413);

  const bytes = new Uint8Array(await uploaded.arrayBuffer());
  const checksum = await sha256(bytes);
  const mockRequested = req.headers.get("x-ocr-test-mode") === "mock";
  if (mockRequested && !MOCK_OCR_ENABLED) return json({ error: "Mock OCR is disabled" }, 403);
  const ocr = mockRequested ? mockOcrData() : await runOcr(uploaded);
  if (mockRequested) console.warn(JSON.stringify({ event: "svp.ocr.mock_used", bytes: uploaded.size }));
  const idempotencyKey = String(req.headers.get("idempotency-key") || form.get("idempotency_key") || crypto.randomUUID()).trim();
  if (idempotencyKey.length > 160) return json({ error: "idempotency_key is too long" }, 400);
  const passportHash = await hmacPassport(normalizePassport(ocr.passport_number));
  const registrationId = crypto.randomUUID();
  const path = `${account.id}/${registrationId}/passport/${safeFileName("passport", uploaded.type)}`;

  const { error: uploadError } = await client.storage.from(BUCKET).upload(path, bytes, {
    contentType: uploaded.type,
    cacheControl: "3600",
    upsert: false,
  });
  if (uploadError) throw new Error(`Passport storage failed: ${uploadError.message}`);

  const encryptedOcr = await encryptJson({
    ...ocr,
    submitted_by_account_id: account.id,
    submitted_at: new Date().toISOString(),
  });
  const { error: registrationError } = await client.from("svp_registrations").insert({
    id: registrationId,
    owner_account_id: account.id,
    created_by_account_id: account.id,
    status: "DRAFT",
    current_step: "review",
    pii_ciphertext: encryptedOcr,
    pii_key_version: KEY_VERSION,
    passport_number_hash: passportHash,
    entry_source: "ocr",
    ocr_confidence: ocr.confidence === "high" ? 0.95 : ocr.confidence === "medium" ? 0.75 : 0.4,
    ocr_provider: mockRequested ? "mock-ocr-test" : "svp-official-passport-recognition",
    idempotency_key: idempotencyKey,
  });
  if (registrationError) {
    await client.storage.from(BUCKET).remove([path]);
    if (registrationError.code === "23505") return json({ error: "An active registration already exists for this passport or idempotency key" }, 409);
    throw new Error(`Registration draft failed: ${registrationError.message}`);
  }

  const { data: document, error: documentError } = await client.from("svp_registration_documents").insert({
    id: crypto.randomUUID(),
    registration_id: registrationId,
    owner_account_id: account.id,
    kind: "PASSPORT",
    bucket_id: BUCKET,
    object_path: path,
    mime_type: uploaded.type,
    byte_size: uploaded.size,
    sha256: checksum,
    key_version: KEY_VERSION,
  }).select("id, registration_id, kind, bucket_id, object_path, mime_type, byte_size, sha256, uploaded_at").single();

  if (documentError) {
    await client.storage.from(BUCKET).remove([path]);
    await client.from("svp_registrations").delete().eq("id", registrationId).eq("owner_account_id", account.id);
    throw new Error(`Passport metadata failed: ${documentError.message}`);
  }

  await audit(client, registrationId, account.id, "registration.ocr_scanned", { document_kind: "PASSPORT", ocr_provider: mockRequested ? "mock-ocr-test" : "svp-official-passport-recognition" }, "DRAFT");
  return json({ ok: true, data: { registration_id: registrationId, document, ocr, ocr_provider: mockRequested ? "mock-ocr-test" : "svp-official-passport-recognition" } }, 201);
}

async function handleStore(req: Request, client: SupabaseClient, account: AuthAccount) {
  requireCryptoConfig();
  const body = await req.json().catch(() => ({}));
  const pii = body?.personal_information;
  const normalizedPii = pii && typeof pii === "object" ? {
    ...pii,
    phone_number: normalizePhone(pii.phone_number || pii.phone || pii.mobile || pii.telephone),
    // National ID is optional at this storage boundary. Keep it explicit and
    // null when the provider did not return one; the official validation step
    // may still require a user-supplied value before account creation.
    national_id: normalizePassport(pii.national_id || pii.personal_number || pii.personal_id || pii.holder_id) || null,
  } : pii;
  const documentId = String(body?.passport_document_id || "");
  const idempotencyKey = String(req.headers.get("idempotency-key") || body?.idempotency_key || "").trim();
  const passportNumber = normalizePassport(pii?.passport_number);
  if (!documentId || !idempotencyKey || !passportNumber) return json({ error: "passport_document_id, idempotency_key, and passport_number are required" }, 400);
  if (idempotencyKey.length > 160) return json({ error: "idempotency_key is too long" }, 400);

  const { data: document, error: documentError } = await client.from("svp_registration_documents")
    .select("id, registration_id, owner_account_id, kind, bucket_id, object_path")
    .eq("id", documentId).eq("owner_account_id", account.id).eq("kind", "PASSPORT").maybeSingle();
  if (documentError || !document) return json({ error: "Passport document not found" }, 404);

  const { data: draft, error: draftError } = await client.from("svp_registrations")
    .select("id, owner_account_id, status, idempotency_key")
    .eq("id", document.registration_id).eq("owner_account_id", account.id).maybeSingle();
  if (draftError || !draft) return json({ error: "Registration draft not found" }, 404);
  if (draft.status !== "DRAFT") return json({ error: "Registration is no longer editable" }, 409);
  if (draft.idempotency_key === idempotencyKey) {
    const { data: replay } = await client.from("svp_registrations")
      .select("id, owner_account_id, status, current_step, entry_source, ocr_confidence, idempotency_key, created_at, updated_at")
      .eq("id", draft.id).single();
    return json({ ok: true, data: replay, idempotent_replay: true }, 200);
  }

  const passportHash = await hmacPassport(passportNumber);
  const encryptedPii = await encryptJson({
    ...normalizedPii,
    passport_number: passportNumber,
    submitted_by_account_id: account.id,
    submitted_at: new Date().toISOString(),
  });

  const { data: registration, error } = await client.from("svp_registrations").update({
    pii_ciphertext: encryptedPii,
    pii_key_version: KEY_VERSION,
    passport_number_hash: passportHash,
    entry_source: body?.entry_source === "manual" ? "manual" : "ocr",
    ocr_confidence: body?.ocr_confidence == null ? null : Number(body.ocr_confidence),
    ocr_provider: body?.ocr_provider ? String(body.ocr_provider).slice(0, 120) : null,
    idempotency_key: idempotencyKey,
  }).eq("id", draft.id).eq("owner_account_id", account.id)
    .select("id, owner_account_id, status, current_step, entry_source, ocr_confidence, idempotency_key, created_at, updated_at").single();

  if (error) {
    if (error.code === "23505") return json({ error: "An active registration already exists for this passport or idempotency key" }, 409);
    throw new Error(`Registration store failed: ${error.message}`);
  }

  await audit(client, registration.id, account.id, "registration.created", { entry_source: registration.entry_source }, "DRAFT");
  return json({ ok: true, data: registration }, 201);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const url = new URL(req.url);
  const marker = "/svp-registration";
  const index = url.pathname.indexOf(marker);
  const path = index >= 0 ? url.pathname.slice(index + marker.length) || "/" : url.pathname;

  try {
    console.info(JSON.stringify({ event: "svp.request.start", method: req.method, path }));
    const client = supabase();
    const account = await requireAccount(req, client);
    console.info(JSON.stringify({ event: "svp.request.authenticated", account_id: account.id, path }));
    if (req.method === "POST" && (path === "/ocr-scan" || path === "/scan")) return await handleOcrScan(req, client, account);
    if (req.method === "POST" && (path === "/store" || path === "/registrations")) return await handleStore(req, client, account);
    if (req.method === "POST" && path === "/official/validate") {
      return await handleOfficialMultipart(req, client, account, "/individual_labor_space/registrations/validate");
    }
    if (req.method === "POST" && path === "/official/register") {
      return await handleOfficialMultipart(req, client, account, "/individual_labor_space/registrations");
    }
    if (req.method === "POST" && path === "/official/resend-otp") {
      return await handleOfficialMultipart(req, client, account, "/individual_labor_space/registrations/resend_otp");
    }
    if (req.method === "GET" && path === "/health") return json({ ok: true });
    return json({ error: "Not found" }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    const upstreamStatus = message.match(/SVP passport recognition failed \((\d{3})\)/)?.[1];
    const status = upstreamStatus ? Number(upstreamStatus) : /Unauthorized|access token/i.test(message) ? 401 : /not configured|configuration/i.test(message) ? 503 : 400;
    return json({ error: message, detail: message }, status);
  }
});
