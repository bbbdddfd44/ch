// Passport auto-fill client backed by the Supabase svp-registration function.

import { getAccessToken } from "./access-api";

export interface PassportScanData {
  passport_number: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;             // ISO YYYY-MM-DD (fits <input type="date"> directly)
  passport_expiration_date: string;  // ISO YYYY-MM-DD
  national_id: string;               // Separate holder ID printed on the passport, when present
  personal_number?: string;
  personal_id?: string;
  holder_id?: string;
  optional_data?: string;
  mrz_optional_data?: string;
  optional?: string;
  mrz_text?: string;
  raw_mrz?: string;
  raw_text?: string;
  sex: "male" | "female" | "";
  nationality_code: string;          // 3-letter ISO ("BGD")
  country_code: string;              // 2-letter ISO ("BD")
  issuing_country: string;           // e.g. "BANGLADESH"
  portrait_box: number[];            // [ymin, xmin, ymax, xmax], normalized 0..1000
  confidence: "high" | "medium" | "low";
  mrz_present: boolean;              // both MRZ lines were visible on the biodata page
  raw?: string;
}

export interface PassportScanResponse {
  ok: boolean;
  data: PassportScanData;
}

const ACCEPTED_MIME_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"] as const;
const SUPABASE_URL = String(import.meta.env.VITE_SUPABASE_URL || "").replace(/\/$/, "");

function resolveScanUrl(): string {
  if (!SUPABASE_URL) throw new Error("VITE_SUPABASE_URL is not configured");
  return `${SUPABASE_URL}/functions/v1/svp-registration/ocr-scan`;
}

function normalizeDateInput(value: unknown): string {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = text.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "";
}

export function isSupportedPassportImage(file: File): boolean {
  const mime = (file.type || "").toLowerCase();
  if (ACCEPTED_MIME_TYPES.includes(mime as (typeof ACCEPTED_MIME_TYPES)[number])) return true;
  return !mime && /\.(?:jpe?g|png|webp)$/i.test(file.name);
}

export async function cropPassportPortrait(file: File, portraitBox: readonly number[]): Promise<File | null> {
  if (portraitBox.length !== 4 || portraitBox.some((value) => !Number.isFinite(value))) return null;
  const [rawYmin, rawXmin, rawYmax, rawXmax] = portraitBox.map((value) => Math.max(0, Math.min(1000, value)));
  if (rawYmax - rawYmin < 30 || rawXmax - rawXmin < 30) return null;

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();

    const portraitWidth = ((rawXmax - rawXmin) / 1000) * image.naturalWidth;
    const portraitHeight = ((rawYmax - rawYmin) / 1000) * image.naturalHeight;
    const paddingX = portraitWidth * 0.08;
    const paddingY = portraitHeight * 0.08;
    const sourceX = Math.max(0, (rawXmin / 1000) * image.naturalWidth - paddingX);
    const sourceY = Math.max(0, (rawYmin / 1000) * image.naturalHeight - paddingY);
    const sourceWidth = Math.min(image.naturalWidth - sourceX, portraitWidth + paddingX * 2);
    const sourceHeight = Math.min(image.naturalHeight - sourceY, portraitHeight + paddingY * 2);
    if (sourceWidth < 20 || sourceHeight < 20) return null;

    const maxOutputSide = 720;
    const scale = Math.min(1, maxOutputSide / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) return null;
    return new File([blob], "passport-profile.jpg", { type: "image/jpeg", lastModified: Date.now() });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function scanPassport(file: File): Promise<PassportScanData> {
  if (!isSupportedPassportImage(file)) {
    throw new Error("Upload one JPEG, PNG or WEBP image of the passport biodata page. Do not upload a PDF, personal-data page, or combined document.");
  }
  const form = new FormData();
  form.append("file", file);
  const token = getAccessToken();
  if (!token) throw new Error("Sign in before scanning a passport.");
  const idempotencyKey = crypto.randomUUID();

  let res: Response;
  try {
    res = await fetch(resolveScanUrl(), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Idempotency-Key": idempotencyKey },
      body: form,
    });
  } catch {
    throw new Error("Passport auto-fill service could not be reached. Please try again or enter the details manually.");
  }
  const text = await res.text();
  let body: (Partial<PassportScanResponse> & { detail?: unknown; message?: unknown; error?: unknown }) | null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }

  if (!res.ok) {
    const message = body?.detail || body?.message || body?.error || `Passport auto-fill service is unavailable (HTTP ${res.status}).`;
    throw new Error(String(message));
  }
  const data = body?.data?.ocr || body?.data;
  if (!body?.ok || !data) {
    throw new Error("Passport scan returned an unexpected response.");
  }
  const scan = {
    ...(data as PassportScanData),
    date_of_birth: normalizeDateInput((data as PassportScanData).date_of_birth),
    passport_expiration_date: normalizeDateInput((data as PassportScanData).passport_expiration_date),
  };
  if (scan.mrz_present !== true) {
    throw new Error("Invalid passport MRZ. Upload a clear single biodata page showing both MRZ lines at the bottom; do not upload the personal-data page or a combined document.");
  }
  return scan;
}
