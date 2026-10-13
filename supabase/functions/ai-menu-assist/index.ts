// SERVISIUM · ai-menu-assist — AI help for the menu knowledge base (instruction §5, tasks 56–58).
//   extract_ingredients: proposes a structured ingredient list ONLY from what the item's own name/description says.
//                        Result is a suggestion: the venue confirms it in the editor (ingredients_status stays 'unknown').
//   ingredient_info:     short general (encyclopedic) note about an ingredient for the waiter, clearly labelled
//                        as general knowledge; never invents the venue's specific variety, origin or producer.
// verify_jwt = false: the session and venue membership are checked here.
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODELS = [Deno.env.get("MENU_AI_MODEL") || "gemini-3.5-flash-lite", "gemini-3.5-flash"];
const ATTEMPT_TIMEOUT_MS = 9000;
const ALLERGENS = ["gluten", "crustaceans", "eggs", "fish", "peanuts", "soy", "milk", "tree_nuts", "celery", "mustard",
  "sesame", "sulphites", "lupin", "molluscs"];
const ROLES = ["основа", "соус", "гарнір", "спеція", "топінг", "інше"];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: CORS });
const clip = (s: unknown, n: number) =>
  String(s ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

const EXTRACT_SCHEMA = {
  type: "object",
  properties: {
    ingredients: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          qty: { type: "string", description: "Only if the text states it, else empty." },
          unit: { type: "string", description: "Only if the text states it, else empty." },
          role: { type: "string", enum: ROLES },
          allergens: { type: "array", items: { type: "string", enum: ALLERGENS } },
          quote: { type: "string", description: "Exact words from the source text that mention this ingredient." },
        },
        required: ["name", "role", "allergens", "quote"],
      },
    },
    missing_info: { type: "string", description: "What is not stated (e.g. salt type, oil, garnish) — Ukrainian." },
  },
  required: ["ingredients", "missing_info"],
};

const EXTRACT_SYSTEM = `Ти розбираєш позицію меню ресторану на окремі інгредієнти.
ПРАВИЛА:
1. Бери ЛИШЕ інгредієнти, прямо названі в назві чи описі. Нічого не додавай «за рецептом за замовчуванням».
2. Для кожного інгредієнта наведи точну цитату з тексту (quote).
3. Кількість/одиниці — лише якщо вони прямо вказані.
4. Алергени (коди ЄС-14) — лише ті, що НЕМИНУЧЕ випливають із самого простого інгредієнта (вершки/сир/масло → milk, пшеничне борошно/хліб → gluten, креветки → crustaceans, лосось → fish, горіхи → tree_nuts).
   Для складних компонентів (соуси, айолі, кімчі, маринади, суміші, дресинги) — порожній масив, якщо їхній склад не розписаний у тексті: рецептури різняться. Додай їх у missing_info як «склад соусу … не вказано».
5. Не вигадуй сорт солі, спецій, олії чи виробника. Що не вказано — опиши в missing_info.
6. Мова — українська.`;

const INFO_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "2–4 sentences of general knowledge, Ukrainian." },
    taste: { type: "string", description: "Typical taste/texture role in dishes, 1 sentence." },
    waiter_phrase: { type: "string", description: "One short phrase a waiter can say, without claims about this venue's specific product." },
    uncertain: { type: "boolean", description: "true if the ingredient name is too generic or unclear for a reliable note." },
  },
  required: ["summary", "taste", "waiter_phrase", "uncertain"],
};

const INFO_SYSTEM = `Ти даєш офіціанту коротку ЗАГАЛЬНУ довідку про інгредієнт (енциклопедичні відомості).
ПРАВИЛА:
1. Лише загальновідомі, перевірювані факти. Без вигаданих історій, дат, легенд.
2. Не стверджуй, який саме сорт/виробник/походження використовує ресторан — цього ти не знаєш.
3. Якщо назва загальна (напр. «сіль», «спеції», «олія») — так і скажи: без уточнення від закладу тип/походження невідомі; поясни лише загальну роль. uncertain=true.
4. Мова — українська, коротко.`;

async function gemini(system: string, prompt: string, schema: unknown) {
  for (const model of MODELS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
        }),
      });
      if (!r.ok) { console.warn(`ai-menu-assist ${model}: HTTP ${r.status}`); continue; }
      const env = await r.json();
      const text = (env?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("");
      return { model, data: JSON.parse(text) };
    } catch (e) {
      console.warn(`ai-menu-assist ${model}: ${e instanceof Error ? e.name : "error"}`);
    } finally { clearTimeout(t); }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);

  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) return json({ success: false, error: "unauthorized" }, 401);
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? req.headers.get("apikey") ?? "";
  const userDb = createClient(SUPABASE_URL, anonKey, { global: { headers: { Authorization: auth } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: u, error: uErr } = await userDb.auth.getUser(auth.replace(/^Bearer\s+/i, ""));
  if (uErr || !u?.user) return json({ success: false, error: "unauthorized" }, 401);
  const { data: profile } = await userDb.rpc("my_profile");
  if (!profile) return json({ success: false, error: "unauthorized" }, 401);

  let body: any;
  try { body = await req.json(); } catch { return json({ success: false, error: "bad_request" }, 400); }
  const rid = Number(body?.restaurant_id);
  const action = String(body?.action ?? "");
  const staff = (profile.staff ?? []).find((s: any) => Number(s.restaurant_id) === rid);
  if (!profile.is_platform_admin && !staff) return json({ success: false, error: "forbidden" }, 403);
  if (!GEMINI_API_KEY) return json({ success: false, error: "not_configured", message: "AI не налаштовано на сервері." }, 503);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: allowed } = await admin.rpc("svc_ai_rate_check", { p_user: u.user.id, p_restaurant_id: rid, p_fn: "ai-menu-assist", p_per_minute: 20 });
  if (allowed === false) return json({ success: false, error: "rate_limited", message: "Забагато запитів. Спробуй за хвилину." }, 429);

  if (action === "extract_ingredients") {
    const canManage = profile.is_platform_admin || ["ADMIN", "SENIOR WAITER"].includes(String(staff?.role));
    if (!canManage) return json({ success: false, error: "forbidden" }, 403);
    // read the item through the caller's session (RLS: own venue only)
    const { data: item } = await userDb.from("menu_items").select("id,name,description,category,type,weight")
      .eq("id", Number(body?.menu_item_id)).eq("restaurant_id", rid).maybeSingle();
    if (!item) return json({ success: false, error: "item_not_found" }, 404);
    const text = `${clip(item.name, 200)}. ${clip(item.description, 1500)}`.trim();
    if (clip(item.description, 1500).length < 8) {
      return json({ success: true, ingredients: [], missing_info: "Опису позиції немає — склад потрібно внести вручну або з техкарти." });
    }
    const res = await gemini(EXTRACT_SYSTEM, JSON.stringify({ item: { name: item.name, category: item.category, type: item.type, portion: item.weight }, source_text: text }), EXTRACT_SCHEMA);
    if (!res) return json({ success: false, error: "ai_unavailable", message: "AI тимчасово недоступний." }, 503);
    const lower = text.toLowerCase();
    // keep only ingredients whose quote really occurs in the source text
    const ingredients = (Array.isArray(res.data?.ingredients) ? res.data.ingredients : [])
      .filter((i: any) => clip(i?.name, 80) && clip(i?.quote, 200) && lower.includes(clip(i.quote, 200).toLowerCase()))
      .slice(0, 30)
      .map((i: any) => ({
        name: clip(i.name, 80), qty: clip(i.qty, 20), unit: clip(i.unit, 20),
        role: ROLES.includes(i.role) ? i.role : "інше",
        allergens: (Array.isArray(i.allergens) ? i.allergens : []).filter((a: string) => ALLERGENS.includes(a)),
        origin: "", note: "", quote: clip(i.quote, 200),
      }));
    const dropped = (res.data?.ingredients?.length ?? 0) - ingredients.length;
    return json({ success: true, model: res.model, ingredients, dropped_unquoted: dropped, missing_info: clip(res.data?.missing_info, 400), source: "ai_suggestion_from_menu_text" });
  }

  if (action === "ingredient_info") {
    const name = clip(body?.ingredient, 80);
    if (!name) return json({ success: false, error: "ingredient_required" }, 400);
    const res = await gemini(INFO_SYSTEM, JSON.stringify({ ingredient: name, dish: clip(body?.dish, 120) }), INFO_SCHEMA);
    if (!res) return json({ success: false, error: "ai_unavailable", message: "AI тимчасово недоступний." }, 503);
    return json({
      success: true, model: res.model, ingredient: name,
      summary: clip(res.data?.summary, 600), taste: clip(res.data?.taste, 250), waiter_phrase: clip(res.data?.waiter_phrase, 200),
      uncertain: Boolean(res.data?.uncertain), source: "ai_general_knowledge",
    });
  }

  return json({ success: false, error: "unknown_action" }, 400);
});
