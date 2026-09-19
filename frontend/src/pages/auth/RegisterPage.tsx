import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiAuthForm, apiAuthGet } from "@/lib/api";
import { cropPassportPortrait, scanPassport, isSupportedPassportImage, type PassportScanData } from "@/lib/passport-scan-client";
import { completeRegistrationEmail, resolveCountryDialingCode, toApiDate } from "@/lib/registration-payload";
import "@/styles/registration-premium.css";

const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined;

type RecaptchaApi = {
  render: (container: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void; "error-callback": () => void }) => number;
  reset: (widgetId?: number) => void;
};

declare global {
  interface Window { grecaptcha?: RecaptchaApi; }
}

function pickArray(payload: any): any[] {
  for (const value of [payload, payload?.data, payload?.countries, payload?.data?.countries, payload?.items]) if (Array.isArray(value)) return value;
  return [];
}
function deepValue(payload: any, keys: string[]): string {
  const wanted = new Set(keys);
  const queue = [payload];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    for (const [key, value] of Object.entries(current)) {
      if (wanted.has(key) && value !== null && value !== "") return String(value);
      if (value && typeof value === "object") queue.push(value);
    }
  }
  return "";
}
// NOTE: these two lists were previously hardcoded down to a single option
// (the default value) with no other choices selectable. Filled in with the
// standard SVP enum shape (matches the naming pattern of the confirmed
// defaults "middle" / "between_3_and_5") — verify the exact accepted strings
// against the Postman collection / JS bundle before relying on this in prod.
const EDUCATION_LEVELS = [
  { value: "none", label: "No formal education" },
  { value: "primary", label: "Primary school" },
  { value: "middle", label: "Middle school" },
  { value: "secondary", label: "Secondary school" },
  { value: "diploma", label: "Diploma" },
  { value: "bachelor", label: "Bachelor's degree" },
  { value: "master", label: "Master's degree" },
  { value: "doctorate", label: "Doctorate" },
];
const EXPERIENCE_LEVELS = [
  { value: "less_than_1", label: "Less than 1 year" },
  { value: "between_1_and_3", label: "Between 1 and 3 years" },
  { value: "between_3_and_5", label: "Between 3 and 5 years" },
  { value: "between_5_and_10", label: "Between 5 and 10 years" },
  { value: "more_than_10", label: "More than 10 years" },
];
// These three are the values already confirmed from reverse-engineering
// (the previous hardcoded default). Exposed as togglable checkboxes since
// the field is sent as a comma-joined list.
const KNOWLEDGE_LEVELS = [
  { value: "erudite", label: "Erudite" },
  { value: "experienced", label: "Experienced" },
  { value: "certificated", label: "Certificated" },
];

export default function RegisterPage() {
  const navigate = useNavigate();
  const [step, setStep] = useState(1);
  const [countries, setCountries] = useState<any[]>([]);
  const [nationalities, setNationalities] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [confirmationId, setConfirmationId] = useState("");
  const [form, setForm] = useState<Record<string, string>>({ country_id:"", country_code:"", nationality_id:"", national_id:"", first_name:"", last_name:"", date_of_birth:"", passport_number:"", passport_expiration_date:"", sex:"male", email:"", phone_number:"", password:"", password_confirmation:"", otp_attempt:"", education_level:"middle", experience_level:"between_3_and_5", knowledge_level:"erudite,experienced,certificated", institute_name:"Bureau of Manpower, Employment and Training (BMET)", recaptcha_response:"" });
  const [passportFile, setPassportFile] = useState<File | null>(null);
  const [profileImage, setProfileImage] = useState<File | null>(null);
  const [profilePreview, setProfilePreview] = useState("");
  const [profileMessage, setProfileMessage] = useState("");
  const [emailUsername, setEmailUsername] = useState("");
  const [scanStatus, setScanStatus] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const [scanMessage, setScanMessage] = useState("");
  const [pendingNationalityCode, setPendingNationalityCode] = useState("");
  const [recaptchaReady, setRecaptchaReady] = useState(false);
  const [recaptchaError, setRecaptchaError] = useState("");
  const recaptchaHost = useRef<HTMLDivElement | null>(null);
  const recaptchaWidgetId = useRef<number | null>(null);
  const selectedCountry = useMemo(() => countries.find((item) => String(item.id) === form.country_id), [countries, form.country_id]);
  const selectedKnowledge = useMemo(() => new Set(form.knowledge_level ? form.knowledge_level.split(",") : []), [form.knowledge_level]);
  const passwordMismatch = form.password_confirmation.length > 0 && form.password !== form.password_confirmation;

  useEffect(() => {
    apiAuthGet("/registration/countries").then((data) => {
      const list = pickArray(data);
      setCountries(list);
      const bangladesh = list.find((country) => {
        const code = String(country.country_code || country.code || country.iso2 || "").toUpperCase();
        const name = String(country.english_name || country.name || "").toUpperCase();
        return code === "BGD" || code === "BD" || name === "BANGLADESH";
      });
      if (bangladesh) {
        const dialingCode = resolveCountryDialingCode(bangladesh);
        setPendingNationalityCode("BGD");
        setForm((old) => old.country_id ? old : {
          ...old,
          country_id: String(bangladesh.id),
          country_code: dialingCode,
          phone_number: old.phone_number || dialingCode,
          nationality_id: "",
        });
      }
    }).catch((err) => setMessage(err.message));
  }, []);
  useEffect(() => {
    if (!form.country_id) { setNationalities([]); return; }
    apiAuthGet<any>(`/registration/countries/${encodeURIComponent(form.country_id)}`)
      .then((data) => {
        const list = data?.nationalities || data?.data?.nationalities || [];
        setNationalities(list);
        if (pendingNationalityCode) {
          const match = list.find((n: any) => [n.code, n.nationality_code, n.iso3, n.alpha3].some((c) => String(c || "").toUpperCase() === pendingNationalityCode));
          if (match) update("nationality_id", String(match.id));
          setPendingNationalityCode("");
        }
      })
      .catch((err) => { setNationalities([]); setMessage(err.message); });
  }, [form.country_id]);
  useEffect(() => () => { if (profilePreview) URL.revokeObjectURL(profilePreview); }, [profilePreview]);
  useEffect(() => {
    if (!RECAPTCHA_SITE_KEY) return;
    if (window.grecaptcha) { setRecaptchaReady(true); return; }
    const existing = document.querySelector<HTMLScriptElement>('script[data-recaptcha-api="true"]');
    const onLoad = () => setRecaptchaReady(true);
    const onError = () => setRecaptchaError("Google reCAPTCHA could not be loaded. Check your connection and disable blockers for this page.");
    if (existing) {
      existing.addEventListener("load", onLoad);
      existing.addEventListener("error", onError);
      return () => { existing.removeEventListener("load", onLoad); existing.removeEventListener("error", onError); };
    }
    const script = document.createElement("script");
    script.src = "https://www.google.com/recaptcha/api.js?render=explicit";
    script.async = true; script.defer = true; script.dataset.recaptchaApi = "true";
    script.addEventListener("load", onLoad); script.addEventListener("error", onError);
    document.head.appendChild(script);
    return () => { script.removeEventListener("load", onLoad); script.removeEventListener("error", onError); };
  }, []);
  useEffect(() => {
    if (step !== 2) recaptchaWidgetId.current = null;
  }, [step]);
  useEffect(() => {
    if (step !== 2 || !recaptchaReady || !RECAPTCHA_SITE_KEY || !window.grecaptcha || !recaptchaHost.current || recaptchaWidgetId.current !== null) return;
    recaptchaWidgetId.current = window.grecaptcha.render(recaptchaHost.current, {
      sitekey: RECAPTCHA_SITE_KEY,
      callback: (token) => { update("recaptcha_response", token); setRecaptchaError(""); },
      "expired-callback": () => { update("recaptcha_response", ""); setRecaptchaError("The reCAPTCHA check expired. Please complete it again."); },
      "error-callback": () => { update("recaptcha_response", ""); setRecaptchaError("reCAPTCHA could not verify your response. Please try again."); },
    });
  }, [step, recaptchaReady]);
  function update(key: string, value: string) { setForm((old) => ({ ...old, [key]: value })); }
  function toggleKnowledge(value: string) {
    setForm((old) => {
      const current = new Set(old.knowledge_level ? old.knowledge_level.split(",") : []);
      if (current.has(value)) current.delete(value); else current.add(value);
      return { ...old, knowledge_level: Array.from(current).join(",") };
    });
  }
  async function handlePassportFile(file: File | null) {
    setPassportFile(file);
    if (!file) { setScanStatus("idle"); setScanMessage(""); return; }
    if (!isSupportedPassportImage(file)) {
      setPassportFile(null);
      setScanStatus("error"); setScanMessage("Use one JPEG, PNG or WEBP image of the passport biodata page with both MRZ lines. PDFs and combined personal-data documents are not accepted.");
      return;
    }
    setScanStatus("scanning"); setScanMessage("Reading passport…");
    try {
      const data: PassportScanData = await scanPassport(file);
      setForm((old) => ({
        ...old,
        passport_number: data.passport_number || old.passport_number,
        first_name: data.first_name || old.first_name,
        last_name: data.last_name || old.last_name,
        date_of_birth: data.date_of_birth || old.date_of_birth,
        passport_expiration_date: data.passport_expiration_date || old.passport_expiration_date,
        national_id: data.national_id || old.national_id,
        sex: data.sex || old.sex,
      }));
      if (data.country_code) {
        const match = countries.find((c) => [c.code, c.country_code, c.iso2, c.alpha2].some((v) => String(v || "").toUpperCase() === data.country_code.toUpperCase()));
        if (match) {
          setForm((old) => ({ ...old, country_id: String(match.id), country_code: resolveCountryDialingCode(match), nationality_id: "" }));
          if (data.nationality_code) setPendingNationalityCode(data.nationality_code.toUpperCase());
        }
      }
      const portrait = await cropPassportPortrait(file, data.portrait_box || []);
      if (portrait) {
        setProfileImage(portrait);
        setProfilePreview(URL.createObjectURL(portrait));
        setProfileMessage("Face cropped automatically from the passport. Review it or choose a different profile photo.");
      } else {
        setProfileMessage("Face could not be cropped reliably. Please choose a clear profile photo manually.");
      }
      const extraFields = [data.national_id ? "National ID" : "", portrait ? "profile photo" : ""].filter(Boolean);
      if (data.confidence === "low") {
        setScanStatus("error"); setScanMessage("Passport read with low confidence — please double check the auto-filled fields below.");
      } else {
        setScanStatus("done"); setScanMessage(`Auto-filled from this passport${extraFields.length ? `, including ${extraFields.join(" and ")}` : ""}. Please review before continuing.${data.national_id ? "" : " This passport has no readable separate National ID, so enter it manually."}`);
      }
    } catch (err: any) {
      setScanStatus("error"); setScanMessage(err?.message || "Auto-fill failed — please enter your details manually.");
    }
  }
  function handleProfileFile(file: File | null) {
    setProfileImage(file);
    setProfilePreview(file ? URL.createObjectURL(file) : "");
    setProfileMessage(file ? "Profile photo selected manually." : "");
  }
  function handleEmailUsername(value: string) {
    setEmailUsername(value);
    update("email", completeRegistrationEmail(value));
  }
  function appendCommon(data: FormData) {
    Object.entries(form).forEach(([key, value]) => { if (value) data.append(key, value); });
    data.set("country_code", form.country_code || selectedCountry?.code || selectedCountry?.country_code || "");
    data.set("first_name_not_specified", "false"); data.set("last_name_not_specified", "false");
    // Confirmed from the captured Postman traffic: SVP expects DD/MM/YYYY here,
    // not the ISO (YYYY-MM-DD) format that native <input type="date"> produces.
    if (form.date_of_birth) data.set("date_of_birth", toApiDate(form.date_of_birth));
    if (form.passport_expiration_date) data.set("passport_expiration_date", toApiDate(form.passport_expiration_date));
    if (passportFile) data.set("file", passportFile); if (profileImage) data.set("image", profileImage);
  }
  async function validateIdentity(e: React.FormEvent) {
    e.preventDefault();
    // SVP's validation endpoint requires the passport document in the `file`
    // multipart part.  Sending an empty part (as in the captured request)
    // produces an opaque upstream validation error, so stop it locally.
    if (!passportFile || passportFile.size === 0) {
      setMessage("Upload one non-empty passport biodata-page image showing both MRZ lines before validating your identity.");
      return;
    }
    if (!isSupportedPassportImage(passportFile)) {
      setMessage("SVP requires a single JPEG, PNG or WEBP passport biodata page with the two MRZ lines. Do not upload a PDF, personal-data page, or combined document.");
      return;
    }
    if (scanStatus !== "done") {
      setMessage("Scan the single passport biodata page successfully before validating. The two MRZ lines must be visible.");
      return;
    }
    setLoading(true); setMessage("Validating identity with live SVP…");
    try {
      const data = new FormData(); appendCommon(data); data.set("step", "passport_info");
      const result = await apiAuthForm<any>("/registration/validate", data);
      setConfirmationId(deepValue(result, ["confirmation_id", "confirmationId", "id"]));
      setStep(2); setMessage("Identity accepted. Complete your account and verification details.");
    } catch (err: any) { setMessage(err?.data?.details?.message || err?.message || "Validation failed"); }
    finally { setLoading(false); }
  }
  async function register(e: React.FormEvent) {
    e.preventDefault();
    if (form.password !== form.password_confirmation) { setMessage("Passwords do not match."); return; }
    if (!RECAPTCHA_SITE_KEY) { setMessage("Registration is unavailable because reCAPTCHA has not been configured for this site."); return; }
    if (!form.recaptcha_response) { setMessage("Complete the reCAPTCHA check before registering."); return; }
    setLoading(true); setMessage("Creating your labor account in live SVP…");
    try {
      const data = new FormData(); appendCommon(data);
      const registrationEmail = completeRegistrationEmail(emailUsername || form.email);
      data.set("email", registrationEmail);
      if (confirmationId) data.set("confirmation_id", confirmationId);
      // Confirmed from captured traffic: contact_to_confirm is the contact-method
      // enum ("email"), not the actual email address — sending the raw email here
      // was a bug that would likely be silently rejected or ignored by the API.
      data.set("contact_to_confirm", "email"); data.set("preferable_contact", "email");
      data.set("terms_and_privacy_accepted", "true"); data.set("data_accuracy_acknowledged", "true"); data.set("onboarding_video_seen", "false"); data.set("step", "contact_confirmation");
      await apiAuthForm("/registration", data);
      sessionStorage.setItem("portal_login", registrationEmail); sessionStorage.setItem("portal_password", form.password);
      setStep(3); setMessage("Registration completed. Continue to login and OTP verification.");
    } catch (err: any) { setMessage(err?.data?.details?.message || err?.message || "Registration failed"); }
    finally { setLoading(false); }
  }

  return <main className="rg-shell"><section className="rg-panel"><header><span>SVP LABOR ONBOARDING</span><h1>Create your accreditation account</h1><p>Live registration, identity validation and OTP handoff through the official SVP APIs.</p></header><div className="rg-progress"><b className={step>=1?"on":""}>1 <small>Identity</small></b><i/><b className={step>=2?"on":""}>2 <small>Account</small></b><i/><b className={step>=3?"on":""}>3 <small>Complete</small></b></div>
    {step===1 && <form onSubmit={validateIdentity} className="rg-form"><h2>Personal & passport information</h2><div className="rg-grid">
      <label>Country<select required value={form.country_id} onChange={(e)=>{const c=countries.find(x=>String(x.id)===e.target.value);setForm((old)=>({...old,country_id:e.target.value,country_code:resolveCountryDialingCode(c),nationality_id:""}));}}><option value="">Select country</option>{countries.map(c=><option key={c.id} value={c.id}>{c.name||c.english_name}</option>)}</select><small>Bangladesh is selected by default with country code +880.</small></label>
      <label>Nationality<select required disabled={!form.country_id} value={form.nationality_id} onChange={(e)=>update("nationality_id",e.target.value)}><option value="">{form.country_id?"Select nationality":"Select country first"}</option>{nationalities.map(n=><option key={n.id} value={n.id}>{n.english_name||n.arabic_name}</option>)}</select></label>
      <label>First name<input required value={form.first_name} onChange={(e)=>update("first_name",e.target.value)}/></label><label>Last name<input required value={form.last_name} onChange={(e)=>update("last_name",e.target.value)}/></label>
      <label>Date of birth<input required type="date" value={form.date_of_birth} onChange={(e)=>update("date_of_birth",e.target.value)}/></label><label>Sex<select value={form.sex} onChange={(e)=>update("sex",e.target.value)}><option value="male">Male</option><option value="female">Female</option></select></label>
      <label>Passport number<input required value={form.passport_number} onChange={(e)=>update("passport_number",e.target.value)}/></label><label>Passport expiration<input required type="date" value={form.passport_expiration_date} onChange={(e)=>update("passport_expiration_date",e.target.value)}/></label>
      <label>National ID / Personal number<input required value={form.national_id} onChange={(e)=>update("national_id",e.target.value)} placeholder="Auto-filled only from this passport"/><small>Passport source only. No separate NID document is scanned.</small></label>
      <label>Passport biodata / MRZ page<input required type="file" accept="image/jpeg,image/png,image/webp" onChange={(e)=>handlePassportFile(e.target.files?.[0]||null)}/><small>Required: upload only one clear image of the passport biodata/photo page with both MRZ lines visible at the bottom. Do not upload the personal-data page, a PDF, or a combined document.</small></label><label>Profile image{profilePreview && <img style={{display:"block",width:112,height:132,margin:"8px 0 10px",borderRadius:12,objectFit:"cover"}} src={profilePreview} alt="Profile preview"/>}<input type="file" accept="image/*" onChange={(e)=>handleProfileFile(e.target.files?.[0]||null)}/><small>{profileMessage || "Your face will be cropped from the passport automatically when detected; you can replace it here."}</small></label>
      {scanStatus!=="idle" && <div className={`rg-wide rg-scan-status rg-scan-${scanStatus}`}>{scanStatus==="scanning"?"⏳ ":scanStatus==="done"?"✓ ":scanStatus==="error"?"⚠ ":""}{scanMessage}</div>}
    </div><button disabled={loading}>{loading?"Validating…":"Validate and continue"}</button></form>}
    {step===2 && <form onSubmit={register} className="rg-form"><h2>Account & professional details</h2><div className="rg-grid">
      <label>Email username<input required value={emailUsername} onChange={(e)=>handleEmailUsername(e.target.value)} placeholder="abdurrazzak3346"/><small>{completeRegistrationEmail(emailUsername) || "Type a username — @yopmail.com will be added automatically."}</small></label>
      <label>Phone number<input required type="tel" value={form.phone_number} onChange={(e)=>update("phone_number",e.target.value)}/></label>
      <label>Password<input required minLength={8} type="password" value={form.password} onChange={(e)=>update("password",e.target.value)}/></label>
      <label>Confirm password<input required minLength={8} type="password" value={form.password_confirmation} onChange={(e)=>update("password_confirmation",e.target.value)}/>{passwordMismatch && <small className="rg-error">Passwords do not match.</small>}</label>
      <label>OTP code (if sent)<input value={form.otp_attempt} onChange={(e)=>update("otp_attempt",e.target.value)}/></label>
      <label>Education level<select required value={form.education_level} onChange={(e)=>update("education_level",e.target.value)}>{EDUCATION_LEVELS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label>Experience level<select required value={form.experience_level} onChange={(e)=>update("experience_level",e.target.value)}>{EXPERIENCE_LEVELS.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>
      <label className="rg-wide">Knowledge level<div className="rg-checkgroup">{KNOWLEDGE_LEVELS.map(o=><label key={o.value} className="rg-checkbox"><input type="checkbox" checked={selectedKnowledge.has(o.value)} onChange={()=>toggleKnowledge(o.value)}/>{o.label}</label>)}</div></label>
      <label>Institute name<input required value={form.institute_name} onChange={(e)=>update("institute_name",e.target.value)}/><small>Confirmed from live traffic: SVP expects the fixed government labor bureau name here, not a personal institute — only change this if you know your case is different.</small></label>
      <div className="rg-wide"><label>Security verification (required by SVP)</label>{RECAPTCHA_SITE_KEY ? <><div ref={recaptchaHost}/>{!recaptchaReady && !recaptchaError && <small>Loading reCAPTCHA…</small>}{recaptchaError && <small className="rg-error">{recaptchaError}</small>}</> : <small className="rg-error">reCAPTCHA is not configured. Set VITE_RECAPTCHA_SITE_KEY to a site key registered for this application’s deployed domain, then rebuild.</small>}</div>
    </div><div className="rg-actions"><button type="button" onClick={()=>{update("recaptcha_response", "");setStep(1);}}>Back</button><button disabled={loading || passwordMismatch}>{loading?"Creating…":"Complete registration"}</button></div></form>}
    {step===3 && <div className="rg-complete"><strong>✓</strong><h2>Registration submitted</h2><p>Your account is ready for the official login and OTP verification flow.</p><button onClick={()=>navigate("/auth/login")}>Continue to login</button></div>}
    {message&&<div className="rg-message">{message}</div>}<footer>Already registered? <Link to="/auth/login">Sign in</Link></footer></section></main>;
}
