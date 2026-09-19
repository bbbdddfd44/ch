const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;

function getBase() {
  return SUPABASE_URL ? `${SUPABASE_URL}/functions/v1` : "";
}

export function getAccessToken(): string | null {
  return localStorage.getItem("access_token");
}

export function saveAccessToken(token: string) {
  localStorage.setItem("access_token", token);
}

export function clearAccessToken() {
  localStorage.removeItem("access_token");
}

export function getAccessUser(): any | null {
  const raw = localStorage.getItem("access_user");
  return raw ? JSON.parse(raw) : null;
}

export function saveAccessUser(user: any) {
  localStorage.setItem("access_user", JSON.stringify(user));
}

export function clearAccessUser() {
  localStorage.removeItem("access_user");
}

async function doFetch(url: string, opts: RequestInit) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  return { res, data };
}

export async function accessAuthApi<T = any>(action: string, body?: any): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const method = body !== undefined ? "POST" : "GET";
  const { res, data } = await doFetch(`${getBase()}/access-auth${action}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(data?.message || "Request failed"), { status: res.status, data });
  return data as T;
}

export async function accessAdminApi<T = any>(
  path: string,
  opts: { method?: string; body?: any } = {}
): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const { res, data } = await doFetch(`${getBase()}/access-admin${path}`, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(data?.message || "Request failed"), { status: res.status, data });
  return data as T;
}

export async function accessAgencyApi<T = any>(
  path: string,
  opts: { method?: string; body?: any } = {}
): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const { res, data } = await doFetch(`${getBase()}/access-agency${path}`, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(data?.message || "Request failed"), { status: res.status, data });
  return data as T;
}

export async function accessWalletApi<T = any>(
  path: string,
  opts: { method?: string; body?: any } = {}
): Promise<T> {
  const token = getAccessToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const { res, data } = await doFetch(`${getBase()}/access-wallet${path}`, {
    method: opts.method || (opts.body ? "POST" : "GET"),
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(data?.message || "Request failed"), { status: res.status, data });
  return data as T;
}
