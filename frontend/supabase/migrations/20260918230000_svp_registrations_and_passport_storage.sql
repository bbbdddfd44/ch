-- SVP registrations and private passport storage
--
-- Security model:
--   * The browser never writes these tables or Storage objects directly.
--   * Edge Functions use service_role and perform encryption/decryption server-side.
--   * PII is stored as an encrypted JSON envelope in pii_ciphertext.
--   * passport_number_hash is a keyed/deterministic hash used only for deduplication.
--   * The passport image bucket is private and has no anon/authenticated access policy.
--
-- Required application contract (implemented outside SQL):
--   pii_ciphertext = encrypted JSON containing passport/name/contact fields
--   pii_key_version = version of the server-side encryption key
--   passport_number_hash = HMAC-SHA-256(passport number, server-side secret)
--   storage path = <owner_account_id>/<registration_id>/<document_kind>/<uuid>.<ext>
--
-- Do not put encryption keys, HMAC secrets, passport images, OTPs, or plaintext
-- credentials in VITE_* variables, SQL source, or client-side logs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'svp_registration_status') THEN
    CREATE TYPE public.svp_registration_status AS ENUM (
      'DRAFT',
      'CONFIRMED',
      'QUEUED',
      'OTP_REQUIRED',
      'PROCESSING',
      'COMPLETED',
      'FAILED',
      'STOPPED',
      'CANCELLED'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typnamespace = 'public'::regnamespace AND typname = 'svp_registration_document_kind') THEN
    CREATE TYPE public.svp_registration_document_kind AS ENUM (
      'PASSPORT',
      'PICTURE',
      'OTHER'
    );
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.svp_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  created_by_account_id TEXT REFERENCES public.accounts(id) ON DELETE SET NULL,

  status public.svp_registration_status NOT NULL DEFAULT 'DRAFT',
  current_step TEXT,
  status_message TEXT,
  error_code TEXT,

  -- Encrypted server-side envelope. Never store plaintext PII here.
  pii_ciphertext TEXT NOT NULL,
  pii_key_version TEXT NOT NULL,
  passport_number_hash TEXT NOT NULL,

  -- OCR metadata only; raw OCR content belongs in the encrypted envelope.
  entry_source TEXT NOT NULL DEFAULT 'manual'
    CHECK (entry_source IN ('manual', 'ocr')),
  ocr_confidence NUMERIC(5, 4)
    CHECK (ocr_confidence IS NULL OR (ocr_confidence >= 0 AND ocr_confidence <= 1)),
  ocr_provider TEXT,

  -- External workflow identifiers/status, if returned by the official provider.
  external_registration_id TEXT,
  confirmation_id TEXT,
  external_status TEXT,
  external_email TEXT,

  -- Idempotency prevents duplicate real-account registration attempts.
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT svp_registrations_idempotency_key_unique UNIQUE (owner_account_id, idempotency_key),
  CONSTRAINT svp_registrations_pii_key_version_not_blank CHECK (length(trim(pii_key_version)) > 0),
  CONSTRAINT svp_registrations_hash_not_blank CHECK (length(trim(passport_number_hash)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_svp_registrations_owner_created
  ON public.svp_registrations(owner_account_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_svp_registrations_owner_status
  ON public.svp_registrations(owner_account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_svp_registrations_passport_hash
  ON public.svp_registrations(owner_account_id, passport_number_hash);

CREATE INDEX IF NOT EXISTS idx_svp_registrations_external_id
  ON public.svp_registrations(external_registration_id)
  WHERE external_registration_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_svp_registrations_active_passport
  ON public.svp_registrations(owner_account_id, passport_number_hash)
  WHERE status IN ('DRAFT', 'CONFIRMED', 'QUEUED', 'OTP_REQUIRED', 'PROCESSING');

CREATE TABLE IF NOT EXISTS public.svp_registration_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NOT NULL REFERENCES public.svp_registrations(id) ON DELETE CASCADE,
  owner_account_id TEXT NOT NULL REFERENCES public.accounts(id) ON DELETE RESTRICT,
  kind public.svp_registration_document_kind NOT NULL,

  bucket_id TEXT NOT NULL DEFAULT 'svp-private-documents',
  object_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  sha256 TEXT NOT NULL,
  key_version TEXT NOT NULL,

  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,

  CONSTRAINT svp_registration_documents_path_unique UNIQUE (bucket_id, object_path),
  CONSTRAINT svp_registration_documents_hash_not_blank CHECK (length(trim(sha256)) > 0),
  CONSTRAINT svp_registration_documents_key_version_not_blank CHECK (length(trim(key_version)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_svp_registration_documents_registration
  ON public.svp_registration_documents(registration_id, kind);

CREATE INDEX IF NOT EXISTS idx_svp_registration_documents_owner
  ON public.svp_registration_documents(owner_account_id, uploaded_at DESC);

CREATE TABLE IF NOT EXISTS public.svp_registration_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id UUID NOT NULL REFERENCES public.svp_registrations(id) ON DELETE CASCADE,
  actor_account_id TEXT REFERENCES public.accounts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  from_status public.svp_registration_status,
  to_status public.svp_registration_status,
  step TEXT,
  provider_request_id TEXT,
  -- Must contain metadata only; never put PII, OCR, OTP, passwords, or tokens here.
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_svp_registration_events_registration
  ON public.svp_registration_events(registration_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_svp_registration_events_type
  ON public.svp_registration_events(event_type, created_at DESC);

CREATE OR REPLACE FUNCTION public.svp_registrations_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_svp_registrations_updated_at ON public.svp_registrations;
CREATE TRIGGER trg_svp_registrations_updated_at
  BEFORE UPDATE ON public.svp_registrations
  FOR EACH ROW
  EXECUTE FUNCTION public.svp_registrations_touch_updated_at();

-- Keep document ownership aligned with the registration owner.
CREATE OR REPLACE FUNCTION public.svp_registration_documents_owner_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  registration_owner TEXT;
BEGIN
  SELECT owner_account_id INTO registration_owner
  FROM public.svp_registrations
  WHERE id = NEW.registration_id;

  IF registration_owner IS NULL THEN
    RAISE EXCEPTION 'Registration % does not exist', NEW.registration_id;
  END IF;

  IF NEW.owner_account_id <> registration_owner THEN
    RAISE EXCEPTION 'Document owner must match registration owner';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_svp_registration_documents_owner_guard ON public.svp_registration_documents;
CREATE TRIGGER trg_svp_registration_documents_owner_guard
  BEFORE INSERT OR UPDATE ON public.svp_registration_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.svp_registration_documents_owner_guard();

-- Private bucket. The application must upload through a server-side Edge Function.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'svp-private-documents',
  'svp-private-documents',
  false,
  8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[]
)
ON CONFLICT (id) DO UPDATE
SET public = false,
    file_size_limit = 8388608,
    allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']::text[];

-- Explicitly deny direct client access. service_role bypasses RLS and is used by Edge Functions.
ALTER TABLE public.svp_registrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.svp_registration_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.svp_registration_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.svp_registrations FROM anon, authenticated;
REVOKE ALL ON TABLE public.svp_registration_documents FROM anon, authenticated;
REVOKE ALL ON TABLE public.svp_registration_events FROM anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.svp_registrations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.svp_registration_documents TO service_role;
GRANT SELECT, INSERT ON TABLE public.svp_registration_events TO service_role;

DROP POLICY IF EXISTS "deny anon svp registrations" ON public.svp_registrations;
CREATE POLICY "deny anon svp registrations"
  ON public.svp_registrations FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny authenticated svp registrations" ON public.svp_registrations;
CREATE POLICY "deny authenticated svp registrations"
  ON public.svp_registrations FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny anon svp documents" ON public.svp_registration_documents;
CREATE POLICY "deny anon svp documents"
  ON public.svp_registration_documents FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny authenticated svp documents" ON public.svp_registration_documents;
CREATE POLICY "deny authenticated svp documents"
  ON public.svp_registration_documents FOR ALL TO authenticated USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny anon svp events" ON public.svp_registration_events;
CREATE POLICY "deny anon svp events"
  ON public.svp_registration_events FOR ALL TO anon USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "deny authenticated svp events" ON public.svp_registration_events;
CREATE POLICY "deny authenticated svp events"
  ON public.svp_registration_events FOR ALL TO authenticated USING (false) WITH CHECK (false);

-- The private bucket intentionally has no anon/authenticated Storage policy.
-- Supabase Storage therefore denies direct client access to this bucket by
-- default, while service_role continues to bypass RLS for Edge Functions.

-- No DELETE cascade from account deletion is used for documents because the bucket
-- object itself must be deleted by a server-side retention/deletion job first.
COMMENT ON TABLE public.svp_registrations IS
  'Server-managed SVP registration drafts and workflow state. PII is encrypted in pii_ciphertext.';
COMMENT ON COLUMN public.svp_registrations.pii_ciphertext IS
  'Encrypted PII envelope; decrypt only inside a trusted server-side function.';
COMMENT ON COLUMN public.svp_registrations.passport_number_hash IS
  'Keyed deterministic hash used for deduplication; not a plaintext passport number.';
COMMENT ON TABLE public.svp_registration_documents IS
  'Metadata for private Storage objects; actual document bytes live in svp-private-documents.';
COMMENT ON TABLE public.svp_registration_events IS
  'Metadata-only audit trail; never store PII, OTPs, passwords, tokens, or OCR raw payloads.';
