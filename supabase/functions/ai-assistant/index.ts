// SERVISIUM · ai-assistant — one assistant for the waiter (tasks 26–31, 45; Waiter Quick Mode).
// Answers ONLY from this venue's data: menu (names, prices, descriptions, confirmed allergens/ingredients),
// stop list and the live hall state. Item references are validated against the DB; allergen answers never
// promise safety; missing data → «потрібно уточнити». verify_jwt = false: session + venue checked here.
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODELS = [Deno.env.get("ASSISTANT_AI_MODEL") || "gemini-3.5-flash-lite", "gemini-3.5-flash"];
const ATTEMPT_TIMEOUT_MS = 9000;
const MAX_ITEMS = 45;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: CORS });
const clip = (s: unknown, n: number) =>
  String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const ALLERGEN_UA: Record<string, string> = {
  gluten: "глютен", crustaceans: "ракоподібні", eggs: "яйця", fish: "риба", peanuts: "арахіс", soy: "соя", milk: "молоко",
  tree_nuts: "горіхи", celery: "селера", mustard: "гірчиця", sesame: "кунжут", sulphites: "сульфіти", lupin: "люпин", molluscs: "молюски",
};

const SCHEMA = {
  type: "object",
  properties: {
    answer: { type: "string", description: "Ukrainian. Quick mode: up to 4 short sentences or a compact list." },
    items: {
      type: "array",
      items: { type: "object", properties: { menu_item_id: { type: "integer" }, note: { type: "string" } }, required: ["menu_item_id", "note"] },
    },
    guest_phrase: { type: "string", description: "Optional one short phrase for the guest, Ukrainian; empty if not relevant." },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    needs_clarification: { type: "string", description: "What data is missing or what to ask the kitchen/manager; empty if none." },
  },
  required: ["answer", "items", "guest_phrase", "confidence", "needs_clarification"],
};

const SYSTEM = `Ти — SERVISIUM AI, асистент офіціанта конкретного ресторану.
ПРАВИЛА:
1. Відповідай ЛИШЕ з наданих DATA (меню цього закладу, стоп-лист, стан залу). Не вигадуй страв, цін, складу, алергенів, походження, вінтажу.
2. Позиції називай так, як у меню, і додавай їх id у items. Позиції зі стоп-листа не рекомендуй (можеш сказати, що вони зараз недоступні).
3. Алергени: факти — лише якщо allergens_confirmed=true. Ніколи не кажи «безпечно»; кажи «за даними меню не містить зазначених алергенів». Якщо не підтверджено — «потрібне уточнення в кухні».
4. Питання про зал (вільні місця, групи, столи) — тільки з HALL. Якщо HALL порожній — скажи, що схема залу не налаштована.
5. Якщо даних не вистачає — коротко скажи це і заповни needs_clarification. Не вгадуй.
6. Режим QUICK: коротко, по суті, за 5–10 секунд читання. Мова — українська.
7. Не пиши технічні id у тексті answer — лише назви й ціни; id став тільки в items.
9. Поле pro — факти закладу (status confirmed — підтверджено; from_menu — з назви меню). Використовуй їх для вина/коктейлів/стейків.
8. Категорії вин часто названі країнами (напр. «Італія», «Франція») — враховуй це.`;

const STOP = new Set(["які", "яка", "який", "яке", "чи", "для", "що", "щось", "можна", "є", "до", "від", "грн", "гривень", "можете",
  "порадь", "порадьте", "підкажи", "підкажіть", "будь", "ласка", "мені", "нам", "гість", "гостя", "гостю", "хоче", "хочуть", "без", "або",
  "про", "так", "цей", "ця", "це", "наш", "наше", "нашого", "меню", "позиції", "позиція", "є?"]);
const tokens = (s: string) => [...new Set(s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)
  .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)))];
// Ukrainian endings vary a lot («італійські» / «Італія», «вина» / «вино»): match by a short stem
const stemOf = (w: string) => (w.length >= 5 ? w.slice(0, 4) : w.length === 4 ? w.slice(0, 3) : w);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) return json({ success: false, error: "unauthorized" }, 401);
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
  const db = createClient(SUPABASE_URL, anonKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: u, error: uErr } = await db.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (uErr || !u?.user) return json({ success: false, error: "unauthorized" }, 401);
  const { data: profile } = await db.rpc("my_profile");
  if (!profile) return json({ success: false, error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ success: false, error: "bad_request" }, 400); }
  const rid = Number(body?.restaurant_id);
  const question = clip(body?.question, 500);
  if (!question) return json({ success: false, error: "question_required" }, 400);
  if (!profile.is_platform_admin && !(profile.staff ?? []).some((s: any) => Number(s.restaurant_id) === rid)) return json({ success: false, error: "forbidden" }, 403);
  if (!GEMINI_API_KEY) return json({ success: false, error: "not_configured", message: "AI не налаштовано на сервері." }, 503);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await admin.rpc("svc_ai_rate_check", { p_user: u.user.id, p_restaurant_id: rid, p_fn: "ai-assistant", p_per_minute: 20 });
  if (allowed === false) return json({ success: false, error: "rate_limited", message: "Забагато запитів. Спробуй за хвилину." }, 429);

  // venue data through the caller's session (RLS)
  const [{ data: menu }, { data: stops }, { data: hall }] = await Promise.all([
    db.from("menu_items").select("id,name,type,category,price,weight,description,country,allergens,allergens_status,ingredients,ingredients_status,cross_contact_note,pro_kind,pro,pro_status")
      .eq("restaurant_id", rid).limit(3000),
    db.from("stop_list").select("menu_item_id,reason").eq("restaurant_id", rid).eq("status", "active"),
    db.rpc("hall_stats", { p_restaurant_id: rid }),
  ]);
  const all = (menu ?? []) as any[];
  const byId = new Map(all.map((m) => [Number(m.id), m]));
  const stopped = new Map((stops ?? []).map((s: any) => [Number(s.menu_item_id), clip(s.reason, 80)]));

  // retrieval: score items by question words (name > category > ingredients > description)
  const q = tokens(question);
  const stems = [...new Set(q.map(stemOf))];
  const scored = all.map((m) => {
    const name = String(m.name ?? "").toLowerCase(), cat = String(m.category ?? "").toLowerCase();
    const ing = (Array.isArray(m.ingredients) ? m.ingredients : []).map((i: any) => String(i?.name ?? "")).join(" ").toLowerCase();
    const desc = clip(m.description, 400).toLowerCase();
    let s = 0;
    for (const st of stems) {
      if (name.includes(st)) s += 5;
      if (cat.includes(st)) s += 3;
      if (ing.includes(st)) s += 2;
      if (desc.includes(st)) s += 1;
    }
    return { m, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, MAX_ITEMS).map((x) => x.m);

  const asksHall = /(місц|стол|столик|зал|вільн|гост|груп|посад|резерв|людей|осіб|персон)/i.test(question);
  const data = {
    question,
    guest_allergens: (Array.isArray(body?.guest_allergens) ? body.guest_allergens : []).filter((a: string) => ALLERGEN_UA[a]).map((a: string) => ALLERGEN_UA[a]),
    categories: [...new Set(all.map((m) => `${m.type ?? ""}: ${m.category ?? ""}`))].slice(0, 120),
    items: scored.map((m) => ({
      id: m.id, name: clip(m.name, 120), type: m.type, category: clip(m.category, 60), price: m.price, portion: clip(m.weight, 30),
      country: clip(m.country, 40), description: clip(m.description, 260),
      allergens_confirmed: m.allergens_status === "confirmed", allergens: (m.allergens ?? []).map((a: string) => ALLERGEN_UA[a] ?? a),
      ingredients_confirmed: m.ingredients_status === "confirmed",
      ingredients: (Array.isArray(m.ingredients) ? m.ingredients : []).map((i: any) => clip(i?.name, 40)).filter(Boolean),
      cross_contact: clip(m.cross_contact_note, 120) || null,
      in_stop_list: stopped.has(Number(m.id)), stop_reason: stopped.get(Number(m.id)) || null,
      pro: m.pro_kind ? { kind: m.pro_kind, status: m.pro_status, ...(m.pro ?? {}) } : undefined,
    })),
    hall: asksHall ? (hall ?? null) : undefined,
    note: scored.length ? undefined : "За словами питання позицій не знайдено — є лише перелік категорій.",
  };

  let out: any = null, model = "";
  const t0 = Date.now();
  for (const mdl of MODELS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent`, {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents: [{ role: "user", parts: [{ text: "QUICK MODE\nDATA:\n" + JSON.stringify(data) }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: SCHEMA, temperature: 0.2 },
        }),
      });
      if (!r.ok) { console.warn(`ai-assistant ${mdl}: HTTP ${r.status}`); continue; }
      const env = await r.json();
      out = JSON.parse((env?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("")); model = mdl; break;
    } catch (e) { console.warn(`ai-assistant ${mdl}: ${e instanceof Error ? e.name : "error"}`); }
    finally { clearTimeout(timer); }
  }
  console.log(`ai-assistant: ${model || "none"} ${Date.now() - t0} ms, ${scored.length} items, hall=${asksHall}`);
  if (!out) return json({ success: false, error: "ai_unavailable", message: "AI тимчасово недоступний." }, 503);

  const seen = new Set<number>();
  const items = (Array.isArray(out.items) ? out.items : [])
    .filter((i: any) => byId.has(Number(i?.menu_item_id)) && !seen.has(Number(i.menu_item_id)) && seen.add(Number(i.menu_item_id)))
    .slice(0, 8)
    .map((i: any) => {
      const m = byId.get(Number(i.menu_item_id));
      return { menu_item_id: m.id, name: m.name, type: m.type, category: m.category, price: m.price, in_stop_list: stopped.has(Number(m.id)),
        allergens: m.allergens ?? [], allergens_confirmed: m.allergens_status === "confirmed", note: clip(i.note, 200) };
    });

  return json({
    success: true, model, answer: clip(out.answer, 1200), items, guest_phrase: clip(out.guest_phrase, 200),
    confidence: ["high", "medium", "low"].includes(out.confidence) ? out.confidence : "low",
    needs_clarification: clip(out.needs_clarification, 300), used_hall: asksHall, items_considered: scored.length,
  });
});
