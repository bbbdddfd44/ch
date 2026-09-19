# Local Mocked Booking Workflow Test

**Repository:** `abdurrazzak2895-debug/ch`  
**Branch:** `agents/hi`  
**Environment:** Local Vite app at `http://127.0.0.1:3000`  
**Date:** 2026-09-18

## Result

The browser workflow passed end to end using Playwright route mocks. No YOPmail, live SVP authentication, live booking API, reservation, payment, or external hold was created.

| Step | Result |
|---|---|
| Booking page loads | Passed |
| Mocked authentication/session accepted | Passed |
| Occupation selected: Software Developer | Passed |
| City selected: Dhaka | Passed |
| Available date selected: 2026-10-15 | Passed |
| Test centre selected: Dhaka TTC Mock Center, site 55 | Passed |
| Exam session selected: 900155 | Passed |
| Temporary seat hold created | Passed; mock hold `MOCK-HOLD-900155` |
| Booking confirmation submitted | Passed; mock reservation `MOCK-RES-900155` |

## Mocked payloads

The harness used deterministic local fixtures for occupation `78`, centre `55`, exam session `900155`, hold `MOCK-HOLD-900155`, and reservation `MOCK-RES-900155`. Auth uses a local mock session and does not contact YOPmail.

## Additional validation

The repository’s existing Vitest suite also passed: **23 test files and 131 tests**.

## Harness

The reusable Playwright harness is [`frontend/scripts/mock-booking-e2e.mjs`](./frontend/scripts/mock-booking-e2e.mjs). It intercepts the app’s auth, SVP proxy, hold, reservation, and local Supabase requests and fails if any workflow step is unsuccessful.
