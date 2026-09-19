import { Router } from 'express';
import multer from 'multer';
import { GoogleGenAI } from '@google/genai';

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const ACCEPTED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png', 'image/webp']);
const MAX_BYTES = 8 * 1024 * 1024; // 8 MB

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

export function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return '';
}

const SYSTEM_PROMPT = `You are a passport data extractor. You receive a single passport image and return ONLY a JSON object (no markdown, no prose, no code fences) with the fields listed below. If you cannot read a field reliably, use an empty string ""; do NOT invent data.

Return this exact schema:
{
  "passport_number": "string (uppercase, alphanumeric only, e.g. BC1234567)",
  "first_name": "string (given names in UPPERCASE, English/Latin only; if there is no dedicated last-name field, put ALL names here)",
  "last_name": "string (surname in UPPERCASE, English/Latin only; empty string if not separately printed)",
  "date_of_birth": "ISO date YYYY-MM-DD",
  "passport_expiration_date": "ISO date YYYY-MM-DD",
  "national_id": "National ID, Personal No., Personal Number, or holder identity number printed on this passport; uppercase without spaces; empty when absent",
  "sex": "male | female (lowercase; do not use M/F, do not translate)",
  "nationality_code": "3-letter ISO code, uppercase (BGD, SAU, IND, PAK, EGY, ...)",
  "country_code": "2-letter ISO code, uppercase (BD, SA, IN, PK, EG, ...)",
  "issuing_country": "country name in UPPERCASE English (BANGLADESH, SAUDI ARABIA, ...)",
  "portrait_box": [100, 100, 700, 450],
  "confidence": "high | medium | low (your own honest self-rating of the extraction quality)",
  "mrz_present": true
}

Rules:
- The MRZ (2 lines at the bottom of the passport photo page) is usually the most reliable source -- prefer it when it disagrees with the visual page.
- Dates in the MRZ are YYMMDD; convert them to YYYY-MM-DD. For birth dates, if the 2-digit year is >= current YY, treat it as 19YY; otherwise 20YY. For expiration dates, always treat as 20YY.
- "SEX" field in the MRZ is M or F -- convert to "male" or "female".
- Extract national_id only from a separate identifier visibly printed on this passport. Never use another document and never copy the passport number into national_id.
- Set mrz_present to true only when the two machine-readable-zone lines are visibly present on this single biodata/photo page. A personal-data page, portrait-only image, cropped upper page, or combined multi-page document must be false.
- portrait_box must be an array of four integers in [ymin, xmin, ymax, xmax] order, normalized from 0 to 1000. It must tightly contain the printed holder portrait/photo, not the full passport page. Return [] when no portrait is visible.
- Do NOT return markdown or code fences. Return the JSON object and nothing else.`;

const EMPTY_RESULT = Object.freeze({
  passport_number: '',
  first_name: '',
  last_name: '',
  date_of_birth: '',
  passport_expiration_date: '',
  national_id: '',
  sex: '',
  nationality_code: '',
  country_code: '',
  issuing_country: '',
  portrait_box: [],
  confidence: 'low',
  mrz_present: false,
  raw: '',
});

let genAiClient = null;
function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const err = new Error('GEMINI_API_KEY is not configured on the backend.');
    err.statusCode = 502;
    throw err;
  }
  if (!genAiClient) genAiClient = new GoogleGenAI({ apiKey });
  return genAiClient;
}

function parseJsonBlock(text) {
  if (!text) return null;
  let stripped = text.trim();
  if (stripped.startsWith('```')) {
    stripped = stripped.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(stripped);
  } catch {
    // fall through to brace extraction
  }
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizePortraitBox(value) {
  if (!Array.isArray(value) || value.length !== 4) return [];
  const box = value.map((coordinate) => Math.max(0, Math.min(1000, Math.round(Number(coordinate)))));
  if (!box.every(Number.isFinite)) return [];
  const [ymin, xmin, ymax, xmax] = box;
  if (ymax - ymin < 30 || xmax - xmin < 30) return [];
  return box;
}

export function coercePassportData(data) {
  const s = (key, upper = false) => {
    const v = data?.[key];
    if (v === null || v === undefined) return '';
    const out = String(v).trim();
    return upper ? out.toUpperCase() : out;
  };
  const mrzValue = data?.mrz_present;
  const mrzPresent = mrzValue === true || ['true', 'yes', 'present'].includes(String(mrzValue || '').trim().toLowerCase());
  const out = {
    passport_number: s('passport_number', true).replace(/\s+/g, ''),
    first_name: s('first_name', true),
    last_name: s('last_name', true),
    date_of_birth: s('date_of_birth'),
    passport_expiration_date: s('passport_expiration_date'),
    national_id: s('national_id', true).replace(/\s+/g, ''),
    sex: s('sex').toLowerCase(),
    nationality_code: s('nationality_code', true),
    country_code: s('country_code', true),
    issuing_country: s('issuing_country', true),
    portrait_box: normalizePortraitBox(data?.portrait_box),
    confidence: s('confidence').toLowerCase() || 'low',
    mrz_present: mrzPresent,
  };
  const isoDate = /^\d{4}-\d{2}-\d{2}$/;
  if (!isoDate.test(out.date_of_birth)) out.date_of_birth = '';
  if (!isoDate.test(out.passport_expiration_date)) out.passport_expiration_date = '';
  if (out.sex !== 'male' && out.sex !== 'female') out.sex = '';
  if (!['high', 'medium', 'low'].includes(out.confidence)) out.confidence = 'low';
  return out;
}

router.post('/passport-scan', upload.single('file'), async (req, res, next) => {
  try {
    const file = req.file;
    if (!file) {
      const err = new Error('No file uploaded. Send the passport image under the "file" field.');
      err.statusCode = 400;
      throw err;
    }
    const mime = detectImageMime(file.buffer);
    if (!ACCEPTED_MIME.has(mime)) {
      const err = new Error('Unsupported or invalid file. Please upload a real JPEG, PNG or WEBP passport photo.');
      err.statusCode = 415;
      throw err;
    }

    const client = getClient();
    const base64Data = file.buffer.toString('base64');

    let response;
    try {
      response = await client.models.generateContent({
        model: GEMINI_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: base64Data, mimeType: mime } },
              { text: 'Extract the passport fields from this image and return the JSON object only.' },
            ],
          },
        ],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0,
        },
      });
    } catch (geminiErr) {
      const err = new Error('Passport auto-fill service is temporarily unavailable. Please enter your details manually.');
      err.statusCode = 502;
      err.details = geminiErr?.message;
      throw err;
    }

    const rawText = response?.text || '';
    const parsed = parseJsonBlock(rawText);
    const data = parsed ? coercePassportData(parsed) : { ...EMPTY_RESULT };
    data.raw = rawText.slice(0, 4000);

    res.json({ ok: true, data });
  } catch (err) {
    next(err);
  }
});

// Multer errors (e.g. file too large) don't carry statusCode by default.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const statusCode = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return res.status(statusCode).json({ message: err.message });
  }
  next(err);
});

export { router as passportRouter };
