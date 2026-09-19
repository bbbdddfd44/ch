import { chromium } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const mock = {
  occupation: { id: 78, name: 'Software Developer', raw: { occupation_id: 78, id: 78, name: 'Software Developer', category_id: 78, category_name: 'Information Technology', prometric_codes: [{ code: 'en', english_name: 'English' }] } },
  date: '2026-10-15',
  city: 'Dhaka',
  center: { test_center_id: 55, test_center_name: 'Dhaka TTC Mock Center', city: 'Dhaka' },
  session: { id: 900155, site_id: 55, site_city: 'Dhaka', exam_date: '2026-10-15', start_at: '2026-10-15T09:00:00Z', available_seats: 12, status: 'scheduled', test_center_name: 'Dhaka TTC Mock Center', test_center: { test_center_id: 55, name: 'Dhaka TTC Mock Center', city: 'Dhaka', site_id: 55 } },
};
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ baseURL });
const page = await context.newPage();
const calls = [];

await page.route('**/*', async route => {
  const request = route.request();
  const url = new URL(request.url());
  const path = url.pathname;
  const proxy = path.includes('/svp-proxy') || path.includes('/api/svp');
  calls.push({ method: request.method(), path, body: request.postDataJSON?.() || null });

  if (path.endsWith('/svp-auth/login')) return route.fulfill(json({ ok: true, otpRequired: true, mockOtp: '123456' }));
  if (path.endsWith('/svp-auth/otp-verify')) return route.fulfill(json({ accessToken: 'mock-candidate-token', user: { email: 'mock@example.test' } }));
  if (path.endsWith('/access-auth/me')) return route.fulfill(json({ user: { id: 'mock-user', name: 'Mock Candidate', email: 'mock@example.test', role: 'USER', status: 'ACTIVE', permissions: { 'booking.create': true } } }));
  if (proxy && path.includes('/occupations')) return route.fulfill(json({ occupations: [mock.occupation.raw] }));
  if (proxy && path.includes('/available-dates')) return route.fulfill(json({ available_dates: [{ date: mock.date, city: mock.city }] }));
  if (proxy && path.includes('/test-centers')) return route.fulfill(json({ sites: [mock.center] }));
  if (proxy && path.includes('/t2hub/pacc-exam-sessions')) return route.fulfill(json({ sessions: [mock.session] }));
  if (proxy && path.includes('/exam-sessions/')) return route.fulfill(json({ exam_session: mock.session }));
  if (proxy && path.includes('/exam-session/')) return route.fulfill(json({ exam_session: mock.session }));
  if (proxy && path.includes('/user-balance')) return route.fulfill(json({ balance: 10, reservation_credits: 10, free_certificates: 0 }));
  if (proxy && path.includes('/temporary-seats')) return route.fulfill(json({ hold_id: 'MOCK-HOLD-900155', expires_at: '2026-10-15T09:15:00Z', status: 'held' }));
  if (proxy && path.includes('/exam-reservations') && request.method() === 'POST') return route.fulfill(json({ reservation: { id: 'MOCK-RES-900155', reservation_id: 'MOCK-RES-900155', status: 'confirmed' }, id: 'MOCK-RES-900155' }));
  if (proxy && path.includes('/exam-reservations')) return route.fulfill(json({ reservations: [] }));
  if (path.includes('/rest/v1/section_center_rules') || path.includes('/rest/v1/test_centers')) return route.fulfill(json([]));
  return route.continue();
});

await page.goto('/access/login');
await page.evaluate(() => {
  localStorage.setItem('access_token', 'mock-portal-token');
  localStorage.setItem('accessToken', 'mock-candidate-token');
  localStorage.setItem('access_user', JSON.stringify({ role: 'USER', status: 'ACTIVE', permissions: { 'booking.create': true } }));
  localStorage.setItem('access_login_time', String(Date.now()));
});
await page.goto('/exam/booking');
await page.waitForLoadState('networkidle');

const result = { steps: [], requests: calls };
console.log('PAGE', page.url(), await page.title());
console.log('BODY', (await page.locator('body').innerText()).slice(0, 1200));
console.log('CALLS', JSON.stringify(calls, null, 2));
result.steps.push({ name: 'booking page loads', ok: await page.getByRole('heading', { name: 'Create a new booking' }).isVisible().catch(() => false) });

await page.getByRole('button', { name: /Select occupation/i }).click();
await page.getByRole('button', { name: /Software Developer/i }).click();
result.steps.push({ name: 'occupation selected', ok: await page.getByRole('button', { name: /Software Developer/i }).isVisible().catch(() => false) });

await page.locator('select').nth(0).selectOption(mock.city);
await page.waitForTimeout(500);
console.log('AFTER CITY', (await page.locator('body').innerText()).slice(0, 900));
if (await page.locator('button.bk-input').filter({ hasText: /2026/ }).count() === 0) {
  await page.getByRole('button', { name: /Select available date/i }).click();
  await page.locator('button.bk-cell--available').first().click();
}
result.steps.push({ name: 'city and date selected', ok: (await page.locator('select').nth(0).inputValue()) === mock.city && (await page.locator('button.bk-input').filter({ hasText: /2026/ }).count()) > 0 });

await page.locator('select').nth(1).selectOption(String(mock.center.test_center_id));
await page.locator('select').nth(2).locator(`option[value="${mock.session.id}"]`).waitFor({ state: 'attached', timeout: 5000 });
await page.locator('select').nth(2).selectOption(String(mock.session.id));
result.steps.push({ name: 'test center and exam session selected', ok: (await page.locator('select').nth(1).inputValue()) === '55' && (await page.locator('select').nth(2).inputValue()) === '900155' });

await page.getByRole('button', { name: 'Create hold', exact: true }).click();
await page.getByText(/Hold created/i).waitFor({ timeout: 5000 });
result.steps.push({ name: 'temporary seat hold created', ok: await page.getByText(/MOCK-HOLD-900155|Hold created/i).count() > 0 });

await page.getByRole('button', { name: /Confirm booking/i }).click();
await page.getByText(/MOCK-RES-900155|confirmed|Booking confirmed/i).waitFor({ timeout: 5000 }).catch(() => {});
result.steps.push({ name: 'booking confirmation submitted', ok: await page.getByText(/MOCK-RES-900155|confirmed|Booking confirmed/i).count() > 0 });

result.finalUrl = page.url();
result.apiCalls = calls.filter(c => c.path.includes('/svp-proxy/') || c.path.includes('/api/svp/')).map(c => ({ method: c.method, path: c.path, body: c.body }));
console.log(JSON.stringify(result, null, 2));
await browser.close();

if (result.steps.some(step => !step.ok)) process.exit(1);
