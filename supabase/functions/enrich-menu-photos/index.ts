
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PHOTO_BUCKET = "servisium-menu-photos";
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_ITEMS_PER_REQUEST = 20;
const MAX_BING_CANDIDATES = 48;
const MAX_PAGE_CANDIDATES = 5;
const MAX_VISION_ITEMS_PER_REQUEST = 5;
const MAX_VISION_CANDIDATES = 6;
const SEARCH_TIMEOUT_MS = 12000;
const IMAGE_TIMEOUT_MS = 18000;

type IncomingItem = {
  name?: string;
  title?: string;
  description?: string | null;
  category?: string | null;
  category_id?: string | number | null;
  menu?: string | null;
  menu_id?: string | number | null;
  type?: string | null;
  weight?: string | number | null;
  unit?: string | null;
  image_url?: string | null;
  thumbnail_url?: string | null;
  photo_url?: string | null;
  external_id?: string | number | null;
  source_id?: string | number | null;
  source?: string | null;
  country?: string | null;
};

type ImageCandidate = {
  image_url: string;
  download_url?: string;
  page_url: string;
  title: string;
  source: string;
  image_role?: string;
  page_priority?: number;
  source_authority?: number;
};

type FoundPhoto = {
  url: string;
  download_urls: string[];
  source: string;
  confidence: number;
};

type Match = {
  name: string;
  photo_url: string;
  photo_source: string;
  source: string;
  confidence: number;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function clean(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHtml(v: unknown): string {
  return clean(v)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeUrl(v: unknown): string {
  let s = clean(v).replace(/\\\//g, "/");
  if (!s) return "";

  if (s.startsWith("//")) {
    s = "https:" + s;
  }

  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return "";
    }
    return u.toString();
  } catch {
    return "";
  }
}

function transliterate(v: string): string {
  const map: Record<string, string> = {
    а:"a", б:"b", в:"v", г:"h", ґ:"g", д:"d", е:"e", є:"ye", ж:"zh",
    з:"z", и:"y", і:"i", ї:"yi", й:"y", к:"k", л:"l", м:"m", н:"n",
    о:"o", п:"p", р:"r", с:"s", т:"t", у:"u", ф:"f", х:"kh", ц:"ts",
    ч:"ch", ш:"sh", щ:"shch", ь:"", ю:"yu", я:"ya",
    А:"A", Б:"B", В:"V", Г:"H", Ґ:"G", Д:"D", Е:"E", Є:"Ye", Ж:"Zh",
    З:"Z", И:"Y", І:"I", Ї:"Yi", Й:"Y", К:"K", Л:"L", М:"M", Н:"N",
    О:"O", П:"P", Р:"R", С:"S", Т:"T", У:"U", Ф:"F", Х:"Kh", Ц:"Ts",
    Ч:"Ch", Ш:"Sh", Щ:"Shch", Ь:"", Ю:"Yu", Я:"Ya",
  };

  return v
    .split("")
    .map((ch) => map[ch] ?? ch)
    .join("");
}

function normalizeSearch(v: unknown): string {
  return transliterate(stripHtml(v))
    .toLowerCase()
    .replace(/[’'`]/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenList(v: string): string[] {
  return [...new Set(
    normalizeSearch(v)
      .split(" ")
      .filter((t) => t.length >= 2)
  )];
}

/*
  Share of the alias tokens found in the text (0..1). Was referenced but never
  defined, so every call threw a ReferenceError.
*/
function similarity(alias: unknown, text: unknown): number {
  const a = tokenList(String(alias ?? ""));
  if (!a.length) return 0;
  const t = new Set(tokenList(String(text ?? "")));
  const hits = a.filter((tok) => t.has(tok)).length;
  return hits / a.length;
}

function stripTagsForAlias(v: string): string {
  return stripHtml(v)
    .replace(/[|;•\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractParentheticalAliases(v: string): string[] {
  return (clean(v).match(/\(([^)]+)\)/g) || [])
    .map((x) => x.slice(1, -1).trim())
    .filter(Boolean);
}

function extractVolumeAliases(v: string): string[] {
  const raw = clean(v);
  const out: string[] = [];

  if (/\b0[,.]5\b/i.test(raw)) {
    out.push("500 ml", "0.5 l");
  }
  if (/\b0[,.]33\b/i.test(raw)) {
    out.push("330 ml", "0.33 l");
  }
  if (/\b0[,.]75\b/i.test(raw)) {
    out.push("750 ml", "0.75 l");
  }
  if (/\b1(?:[,.]0)?\s*l\b/i.test(raw) || /\b1000\s*ml\b/i.test(raw)) {
    out.push("1000 ml", "1 l");
  }

  return [...new Set(out)];
}

function searchAliases(item: IncomingItem): string[] {
  const name = clean(item.name || item.title);
  const description = stripTagsForAlias(item.description);

  const out = [
    name,
    description,
    clean(item.category),
    clean(item.menu),
    ...extractParentheticalAliases(name),
    ...extractParentheticalAliases(description),
  ];

  const latinFragments =
    description.match(/[A-Za-z][A-Za-z0-9 .,'"&+\-\/]{2,100}/g) || [];

  out.push(
    ...latinFragments
      .map(clean)
      .filter((x) => x.length >= 3)
      .filter((x) => x.split(/\s+/).length <= 12)
  );

  const latinName = transliterate(name);
  if (latinName && normalizeSearch(latinName) !== normalizeSearch(name)) {
    out.push(latinName);
  }

  out.push(
    ...extractVolumeAliases(name),
    ...extractVolumeAliases(description)
  );

  if (/,\s*\d/.test(name)) {
    out.push(name.replace(/,(\d)/g, ".$1"));
  }

  return [...new Set(
    out
      .map(clean)
      .filter((x) => x.length >= 2)
  )].slice(0, 20);
}

function expectedVolumeMl(item: IncomingItem): number | null {
  const raw = [
    clean(item.name || item.title),
    clean(item.weight),
    stripHtml(item.description),
  ].join(" ");

  if (/\b0[,.]5\b/i.test(raw) || /\b500\s*ml\b/i.test(raw)) return 500;
  if (/\b0[,.]33\b/i.test(raw) || /\b330\s*ml\b/i.test(raw)) return 330;
  if (/\b0[,.]75\b/i.test(raw) || /\b750\s*ml\b/i.test(raw)) return 750;
  if (/\b1(?:[,.]0)?\s*l\b/i.test(raw) || /\b1000\s*ml\b/i.test(raw)) return 1000;

  return null;
}

function candidateVolumeMl(candidate: ImageCandidate): number | null {
  const raw = [
    candidate.title,
    candidate.page_url,
    candidate.image_url,
    candidate.download_url || "",
  ].join(" ");

  if (/\b(?:500\s*ml|0[,.]5\s*l|0[,.]5)\b/i.test(raw)) return 500;
  if (/\b(?:330\s*ml|0[,.]33\s*l|0[,.]33)\b/i.test(raw)) return 330;
  if (/\b(?:750\s*ml|0[,.]75\s*l|0[,.]75)\b/i.test(raw)) return 750;
  if (/\b(?:1000\s*ml|1[,.]0\s*l|1\s*l)\b/i.test(raw)) return 1000;

  return null;
}

function alcoholKind(
  item: IncomingItem
): "beer" | "wine" | "spirit" | "other" {

  const name =
    clean(
      item.name ||
      item.title
    );

  const category =
    clean(
      item.category
    );

  const menu =
    clean(
      item.menu
    );

  const raw =
    [
      name,
      category,
      menu,
      stripHtml(
        item.description
      )
    ].join(" ");

  const lower =
    raw.toLowerCase();

  const normalized =
    normalizeSearch(
      raw
    );

  /*
    MENU-FIRST classification is deliberate:
    the verified Expz menu has explicit menu names such as
    "Алкогольні напої", "Білі вина", "Червоні вина",
    "Ігристі вина", "Побакальні вина".
    This prevents plural Ukrainian forms ("вина", "ігристі")
    from being missed by a singular-only text regex.
  */

  if(
    /(коктейльна карта|коктейлі|коктейл|cocktail|mocktail|моктейл)/i
      .test(
        `${menu} ${category}`
      )
  ){
    return "other";
  }

  if(
    /(безалкогольні напої|безалкогольні вина|non[-\s]?alcoholic|0\s*%\s*alc)/i
      .test(
        `${menu} ${category} ${name}`
      )
  ){
    return "other";
  }

  if(
    /(пиво|beer|witbier|lager|ale|ipa|porter|stout|pils|saison|cider|сидр)/i
      .test(
        lower
      )
  ){
    return "beer";
  }

  if(
    /(вина|вино|wine|sparkling|ігрист|игрист|шампан|champagne|prosecco|cava|rose|rosé|рожев|померанчев|шері|sherry|портвейн|port|солодкі та кріплені|sweet|fortified)/i
      .test(
        lower
      )
  ){
    return "wine";
  }

  if(
    /(віскі|виски|whisky|whiskey|бурбон|bourbon|scotch|скотч|коньяк|cognac|brandy|бренді|джин|gin|горіл|водк|vodka|ром|rum|текіл|tequila|mezcal|лікер|liqueur|лікерн|амаро|amaro|вермут|vermouth|бітер|bitters|grappa|граппа|sambuca|самбука|ouzo|узо|absinthe|абсент|настоян|налив|jager|jäger|baileys|kahlua|liquor|liquors|spirits)/i
      .test(
        lower
      )
  ){
    return "spirit";
  }

  const menuLower =
    menu.toLowerCase();

  if(
    /(алкогольні напої|алкогольні|alcoholic|spirits|bitters\s*&\s*liquors|liquors|vermouth|whisky|whiskey)/i
      .test(
        menuLower
      )
  ){
    return "spirit";
  }

  if(
    /(ігристі вина|білі вина|червоні вина|побакальні вина|рожеві|померанчеві|солодкі та кріплені)/i
      .test(
        menuLower
      )
  ){
    return "wine";
  }

  if(
    /(пиво на розлив|пляшкове пиво|beer)/i
      .test(
        `${menu} ${category}`
      )
  ){
    return "beer";
  }

  // Normalized fallback.
  if(
    /(pyvo|pivo|beer|witbier|lager|ale|ipa|porter|stout|pils|saison|cider)/.test(
      normalized
    )
  ){
    return "beer";
  }

  if(
    /(vyna|vyno|vino|wine|sparkling|igryst|shampan|champagne|prosecco|cava|rose|sherry|port)/.test(
      normalized
    )
  ){
    return "wine";
  }

  if(
    /(viski|whisky|whiskey|bourbon|scotch|koniyak|cognac|brandy|gin|vodka|goril|vodka|rum|tequila|tekila|mezcal|liker|liqueur|amaro|vermut|vermouth|bitters|biter|grappa|sambuca|ouzo|absinthe|jager|baileys|kahlua|liquor)/.test(
      normalized
    )
  ){
    return "spirit";
  }

  return "other";
}

function isAlcoholItem(
  item: IncomingItem
): boolean {

  const type =
    clean(
      item.type
    ).toLowerCase();

  const menu =
    clean(
      item.menu
    ).toLowerCase();

  const category =
    clean(
      item.category
    ).toLowerCase();

  const name =
    clean(
      item.name ||
      item.title
    );

  const description =
    stripHtml(
      item.description
    );

  if(
    type === "кухня" ||
    type === "kitchen"
  ){
    return false;
  }

  /*
    Hard exclusions always win.
    These are not alcohol-product photos.
  */
  if(
    /(коктейльна карта|коктейлі|коктейл|cocktail|mocktail|моктейл)/i
      .test(
        `${menu} ${category}`
      )
  ){
    return false;
  }

  if(
    /(безалкогольні напої|безалкогольні вина|coffee|кава|чай|tea|вода|water|juice|сік|лимонад|lemonade|soft drink|milk|молоко|non[-\s]?alcoholic)/i
      .test(
        `${menu} ${category} ${name} ${description}`
      )
  ){
    return false;
  }

  /*
    Explicit alcoholic Expz menu sections.
    This is the critical fix for plural/localized wine names.
  */
  if(
    type === "бар" ||
    type === "bar"
  ){

    if(
      /(алкогольні напої|алкогольні)/i
        .test(
          menu
        )
    ){
      return true;
    }

    if(
      /(ігристі вина|побакальні вина|білі вина|червоні вина|рожеві та померанчеві|солодкі та кріплені)/i
        .test(
          menu
        )
    ){
      return true;
    }

    if(
      /(пиво на розлив|пляшкове пиво)/i
        .test(
          category
        )
    ){
      return true;
    }
  }

  const kind =
    alcoholKind(
      item
    );

  return (
    kind !==
    "other"
  );
}

function rejectedByContext(
  text: string
): boolean {

  return /(beer glass|pint glass|wine glass|cocktail glass|shot glass|glassware|drinkware|barware|келих|бокал|фужер|пивний бокал|draft|draught|tap|cocktail|recipe|restaurant|bar scene|served|pouring|menu|logo|poster|illustration|wallpaper|tasting|non[-\s]?alcoholic|безалкоголь|close[\s-]?up|closeup|cropped|crop|bottle neck|neck close|neck-only|горлечко|шийка|rear label|back label|back of bottle|rear of bottle|reverse side|reverse-side|backside|задня етикетка|задня сторона|зворотна сторона|label close|label detail|detail shot|zoomed|cut off|front label only|label-only|етикетка крупним планом|тільки етикетка|лише етикетка)/i
    .test(text);

}

function scoreCandidate(
  candidate: ImageCandidate,
  item: IncomingItem,
) {

  const aliases =
    searchAliases(
      item
    );

  const mainName =
    clean(
      item.name ||
      item.title
    );

  const text =
    [
      candidate.title,
      candidate.page_url,
      candidate.image_url
    ].join(" ");

  const normalized =
    normalizeSearch(
      text
    );

  let aliasScore = 0;

  for(
    const alias of
    aliases
  ){

    const a =
      normalizeSearch(
        alias
      );

    if(!a){
      continue;
    }

    aliasScore =
      Math.max(
        aliasScore,
        normalized.includes(
          a
        )
          ? 1
          : similarity(
              alias,
              text
            )
      );

  }

  let score =
    aliasScore * 60;

  if(
    aliasScore >= 1
  ){
    score += 24;
  }else if(
    aliasScore >= 0.75
  ){
    score += 12;
  }

  const main =
    normalizeSearch(
      mainName
    );

  if(
    main &&
    normalized.includes(
      main
    )
  ){
    score += 22;
  }

  const kind =
    alcoholKind(
      item
    );

  if(
    kind === "wine" &&
    /\b(wine|вино|вина|vino|vin)\b/i.test(
      normalized
    )
  ){
    score += 8;
  }

  if(
    kind === "beer" &&
    /\b(beer|пиво)\b/i.test(
      normalized
    )
  ){
    score += 8;
  }

  if(
    kind === "spirit" &&
    /\b(whisky|whiskey|gin|vodka|rum|tequila|cognac|brandy|liqueur|spirit|віскі|коньяк|джин|горілка|ром)\b/i.test(
      normalized
    )
  ){
    score += 8;
  }

  if(
    /\b(full bottle|whole bottle|front bottle|front view|front-facing|isolated|packshot|product photo|product image|product shot|hero image|main image|main product image)\b/i.test(
      normalized
    )
  ){
    score += 22;
  }

  if(
    /\b(bottle|пляшка|бутылка)\b/i.test(
      normalized
    )
  ){
    score += 12;
  }

  if(
    /\b(rear|back|reverse|rear label|back label|back of bottle|rear of bottle|задня|зворотна)\b/i.test(
      normalized
    )
  ){
    score -= 65;
  }

  if(
    /\b(close[\s-]?up|closeup|label[-\s]?detail|label only|detail shot|zoomed|crop|cropped|bottle neck|neck close|горлечко|шийка)\b/i.test(
      normalized
    )
  ){
    score -= 55;
  }

  score += Number(
    candidate.page_priority ||
    0
  );

  score += Number(
    candidate.source_authority ||
    0
  );

  if(
    candidate.image_role ===
    "og-image"
  ){
    score += 28;
  }

  if(
    candidate.image_role ===
    "product-jsonld-image"
  ){
    score += 26;
  }

  if(
    candidate.image_role ===
    "markdown-main-image"
  ){
    score += 18;
  }

  const expected =
    expectedVolumeMl(
      item
    );

  const actual =
    candidateVolumeMl(
      candidate
    );

  if(
    expected !== null &&
    actual === expected
  ){
    score += 20;
  }

  if(
    expected !== null &&
    actual !== null &&
    actual !== expected
  ){
    score -= 55;
  }

  const bad =
    rejectedByContext(
      text
    );

  if(
    bad
  ){
    score -= 110;
  }

  return {
    score:
      Math.max(
        0,
        Math.min(
          100,
          Math.round(
            score
          )
        )
      ),
    hardReject:
      bad ||
      (
        expected !== null &&
        actual !== null &&
        actual !== expected
      )
  };

}

async function fetchWithTimeout(
  target: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(target, {
      ...init,
      signal: controller.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseBingImages(html: string): ImageCandidate[] {
  const out: ImageCandidate[] = [];
  const seen = new Set<string>();

  const blocks = [
    ...(html.match(/<a[^>]+class=["'][^"']*\biusc\b[^"']*["'][^>]*>/gi) || []),
    ...(html.match(/<div[^>]+class=["'][^"']*\biusc\b[^"']*["'][^>]*>/gi) || []),
  ];

  for (const block of blocks) {
    const raw =
      block.match(/\bm=["']([\s\S]*?)["']/i)?.[1] ||
      block.match(/\bdata-m=["']([\s\S]*?)["']/i)?.[1] ||
      "";

    if (!raw) continue;

    const decoded = raw
      .replace(/&quot;/gi, '"')
      .replace(/&#34;/gi, '"')
      .replace(/&amp;/gi, "&")
      .replace(/\\"/g, '"');

    let meta: any = null;

    try {
      meta = JSON.parse(decoded);
    } catch {
      continue;
    }

    const imageUrl = normalizeUrl(
      meta?.murl ||
      meta?.mediaurl ||
      meta?.image_url ||
      meta?.turl ||
      ""
    );

    const thumbUrl = normalizeUrl(meta?.turl || "");

    const pageUrl = normalizeUrl(
      meta?.purl ||
      meta?.pageurl ||
      ""
    );

    const title = clean(
      meta?.t ||
      meta?.title ||
      meta?.desc ||
      meta?.description ||
      ""
    );

    if (!imageUrl) continue;

    const key = imageUrl.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      image_url: imageUrl,
      download_url:
        thumbUrl && thumbUrl !== imageUrl
          ? thumbUrl
          : undefined,
      page_url: pageUrl,
      title,
      source: "bing-images",
    });

    if (out.length >= MAX_BING_CANDIDATES) break;
  }


  // Raw-page fallback: Bing can expose murl outside the iusc node
  // depending on the served HTML variant.
  const rawPatterns = [
    /"murl"\s*:\s*"((?:https?:)?\\?\/\\?\/[^"]+)"/gi,
    /\\?"murl\\?"\s*:\s*\\?"((?:https?:)?\\?\/\\?\/[^"\\]+)\\?"/gi,
    /"mediaurl"\s*:\s*"((?:https?:)?\\?\/\\?\/[^"]+)"/gi,
  ];

  for (const re of rawPatterns) {
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const candidateUrl = normalizeUrl(
        String(match[1] || "")
          .replace(/\\\//g, "/")
          .replace(/\\"/g, '"')
      );

      if (!candidateUrl) continue;

      const key = candidateUrl.toLowerCase();
      if (seen.has(key)) continue;

      seen.add(key);

      out.push({
        image_url: candidateUrl,
        page_url: "",
        title: "",
        source: "bing-images-raw",
      });

      if (out.length >= MAX_BING_CANDIDATES) {
        return out;
      }
    }
  }

  return out;
}

async function bingImages(query: string): Promise<ImageCandidate[]> {
  const endpoint =
    `https://www.bing.com/images/search?form=HDRSC2&first=1&q=${encodeURIComponent(query)}`;

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 SERVISIUM/43.0",
        "Accept":
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "uk-UA,uk;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
      },
    },
    SEARCH_TIMEOUT_MS
  );

  if (!response || !response.ok) return [];

  try {
    return parseBingImages(await response.text());
  } catch {
    return [];
  }
}



async function duckDuckGoVqd(
  query: string
): Promise<string> {

  const home =
    `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`;

  const response =
    await fetchWithTimeout(
      home,
      {
        method:"GET",
        redirect:"follow",
        headers:{
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 SERVISIUM/43.0",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language":
            "uk-UA,uk;q=0.9,en;q=0.7",
          Referer:
            "https://duckduckgo.com/",
        }
      },
      SEARCH_TIMEOUT_MS
    );

  if(!response || !response.ok){
    return "";
  }

  const text =
    await response.text();

  const patterns = [
    /vqd=['"]([^'"]+)['"]/i,
    /vqd=([0-9-]+)/i,
    /"vqd"\s*:\s*"([^"]+)"/i,
  ];

  for(
    const pattern of patterns
  ){
    const match =
      text.match(pattern);

    if(
      match &&
      clean(match[1])
    ){
      return clean(match[1]);
    }
  }

  return "";
}

async function duckDuckGoImages(
  query: string
): Promise<ImageCandidate[]> {

  const vqd =
    await duckDuckGoVqd(
      query
    );

  if(!vqd){
    return [];
  }

  const endpoint =
    new URL(
      "https://duckduckgo.com/i.js"
    );

  endpoint.searchParams.set(
    "q",
    query
  );
  endpoint.searchParams.set(
    "vqd",
    vqd
  );
  endpoint.searchParams.set(
    "o",
    "json"
  );
  endpoint.searchParams.set(
    "f",
    ",,,"
  );
  endpoint.searchParams.set(
    "p",
    "1"
  );
  endpoint.searchParams.set(
    "s",
    "0"
  );

  const response =
    await fetchWithTimeout(
      endpoint.toString(),
      {
        method:"GET",
        redirect:"follow",
        headers:{
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 SERVISIUM/43.0",
          Accept:
            "application/json,text/plain,*/*;q=0.8",
          "Accept-Language":
            "uk-UA,uk;q=0.9,en;q=0.7",
          Referer:
            "https://duckduckgo.com/",
        }
      },
      SEARCH_TIMEOUT_MS
    );

  if(
    !response ||
    !response.ok
  ){
    return [];
  }

  try{

    const data =
      await response.json();

    const results =
      Array.isArray(
        data?.results
      )
        ? data.results
        : [];

    const out:ImageCandidate[] = [];
    const seen =
      new Set<string>();

    for(
      const result of
      results
    ){

      const image =
        normalizeUrl(
          result?.image ||
          ""
        );

      const thumbnail =
        normalizeUrl(
          result?.thumbnail ||
          ""
        );

      const page =
        normalizeUrl(
          result?.url ||
          ""
        );

      const title =
        clean(
          result?.title ||
          result?.source ||
          ""
        );

      const chosen =
        image ||
        thumbnail;

      if(!chosen){
        continue;
      }

      const key =
        chosen.toLowerCase();

      if(seen.has(key)){
        continue;
      }

      seen.add(key);

      out.push({
        image_url:
          chosen,
        download_url:
          thumbnail &&
          thumbnail !== chosen
            ? thumbnail
            : undefined,
        page_url:
          page,
        title,
        source:
          "duckduckgo-images"
      });

      if(
        out.length >=
        MAX_BING_CANDIDATES
      ){
        break;
      }

    }

    return out;

  }catch{
    return [];
  }
}


const SEARXNG_INSTANCES = [
  "https://search.lumy.live",
  "https://search.mectov.my.id",
  "https://search.minus27315.dev",
];

let searxPreferredInstance: string | null = null;

async function searxImageSearch(
  item: IncomingItem
): Promise<ImageCandidate[]> {

  const aliases =
    searchAliases(item);

  const kind =
    alcoholKind(item);

  const volume =
    expectedVolumeMl(item);

  const main =
    aliases.find(
      x =>
        /[A-Za-z]{3,}/.test(x)
    ) ||
    clean(
      item.name ||
      item.title
    );

  const query =
    `"${main}" ${kind} ${
      volume
        ? `${volume} ml`
        : ""
    } bottle product`
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  const instances =
    searxPreferredInstance
      ? [
          searxPreferredInstance,
          ...SEARXNG_INSTANCES.filter(
            x =>
              x !==
              searxPreferredInstance
          )
        ]
      : SEARXNG_INSTANCES;

  for(
    const instance of
    instances
  ){

    const endpoint =
      new URL(
        `${instance}/search`
      );

    endpoint.searchParams.set(
      "q",
      query
    );
    endpoint.searchParams.set(
      "categories",
      "images"
    );
    endpoint.searchParams.set(
      "format",
      "json"
    );
    endpoint.searchParams.set(
      "safesearch",
      "1"
    );
    endpoint.searchParams.set(
      "language",
      "en"
    );

    const response =
      await fetchWithTimeout(
        endpoint.toString(),
        {
          method:"GET",
          headers:{
            "User-Agent":
              "Mozilla/5.0 SERVISIUM/43.0",
            Accept:
              "application/json",
            "Accept-Language":
              "en-US,en;q=0.9"
          }
        },
        10000
      );

    if(
      !response ||
      !response.ok
    ){
      continue;
    }

    try{

      const data =
        await response.json();

      const results =
        Array.isArray(
          data?.results
        )
          ? data.results
          : [];

      const out:ImageCandidate[] = [];

      for(
        const result of
        results
      ){

        const image =
          normalizeUrl(
            result?.img_src ||
            result?.image ||
            result?.thumbnail_src ||
            result?.thumbnail ||
            ""
          );

        if(!image){
          continue;
        }

        const thumb =
          normalizeUrl(
            result?.thumbnail_src ||
            result?.thumbnail ||
            ""
          );

        const page =
          normalizeUrl(
            result?.url ||
            result?.host_page_url ||
            ""
          );

        const title =
          clean(
            result?.title ||
            result?.content ||
            result?.source ||
            ""
          );

        out.push({
          image_url:image,
          download_url:
            thumb &&
            thumb !== image
              ? thumb
              : undefined,
          page_url:page,
          title,
          source:
            "searxng-images"
        });

        if(
          out.length >=
          MAX_BING_CANDIDATES
        ){
          break;
        }

      }

      if(out.length){
        searxPreferredInstance =
          instance;
        return out;
      }

    }catch{
      continue;
    }

  }

  return [];
}


async function wikimediaSearch(
  item: IncomingItem
): Promise<ImageCandidate[]> {
  const out: ImageCandidate[] = [];
  const aliases = searchAliases(item);

  const queries = [
    ...aliases
      .filter((x) => /[A-Za-z]{3,}/.test(x))
      .slice(0, 4),
    ...aliases.slice(0, 3),
  ];

  for (const q of [...new Set(queries)]) {
    const endpoint =
      new URL("https://commons.wikimedia.org/w/api.php");

    endpoint.searchParams.set("action", "query");
    endpoint.searchParams.set("generator", "search");
    endpoint.searchParams.set(
      "gsrsearch",
      `${q} bottle can product`
    );
    endpoint.searchParams.set(
      "gsrnamespace",
      "6"
    );
    endpoint.searchParams.set(
      "gsrlimit",
      "10"
    );
    endpoint.searchParams.set(
      "prop",
      "imageinfo"
    );
    endpoint.searchParams.set(
      "iiprop",
      "url|mime|extmetadata"
    );
    endpoint.searchParams.set(
      "iiurlwidth",
      "1400"
    );
    endpoint.searchParams.set(
      "format",
      "json"
    );
    endpoint.searchParams.set(
      "origin",
      "*"
    );

    const response =
      await fetchWithTimeout(
        endpoint.toString(),
        {
          method:"GET",
          headers:{
            "User-Agent":
              "SERVISIUM/43.0-free-photo-engine",
            Accept:
              "application/json"
          }
        },
        SEARCH_TIMEOUT_MS
      );

    if(
      !response ||
      !response.ok
    ){
      continue;
    }

    try{
      const data =
        await response.json();

      for(
        const page of
        Object.values(
          data?.query?.pages || {}
        ) as any[]
      ){

        const info =
          page?.imageinfo?.[0];

        const imageUrl =
          normalizeUrl(
            info?.thumburl ||
            info?.url ||
            ""
          );

        if(
          !imageUrl
        ){
          continue;
        }

        const meta =
          info?.extmetadata || {};

        const title = [
          page?.title,
          meta?.ObjectName?.value,
          meta?.ImageDescription?.value
        ]
          .map(clean)
          .filter(Boolean)
          .join(" ");

        out.push({
          image_url:imageUrl,
          page_url:
            `https://commons.wikimedia.org/wiki/${encodeURIComponent(
              String(
                page?.title || ""
              ).replace(/ /g,"_")
            )}`,
          title,
          source:"wikimedia"
        });

      }
    }catch{
      // next source/query
    }

    if(out.length >= 30){
      break;
    }
  }

  return out;
}

async function openFoodFactsSearch(
  item: IncomingItem
): Promise<ImageCandidate[]> {

  const out: ImageCandidate[] = [];

  for(
    const query of
    searchAliases(item)
      .slice(0,2)
  ){

    const endpoint =
      new URL(
        "https://world.openfoodfacts.org/cgi/search.pl"
      );

    endpoint.searchParams.set(
      "search_terms",
      query
    );

    endpoint.searchParams.set(
      "search_simple",
      "1"
    );

    endpoint.searchParams.set(
      "action",
      "process"
    );

    endpoint.searchParams.set(
      "json",
      "1"
    );

    endpoint.searchParams.set(
      "page_size",
      "12"
    );

    endpoint.searchParams.set(
      "fields",
      [
        "code",
        "product_name",
        "product_name_en",
        "brands",
        "quantity",
        "image_front_url",
        "image_url"
      ].join(",")
    );

    const response =
      await fetchWithTimeout(
        endpoint.toString(),
        {
          method:"GET",
          headers:{
            "User-Agent":
              "SERVISIUM/43.0 free-photo-engine (photo enrichment)",
            Accept:
              "application/json"
          }
        },
        SEARCH_TIMEOUT_MS
      );

    if(
      !response ||
      !response.ok
    ){
      continue;
    }

    try{

      const data =
        await response.json();

      const products =
        Array.isArray(
          data?.products
        )
          ? data.products
          : [];

      for(
        const product of
        products
      ){

        const title =
          [
            product?.product_name,
            product?.product_name_en,
            product?.brands,
            product?.quantity
          ]
            .map(clean)
            .filter(Boolean)
            .join(" ");

        const images =
          [
            product?.image_front_url,
            product?.image_url
          ]
            .map(
              normalizeUrl
            )
            .filter(Boolean);

        for(
          const image_url of
          [...new Set(images)]
        ){

          out.push({
            image_url,
            page_url:
              product?.code
                ? `https://world.openfoodfacts.org/product/${product.code}`
                : "https://world.openfoodfacts.org/",
            title,
            source:
              "open-food-facts"
          });

        }

      }

    }catch{
      continue;
    }

  }

  return out;
}

/*
  Only a signed-in ADMIN / SENIOR WAITER of this restaurant (or a platform
  admin) may run the engine: it writes to Storage with the service role and
  spends the Gemini quota. The publishable key alone is not a user session.
*/
async function canManageRestaurant(
  req: Request,
  restaurantId: string
): Promise<boolean> {
  const auth = req.headers.get("authorization") ?? "";
  if (!/^Bearer\s+\S+/i.test(auth)) return false;

  const url = Deno.env.get("SUPABASE_URL") || "";
  const anonKey =
    Deno.env.get("SUPABASE_ANON_KEY") ||
    req.headers.get("apikey") ||
    "";

  const res = await fetch(`${url}/rest/v1/rpc/my_profile`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: auth,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) return false;

  const profile = await res.json().catch(() => null);
  if (!profile) return false;
  if (profile.is_platform_admin === true) return true;

  return (Array.isArray(profile.staff) ? profile.staff : []).some(
    (s: any) =>
      String(s?.restaurant_id) === restaurantId &&
      ["ADMIN", "SENIOR WAITER"].includes(String(s?.role))
  );
}

function getAdminClient() {
  const supabaseUrl =
    Deno.env.get("SUPABASE_URL") || "";

  let secretKey = "";

  try {
    const secretMap = JSON.parse(
      Deno.env.get("SUPABASE_SECRET_KEYS") || ""
    );
    secretKey =
      secretMap?.default || "";
  } catch {}

  if (!secretKey) {
    secretKey =
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  }

  if (!supabaseUrl || !secretKey) {
    throw new Error(
      "Supabase secret key is unavailable in Edge Function environment."
    );
  }

  return createClient(
    supabaseUrl,
    secretKey,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}

async function ensureBucket(
  supabaseAdmin: ReturnType<typeof createClient>
) {
  const bucket =
    await supabaseAdmin.storage.getBucket(
      PHOTO_BUCKET
    );

  if (!bucket.error && bucket.data) {
    if (bucket.data.public !== true) {
      const updated =
        await supabaseAdmin.storage.updateBucket(
          PHOTO_BUCKET,
          { public: true }
        );

      if (updated.error) {
        throw new Error(
          `Unable to make ${PHOTO_BUCKET} public: ${updated.error.message}`
        );
      }
    }
    return;
  }

  const created =
    await supabaseAdmin.storage.createBucket(
      PHOTO_BUCKET,
      {
        public: true,
        fileSizeLimit:
          MAX_IMAGE_BYTES,
        allowedMimeTypes: [
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/avif",
          "image/gif",
        ],
      }
    );

  if (
    created.error &&
    !/already exists/i.test(
      created.error.message || ""
    )
  ) {
    throw new Error(
      `Unable to create ${PHOTO_BUCKET}: ${created.error.message}`
    );
  }
}


function extractProducerAliases(item: IncomingItem): string[] {
  const all = [
    clean(item.description),
    clean(item.category),
    clean(item.menu),
    clean(item.name || item.title),
  ].join(" ");

  const patterns = [
    /\b(?:SASS\s*K\.\s*Winery)\b/gi,
    /\b(?:Four\s*Roses)\b/gi,
    /\b(?:Glenfiddich)\b/gi,
    /\b(?:Glenmorangie)\b/gi,
    /\b(?:Jack\s*Daniel'?s?)\b/gi,
    /\b(?:Jameson)\b/gi,
    /\b(?:John\s*Barr)\b/gi,
    /\b(?:Taittinger)\b/gi,
    /\b(?:Moët|Moet)\b/gi,
    /\b(?:Hennessy)\b/gi,
    /\b(?:Martell)\b/gi,
    /\b(?:Rémy\s*Martin|Remy\s*Martin)\b/gi,
    /\b(?:Bacardi)\b/gi,
    /\b(?:Campari)\b/gi,
    /\b(?:Aperol)\b/gi,
    /\b(?:Jägermeister|Jagermeister)\b/gi,
    /\b(?:Hoegaarden)\b/gi,
  ];

  const out: string[] = [];

  for (const re of patterns) {
    for (const m of all.matchAll(re)) {
      const x = clean(m[0]);
      if (x) out.push(x);
    }
  }

  return [...new Set(out)];
}

function buildHighRecallQueries(item: IncomingItem): string[] {
  const kind = alcoholKind(item);
  const name = clean(item.name || item.title);
  const aliases = searchAliases(item);
  const producers = extractProducerAliases(item);
  const volume = expectedVolumeMl(item);
  const size = volume ? `${volume} ml` : "";

  const latin =
    aliases.find(
      (x) =>
        /[A-Za-z]{3,}/.test(x) &&
        x.length <= 100 &&
        !/^(beer|wine|bottle|product|500 ml|330 ml|750 ml)$/i.test(x)
    ) ||
    producers[0] ||
    transliterate(name);

  const productCore = kind === "beer"
    ? "beer bottle can"
    : kind === "wine"
      ? "wine bottle"
      : "bottle";

  const candidates = [
    `"${latin}" ${size} ${productCore} official product`,
    `"${name}" ${size} ${productCore} official product`,
    `"${latin}" ${size} ${productCore}`,
    `"${name}" ${size} ${productCore}`,
  ];

  for (const producer of producers.slice(0, 2)) {
    candidates.push(
      `"${producer}" "${latin}" ${size} ${productCore}`,
    );
    candidates.push(
      `"${producer}" "${name}" ${size} ${productCore}`,
    );
  }

  // Remove useless size token when no explicit volume is known.
  return [...new Set(
    candidates
      .map((q) => q.replace(/\s+/g, " ").trim())
      .filter(Boolean)
  )].slice(0, 5);
}


function buildWholeBottleFallbackQueries(
  item: IncomingItem
): string[] {

  const name =
    clean(
      item.name ||
      item.title
    );

  const aliases =
    searchAliases(
      item
    );

  const producers =
    extractProducerAliases(
      item
    );

  const volume =
    expectedVolumeMl(
      item
    );

  const size =
    volume
      ? `${volume} ml`
      : "";

  const latin =
    aliases.find(
      x =>
        /[A-Za-z]{3,}/.test(x) &&
        x.length <= 100
    ) ||
    producers[0] ||
    transliterate(
      name
    );

  const kind =
    alcoholKind(
      item
    );

  const product =
    kind === "beer"
      ? "beer bottle can"
      : kind === "wine"
        ? "wine bottle"
        : "spirit bottle";

  return [
    `"${latin}" ${size} ${product} full bottle product photo`,
    `"${name}" ${size} ${product} whole bottle product photo`,
    `"${latin}" ${size} ${product} front bottle packshot`,
    ...(producers.slice(0,2).map(
      producer =>
        `"${producer}" "${latin}" ${size} bottle product photo`
    ))
  ]
    .map(
      q =>
        q
          .replace(
            /\s+/g,
            " "
          )
          .trim()
    )
    .filter(Boolean)
    .slice(
      0,
      4
    );
}

function absoluteImageUrl(raw: string, baseUrl: string): string {
  const cleaned = clean(raw)
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"');

  if (!cleaned) return "";

  try {
    return new URL(cleaned, baseUrl).toString();
  } catch {
    return normalizeUrl(cleaned);
  }
}


function pageSourceAuthority(
  pageUrl: string
): number {

  let host = "";

  try{
    host =
      new URL(
        pageUrl
      ).hostname.toLowerCase();
  }catch{}

  if(
    /(?:^|\.)goodwine\.com\.ua$/.test(host) ||
    /(?:^|\.)kolonist\.com\.ua$/.test(host) ||
    /(?:^|\.)beykush\.com$/.test(host) ||
    /(?:^|\.)sabotage\.wine$/.test(host)
  ){
    return 24;
  }

  if(
    /(?:^|\.)rozetka\.com\.ua$/.test(host) ||
    /(?:^|\.)silpo\.ua$/.test(host) ||
    /(?:^|\.)vino\.ua$/.test(host)
  ){
    return 18;
  }

  return 0;
}

function extractPageImages(
  markdownOrHtml: string,
  pageUrl: string
): ImageCandidate[] {

  const out: ImageCandidate[] = [];
  const seen =
    new Set<string>();

  const authority =
    pageSourceAuthority(
      pageUrl
    );

  const add = (
    raw: string,
    role: string,
    priority: number
  ) => {

    const image =
      absoluteImageUrl(
        raw,
        pageUrl
      );

    if(
      !image ||
      !/^https?:\/\//i.test(
        image
      )
    ){
      return;
    }

    const key =
      image.toLowerCase();

    if(
      seen.has(key)
    ){
      return;
    }

    seen.add(key);

    out.push({
      image_url:
        image,
      page_url:
        pageUrl,
      title:
        pageUrl,
      source:
        "jina-page-image",
      image_role:
        role,
      page_priority:
        priority,
      source_authority:
        authority
    });

  };

  const meta =
    /<(?:meta)[^>]+(?:property|name)=["'](?:og:image|twitter:image|twitter:image:src)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;

  let m:
    RegExpExecArray | null;

  while(
    (m =
      meta.exec(
        markdownOrHtml
      )) !== null
  ){

    add(
      m[1],
      "og-image",
      34
    );

  }

  const json =
    /"(?:image|image_url|contentUrl|thumbnailUrl)"\s*:\s*(?:"([^"]+)"|\[([^\]]+)\])/gi;

  while(
    (m =
      json.exec(
        markdownOrHtml
      )) !== null
  ){

    if(
      clean(
        m[1] ||
        ""
      )
    ){

      add(
        m[1],
        "product-jsonld-image",
        30
      );

    }

    const list =
      m[2] ||
      "";

    const urls =
      list.match(
        /"(https?:\/\/[^"]+)"/gi
      ) || [];

    urls.forEach(
      raw => {

        add(
          raw.replace(
            /^"|"$/g,
            ""
          ),
          "product-jsonld-image",
          30
        );

      }
    );

  }

  const md =
    /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/gi;

  let mdIndex = 0;

  while(
    (m =
      md.exec(
        markdownOrHtml
      )) !== null
  ){

    add(
      m[1],
      mdIndex === 0
        ? "markdown-main-image"
        : "page-gallery-image",
      mdIndex === 0
        ? 22
        : 6
    );

    mdIndex++;

  }

  const direct =
    /https?:\/\/[^\s"'<>()[\]]+?\.(?:jpg|jpeg|png|webp|avif)(?:\?[^\s"'<>()[\]]*)?/gi;

  while(
    (m =
      direct.exec(
        markdownOrHtml
      )) !== null
  ){

    add(
      m[0],
      "page-direct-image",
      2
    );

    if(
      out.length >=
      30
    ){
      break;
    }

  }

  return out;
}

function pageIdentityScore(
  page: { title: string; url: string; snippet?: string },
  item: IncomingItem,
): number {
  const text = [
    page.title,
    page.url,
    page.snippet || "",
  ].join(" ");

  const aliases = searchAliases(item);
  let best = 0;

  for (const alias of aliases) {
    const a = normalizeSearch(alias);
    const t = normalizeSearch(text);
    if (!a) continue;
    best = Math.max(
      best,
      t.includes(a)
        ? 1
        : similarity(alias, text)
    );
  }

  return best;
}


async function bingWebPagesHtml(query: string) {
  const endpoint =
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=uk-UA&cc=UA`;

  const response =
    await fetchWithTimeout(
      endpoint,
      {
        method:"GET",
        redirect:"follow",
        headers:{
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 SERVISIUM/43.0",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language":
            "uk-UA,uk;q=0.9,en;q=0.7",
          "Cache-Control":
            "no-cache"
        }
      },
      SEARCH_TIMEOUT_MS
    );

  if(!response || !response.ok){
    return [];
  }

  const html =
    await response.text();

  const out = [];
  const seen = new Set<string>();

  // Standard Bing result blocks.
  const blocks =
    html.match(
      /<li[^>]+class=["'][^"']*\bb_algo\b[^"']*["'][\s\S]*?<\/li>/gi
    ) || [];

  for(const block of blocks){

    const href =
      block.match(
        /<a[^>]+href=["']([^"']+)["']/i
      )?.[1] || "";

    const pageUrl =
      normalizeUrl(
        decodeURIComponent(
          href
        )
      );

    if(!pageUrl) continue;

    const title =
      stripHtml(
        block.match(
          /<h2[^>]*>[\s\S]*?<\/h2>/i
        )?.[0] || ""
      );

    const snippet =
      stripHtml(
        block.match(
          /<p[^>]*>[\s\S]*?<\/p>/i
        )?.[0] || ""
      );

    const key =
      pageUrl.toLowerCase();

    if(seen.has(key)) continue;

    seen.add(key);

    out.push({
      url:pageUrl,
      title,
      snippet,
      source:"bing-web-html"
    });

    if(out.length >= 12){
      break;
    }

  }

  // Fallback for result markup variants.
  if(!out.length){

    const links =
      html.matchAll(
        /<a[^>]+href=["'](https?:\/\/[^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi
      );

    for(const match of links){

      const pageUrl =
        normalizeUrl(
          match[1]
        );

      if(!pageUrl) continue;

      if(
        /bing\.com|microsoft\.com/i.test(
          pageUrl
        )
      ){
        continue;
      }

      const title =
        stripHtml(
          match[2]
        );

      const key =
        pageUrl.toLowerCase();

      if(seen.has(key)) continue;

      seen.add(key);

      out.push({
        url:pageUrl,
        title,
        snippet:"",
        source:"bing-web-generic"
      });

      if(out.length >= 12){
        break;
      }

    }

  }

  return out;
}

async function bingWebPages(query: string) {
  const endpoint =
    `https://www.bing.com/search?format=rss&setlang=uk-UA&cc=UA&q=${encodeURIComponent(query)}`;

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 SERVISIUM/43.0",
        Accept:
          "application/rss+xml,application/xml,text/xml,*/*;q=0.8",
      },
    },
    SEARCH_TIMEOUT_MS
  );

  if (!response || !response.ok) return [];

  const xml = await response.text();
  const out = [];

  const blocks =
    xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];

  for (const block of blocks) {
    const link =
      block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ||
      block.match(/<guid[^>]*>([\s\S]*?)<\/guid>/i)?.[1] ||
      "";

    const pageUrl =
      normalizeUrl(link);

    if (!pageUrl) continue;

    const title =
      stripHtml(
        block.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""
      );

    const snippet =
      stripHtml(
        block.match(/<description[^>]*>([\s\S]*?)<\/description>/i)?.[1] || ""
      );

    out.push({
      url: pageUrl,
      title,
      snippet,
      source: "bing-web",
    });

    if (out.length >= 15) break;
  }

  return out;
}


function extractSearchCodes(
  item: IncomingItem
): string[] {

  const raw = [
    clean(item.source_id),
    clean(item.external_id),
    clean(item.description),
    clean(item.name || item.title)
  ].join(" ");

  const codes =
    raw.match(
      /\b\d{8,14}\b/g
    ) || [];

  return [
    ...new Set(
      codes
    )
  ].slice(
    0,
    4
  );
}

function retailerQueries(
  item: IncomingItem
): string[] {

  const aliases =
    searchAliases(
      item
    );

  const main =
    clean(
      item.name ||
      item.title
    );

  const english =
    aliases.find(
      x =>
        /[A-Za-z]{3,}/.test(x) &&
        x.length <= 100 &&
        !/^(beer|wine|bottle|product|500 ml|330 ml|750 ml)$/i.test(x)
    ) ||
    transliterate(
      main
    );

  const producers =
    extractProducerAliases(
      item
    );

  const volume =
    expectedVolumeMl(
      item
    );

  const volumeText =
    volume
      ? `${volume} ml`
      : "";

  /*
    These are discovery targets, not trusted content sources.
    Jina later reads the actual product page and extracts its own
    image fields.
  */
  const sites = [
    "site:goodwine.com.ua",
    "site:rozetka.com.ua",
    "site:silpo.ua",
    "site:vino.ua",
    "site:sabotage.wine",
    "site:kolonist.com.ua",
    "site:beykush.com",
    "site:sass-k-winery.com"
  ];

  const out:string[] = [];

  for(
    const site of
    sites
  ){

    out.push(
      `${site} "${main}" ${volumeText}`
        .replace(
          /\s+/g,
          " "
        )
        .trim()
    );

    if(
      english !== main
    ){

      out.push(
        `${site} "${english}" ${volumeText}`
          .replace(
            /\s+/g,
            " "
          )
          .trim()
      );

    }

  }

  for(
    const producer of
    producers.slice(
      0,
      2
    )
  ){

    out.push(
      `site:goodwine.com.ua "${producer}" "${english}" ${volumeText}`
        .replace(/\s+/g," ")
        .trim()
    );

    out.push(
      `site:rozetka.com.ua "${producer}" "${main}" ${volumeText}`
        .replace(/\s+/g," ")
        .trim()
    );

  }

  for(
    const code of
    extractSearchCodes(
      item
    )
  ){

    out.push(
      `"${code}" ${main} bottle`
    );

  }

  return [
    ...new Set(
      out
    )
  ]
    .filter(Boolean)
    .slice(
      0,
      14
    );

}

async function jinaPageImages(
  pageUrl: string,
): Promise<ImageCandidate[]> {
  const endpoint =
    `https://r.jina.ai/${pageUrl}`;

  const response = await fetchWithTimeout(
    endpoint,
    {
      method: "GET",
      headers: {
        "User-Agent":
          "SERVISIUM/43.0",
        Accept:
          "text/markdown,text/plain;q=0.9,*/*;q=0.7",
        "X-Retain-Images":
          "true",
        "X-Retain-Links":
          "true",
      },
    },
    16000
  );

  if (!response || !response.ok) {
    return [];
  }

  const text =
    await response.text();

  return extractPageImages(
    text,
    pageUrl
  );
}

function buildQueries(item: IncomingItem): string[] {
  return buildHighRecallQueries(item);
}


async function deepProductPageSearch(
  item: IncomingItem
): Promise<FoundPhoto | null> {

  const queries =
    retailerQueries(
      item
    ).slice(
      0,
      6
    );

  if(
    !queries.length
  ){
    return null;
  }

  const pageLists =
    await Promise.all(
      queries.map(
        query =>
          bingWebPagesHtml(
            query
          )
      )
    );

  const pages =
    pageLists
      .flat()
      .filter(Boolean);

  const uniquePages =
    [
      ...new Map(
        pages.map(
          page =>
            [
              String(
                page.url
              ).toLowerCase(),
              page
            ]
        )
      ).values()
    ]
      .map(
        page => ({
          page,
          identity:
            pageIdentityScore(
              page,
              item
            )
        })
      )
      .filter(
        entry =>
          entry.identity >=
          0.45
      )
      .sort(
        (a,b) =>
          b.identity -
          a.identity
      )
      .slice(
        0,
        8
      );

  if(
    !uniquePages.length
  ){
    return null;
  }

  const pageResults =
    await Promise.all(
      uniquePages
        .slice(
          0,
          4
        )
        .map(
          entry =>
            jinaPageImages(
              entry.page.url
            )
        )
    );

  const candidates =
    pageResults
      .flat()
      .filter(Boolean);

  const pool =
    new Map<
      string,
      ImageCandidate
    >();

  for(
    const candidate of
    candidates
  ){

    const image =
      normalizeUrl(
        candidate.image_url
      );

    if(!image){
      continue;
    }

    const key =
      image.toLowerCase();

    if(
      !pool.has(
        key
      )
    ){

      pool.set(
        key,
        {
          ...candidate,
          image_url:
            image,
          download_url:
            normalizeUrl(
              candidate.download_url ||
              ""
            ) ||
            undefined
        }
      );

    }

  }

  const rows =
    [...pool.values()]
      .map(
        candidate => {

          const base =
            scoreCandidate(
              candidate,
              item
            );

          const wholeText =
            /\b(full bottle|whole bottle|front bottle|product photo|product image|product shot|packshot|bottle|пляшка|бутылка)\b/i
              .test(
                [
                  candidate.title,
                  candidate.page_url,
                  candidate.image_url
                ].join(" ")
              );

          let score =
            base.score;

          if(
            wholeText
          ){
            score += 14;
          }

          const expected =
            expectedVolumeMl(
              item
            );

          const actual =
            candidateVolumeMl(
              candidate
            );

          if(
            expected !== null &&
            actual === expected
          ){
            score += 16;
          }

          if(
            expected !== null &&
            actual !== null &&
            actual !== expected
          ){
            score -= 50;
          }

          return {
            candidate,
            score:
              Math.max(
                0,
                Math.min(
                  100,
                  Math.round(
                    score
                  )
                )
              ),
            hardReject:
              base.hardReject
          };

        }
      )
      .filter(
        row =>
          !row.hardReject
      )
      .sort(
        (a,b) =>
          b.score -
          a.score
      );

  const selected =
    rows.find(
      row =>
        row.score >=
        58
    );

  if(
    !selected
  ){
    return null;
  }

  const candidate =
    selected.candidate;

  return {
    url:
      candidate.image_url,
    download_urls:[
      candidate.image_url,
      ...(candidate.download_url
        ? [
            candidate.download_url
          ]
        : [])
    ],
    source:
      `${candidate.source}:deep-product-v30`,
    confidence:
      selected.score
  };

}



async function findBetterExistingPhoto(
  item: IncomingItem
): Promise<FoundPhoto | null> {

  if(
    !isAlcoholItem(
      item
    ) ||
    !clean(
      item.photo_url
    )
  ){
    return null;
  }

  const currentUrl =
    normalizeUrl(
      item.photo_url
    );

  /*
    V40: use the existing retailerQueries() list.
    This is the key fix over V39, which only used 3 generic queries.
  */
  const queries =
    retailerQueries(
      item
    ).slice(
      0,
      10
    );

  if(
    !queries.length
  ){
    return null;
  }

  const pageLists =
    await Promise.all(
      queries.map(
        query =>
          bingWebPagesHtml(
            query
          )
      )
    );

  const pages =
    pageLists
      .flat()
      .filter(Boolean);

  const uniquePages =
    [
      ...new Map(
        pages.map(
          page =>
            [
              String(
                page.url
              ).toLowerCase(),
              page
            ]
        )
      ).values()
    ]
      .map(
        page => ({
          page,
          identity:
            pageIdentityScore(
              page,
              item
            )
        })
      )
      .filter(
        entry =>
          entry.identity >=
          0.58
      )
      .sort(
        (a,b) =>
          b.identity -
          a.identity
      )
      .slice(
        0,
        8
      );

  if(
    !uniquePages.length
  ){
    return null;
  }

  const pageImageLists =
    await Promise.all(
      uniquePages.map(
        entry =>
          jinaPageImages(
            entry.page.url
          )
      )
    );

  const pool =
    new Map<
      string,
      ImageCandidate
    >();

  pageImageLists.forEach(
    (
      list,
      pageIndex
    ) => {

      const entry =
        uniquePages[
          pageIndex
        ];

      list.forEach(
        candidate => {

          const image =
            normalizeUrl(
              candidate.image_url
            );

          if(
            !image
          ){
            return;
          }

          /*
            Never select the exact current image again.
          */
          if(
            currentUrl &&
            image ===
              currentUrl
          ){
            return;
          }

          const key =
            image.toLowerCase();

          if(
            pool.has(
              key
            )
          ){
            return;
          }

          /*
            The previous parser only knew pageUrl.
            Attach the actual result title/snippet so product identity
            is evaluated against the page that produced the image.
          */
          const enrichedCandidate = {
            ...candidate,
            image_url:
              image,
            page_url:
              entry.page.url,
            title:
              [
                entry.page.title,
                entry.page.snippet ||
                  "",
                candidate.title ||
                  ""
              ]
                .join(" ")
                .trim(),
            source_authority:
              Math.max(
                Number(
                  candidate.source_authority ||
                  0
                ),
                pageSourceAuthority(
                  entry.page.url
                )
              ),
            page_priority:
              Math.max(
                Number(
                  candidate.page_priority ||
                  0
                ),
                entry.identity >= 0.86
                  ? 26
                  : entry.identity >= 0.75
                    ? 20
                    : 10
              )
          };

          pool.set(
            key,
            enrichedCandidate
          );

        }
      );

    }
  );

  const rows =
    [...pool.values()]
      .map(
        candidate => {

          const scored =
            scoreCandidate(
              candidate,
              item
            );

          const pageIdentity =
            Math.max(
              ...uniquePages
                .filter(
                  entry =>
                    String(
                      entry.page.url
                    ).toLowerCase() ===
                    String(
                      candidate.page_url
                    ).toLowerCase()
                )
                .map(
                  entry =>
                    entry.identity
                ),
              0
            );

          let quality =
            scored.score +
            Math.round(
              pageIdentity *
              24
            );

          /*
            Main page image is what the waiter needs.
            Prefer hero/OG/JSON-LD/main product photo.
          */
          if(
            candidate.image_role ===
            "og-image"
          ){
            quality += 24;
          }

          if(
            candidate.image_role ===
            "product-jsonld-image"
          ){
            quality += 22;
          }

          if(
            candidate.image_role ===
            "markdown-main-image"
          ){
            quality += 16;
          }

          if(
            candidate.image_role ===
            "page-gallery-image"
          ){
            quality += 4;
          }

          const text =
            [
              candidate.title,
              candidate.page_url,
              candidate.image_url
            ].join(" ");

          if(
            /\b(front|front-facing|hero|main|product image|product photo)\b/i
              .test(
                text
              )
          ){
            quality += 12;
          }

          if(
            /\b(rear|back|reverse|rear label|back label|back of bottle|задня|зворотна)\b/i
              .test(
                text
              )
          ){
            quality -= 80;
          }

          if(
            /\b(label only|label-only|label detail|close[\s-]?up|closeup|neck|bottle neck|cropped|crop|горлечко|шийка)\b/i
              .test(
                text
              )
          ){
            quality -= 80;
          }

          return {
            candidate,
            quality:
              Math.max(
                0,
                Math.min(
                  100,
                  Math.round(
                    quality
                  )
                )
              ),
            pageIdentity,
            hardReject:
              scored.hardReject
          };

        }
      )
      .filter(
        row =>
          !row.hardReject
      )
      .sort(
        (a,b) =>
          b.quality -
          a.quality
      );

  /*
    IMPORTANT:
    A replacement is allowed when the page is clearly about the exact
    product AND its main image is available. This was intentionally too
    strict in V39.
  */
  const best =
    rows.find(
      row =>
        (
          row.pageIdentity >=
            0.82 &&
          (
            row.candidate.image_role ===
              "og-image" ||
            row.candidate.image_role ===
              "product-jsonld-image" ||
            row.candidate.image_role ===
              "markdown-main-image"
          ) &&
          row.quality >=
            68
        ) ||
        (
          row.pageIdentity >=
            0.76 &&
          row.quality >=
            74
        )
    );

  if(
    !best
  ){
    return null;
  }

  return {
    url:
      best.candidate.image_url,
    download_urls:[
      best.candidate.image_url,
      ...(best.candidate.download_url
        ? [
            best.candidate.download_url
          ]
        : [])
    ],
    source:
      "quality-audit-v40-real-product-replacement",
    confidence:
      best.quality
  };

}


const GEMINI_VISION_MODEL =
  "gemini-3.1-flash-lite";

function getGeminiApiKey(): string {
  return clean(
    Deno.env.get(
      "GEMINI_API_KEY"
    ) ||
    Deno.env.get(
      "GOOGLE_AI_API_KEY"
    ) ||
    ""
  );
}

function bytesToBase64(
  bytes: Uint8Array
): string {

  let binary = "";

  const CHUNK = 0x8000;

  for(
    let i = 0;
    i < bytes.length;
    i += CHUNK
  ){

    binary += String.fromCharCode(
      ...bytes.subarray(
        i,
        Math.min(
          i + CHUNK,
          bytes.length
        )
      )
    );

  }

  return btoa(
    binary
  );

}

async function fetchVisionImage(
  sourceUrl: string
): Promise<{
  bytes: Uint8Array;
  mimeType: string;
  finalUrl: string;
} | null> {

  const normalized =
    normalizeUrl(
      sourceUrl
    );

  if(
    !normalized
  ){
    return null;
  }

  const encoded =
    encodeURIComponent(
      normalized
    );

  /*
    Always try a small JPEG proxy first. This keeps the multimodal request
    compact and handles WebP/AVIF/large source images without adding a decoder
    dependency to the Edge runtime.
  */
  const candidates = [
    `https://wsrv.nl/?url=${encoded}&w=768&output=jpg&q=72`,
    `https://images.weserv.nl/?url=${encoded}&w=768&output=jpg&q=72`,
    normalized
  ];

  for(
    const candidate of
    [...new Set(candidates)]
  ){

    const response =
      await fetchWithTimeout(
        candidate,
        {
          method:"GET",
          redirect:"follow",
          headers:{
            "User-Agent":
              "Mozilla/5.0 SERVISIUM/43.0",
            Accept:
              "image/jpeg,image/png,image/webp,image/avif,*/*;q=0.8"
          }
        },
        12000
      );

    if(
      !response ||
      !response.ok
    ){
      continue;
    }

    const mime =
      clean(
        response.headers.get(
          "content-type"
        )
      ).toLowerCase();

    if(
      !mime.startsWith(
        "image/"
      )
    ){
      continue;
    }

    try{

      const bytes =
        new Uint8Array(
          await response.arrayBuffer()
        );

      if(
        !bytes.length ||
        bytes.length >
          900 * 1024
      ){
        continue;
      }

      return {
        bytes,
        mimeType:
          mime.includes("jpeg")
            ? "image/jpeg"
            : mime,
        finalUrl:
          clean(
            response.url
          ) ||
          candidate
      };

    }catch{
      continue;
    }

  }

  return null;

}

function visionCandidateText(
  candidate: ImageCandidate
): string {

  return [
    candidate.title || "",
    candidate.page_url || "",
    candidate.image_url || "",
    candidate.source || "",
    candidate.image_role || ""
  ]
    .join(" ")
    .trim();

}

async function collectVisionCandidates(
  item: IncomingItem
): Promise<ImageCandidate[]> {

  const currentUrl =
    normalizeUrl(
      item.photo_url
    );

  const pool =
    new Map<string, ImageCandidate>();

  const add = (
    candidate: ImageCandidate
  ) => {
    const image =
      normalizeUrl(candidate.image_url);

    if(!image) return;

    if(
      currentUrl &&
      image === currentUrl
    ){
      return;
    }

    const key =
      image.toLowerCase();

    if(!pool.has(key)){
      pool.set(key, {
        ...candidate,
        image_url:image
      });
    }
  };

  /*
    0. Existing Expz source image is a candidate, never an automatic truth.
    Gemini must visually approve it before it is stored/replaced.
  */
  for(
    const sourceUrl of [
      item.image_url,
      item.thumbnail_url
    ]
  ){
    const image =
      normalizeUrl(sourceUrl);

    if(image){
      add({
        image_url:image,
        page_url:"",
        title:
          clean(
            item.name ||
            item.title
          ),
        source:"expz-source-candidate",
        image_role:"source-image",
        page_priority:36,
        source_authority:12
      });
    }
  }

  /*
    1. Exact product pages from known Ukrainian retailers / producers.
  */
  const retailerQueriesForAudit =
    retailerQueries(item).slice(0, 6);

  const pageLists =
    await Promise.all(
      retailerQueriesForAudit.map(
        query => bingWebPagesHtml(query)
      )
    );

  const uniquePages =
    [
      ...new Map(
        pageLists
          .flat()
          .filter(Boolean)
          .map(page => [
            String(page.url).toLowerCase(),
            page
          ])
      ).values()
    ]
      .map(page => ({
        page,
        identity:
          pageIdentityScore(page, item)
      }))
      .filter(
        entry =>
          entry.identity >= 0.55
      )
      .sort(
        (a,b) =>
          b.identity - a.identity
      )
      .slice(0, 6);

  const pageImages =
    await Promise.all(
      uniquePages.map(
        entry =>
          jinaPageImages(entry.page.url)
      )
    );

  pageImages.forEach(
    (list, pageIndex) => {
      const entry =
        uniquePages[pageIndex];

      list.forEach(candidate => {
        add({
          ...candidate,
          page_url:
            entry.page.url,
          title:[
            entry.page.title || "",
            entry.page.snippet || "",
            candidate.title || ""
          ]
            .join(" ")
            .trim(),
          source_authority:
            Math.max(
              Number(
                candidate.source_authority || 0
              ),
              pageSourceAuthority(
                entry.page.url
              )
            ),
          page_priority:
            Math.max(
              Number(
                candidate.page_priority || 0
              ),
              entry.identity >= 0.85
                ? 30
                : entry.identity >= 0.75
                  ? 22
                  : 12
            )
        });
      });
    }
  );

  /*
    2. General image engines.
  */
  const queries =
    buildHighRecallQueries(item).slice(0, 3);

  const [
    bingLists,
    ddgLists
  ] = await Promise.all([
    Promise.all(
      queries.map(query => bingImages(query))
    ),
    Promise.all(
      queries.map(query => duckDuckGoImages(query))
    )
  ]);

  bingLists.forEach(list => list.forEach(add));
  ddgLists.forEach(list => list.forEach(add));

  /*
    3. Meta/image indexes only when the first pool is weak.
  */
  if(pool.size < 8){
    const [
      searx,
      off,
      wiki
    ] = await Promise.all([
      searxImageSearch(item),
      openFoodFactsSearch(item),
      wikimediaSearch(item)
    ]);

    searx.forEach(add);
    off.forEach(add);
    wiki.forEach(add);
  }

  const ranked =
    [...pool.values()]
      .map(candidate => ({
        candidate,
        score:
          scoreCandidate(candidate, item)
      }))
      .filter(
        row =>
          !row.score.hardReject
      )
      .sort(
        (a,b) =>
          b.score.score -
          a.score.score
      );

  return ranked
    .slice(0, MAX_VISION_CANDIDATES)
    .map(row => row.candidate);
}

async function callGeminiVision(
  itemGroup: Array<{
    itemIndex: number;
    item: IncomingItem;
    current: string;
    candidates: ImageCandidate[];
  }>
): Promise<Array<{
  item_index:number;
  recommendation:
    "KEEP" |
    "REPLACE" |
    "NO_SAFE_ALT";
  replacement_index:number;
  confidence:number;
  product_match:boolean;
  whole_product:boolean;
  front_view:boolean;
  single_item:boolean;
  current_wrong_reason:string;
}>> {

  const apiKey =
    getGeminiApiKey();

  if(!apiKey){
    throw new Error(
      "GEMINI_API_KEY is not configured in Supabase Secrets."
    );
  }

  const parts:any[] = [];

  /*
    Legacy generateContent structured output schema.
    Do NOT use responseFormat.text.mimeType here: this Edge function
    talks directly to the legacy generateContent REST endpoint and the
    stable REST configuration is responseMimeType + responseSchema.
  */
  const schema = {
    type:"object",
    properties:{
      results:{
        type:"array",
        items:{
          type:"object",
          properties:{
            item_index:{type:"integer"},
            recommendation:{
              type:"string",
              enum:[
                "KEEP",
                "REPLACE",
                "NO_SAFE_ALT"
              ]
            },
            replacement_index:{
              type:"integer"
            },
            confidence:{
              type:"integer",
              minimum:0,
              maximum:100
            },
            product_match:{
              type:"boolean"
            },
            whole_product:{
              type:"boolean"
            },
            front_view:{
              type:"boolean"
            },
            single_item:{
              type:"boolean"
            },
            current_wrong_reason:{
              type:"string"
            }
          },
          required:[
            "item_index",
            "recommendation",
            "replacement_index",
            "confidence",
            "product_match",
            "whole_product",
            "front_view",
            "single_item",
            "current_wrong_reason"
          ]
        }
      }
    },
    required:["results"]
  };

  parts.push({
    text:
`Ти — VISUAL QUALITY GATE для ресторанної системи SERVISIUM.

Ти перевіряєш ТІЛЬКИ алкогольні товари BAR. КУХНЮ НЕ ЧІПАЙ.
Коктейлі та безалкогольні позиції також не чіпай.

Для кожного ITEM:
1. Визнач, чи CURRENT PHOTO показує саме названий товар.
2. Правильне фото: одна ціла пляшка/банка, повністю видима тара,
   бажано фронт або корисний 3/4 ракурс із видимою лицьовою етикеткою.
3. Заборонено приймати: інший продукт, інший алкоголь, іншу версію/об'єм,
   задню сторону, задню етикетку, label-only, close-up, тільки горлечко,
   пляшку в руці, групу пляшок, коробку/ящик, келих, наливання,
   коктейль, меню або рекламний банер без самого товару.
4. Назва/URL самі по собі НЕ є доказом. Порівнюй форму тари, колір,
   етикетку, бренд, назву та інші видимі ознаки.
5. Якщо CURRENT PHOTO неправильне, але серед кандидатів немає безпечної
   точної заміни — NO_SAFE_ALT.
6. Якщо CURRENT PHOTO відсутнє, використовуй REPLACE тільки тоді,
   коли один із кандидатів візуально підтверджує ТОЧНИЙ товар.
7. Для REPLACE replacement_index — номер кандидата 1..N.
8. Для KEEP replacement_index = 0.
9. Для NO_SAFE_ALT replacement_index = 0.
10. confidence 85+ потрібен для автоматичної заміни.
11. Не вгадуй. Краще NO_SAFE_ALT, ніж неправильна пляшка.
12. Поверни тільки JSON за схемою.`
  });

  for(const group of itemGroup){
    parts.push({
      text:
        `\n=== ITEM ${group.itemIndex} ===\n` +
        `PRODUCT: ${clean(
          group.item.name ||
          group.item.title
        )}\n` +
        `CURRENT PHOTO INDEX: 0\n` +
        `CANDIDATES FOLLOW WITH THEIR INDEX NUMBERS.`
    });

    if(group.current){
      const current =
        await fetchVisionImage(group.current);

      if(current){
        parts.push({
          text:"CURRENT PHOTO 0:"
        });
        parts.push({
          inline_data:{
            mime_type:current.mimeType,
            data:bytesToBase64(current.bytes)
          }
        });
      }else{
        parts.push({
          text:
            "CURRENT PHOTO 0: unavailable."
        });
      }
    }else{
      parts.push({
        text:
          "CURRENT PHOTO 0: MISSING — choose a candidate only if exact product is visually confirmed."
      });
    }

    let candidateNumber = 1;

    for(const candidate of group.candidates){
      parts.push({
        text:
          `CANDIDATE ${candidateNumber}:\n` +
          `CONTEXT: ${visionCandidateText(candidate)}`
      });

      const image =
        await fetchVisionImage(
          candidate.download_url ||
          candidate.image_url
        );

      if(image){
        parts.push({
          inline_data:{
            mime_type:image.mimeType,
            data:bytesToBase64(image.bytes)
          }
        });
      }else{
        parts.push({
          text:
            `CANDIDATE ${candidateNumber}: image unavailable.`
        });
      }

      candidateNumber++;
    }
  }

  const response =
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_VISION_MODEL}:generateContent`,
      {
        method:"POST",
        headers:{
          "Content-Type":"application/json",
          "x-goog-api-key":apiKey
        },
        body:JSON.stringify({
          contents:[
            {
              role:"user",
              parts
            }
          ],
          generationConfig:{
            temperature:0,
            maxOutputTokens:4096,
            responseMimeType:"application/json",
            responseSchema:schema
          }
        })
      }
    );

  const raw =
    await response.text();

  if(!response.ok){
    throw new Error(
      `Gemini Vision HTTP ${response.status}: ${raw.slice(0,1800)}`
    );
  }

  let jsonResponse:any = null;

  try{
    jsonResponse =
      raw ? JSON.parse(raw) : null;
  }catch{
    jsonResponse = null;
  }

  const text =
    jsonResponse
      ?.candidates?.[0]
      ?.content?.parts
      ?.find(
        part =>
          typeof part?.text === "string"
      )
      ?.text || "";

  if(!text){
    throw new Error(
      "Gemini Vision returned no structured text."
    );
  }

  const cleanedText =
    text
      .trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

  try{
    const parsed =
      JSON.parse(cleanedText);

    return Array.isArray(parsed?.results)
      ? parsed.results
      : [];
  }catch{
    throw new Error(
      `Gemini Vision structured response is not valid JSON: ${cleanedText.slice(0,500)}`
    );
  }
}

async function runVisionQualityAudit(
  items: IncomingItem[],
  restaurantId: string,
  supabaseAdmin: ReturnType<typeof createClient>
): Promise<{
  matches: Match[];
  checked:number;
  replacements:number;
}> {

  /*
    IMPORTANT:
    - only BAR alcohol is eligible;
    - kitchen is never searched, replaced or written;
    - items without a photo are also sent through the same visual gate,
      so the normal search engine cannot silently save a bad bottle.
  */
  const groups =
    items
      .map((item,index) => ({item,index}))
      .filter(
        entry =>
          isAlcoholItem(entry.item)
      );

  if(!groups.length){
    return {
      matches:[],
      checked:0,
      replacements:0
    };
  }

  const outputs:Match[] = [];
  let checked = 0;
  let replacements = 0;

  for(
    let start = 0;
    start < groups.length;
    start += MAX_VISION_ITEMS_PER_REQUEST
  ){

    const batch =
      groups.slice(
        start,
        start + MAX_VISION_ITEMS_PER_REQUEST
      );

    const visionGroups:any[] = [];

    for(const entry of batch){
      const candidates =
        await collectVisionCandidates(
          entry.item
        );

      visionGroups.push({
        itemIndex:entry.index,
        item:entry.item,
        current:
          clean(entry.item.photo_url),
        candidates
      });
    }

    const decisions =
      await callGeminiVision(
        visionGroups
      );

    checked += batch.length;

    for(const decision of decisions){
      const group =
        visionGroups.find(
          g =>
            g.itemIndex ===
            Number(decision.item_index)
        );

      if(!group) continue;

      const recommendation =
        decision.recommendation;

      /* KEEP is meaningful only when a current photo exists. */
      if(
        recommendation === "KEEP" &&
        group.current
      ){
        continue;
      }

      if(recommendation !== "REPLACE"){
        continue;
      }

      const index =
        Number(decision.replacement_index);

      if(
        !Number.isInteger(index) ||
        index < 1 ||
        index > group.candidates.length ||
        Number(decision.confidence) < 85 ||
        !decision.product_match ||
        !decision.whole_product ||
        !decision.front_view ||
        !decision.single_item
      ){
        continue;
      }

      const selected =
        group.candidates[index - 1];

      if(!selected) continue;

      for(
        const candidateUrl of [
          selected.download_url,
          selected.image_url
        ].filter(Boolean)
      ){
        const stored =
          await storePhoto(
            candidateUrl,
            group.item,
            restaurantId,
            supabaseAdmin
          );

        if(stored){
          outputs.push({
            name:clean(
              group.item.name ||
              group.item.title
            ),
            photo_url:stored,
            photo_source:"servisium-storage",
            source:
              group.current
                ? "gemini-vision-v43-replacement"
                : "gemini-vision-v43-new-photo",
            confidence:
              Number(decision.confidence)
          } satisfies Match);

          replacements++;
          break;
        }
      }
    }
  }

  return {
    matches:outputs,
    checked,
    replacements
  };
}

async function findPhoto(
  item: IncomingItem
): Promise<FoundPhoto> {

  if (
    !isAlcoholItem(
      item
    )
  ) {
    return {
      url:"",
      download_urls:[],
      source:
        "skipped-non-alcohol",
      confidence:0
    };
  }

  const existingStorage =
    normalizeUrl(
      item.photo_url
    );

  if (
    existingStorage &&
    /\/storage\/v1\/object\/public\//i.test(
      existingStorage
    )
  ) {
    return {
      url:
        existingStorage,
      download_urls:[
        existingStorage
      ],
      source:
        "existing-servisium-storage",
      confidence:100
    };
  }

  const sourceImages = [
    normalizeUrl(
      item.image_url
    ),
    normalizeUrl(
      item.thumbnail_url
    ),
    normalizeUrl(
      item.photo_url
    ),
  ]
    .filter(Boolean)
    .filter(
      (u) =>
        !/\/storage\/v1\/object\/public\//i.test(
          u
        )
    );

  /*
    Keep exact Expz source images authoritative.
  */
  if (
    sourceImages.length
  ) {
    return {
      url:
        sourceImages[0],
      download_urls:[
        ...new Set(
          sourceImages
        )
      ],
      source:
        "expz-source-image",
      confidence:98
    };
  }

  const pool =
    new Map<
      string,
      ImageCandidate
    >();

  const addCandidates =
    (
      list: ImageCandidate[]
    ) => {

      for(
        const candidate of
        list
      ){

        const image =
          normalizeUrl(
            candidate.image_url
          );

        if(!image){
          continue;
        }

        const key =
          image.toLowerCase();

        if(
          !pool.has(key)
        ){

          pool.set(
            key,
            {
              ...candidate,
              image_url:
                image,
              download_url:
                normalizeUrl(
                  candidate.download_url ||
                  ""
                ) ||
                undefined
            }
          );

        }

      }

    };

  const ranked =
    () =>
      [...pool.values()]
        .map(
          candidate => ({
            candidate,
            ...scoreCandidate(
              candidate,
              item
            )
          })
        )
        .sort(
          (a,b) =>
            b.score -
            a.score
        );

  const acceptBest =
    (
      minimum:number,
      sourcePrefix:string
    ):FoundPhoto | null => {

      const rows =
        ranked();

      const found =
        rows.find(
          row =>
            !row.hardReject &&
            row.score >=
            minimum
        );

      if(!found){
        return null;
      }

      return {
        url:
          found.candidate.image_url,
        download_urls:[
          found.candidate.image_url,
          ...(found.candidate.download_url
            ? [
                found.candidate.download_url
              ]
            : [])
        ],
        source:
          `${found.candidate.source}:${sourcePrefix}`,
        confidence:
          found.score
      };

    };

  /*
    PASS 1 — the proven V24 search strategy.
    Do NOT replace its broad queries with restrictive negative-word queries.
  */
  const primaryQueries =
    buildHighRecallQueries(
      item
    );

  for(
    const query of
    primaryQueries.slice(
      0,
      2
    )
  ){

    addCandidates(
      await duckDuckGoImages(
        query
      )
    );

    const ddg =
      acceptBest(
        70,
        "whole-bottle-preferred"
      );

    if(ddg){
      return ddg;
    }

  }

  for(
    const query of
    primaryQueries.slice(
      0,
      3
    )
  ){

    addCandidates(
      await bingImages(
        query
      )
    );

    const bing =
      acceptBest(
        70,
        "whole-bottle-preferred"
      );

    if(bing){
      return bing;
    }

  }

  /*
    PASS 2 — only when the standard V24 search didn't return a suitable
    candidate. This raises the probability of a whole front-facing product
    shot without sacrificing the original recall.
  */
  const wholeQueries =
    buildWholeBottleFallbackQueries(
      item
    );

  for(
    const query of
    wholeQueries.slice(
      0,
      3
    )
  ){

    addCandidates(
      await bingImages(
        query
      )
    );

    const whole =
      acceptBest(
        64,
        "whole-bottle-second-pass"
      );

    if(whole){
      return whole;
    }

  }

  /*
    SearXNG meta-search.
  */
  addCandidates(
    await searxImageSearch(
      item
    )
  );

  const searx =
    acceptBest(
      58,
      "whole-bottle-preferred"
    );

  if(searx){
    return searx;
  }

  /*
    Open Food Facts.
  */
  addCandidates(
    await openFoodFactsSearch(
      item
    )
  );

  const off =
    acceptBest(
      62,
      "whole-bottle-preferred"
    );

  if(off){
    return off;
  }

  /*
    Wikimedia.
  */
  addCandidates(
    await wikimediaSearch(
      item
    )
  );

  const wiki =
    acceptBest(
      58,
      "whole-bottle-preferred"
    );

  if(wiki){
    return wiki;
  }

  /*
    Strong identity fallback. This is deliberately retained from the
    production-safe V24/V22 path so the whole-bottle preference cannot
    collapse the total photo count.
  */
  const identityRows =
    ranked();

  const strongIdentity =
    identityRows.find(
      row =>
        !row.hardReject &&
        row.score >= 56 &&
        Math.max(
          similarity(
            clean(
              item.name ||
              item.title
            ),
            [
              row.candidate.title,
              row.candidate.page_url,
              row.candidate.image_url
            ].join(" ")
          ),
          ...searchAliases(
            item
          ).map(
            alias =>
              normalizeSearch(
                [
                  row.candidate.title,
                  row.candidate.page_url,
                  row.candidate.image_url
                ].join(" ")
              ).includes(
                normalizeSearch(
                  alias
                )
              )
                ? 1
                : 0
          )
        ) >= 0.70
    );

  if(strongIdentity){

    return {
      url:
        strongIdentity.candidate.image_url,
      download_urls:[
        strongIdentity.candidate.image_url,
        ...(strongIdentity.candidate.download_url
          ? [
              strongIdentity.candidate.download_url
            ]
          : [])
      ],
      source:
        `${strongIdentity.candidate.source}:strong-identity-whole-bottle-preferred`,
      confidence:
        strongIdentity.score
    };

  }

  /*
    Deep product-page fallback.
  */
  const pageQuery =
    wholeQueries[0] ||
    primaryQueries[0] ||
    `"${clean(
      item.name ||
      item.title
    )}" product bottle`;

  const pages =
    await bingWebPagesHtml(
      pageQuery
    );

  const uniquePages =
    [
      ...new Map(
        pages.map(
          page =>
            [
              String(
                page.url
              ).toLowerCase(),
              page
            ]
        )
      ).values()
    ]
      .map(
        page => ({
          page,
          identity:
            pageIdentityScore(
              page,
              item
            )
        })
      )
      .filter(
        entry =>
          entry.identity >=
          0.50
      )
      .sort(
        (a,b) =>
          b.identity -
          a.identity
      )
      .slice(
        0,
        3
      );

  for(
    const entry of
    uniquePages
  ){

    addCandidates(
      await jinaPageImages(
        entry.page.url
      )
    );

    const page =
      acceptBest(
        52,
        "whole-bottle-product-page"
      );

    if(page){
      return page;
    }

  }

  /*
    V30 DEEP PRODUCT PAGE PASS:
    only for unresolved items after the normal V29 sources.
    This searches exact product pages across multiple Ukrainian retailers
    and manufacturer domains, then extracts actual page images.
  */
  const deep =
    await deepProductPageSearch(
      item
    );

  if(
    deep
  ){
    return deep;
  }

  return {
    url:"",
    download_urls:[],
    source:
      "free-search-exhausted-v30",
    confidence:0
  };

}

function buildImageProxyUrls(
  sourceUrl: string
): string[] {
  const normalized =
    normalizeUrl(sourceUrl);

  if(!normalized){
    return [];
  }

  const encoded =
    encodeURIComponent(
      normalized
    );

  return [
    `https://wsrv.nl/?url=${encoded}&w=1400&output=jpg&q=88`,
    `https://images.weserv.nl/?url=${encoded}&w=1400&output=jpg&q=88`
  ];
}

async function fetchImageBytes(
  sourceUrl: string
): Promise<{
  bytes: Uint8Array;
  contentType: string;
  finalUrl: string;
} | null> {

  const direct =
    normalizeUrl(
      sourceUrl
    );

  const candidates =
    [
      direct,
      ...buildImageProxyUrls(
        direct
      )
    ]
      .filter(Boolean);

  const unique =
    [
      ...new Set(
        candidates
      )
    ];

  for(
    const candidate of
    unique
  ){

    const response =
      await fetchWithTimeout(
        candidate,
        {
          method:"GET",
          redirect:"follow",
          headers:{
            "User-Agent":
              "Mozilla/5.0 SERVISIUM/43.0",
            Accept:
              "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
          }
        },
        IMAGE_TIMEOUT_MS
      );

    if(
      !response ||
      !response.ok
    ){
      continue;
    }

    const contentType =
      clean(
        response.headers.get(
          "content-type"
        )
      ).toLowerCase();

    if(
      !contentType.startsWith(
        "image/"
      )
    ){
      continue;
    }

    const contentLength =
      Number(
        response.headers.get(
          "content-length"
        ) || "0"
      );

    if(
      contentLength >
      MAX_IMAGE_BYTES
    ){
      continue;
    }

    try{

      const bytes =
        new Uint8Array(
          await response.arrayBuffer()
        );

      if(
        !bytes.length ||
        bytes.length >
          MAX_IMAGE_BYTES
      ){
        continue;
      }

      return {
        bytes,
        contentType,
        finalUrl:
          clean(
            response.url
          ) ||
          candidate
      };

    }catch{
      continue;
    }

  }

  return null;
}

async function storePhoto(
  sourceUrl: string,
  item: IncomingItem,
  restaurantId: string,
  supabaseAdmin: ReturnType<typeof createClient>
): Promise<string | null> {
  const normalized =
    normalizeUrl(sourceUrl);

  if (!normalized) return null;

  const downloaded =
    await fetchImageBytes(
      normalized
    );

  if(!downloaded){
    return null;
  }

  const {
    bytes,
    contentType,
    finalUrl
  } = downloaded;

  if(
    contentType.includes("svg") ||
    contentType.includes("svg+xml")
  ){
    return null;
  }

  const identity =
    clean(
      item.source_id ||
      item.external_id ||
      item.name ||
      item.title
    );

  const digest =
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `${restaurantId}|${identity}|${normalized}`
      )
    );

  const hash =
    [...new Uint8Array(digest)]
      .map((b) =>
        b
          .toString(16)
          .padStart(2, "0")
      )
      .join("");

  let extension =
    "jpg";

  if (
    contentType.includes(
      "png"
    )
  ) {
    extension = "png";
  } else if (
    contentType.includes(
      "webp"
    )
  ) {
    extension = "webp";
  } else if (
    contentType.includes(
      "avif"
    )
  ) {
    extension = "avif";
  } else if (
    contentType.includes(
      "gif"
    )
  ) {
    extension = "gif";
  }

  const safeRestaurantId =
    restaurantId.replace(
      /[^a-zA-Z0-9_-]/g,
      "_"
    );

  const storagePath =
    `restaurants/${safeRestaurantId}/alcohol/${hash}.${extension}`;

  const upload =
    await supabaseAdmin.storage
      .from(PHOTO_BUCKET)
      .upload(
        storagePath,
        bytes,
        {
          contentType,
          cacheControl:
            "31536000",
          upsert: false,
        }
      );

  if (
    upload.error &&
    !/already exists/i.test(
      upload.error.message ||
      ""
    )
  ) {
    return null;
  }

  const publicUrl =
    supabaseAdmin.storage
      .from(PHOTO_BUCKET)
      .getPublicUrl(
        storagePath
      )
      .data
      .publicUrl;

  return (
    clean(publicUrl) ||
    null
  );
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (
    item: T,
    index: number
  ) => Promise<R>
): Promise<R[]> {
  const result =
    new Array<R>(
      items.length
    );

  let cursor = 0;

  async function run() {
    while (true) {
      const index =
        cursor++;

      if (
        index >=
        items.length
      ) {
        return;
      }

      result[index] =
        await worker(
          items[index],
          index
        );
    }
  }

  const count =
    Math.min(
      Math.max(
        concurrency,
        1
      ),
      items.length || 1
    );

  await Promise.all(
    Array.from(
      { length: count },
      () => run()
    )
  );

  return result;
}

Deno.serve(async (req: Request) => {
  if (
    req.method === "OPTIONS"
  ) {
    return new Response(
      "ok",
      {
        headers:
          corsHeaders,
      }
    );
  }

  if (
    req.method !== "POST"
  ) {
    return jsonResponse(
      {
        success: false,
        error:
          "POST only",
      },
      405
    );
  }

  try {
    const body =
      await req.json();

    const restaurantId =
      clean(
        body?.restaurant_id ||
        body?.restaurantId
      );

    const qualityAudit =
      Boolean(
        body?.quality_audit
      );

    const qualityVisionAudit =
      Boolean(
        body?.quality_vision_audit
      );

    const rawItems =
      Array.isArray(
        body?.items
      )
        ? body.items
        : [];

    if(
      rawItems.length >
      MAX_ITEMS_PER_REQUEST
    ){
      return jsonResponse(
        {
          success:false,
          error:
            `Too many items in one request. Maximum is ${MAX_ITEMS_PER_REQUEST}.`,
          received:
            rawItems.length,
          max:
            MAX_ITEMS_PER_REQUEST
        },
        400
      );
    }

    const items:
      IncomingItem[] =
        rawItems;

    if (!restaurantId) {
      return jsonResponse(
        {
          success: false,
          error:
            "restaurant_id is required for tenant-scoped photo storage.",
        },
        400
      );
    }

    if (!(await canManageRestaurant(req, restaurantId))) {
      return jsonResponse(
        {
          success: false,
          error: "forbidden",
        },
        403
      );
    }

    if (!items.length) {
      return jsonResponse({
        success: true,
        restaurant_id:
          restaurantId,
        matches: [],
        matched: 0,
        total_items: 0,
        skipped_non_alcohol: 0,
        storage_failed: 0,
        strategy:
          "global-alcohol-photo-engine-v43-gemini-vision-quality-gate",
      });
    }

    const supabaseAdmin =
      getAdminClient();

    await ensureBucket(
      supabaseAdmin
    );


    let visionAudit:
      {
        matches: Match[];
        checked: number;
        replacements: number;
      } = {
        matches:[],
        checked:0,
        replacements:0
      };

    let visionError = "";

    if(
      qualityVisionAudit
    ){

      try{

        visionAudit =
          await runVisionQualityAudit(
            items,
            restaurantId,
            supabaseAdmin
          );

      }catch(error){

        visionError =
          error instanceof Error
            ? error.message
            : String(error);

        console.error(
          "SERVISIUM Gemini Vision audit error:",
          error
        );

      }

    }

    const results =
      await mapWithConcurrency(
        items,
        4,
        async (item) => {
          if(
            qualityVisionAudit &&
            isAlcoholItem(item)
          ){

            /*
              Vision is now the ONLY writer for alcohol photos during a
              vision-enabled import. Existing photos are preserved by the
              frontend unless Gemini explicitly approves a replacement.
              Missing photos are also left empty unless Gemini approves a
              candidate. Kitchen/non-alcohol items never enter this branch.
            */
            return {
              name:
                clean(
                  item.name ||
                  item.title
                ),
              photo_url:"",
              photo_source:"",
              source:
                clean(item.photo_url)
                  ? "quality-vision-preserve-current"
                  : "quality-vision-no-approved-photo",
              confidence:0
            } satisfies Match;

          }

          if(
            qualityAudit &&
            !qualityVisionAudit &&
            clean(
              item.photo_url
            )
          ){

            const better =
              await findBetterExistingPhoto(
                item
              );

            if(
              better?.url
            ){

              for(
                const candidateUrl of
                better.download_urls
              ){

                const stored =
                  await storePhoto(
                    candidateUrl,
                    item,
                    restaurantId,
                    supabaseAdmin
                  );

                if(stored){

                  return {
                    name:
                      clean(
                        item.name ||
                        item.title
                      ),
                    photo_url:
                      stored,
                    photo_source:
                      "servisium-storage",
                    source:
                      better.source,
                    confidence:
                      better.confidence
                  } satisfies Match;

                }

              }

            }

            /*
              No replacement = preserve existing photo in frontend.
            */
            return {
              name:
                clean(
                  item.name ||
                  item.title
                ),
              photo_url:"",
              photo_source:"",
              source:
                "quality-audit-no-better-photo",
              confidence:0
            } satisfies Match;

          }


          try{
            const found =
              await findPhoto(
                item
              );

            if (!found.url) {
              return {
                name:
                  clean(
                    item.name ||
                    item.title
                  ),
                photo_url: "",
                photo_source: "",
                source:
                  found.source,
                confidence:
                  found.confidence,
              } satisfies Match;
            }

            for (
              const candidateUrl of
              found.download_urls
            ) {

              const stored =
                await storePhoto(
                  candidateUrl,
                  item,
                  restaurantId,
                  supabaseAdmin
                );

              if (stored) {
                return {
                  name:
                    clean(
                      item.name ||
                      item.title
                    ),
                  photo_url:
                    stored,
                  photo_source:
                    "servisium-storage",
                  source:
                    `supabase-storage:${found.source}`,
                  confidence:
                    found.confidence,
                } satisfies Match;
              }

            }

            return {
              name:
                clean(
                  item.name ||
                  item.title
                ),
              photo_url: "",
              photo_source: "",
              source:
                `storage-failed:${found.source}`,
              confidence:
                found.confidence,
            } satisfies Match;

          }catch(error){

            console.warn(
              "Photo item failed:",
              clean(
                item.name ||
                item.title
              ),
              error instanceof Error
                ? error.message
                : String(error)
            );

            return {
              name:
                clean(
                  item.name ||
                  item.title
                ),
              photo_url: "",
              photo_source: "",
              source:
                "item-error",
              confidence:0
            } satisfies Match;

          }
        }
      );

    
    /*
      Vision-approved replacements take precedence over the normal result
      only for items that the vision gate actually approved.
    */
    const visionByName =
      new Map(
        visionAudit.matches.map(
          match => [
            clean(
              match.name
            ).toLowerCase(),
            match
          ]
        )
      );

    results.forEach(
      (match, index) => {

        const key =
          clean(
            match?.name
          ).toLowerCase();

        const replacement =
          visionByName.get(
            key
          );

        if(
          replacement
        ){

          results[index] =
            replacement;

        }

      }
    );

const matches =
      results.filter(
        (r) =>
          Boolean(
            clean(
              r.photo_url
            )
          )
      );

    const skipped =
      results.filter(
        (r) =>
          r.source ===
          "skipped-non-alcohol"
      ).length;

    const storageFailed =
      results.filter(
        (r) =>
          r.source.startsWith(
            "storage-failed:"
          )
      ).length;

    
    const qualityReplacements =
      results.filter(
        r =>
          String(
            r?.source ||
            ""
          ).startsWith(
            "quality-audit-v40-"
          )
      ).length;

    const alcoholItems =
      items.filter(
        item =>
          isAlcoholItem(item)
      ).length;

    const matchedAlcoholItems =
      matches.filter(
        match =>
          isAlcoholItem(
            items.find(
              item =>
                clean(item.name || item.title).toLowerCase() ===
                clean(match.name).toLowerCase()
            ) || {}
          )
      ).length;

    const missingAlcoholItems =
      Math.max(
        0,
        alcoholItems - matchedAlcoholItems
      );

return jsonResponse({
      success: true,
      restaurant_id:
        restaurantId,
      bucket:
        PHOTO_BUCKET,
      matches,
      quality_replacements:
        qualityReplacements +
        visionAudit.replacements,
      vision_checked:
        visionAudit.checked,
      vision_replacements:
        visionAudit.replacements,
      vision_error:
        visionError,
      matched:
        matches.length,
      total_items:
        items.length,
      alcohol_items:
        alcoholItems,
      matched_alcohol_items:
        matchedAlcoholItems,
      missing_alcohol_items:
        missingAlcoholItems,
      skipped_non_alcohol:
        skipped,
      storage_failed:
        storageFailed,
      candidates_found:
        matches.length,
      pages_scanned:
        items.length,
      processed_items:
        items.length,
      strategy:
        "global-alcohol-photo-engine-v43-gemini-vision-quality-gate",
    });
  } catch (error) {
    console.error(
      "enrich-menu-photos FINAL error:",
      error
    );

    return jsonResponse(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Unknown error",
      },
      500
    );
  }
});


