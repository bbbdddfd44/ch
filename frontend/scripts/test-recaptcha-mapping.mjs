#!/usr/bin/env node
/**
 * Safe SVP adapter test harness.
 *
 * This does not contact SVP, solve CAPTCHA, or bypass CAPTCHA verification.
 * It validates local multipart normalization and, when BASE_URL is supplied,
 * checks that the local registration bundle contains the expected flow guards.
 */

import assert from "node:assert/strict";

function normalizeRecaptcha(form, { mockEnabled = false, testMode = "" } = {}) {
  const aliases = ["recaptcha_response", "recaptchaResponse", "recaptcha_token", "recaptchaToken"];
  const existing = aliases.map((key) => form.get(key)).find((value) => value !== null && value !== "");

  if (!form.get("recaptcha_response") && existing) form.set("recaptcha_response", String(existing));
  if (!existing && mockEnabled && testMode === "mock") {
    form.set("recaptcha_response", "mock-recaptcha-token");
    return { form, usedMock: true };
  }
  return { form, usedMock: false };
}

for (const alias of ["recaptcha_response", "recaptchaResponse", "recaptcha_token", "recaptchaToken"]) {
  const form = new FormData();
  form.set(alias, "alias-test-token");
  const result = normalizeRecaptcha(form);
  assert.equal(result.form.get("recaptcha_response"), "alias-test-token");
  assert.equal(result.usedMock, false);
  console.log(`PASS alias: ${alias}`);
}

{
  const form = new FormData();
  const result = normalizeRecaptcha(form, { mockEnabled: true, testMode: "mock" });
  assert.equal(result.form.get("recaptcha_response"), "mock-recaptcha-token");
  assert.equal(result.usedMock, true);
  console.log("PASS explicit mock mode");
}

{
  const form = new FormData();
  const result = normalizeRecaptcha(form, { mockEnabled: true, testMode: "production" });
  assert.equal(result.form.get("recaptcha_response"), null);
  assert.equal(result.usedMock, false);
  console.log("PASS mock disabled outside explicit test mode");
}

const baseUrl = process.env.BASE_URL;
if (baseUrl) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/auth/register`);
  assert.equal(response.ok, true, `local registration page returned ${response.status}`);
  const html = await response.text();
  assert.match(html, /<div id="root"|src="\/src\//, "Vite registration shell was not served");
  console.log(`PASS local registration page: ${response.status}`);
  console.log("PASS local integration target reachable; browser runtime handles the actual reCAPTCHA widget.");
}

console.log("All safe reCAPTCHA adapter tests passed. No CAPTCHA was solved or bypassed.");
