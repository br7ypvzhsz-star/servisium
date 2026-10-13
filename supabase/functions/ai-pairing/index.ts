// SERVISIUM · ai-pairing — SERVISIUM AI sommelier / pairing agent (task 66, instruction §6).
// verify_jwt = false: the caller's session is checked here (my_profile), like analyze-hall-ai.
// Facts come from the venue menu only. The model may only CHOOSE among candidate ids we send and
// explain why; names, prices and allergens in the response are re-read from the database.
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// flash-lite first: the waiter needs an answer in 5–10 s (handoff); heavier models are fallbacks.
const MODEL = Deno.env.get("PAIRING_AI_MODEL") || "gemini-3.5-flash-lite";
const FALLBACK_MODELS = [MODEL, "gemini-3.5-flash", "gemini-3.6-flash"];
const ATTEMPT_TIMEOUT_MS = 9000;
const MAX_CANDIDATES = 100;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });

type MenuRow = {
  id: number; name: string; type: string | null; category: string | null; description: string | null;
  price: number | null; weight: string | null; country: string | null; menu: string | null;
  allergens: string[] | null; allergens_status: string | null;
};

const ALLERGEN_UA: Record<string, string> = {
  gluten: "глютен", crustaceans: "ракоподібні", eggs: "яйця", fish: "риба", peanuts: "арахіс", soy: "соя",
  milk: "молоко", tree_nuts: "горіхи", celery: "селера", mustard: "гірчиця", sesame: "кунжут",
  sulphites: "сульфіти", lupin: "люпин", molluscs: "молюски",
};

const clip = (s: unknown, n: number) =>
  String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const isBar = (m: MenuRow) => m.type === "Бар";

function describe(m: MenuRow) {
  return {
    id: m.id, name: clip(m.name, 120), kind: isBar(m) ? "drink" : "food",
    category: clip(m.category, 60), menu: clip(m.menu, 60), country: clip(m.country, 40),
    price: m.price, portion: clip(m.weight, 30), description: clip(m.description, 220),
  };
}

const responseSchema = {
  type: "object",
  properties: {
    recommendations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          menu_item_id: { type: "integer" },
          role: { type: "string", enum: ["best", "alternative", "addon"] },
          pairs_with: { type: "string", description: "Name of the cart item this recommendation is for." },
          reason: { type: "string", description: "1–2 sentences, Ukrainian, based only on the given data." },
          guest_phrase: { type: "string", description: "One short phrase the waiter can say to the guest, Ukrainian." },
        },
        required: ["menu_item_id", "role", "reason", "guest_phrase"],
      },
    },
    data_gaps: { type: "string", description: "What data is missing to recommend confidently (Ukrainian), or empty." },
  },
  required: ["recommendations", "data_gaps"],
};

const SYSTEM = `Ти — SERVISIUM AI, помічник офіціанта з поєднань страв і напоїв.
ПРАВИЛА:
1. Обирай ЛИШЕ з наданого списку CANDIDATES за їхнім id. Ніколи не вигадуй позиції, ціни, склад, вінтаж, сорт чи походження.
2. Пояснення — тільки з наданих полів (назва, категорія, меню, країна, опис, порція) і загальновідомих принципів поєднання. Якщо даних мало — коротко скажи це в data_gaps і не вигадуй.
3. Для кожної позиції з CART (або для FOCUS) дай 1 найкращий вибір (role=best) і до 2 альтернатив (role=alternative); за потреби до 2 доречних доповнень (role=addon).
4. Враховуй бюджет (якщо заданий) і побажання гостя.
5. Мова — українська. reason: 1–2 речення. guest_phrase: одна коротка фраза для гостя, без гарантій щодо алергенів.
6. Не згадуй алергени як «безпечно» — фільтрацію алергенів робить система.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  // ---- who is calling ----
  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) return json({ success: false, error: "unauthorized" }, 401);
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
  const userDb = createClient(SUPABASE_URL, anonKey, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await userDb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (userErr || !userData?.user) return json({ success: false, error: "unauthorized" }, 401);
  const { data: profile, error: profErr } = await userDb.rpc("my_profile");
  if (profErr || !profile) return json({ success: false, error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ success: false, error: "bad_request" }, 400); }
  const rid = Number(body?.restaurant_id);
  if (!Number.isFinite(rid)) return json({ success: false, error: "restaurant_id_required" }, 400);
  const member = profile.is_platform_admin || (profile.staff ?? []).some((s: any) => Number(s.restaurant_id) === rid);
  if (!member) return json({ success: false, error: "forbidden" }, 403);

  if (!GEMINI_API_KEY) return json({ success: false, error: "not_configured", message: "AI не налаштовано на сервері." }, 503);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await admin.rpc("svc_ai_rate_check", { p_user: userData.user.id, p_restaurant_id: rid, p_fn: "ai-pairing", p_per_minute: 20 });
  if (allowed === false) return json({ success: false, error: "rate_limited", message: "Забагато запитів. Спробуй за хвилину." }, 429);

  // ---- venue data through the CALLER's session (RLS limits it to this venue) ----
  const [{ data: menu, error: menuErr }, { data: stops }] = await Promise.all([
    userDb.from("menu_items")
      .select("id,name,type,category,description,price,weight,country,menu,allergens,allergens_status,status")
      .eq("restaurant_id", rid).limit(3000),
    userDb.from("stop_list").select("menu_item_id").eq("restaurant_id", rid).eq("status", "active"),
  ]);
  if (menuErr) return json({ success: false, error: "menu_unavailable" }, 500);
  const stopped = new Set((stops ?? []).map((s: any) => Number(s.menu_item_id)));
  const all = (menu ?? []) as (MenuRow & { status?: string })[];
  const byId = new Map(all.map((m) => [Number(m.id), m]));

  const cartIds: number[] = (Array.isArray(body?.cart_item_ids) ? body.cart_item_ids : []).map(Number).filter((n: number) => byId.has(n)).slice(0, 20);
  const focusId = byId.has(Number(body?.focus_item_id)) ? Number(body.focus_item_id) : null;
  const guestAllergens: string[] = (Array.isArray(body?.guest_allergens) ? body.guest_allergens : []).filter((a: string) => ALLERGEN_UA[a]);
  const budget = Number.isFinite(Number(body?.budget)) && Number(body.budget) > 0 ? Number(body.budget) : null;
  const wishes = clip(body?.wishes, 300);
  const focusItems = focusId ? [byId.get(focusId)!] : cartIds.map((id) => byId.get(id)!);
  if (!focusItems.length) return json({ success: false, error: "empty_cart", message: "Додай позицію в замовлення або вибери страву/напій." }, 400);

  // direction: what to look for
  const hasFood = focusItems.some((m) => !isBar(m)), hasDrink = focusItems.some(isBar);
  const mode = ["drink_for_food", "food_for_drink", "addons"].includes(body?.mode) ? body.mode
    : hasFood && !hasDrink ? "drink_for_food" : hasDrink && !hasFood ? "food_for_drink" : "addons";
  const wantDrinks = mode === "drink_for_food" || mode === "addons";
  const wantFood = mode === "food_for_drink" || mode === "addons";

  const excludedByAllergen: string[] = [];
  const candidates = all.filter((m) => {
    const id = Number(m.id);
    if (focusItems.some((f) => Number(f.id) === id)) return false;
    if (stopped.has(id) || ["stop", "stopped"].includes(String(m.status ?? "").toLowerCase())) return false;
    if (m.price == null || Number(m.price) <= 0) return false;
    if (!((wantDrinks && isBar(m)) || (wantFood && !isBar(m)))) return false;
    if (budget && Number(m.price) > budget) return false;
    const hits = (m.allergens ?? []).filter((a) => guestAllergens.includes(a));
    if (hits.length) { excludedByAllergen.push(m.name); return false; }
    return true;
  });
  // keep the prompt bounded: prefer items with a description, then by category spread
  candidates.sort((a, b) => Number(!!b.description) - Number(!!a.description));
  const shortlist = candidates.slice(0, MAX_CANDIDATES);
  if (!shortlist.length) {
    return json({ success: true, mode, recommendations: [], data_gaps: "Немає доступних позицій, що відповідають умовам (стоп-лист, бюджет, алергени).", excluded_by_allergen: excludedByAllergen.length });
  }

  const prompt = JSON.stringify({
    task: mode === "drink_for_food" ? "Підбери напої до страв з CART/FOCUS"
      : mode === "food_for_drink" ? "Підбери страви до напоїв з CART/FOCUS" : "Підбери доречні напої та страви-доповнення до CART",
    cart: focusItems.map(describe), budget_per_item: budget, guest_wishes: wishes || null,
    candidates: shortlist.map(describe),
  });

  const geminiBody = {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema, temperature: 0.4 },
  };

  let out: any = null, usedModel = "";
  const started = Date.now();
  for (const model of [...new Set(FALLBACK_MODELS)]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify(geminiBody), signal: ctrl.signal,
      });
      if (!r.ok) { console.warn(`ai-pairing ${model}: HTTP ${r.status}`); if (r.status === 429 || r.status >= 500 || r.status === 404) continue; break; }
      const env = await r.json();
      const text = (env?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
      out = JSON.parse(text); usedModel = model; break;
    } catch (e) {
      console.warn(`ai-pairing ${model}: ${e instanceof Error ? e.name : "error"}`);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  console.log(`ai-pairing: ${usedModel || "none"} in ${Date.now() - started} ms, ${shortlist.length} candidates`);
  if (!out) return json({ success: false, error: "ai_unavailable", message: "AI тимчасово недоступний. Спробуй ще раз." }, 503);

  // ---- validate: only real, allowed candidates; facts re-read from the DB ----
  const allowedIds = new Set(shortlist.map((m) => Number(m.id)));
  const seen = new Set<number>();
  const recs = (Array.isArray(out.recommendations) ? out.recommendations : [])
    .filter((r: any) => allowedIds.has(Number(r?.menu_item_id)) && !seen.has(Number(r.menu_item_id)) && seen.add(Number(r.menu_item_id)))
    .slice(0, 9)
    .map((r: any) => {
      const m = byId.get(Number(r.menu_item_id))!;
      return {
        menu_item_id: m.id, name: m.name, category: m.category, type: m.type, price: m.price,
        allergens: m.allergens ?? [], allergens_confirmed: m.allergens_status === "confirmed",
        role: ["best", "alternative", "addon"].includes(r.role) ? r.role : "alternative",
        pairs_with: clip(r.pairs_with, 120), reason: clip(r.reason, 400), guest_phrase: clip(r.guest_phrase, 200),
        source: "ai_explanation", // facts above = venue menu; reason/phrase = AI
      };
    });

  return json({
    success: true, mode, model: usedModel, recommendations: recs,
    dropped_invalid: (Array.isArray(out.recommendations) ? out.recommendations.length : 0) - recs.length,
    data_gaps: clip(out.data_gaps, 400), excluded_by_allergen: excludedByAllergen.length,
    candidates_considered: shortlist.length,
  });
});
