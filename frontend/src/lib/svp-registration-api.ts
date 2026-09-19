import { getAccessToken } from "./access-api";

const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");
const BASE = `${SUPABASE_URL}/functions/v1/svp-registration`;

export type SvpRegistrationResponse<T = any> = {
  ok?: boolean;
  data?: T;
  error?: string;
  message?: string;
  [key: string]: any;
};

function authHeaders(extra: Record<string, string> = {}): HeadersInit {
  const token = getAccessToken();
  return {
    Accept: "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  if (!response.ok) {
    throw Object.assign(new Error(body?.error || body?.message || `Request failed (${response.status})`), {
      status: response.status,
      data: body,
    });
  }
  return body as T;
}

function ensureConfigured() {
  if (!SUPABASE_URL) throw new Error("VITE_SUPABASE_URL is not configured");
}

export async function scanPassport(file: File, idempotencyKey = crypto.randomUUID()) {
  ensureConfigured();
  const form = new FormData();
  form.append("file", file, file.name || "passport.jpg");
  form.append("idempotency_key", idempotencyKey);
  const response = await fetch(`${BASE}/ocr-scan`, {
    method: "POST",
    headers: authHeaders({ "Idempotency-Key": idempotencyKey }),
    body: form,
  });
  return parseResponse<SvpRegistrationResponse>(response);
}

export async function storeRegistrationDraft(input: {
  passport_document_id: string;
  idempotency_key?: string;
  entry_source?: "ocr" | "manual";
  ocr_confidence?: number;
  ocr_provider?: string;
  personal_information: Record<string, unknown>;
}) {
  ensureConfigured();
  const idempotencyKey = input.idempotency_key || crypto.randomUUID();
  const response = await fetch(`${BASE}/store`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }),
    body: JSON.stringify({ ...input, idempotency_key: idempotencyKey }),
  });
  return parseResponse<SvpRegistrationResponse>(response);
}

async function officialMultipart(path: string, form: FormData, options: { confirmation?: boolean } = {}) {
  ensureConfigured();
  const headers: Record<string, string> = {};
  if (options.confirmation) headers["X-Registration-Confirmation"] = "CONFIRMED";
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(headers),
    body: form,
  });
  return parseResponse<SvpRegistrationResponse>(response);
}

/** Official POST /api/v1/individual_labor_space/registrations/validate adapter. */
export function validateOfficialRegistration(form: FormData) {
  return officialMultipart("/official/validate", form);
}

/**
 * Official POST /api/v1/individual_labor_space/registrations adapter.
 * The server requires an explicit confirmation header; this function does not
 * send it unless confirmation=true is passed by a deliberate UI action.
 */
export function submitOfficialRegistration(form: FormData, confirmation = false) {
  return officialMultipart("/official/register", form, { confirmation });
}

/** Official POST /api/v1/individual_labor_space/registrations/resend_otp adapter. */
export function resendOfficialOtp(form: FormData) {
  return officialMultipart("/official/resend-otp", form);
}

export const OFFICIAL_SVP_ENDPOINTS = {
  recognizePassport: "/api/v1/individual_labor_space/registrations/recognize_passport",
  validate: "/api/v1/individual_labor_space/registrations/validate",
  register: "/api/v1/individual_labor_space/registrations",
  resendOtp: "/api/v1/individual_labor_space/registrations/resend_otp",
} as const;
