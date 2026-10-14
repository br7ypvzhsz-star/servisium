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

// ---- universal menu import (tasks 67–69): PDF / photo / any web page ----
const MENU_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string", description: "As written in the source, or empty." },
          category: { type: "string", description: "Section heading the item is under, as written." },
          price: { type: "number", description: "As written; 0 if the source shows no price." },
          currency: { type: "string", description: "ISO code if shown (UAH, EUR, USD…), else empty." },
          weight: { type: "string", description: "Portion / volume as written (300 г, 0.5 л, 50 мл), else empty." },
          kind: { type: "string", enum: ["food", "drink"] },
        },
        required: ["name", "description", "category", "price", "currency", "weight", "kind"],
      },
    },
    notes: { type: "string" },
  },
  required: ["items", "notes"],
};
const MENU_SYSTEM = `Ти переносиш меню ресторану з документа/сторінки у структуру.
ПРАВИЛА: бери ЛИШЕ позиції, які є в джерелі; назви, описи й ціни — дослівно; не перекладай і не вигадуй.
Якщо ціни немає — price = 0. Категорія — заголовок розділу, під яким позиція. kind: drink — напої/алкоголь/кава/чай/вода, інакше food.
Ігноруй рекламу, адреси, години роботи, навігацію сайту. У notes коротко опиши, що не вдалося розпізнати.`;

function cleanMenuItems(raw: any) {
  return (Array.isArray(raw?.items) ? raw.items : [])
    .filter((i: any) => clip(i?.name, 160))
    .slice(0, 1500)
    .map((i: any) => ({
      name: clip(i.name, 160), description: clip(i.description, 600), category: clip(i.category, 80) || "Інше",
      price: Number.isFinite(Number(i.price)) && Number(i.price) > 0 ? Number(i.price) : null,
      currency: clip(i.currency, 3).toUpperCase() || null, weight: clip(i.weight, 30) || null,
      type: i.kind === "drink" ? "Бар" : "Кухня",
    }));
}

async function geminiParts(system: string, parts: unknown[], schema: unknown, timeoutMs = 45000) {
  for (const model of MODELS) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY! },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 } }),
      });
      if (!r.ok) { console.warn(`ai-menu-assist ${model}: HTTP ${r.status}`); continue; }
      const env = await r.json();
      return { model, data: JSON.parse((env?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? "").join("")) };
    } catch (e) { console.warn(`ai-menu-assist ${model}: ${e instanceof Error ? e.name : "error"}`); }
    finally { clearTimeout(t); }
  }
  return null;
}

// public https pages only — no IP literals, localhost or internal names (SSRF guard)
function safeMenuUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return null;
    const h = u.hostname.toLowerCase();
    if (!h.includes(".") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".localhost")) return null;
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":") || h.startsWith("[")) return null;
    if (h.endsWith("supabase.co") || h.endsWith("supabase.in")) return null;
    return u;
  } catch { return null; }
}

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

  // ---- audit existing drink photos (task 2): does the photo show EXACTLY this product? Read-only. ----
  if (action === "verify_photos") {
    const canManage = profile.is_platform_admin || ["ADMIN", "SENIOR WAITER"].includes(String(staff?.role));
    if (!canManage) return json({ success: false, error: "forbidden" }, 403);
    const ids = (Array.isArray(body?.menu_item_ids) ? body.menu_item_ids : []).map(Number).filter(Number.isFinite).slice(0, 6);
    if (!ids.length) return json({ success: false, error: "no_items" }, 400);
    const { data: rows } = await userDb.from("menu_items").select("id,name,category,type,photo_url").eq("restaurant_id", rid).in("id", ids);
    const VERIFY_SCHEMA = {
      type: "object",
      properties: {
        verdict: { type: "string", enum: ["match", "wrong_product", "wrong_line", "pack_or_promo", "not_a_bottle", "unclear"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        seen: { type: "string", description: "Brand and product name readable on the label, as seen." },
        reason: { type: "string", description: "Ukrainian, one short sentence." },
      },
      required: ["verdict", "confidence", "seen", "reason"],
    };
    const VERIFY_SYSTEM = `Ти перевіряєш фото позиції бару. Порівняй ТЕ, ЩО ВИДНО на етикетці, з назвою позиції меню.
match — той самий виробник/бренд І та сама лінійка/кюве (і тип: ігристе/рожеве/сухе, якщо вказано в назві; вінтаж не обов'язковий).
wrong_line — той самий бренд, але інша лінійка/версія (напр. «Kaiken» vs «Kaiken Ultra», «XO» vs «VSOP»).
wrong_product — інший виробник або інший продукт.
pack_or_promo — ящик, кілька пляшок/банок, промо-наліпки на кшталт «4 CANS», келих замість пляшки, пляшка в руці.
not_a_bottle — немає пляшки/банки продукту.
unclear — етикетку не прочитати. Не вгадуй: якщо не можеш прочитати бренд — unclear.`;
    const results: any[] = [];
    await Promise.all((rows ?? []).map(async (m: any) => {
      const url = String(m.photo_url ?? "");
      if (!/^https:\/\//.test(url)) { results.push({ menu_item_id: m.id, verdict: "no_photo" }); return; }
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
        const r = await fetch(url, { signal: ctrl.signal }); clearTimeout(t);
        const ct = (r.headers.get("content-type") ?? "").split(";")[0];
        if (!r.ok || !/^image\/(png|jpe?g|webp|gif|avif)$/.test(ct)) { results.push({ menu_item_id: m.id, verdict: "unclear", reason: "Фото недоступне або непідтримуваний формат." }); return; }
        const buf = new Uint8Array(await r.arrayBuffer());
        if (buf.length > 6_000_000) { results.push({ menu_item_id: m.id, verdict: "unclear", reason: "Фото завелике." }); return; }
        let b64 = ""; const CH = 0x8000;
        for (let i = 0; i < buf.length; i += CH) b64 += String.fromCharCode(...buf.subarray(i, i + CH));
        const res = await geminiParts(VERIFY_SYSTEM, [{ text: `Позиція меню: «${clip(m.name, 160)}» (категорія: ${clip(m.category, 60)}).` }, { inline_data: { mime_type: ct, data: btoa(b64) } }], VERIFY_SCHEMA, 20000);
        if (!res) { results.push({ menu_item_id: m.id, verdict: "unclear", reason: "AI недоступний." }); return; }
        results.push({ menu_item_id: m.id, name: m.name, verdict: res.data?.verdict ?? "unclear", confidence: Number(res.data?.confidence) || 0,
          seen: clip(res.data?.seen, 120), reason: clip(res.data?.reason, 200) });
      } catch { results.push({ menu_item_id: m.id, verdict: "unclear", reason: "Не вдалося перевірити." }); }
    }));
    return json({ success: true, results });
  }

  if (action === "extract_menu_document" || action === "extract_menu_url") {
    const canManage = profile.is_platform_admin || ["ADMIN", "SENIOR WAITER"].includes(String(staff?.role));
    if (!canManage) return json({ success: false, error: "forbidden" }, 403);

    if (action === "extract_menu_document") {
      const mime = String(body?.mime ?? "");
      const data = String(body?.data ?? "");
      if (!/^(application\/pdf|image\/(png|jpe?g|webp|heic|heif))$/.test(mime)) return json({ success: false, error: "unsupported_type", message: "Підтримуються PDF, PNG, JPG, WEBP." }, 400);
      if (!data || data.length > 14_000_000) return json({ success: false, error: "file_too_large", message: "Файл завеликий (до ~10 МБ)." }, 400);
      const res = await geminiParts(MENU_SYSTEM, [{ text: `Файл: ${clip(body?.filename, 120)}. Перенеси меню.` }, { inline_data: { mime_type: mime, data } }], MENU_SCHEMA);
      if (!res) return json({ success: false, error: "ai_unavailable", message: "AI тимчасово недоступний." }, 503);
      const items = cleanMenuItems(res.data);
      return json({ success: true, model: res.model, items, notes: clip(res.data?.notes, 500), source: "ai_document_extraction" });
    }

    const url = safeMenuUrl(String(body?.url ?? ""));
    if (!url) return json({ success: false, error: "bad_url", message: "Потрібне публічне https-посилання." }, 400);
    let text = "";
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "User-Agent": "SERVISIUM-MenuImport/1.0" } });
      clearTimeout(t);
      if (!r.ok) return json({ success: false, error: "fetch_failed", message: `Сторінка відповіла ${r.status}.` }, 400);
      if (r.url && !safeMenuUrl(r.url)) return json({ success: false, error: "bad_redirect" }, 400);
      const ct = r.headers.get("content-type") ?? "";
      if (!/text\/html|text\/plain|application\/json/.test(ct)) return json({ success: false, error: "unsupported_page", message: "Це не сторінка меню (HTML/текст)." }, 400);
      const raw = (await r.text()).slice(0, 1_500_000);
      text = raw.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<(br|p|div|li|tr|h\d)[^>]*>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, 60000);
    } catch (e) {
      return json({ success: false, error: "fetch_failed", message: "Не вдалося завантажити сторінку." }, 400);
    }
    if (text.length < 40) return json({ success: false, error: "empty_page", message: "На сторінці немає тексту меню (можливо, меню завантажується скриптом)." }, 400);
    const res = await geminiParts(MENU_SYSTEM, [{ text: `URL: ${url.href}\n\n${text}` }], MENU_SCHEMA);
    if (!res) return json({ success: false, error: "ai_unavailable", message: "AI тимчасово недоступний." }, 503);
    const items = cleanMenuItems(res.data);
    // keep only items whose name really occurs on the page (no invented positions)
    const low = text.toLowerCase();
    const kept = items.filter((i: any) => low.includes(i.name.toLowerCase().slice(0, Math.min(18, i.name.length))));
    return json({ success: true, model: res.model, items: kept, dropped_not_on_page: items.length - kept.length, notes: clip(res.data?.notes, 500), source: "ai_page_extraction", host: url.hostname });
  }

  return json({ success: false, error: "unknown_action" }, 400);
});
