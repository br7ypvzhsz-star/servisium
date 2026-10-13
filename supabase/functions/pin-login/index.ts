// SERVISIUM · pin-login — exchanges a staff PIN for a real Supabase session.
// verify_jwt = false (the caller has no session yet). Uses the service role only server-side.
// Brute-force protection lives in the database (svc_pin_login_check / svc_pin_login_record).
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  let pin = "";
  try {
    const body = await req.json();
    pin = String(body?.pin ?? "").trim();
  } catch (_) {
    return json({ error: "bad_request" }, 400);
  }
  if (!/^[0-9]{4,8}$/.test(pin)) return json({ error: "invalid_pin" }, 400);

  const ip = (req.headers.get("x-forwarded-for") ?? "unknown").split(",")[0].trim();

  const { data: allowed, error: chkErr } = await admin.rpc("svc_pin_login_check", { p_ip: ip });
  if (chkErr) return json({ error: "server_error" }, 500);
  if (allowed === false) return json({ error: "too_many_attempts" }, 429);

  const { data: found, error: findErr } = await admin.rpc("svc_pin_find_staff", { p_pin: pin });
  if (findErr) return json({ error: "server_error" }, 500);
  const staff = Array.isArray(found) ? found[0] : found;
  if (!staff || !staff.id) {
    await admin.rpc("svc_pin_login_record", { p_ip: ip, p_ok: false });
    return json({ error: "invalid_credentials" }, 401);
  }
  await admin.rpc("svc_pin_login_record", { p_ip: ip, p_ok: true });

  // Synthetic auth user per staff member; linked through restaurant_staff.auth_user_id.
  const email = `staff-${staff.id}@staff.servisium.invalid`;
  let authId: string | null = staff.auth_user_id ?? null;

  if (!authId) {
    const created = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { staff_id: staff.id, kind: "pin" },
    });
    if (created.error || !created.data.user) {
      // may already exist from an earlier half-finished attempt
      const list = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const hit = list.data?.users?.find((u) => u.email === email);
      if (!hit) return json({ error: "server_error" }, 500);
      authId = hit.id;
    } else {
      authId = created.data.user.id;
    }
    const { error: linkErr } = await admin.from("restaurant_staff").update({ auth_user_id: authId }).eq("id", staff.id);
    if (linkErr) return json({ error: "server_error" }, 500);
  }

  // Mint a session without a password: magic link token verified server-side.
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return json({ error: "server_error" }, 500);

  const anon = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await anon.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (verified.error || !verified.data.session) return json({ error: "server_error" }, 500);

  const s = verified.data.session;
  return json({
    access_token: s.access_token,
    refresh_token: s.refresh_token,
    expires_in: s.expires_in,
    expires_at: s.expires_at,
    staff_id: staff.id,
  });
});
