const { ApiError } = require("../middleware/errorHandler");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://overpass.nchc.org.tw/api/interpreter"
];

/* O Overpass público cobra bastante por consulta longa: uma união de 12
   cláusulas estoura o timeout do servidor e devolve "remark" num HTTP 200.
   Por isso a busca roda em DUAS consultas menores (categorias + nome do
   termo) em paralelo, com merge no final. Se só uma falhar, devolve a
   parcial; se as duas falharem, 502 honesto — nunca lista vazia fingindo
   sucesso. */
const QUERY_TIMEOUT_MS = 15000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map();

function normalizePhone(value) {
  if (!value) return null;
  return String(value).replace(/[^\d+]/g, "") || null;
}

function toWhatsAppNumber(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return null;

  let digits = normalized.replace(/\D/g, "");
  if (normalized.startsWith("+")) {
    // E.164 numbers already include their country code.
    return digits.length >= 8 && digits.length <= 15 ? digits : null;
  } else if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }

  return digits.length >= 12 && digits.length <= 15 ? digits : null;
}

function firstTag(tags = {}, keys = []) {
  for (const key of keys) {
    if (tags[key]) return String(tags[key]).trim();
  }
  return null;
}

const INSTAGRAM_NON_HANDLE = new Set([
  "p", "reels", "reel", "stories", "accounts", "explore", "direct", "about",
  "legal", "developer", "tv", "share", "invites", "nametag", "popular",
  "directory", "web", "static", "graphql", "accounts"
]);

function extractInstagramHandle(value) {
  if (!value) return null;
  let raw = String(value).trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    /* URL parcialmente encoded — segue com o texto original */
  }
  const urlMatch =
    raw.match(/instagram\.com\/(?:[a-z]{2}\/)?(?:stories\/)?([A-Za-z0-9._]{2,30})/i) ||
    raw.match(/instagr\.am\/([A-Za-z0-9._]{2,30})/i);
  const handle = urlMatch
    ? urlMatch[1]
    : (raw.match(/^@?([A-Za-z0-9._]{2,30})$/) || [])[1];
  if (!handle) return null;
  const clean = handle.replace(/\.+$/, "");
  if (INSTAGRAM_NON_HANDLE.has(clean.toLowerCase())) return null;
  return `@${clean}`;
}

function isInstagramUrl(url) {
  return /instagram\.com|instagr\.am/i.test(String(url || ""));
}

function stripAccents(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

const NAME_STOPWORDS = new Set([
  "ltda", "eireli", "me", "sa", "ssa", "bar", "the", "da", "de", "do", "dos",
  "das", "e", "em", "na", "no", "nas", "nos", "a", "o", "as", "os", "para"
]);

const GENERIC_NAME_TOKENS = new Set([
  "barbearia", "salao", "cabeleireiro", "clinica", "hospital", "restaurante",
  "lanchonete", "padaria", "farmacia", "pet", "shop", "studio", "estudio",
  "academia", "oficina", "imobiliaria", "advocacia", "contabilidade",
  "loja", "store", "center", "centro", "house", "club", "spa", "beauty",
  "estetica", "cosmeticos"
]);

function nameTokens(nome) {
  return stripAccents(nome)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(word => word.length >= 3 && !NAME_STOPWORDS.has(word));
}

function compactHandle(handle) {
  return String(handle || "").replace(/^@/, "").toLowerCase().replace(/[._]/g, "");
}

function compactName(nome) {
  return stripAccents(nome).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  for (let len = Math.min(short.length, 24); len >= 4; len--) {
    for (let i = 0; i + len <= short.length; i++) {
      if (long.includes(short.slice(i, i + len))) return len;
    }
  }
  return 0;
}

function handleMatchesName(handle, nome) {
  const compact = compactHandle(handle);
  const tokens = nameTokens(nome).filter(token => token.length >= 4);
  if (!compact || !tokens.length) return false;

  const distinctive = tokens.filter(token => !GENERIC_NAME_TOKENS.has(token));
  if (distinctive.some(token => compact.includes(token))) return true;

  const joined = tokens.slice(0, 3).join("");
  return joined.length >= 6 && compact.includes(joined);
}

function scoreInstagramHandle(handle, nome) {
  const h = compactHandle(handle);
  const n = compactName(nome);
  if (!h || !n) return 0;
  if (n.length >= 5 && (h.includes(n) || (h.length >= 5 && n.includes(h)))) return 100;
  if (handleMatchesName(handle, nome)) return 80;
  return Math.min(79, longestCommonSubstring(h, n) * 10);
}

function collectInstagramHandles(texts) {
  const handles = [];
  const seen = new Set();
  for (const text of texts) {
    let decoded = String(text || "");
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // Algumas respostas de busca contêm URLs parcialmente codificadas.
    }
    const candidates = [
      ...decoded.matchAll(
      /instagram\.com\/(?:[a-z]{2}\/)?([A-Za-z0-9._]{2,30})/gi
      ),
      ...decoded.matchAll(/(?:^|[\s"'=])@([A-Za-z0-9._]{2,30})(?=$|[\s"'.,!?])/g)
    ];
    for (const match of candidates) {
      const handle = extractInstagramHandle(match[0].startsWith("@") ? match[0] : match[1]);
      if (!handle) continue;
      const key = handle.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      handles.push(handle);
    }
  }
  return handles;
}

function pickInstagramHandle(handles, nome) {
  if (!handles.length) return null;
  const ranked = handles
    .map(handle => ({ handle, score: scoreInstagramHandle(handle, nome) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0].score >= 80 ? ranked[0].handle : null;
}

function instagramSearchProvider() {
  if (process.env.SERPER_API_KEY) return "Serper (Google)";
  if (process.env.BRAVE_SEARCH_API_KEY) return "Brave Search";
  if (process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX) return "Google CSE";
  return "Wikidata + DuckDuckGo";
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    ...options,
    headers: {
      "User-Agent": "CRM-Enriquecimento/1.0 (uso interno)",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao consultar ${url}`);
  }

  return response.json();
}

async function geocodeCity(city, state = "MG", country = "Brazil") {
  const params = new URLSearchParams({
    q: `${city}, ${state}, ${country}`,
    format: "jsonv2",
    limit: "1",
    countrycodes: "br"
  });

  const data = await fetchJson(
    `https://nominatim.openstreetmap.org/search?${params.toString()}`
  );

  if (!data.length) {
    throw new ApiError(400, "Cidade não encontrada no OpenStreetMap.");
  }

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
    displayName: data[0].display_name
  };
}

/* Mapeia o termo digitado (em português) para as tags de negócio do OSM.
   Sem isso a consulta de categorias era uma lista fixa e ampla que ignorava
   o termo e devolvia clínicas/hospitais para uma busca de "barbearia". */
const CATEGORY_RULES = [
  {
    match: /barbear|barbeiro/i,
    filters: [
      '["shop"="hairdresser"]',
      '["craft"="hairdresser"]'
    ]
  },
  {
    match: /cabelo|sal[aã]o|beleza|est[eé]tica|hair|manicure|unha|sobrancelha/i,
    filters: [
      '["shop"~"^(hairdresser|beauty|cosmetics|massage)$"]',
      '["craft"~"^(hairdresser|beauty)$"]'
    ]
  },
  {
    match: /sa[uú]de|cl[ií]nica|clinica|m[eé]dic|odonto|dentista|dental|hospital|fisioterap|psic[oó]log|nutri/i,
    filters: [
      '["amenity"~"^(clinic|doctors|dentist|hospital)$"]',
      '["healthcare"~"^(clinic|dentist|doctor|hospital|centre|center)$"]'
    ]
  },
  {
    match: /alimenta|restaurante|lanchonete|padaria|pizzaria|caf[eé]|comida|hamburguer|marmit|doceria|confeitaria/i,
    filters: [
      '["amenity"~"^(restaurant|fast_food|cafe|bar|pub|ice_cream)$"]',
      '["shop"~"^(bakery|confectionery|butcher|greengrocer)$"]'
    ]
  },
  {
    match: /academia|fitness|crossfit|pilates|yoga|personal|gym/i,
    filters: [
      '["leisure"~"^(fitness_centre|sports_centre)$"]',
      '["sport"~"^(fitness|crossfit|yoga|pilates|gymnastics)$"]["leisure"]'
    ]
  },
  {
    match: /\bpet\b|veterin|banho e tosa|tosa|animal|ra[cç][aã]o/i,
    filters: [
      '["shop"="pet"]',
      '["amenity"="veterinary"]',
      '["craft"="pet_grooming"]'
    ]
  },
  {
    match: /imobili|im[oó]veis|corretor/i,
    filters: ['["office"="estate_agent"]']
  },
  {
    match: /advocacia|jur[ií]dic|advogad|not[aá]rio/i,
    filters: ['["office"~"^(lawyer|legal|notary)$"]']
  },
  {
    match: /contab|contador|fiscal/i,
    filters: ['["office"="accountant"]']
  },
  {
    match: /arquitet|arquit|engenharia|engenheiro/i,
    filters: ['["office"~"^(architect|engineer)$"]']
  },
  {
    match: /m[oó]veis|marcenaria|madeireira|moveleira/i,
    filters: [
      '["shop"~"^(furniture|interior_decoration)$"]',
      '["craft"~"^(carpenter|joinery|furniture|sawmill)$"]'
    ]
  },
  {
    match: /automotiv|oficina|mec[aâ]nic|auto ?pe[cç]as|lanternagem|pneus/i,
    filters: [
      '["shop"~"^(car_repair|car|car_parts|tyres)$"]',
      '["amenity"="car_repair"]'
    ]
  }
];

function categoryFiltersFor(term) {
  const value = String(term || "").trim();
  for (const rule of CATEGORY_RULES) {
    if (rule.match.test(value)) return rule.filters;
  }
  return null;
}

/* Termos com categoria mapeada usam só as cláusulas de tag (índice do
   Overpass — rápido e preciso). A regex do termo sobre o nome é cara
   (varre os elementos do raio) e fica apenas como fallback para termos sem
   categoria conhecida; mesclar as duas numa consulta só estourava o timeout
   do servidor. */
function buildOverpassQuery(lat, lon, radius, term) {
  const around = `around:${Number(radius)},${lat},${lon}`;
  const filters = categoryFiltersFor(term);

  let clauses;
  if (filters) {
    clauses = filters.map(f => `  nwr(${around})["name"]${f};`);
  } else {
    const safeTerm = String(term || "")
      .replace(/\\/g, "")
      .replace(/"/g, '\\"')
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clauses = [
      `  nwr(${around})["name"~"${safeTerm}",i]["shop"];`,
      `  nwr(${around})["name"~"${safeTerm}",i]["craft"];`,
      `  nwr(${around})["name"~"${safeTerm}",i]["amenity"];`,
      `  nwr(${around})["name"~"${safeTerm}",i]["office"];`
    ];
  }

  return `
[out:json][timeout:30];
(
${clauses.join("\n")}
);
out center tags;
`;
}

async function queryOverpass(query) {
  const errors = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const body = new URLSearchParams({ data: query }).toString();
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "CRM-Enriquecimento/1.0 (uso interno)"
        },
        body,
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
      });

      if (!response.ok) {
        throw new Error(`Overpass HTTP ${response.status}`);
      }

      const data = await response.json();

      // O Overpass responde 200 mesmo quando a consulta falha; o motivo fica
      // em "remark" (ex.: "Query timed out") e sem chegar isso a API devolvia
      // uma lista vazia como se fosse sucesso.
      const falha = data.error || data.remark;
      if (falha) {
        throw new Error(`Overpass: ${String(falha).replace(/\s+/g, " ").slice(0, 200)}`);
      }

      return data;
    } catch (error) {
      errors.push(`${new URL(endpoint).host}: ${error.message}`);
      console.warn(`[enrichment] ${errors[errors.length - 1]}`);
    }
  }

  throw new Error(errors.join("; ") || "Nenhum servidor Overpass respondeu.");
}

function mapElement(element) {
  const tags = element.tags || {};
  const center = element.center || {
    lat: element.lat,
    lon: element.lon
  };

  const site = firstTag(tags, ["contact:website", "website", "url"]);
  const instagram = extractInstagramHandle(
    firstTag(tags, ["contact:instagram", "instagram", "social:instagram"]) ||
    (isInstagramUrl(site) ? site : null)
  );

  return {
    osm_id: element.id,
    osm_type: element.type,
    nome: tags.name || null,
    categoria: firstTag(tags, ["shop", "amenity", "office", "craft", "healthcare", "leisure"]),
    telefone: normalizePhone(firstTag(tags, [
      "contact:phone", "phone", "contact:mobile", "mobile"
    ])),
    whatsapp: normalizePhone(firstTag(tags, [
      "contact:whatsapp", "whatsapp"
    ])),
    site,
    email: firstTag(tags, ["contact:email", "email"]),
    instagram,
    facebook: firstTag(tags, ["contact:facebook", "facebook"]),
    endereco: [
      tags["addr:street"],
      tags["addr:housenumber"],
      tags["addr:suburb"],
      tags["addr:city"],
      tags["addr:postcode"]
    ].filter(Boolean).join(", ") || null,
    cidade: tags["addr:city"] || null,
    cep: tags["addr:postcode"] || null,
    latitude: center?.lat != null ? Number(center.lat) : null,
    longitude: center?.lon != null ? Number(center.lon) : null,
    fonte: "OpenStreetMap"
  };
}

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    searchCache.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(key, value) {
  if (searchCache.size >= 50) {
    const oldest = searchCache.keys().next().value;
    searchCache.delete(oldest);
  }
  searchCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
}

function mapGooglePlace(place) {
  const phone = normalizePhone(
    place.internationalPhoneNumber || place.nationalPhoneNumber
  );
  const whatsappNumber = toWhatsAppNumber(phone);

  return {
    google_place_id: place.id,
    osm_type: "google",
    osm_id: place.id,
    nome: place.displayName?.text || null,
    categoria: place.primaryTypeDisplayName?.text || null,
    telefone: phone,
    whatsapp: whatsappNumber ? phone : null,
    whatsapp_nao_verificado: Boolean(whatsappNumber),
    whatsapp_link: whatsappNumber ? `https://wa.me/${whatsappNumber}` : null,
    site: null,
    email: null,
    instagram: null,
    facebook: null,
    endereco: place.formattedAddress || null,
    cidade: null,
    cep: null,
    latitude: null,
    longitude: null,
    fonte: "Google Places"
  };
}

async function searchGooglePlaces({ city, state, radius, term, location }) {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new ApiError(503, "Configure GOOGLE_PLACES_API_KEY para usar o Google Places.");
  }

  let response;
  try {
    response = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.formattedAddress",
          "places.primaryTypeDisplayName",
          "places.internationalPhoneNumber",
          "places.nationalPhoneNumber"
        ].join(",")
      },
      body: JSON.stringify({
        textQuery: `${term}, ${city}, ${state}, Brasil`,
        languageCode: "pt-BR",
        regionCode: "BR",
        locationBias: {
          circle: {
            center: {
              latitude: location.lat,
              longitude: location.lon
            },
            radius
          }
        }
      }),
      signal: AbortSignal.timeout(QUERY_TIMEOUT_MS)
    });
  } catch (error) {
    throw new ApiError(
      502,
      `Não foi possível consultar o Google Places: ${error.message}`
    );
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new ApiError(
        502,
        "Google Places rejeitou a chave (401). Verifique se ela está ativa e foi copiada corretamente para backend/.env. Para testar localmente, deixe a restrição de aplicativo como Nenhuma e mantenha a restrição de API limitada à Places API (New); depois reinicie o backend."
      );
    }

    if (response.status === 403) {
      throw new ApiError(
        502,
        "Google Places negou o acesso (403). Confirme que a Places API (New) está ativada no mesmo projeto da chave, que o faturamento está vinculado e que as restrições da chave permitem essa API."
      );
    }

    throw new ApiError(
      502,
      `Google Places retornou HTTP ${response.status}. Verifique a configuração da Places API (New) no Google Cloud.`
    );
  }

  const data = await response.json();
  const results = (data.places || [])
    .map(mapGooglePlace)
    .filter(item => item.nome);

  results.sort(byContactFirst);

  return {
    origem: "Google Places",
    localizacao: location,
    total: results.length,
    resultados: results
  };
}

async function searchBusinesses({
  city,
  state = "MG",
  radius = 10000,
  term,
  source = "auto"
}) {
  if (!city) throw new ApiError(400, "Informe a cidade.");
  if (!term) throw new ApiError(400, "Informe o segmento ou termo de busca.");
  if (!["auto", "google_places", "openstreetmap"].includes(source)) {
    throw new ApiError(400, "Fonte de busca inválida.");
  }

  const location = await geocodeCity(city, state);
  const safeRadius = Math.min(Math.max(Number(radius) || 10000, 100), 50000);

  if (
    source === "google_places" ||
    (source === "auto" && process.env.GOOGLE_PLACES_API_KEY)
  ) {
    return searchGooglePlaces({
      city,
      state,
      radius: safeRadius,
      term: String(term).trim(),
      location
    });
  }

  const cacheKey = `v5:openstreetmap:${location.lat}:${location.lon}:${safeRadius}:${String(term).trim().toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cacheado: true };

  const query = buildOverpassQuery(location.lat, location.lon, safeRadius, term);

  let data;
  try {
    data = await queryOverpass(query);
  } catch (error) {
    console.warn("[enrichment] consulta Overpass falhou:", error.message);
    throw new ApiError(
      502,
      "Os servidores públicos de busca do OpenStreetMap estão indisponíveis. Tente novamente em instantes ou reduza o raio da busca."
    );
  }

  const results = (data.elements || []).map(mapElement);

  // Remove duplicados por tipo + ID e empresas sem nome.
  const unique = [];
  const seen = new Set();

  for (const item of results) {
    if (!item.nome) continue;
    const key = `${item.osm_type}:${item.osm_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }

  // Com telefone/WhatsApp primeiro: é o dado que o comercial usa para abordar
  // o lead, então sobe para o topo da tabela.
  await fillContactsFromSites(unique);
  await fillInstagramFromSearch(unique, city);

  unique.sort(byContactFirst);

  const payload = {
    origem: "OpenStreetMap + Overpass",
    instagram_provedor: instagramSearchProvider(),
    localizacao: location,
    total: unique.length,
    resultados: unique
  };

  cacheSet(cacheKey, payload);
  return payload;
}

async function validateWebsite(url) {
  if (!url) return { status: "nao_informado" };

  let normalized = String(url).trim();
  if (!/^https?:\/\//i.test(normalized)) {
    normalized = `https://${normalized}`;
  }

  try {
    const response = await fetch(normalized, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "CRM-Enriquecimento/1.0"
      }
    });

    const contentType = response.headers.get("content-type") || "";

    return {
      status: response.ok ? "ativo" : "responderia_com_erro",
      http_status: response.status,
      url_final: response.url,
      content_type: contentType
    };
  } catch (error) {
    return {
      status: "nao_validado",
      erro: error.message
    };
  }
}

/* O OpenStreetMap raramente tem telefone/WhatsApp de comércio pequeno, mas o
   site da própria empresa quase sempre publica um wa.me, um tel: ou o
   Instagram. Extrair daí é o que transforma um "sem contato" em lead
   abordável, sem depender de API paga. */
function withProtocol(url) {
  const normalized = String(url || "").trim();
  return /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
}

function extractContactsFromHtml(html) {
  const out = { telefone: null, whatsapp: null, instagram: null };

  const wa =
    html.match(/wa\.me\/(\d{8,15})/i) ||
    html.match(/whatsapp\.com\/send\?phone=(\d{8,15})/i);
  if (wa) out.whatsapp = normalizePhone(wa[1]);

  const tel = html.match(/tel:([+\d][\d\s().-]{6,19})/i);
  if (tel) out.telefone = normalizePhone(tel[1]);

  const igMatches = html.matchAll(/instagram\.com\/(?:[a-z]{2}\/)?([A-Za-z0-9._]{2,30})/gi);
  for (const ig of igMatches) {
    const handle = extractInstagramHandle(ig[1]);
    if (handle) {
      out.instagram = handle;
      break;
    }
  }

  if (!out.telefone) {
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    const mobile = text.match(/\+?55\s?\(?\d{2}\)?\s?9\d{4}[- ]?\d{4}/);
    const landline = text.match(/\(?\d{2}\)?\s?\d{4}[- ]?\d{4}/);
    const hit = mobile || landline;
    if (hit) out.telefone = normalizePhone(hit[0]);
  }

  if (out.whatsapp && !out.telefone) out.telefone = out.whatsapp;
  return out;
}

async function fetchSiteContacts(url) {
  try {
    const response = await fetch(withProtocol(url), {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "CRM-Enriquecimento/1.0" }
    });

    if (!response.ok) return null;

    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|text\/plain/i.test(contentType)) return null;

    return extractContactsFromHtml(await response.text());
  } catch (error) {
    return null;
  }
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function byContactFirst(a, b) {
  const withA = a.telefone || a.whatsapp || a.instagram ? 0 : 1;
  const withB = b.telefone || b.whatsapp || b.instagram ? 0 : 1;
  if (withA !== withB) return withA - withB;
  return String(a.nome).localeCompare(String(b.nome), "pt-BR");
}

function applySiteContacts(item, contacts) {
  if (!contacts) return;
  if (!item.telefone && contacts.telefone) item.telefone = contacts.telefone;
  if (contacts.whatsapp && (!item.whatsapp || item.whatsapp_nao_verificado)) {
    item.whatsapp = contacts.whatsapp;
    item.whatsapp_nao_verificado = false;
    const whatsappNumber = toWhatsAppNumber(contacts.whatsapp);
    item.whatsapp_link = whatsappNumber
      ? `https://wa.me/${whatsappNumber}`
      : null;
  }
  if (!item.instagram && contacts.instagram) item.instagram = contacts.instagram;
}

// Limita quantos sites a busca abre para não travar a resposta em dezenas de
// requisições externas.
const SITE_CONTACT_LIMIT = 20;
const INSTAGRAM_SEARCH_LIMIT = 20;

async function fillContactsFromSites(items) {
  const missing = items
    .filter(item =>
      item.site &&
      !isInstagramUrl(item.site) &&
      (!item.telefone || !item.whatsapp || !item.instagram)
    )
    .slice(0, SITE_CONTACT_LIMIT);

  if (!missing.length) return;

  const found = await mapLimit(missing, 4, item => fetchSiteContacts(item.site));
  missing.forEach((item, index) => applySiteContacts(item, found[index]));
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function decodeDdgHref(href) {
  try {
    const parsed = new URL(decodeHtmlEntities(href), "https://duckduckgo.com");
    return parsed.searchParams.get("uddg") || href;
  } catch {
    return href;
  }
}

function escapeSparql(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function searchWikidataInstagram(nome, city) {
  const search = `${nome} ${city || ""}`.trim();
  const sparql = `
SELECT ?ig WHERE {
  SERVICE wikibase:mwapi {
    bd:serviceParam wikibase:api "EntitySearch";
    bd:serviceParam wikibase:endpoint "www.wikidata.org";
    bd:serviceParam mwapi:search "${escapeSparql(search)}";
    bd:serviceParam mwapi:language "pt".
    ?item wikibase:apiOutputItem mwapi:item.
  }
  ?item wdt:P2003 ?ig.
}
LIMIT 5`.trim();

  try {
    const data = await fetchJson(
      `https://query.wikidata.org/sparql?${new URLSearchParams({
        format: "json",
        query: sparql
      }).toString()}`
    );
    const handles = (data.results?.bindings || [])
      .map(row => extractInstagramHandle(row.ig?.value))
      .filter(Boolean);
    return pickInstagramHandle(handles, nome);
  } catch {
    return null;
  }
}

async function searchSerperBlobs(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return null;

  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q: query, gl: "br", hl: "pt-br", num: 8 }),
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) return null;
  const data = await response.json();
  return (data.organic || []).flatMap(row => [row.link, row.title, row.snippet]);
}

async function searchBraveBlobs(query) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("country", "BR");
  url.searchParams.set("search_lang", "pt");
  url.searchParams.set("count", "8");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) return null;
  const data = await response.json();
  return (data.web?.results || []).flatMap(row => [row.url, row.title, row.description]);
}

async function searchGoogleCseBlobs(query) {
  const key = process.env.GOOGLE_CSE_API_KEY;
  const cx = process.env.GOOGLE_CSE_CX;
  if (!key || !cx) return null;

  const url = new URL("https://www.googleapis.com/customsearch/v1");
  url.searchParams.set("key", key);
  url.searchParams.set("cx", cx);
  url.searchParams.set("q", query);
  url.searchParams.set("num", "8");
  url.searchParams.set("hl", "pt-BR");
  url.searchParams.set("gl", "br");

  const data = await fetchJson(url.toString());
  return (data.items || []).flatMap(row => [row.link, row.title, row.snippet]);
}

async function searchDuckDuckGoBlobs(query) {
  const response = await fetch(
    `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
    {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(10000),
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CRM-Enriquecimento/1.0)",
        Accept: "text/html"
      }
    }
  );

  if (!response.ok) return [];
  const html = decodeHtmlEntities(await response.text());
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map(match => decodeDdgHref(match[1]));
  return [html, ...hrefs];
}

async function searchWebBlobs(query) {
  const providers = [searchSerperBlobs, searchBraveBlobs, searchGoogleCseBlobs];
  for (const provider of providers) {
    try {
      const blobs = await provider(query);
      if (blobs && blobs.length) return blobs;
    } catch (error) {
      console.warn("[enrichment] busca web falhou:", error.message);
    }
  }
  try {
    return await searchDuckDuckGoBlobs(query);
  } catch (error) {
    console.warn("[enrichment] DuckDuckGo falhou:", error.message);
    return [];
  }
}

async function searchInstagramHandle(item, city) {
  const place = city || item.cidade || "";
  const fromWiki = await searchWikidataInstagram(item.nome, place);
  if (fromWiki) return fromWiki;

  const name = String(item.nome || "").trim();
  const queries = [
    `site:instagram.com "${name}" "${place}"`,
    `site:instagram.com "${name}" ${place}`,
    `"${name}" Instagram ${place}`,
    `site:instagram.com ${name} ${place}`
  ].map(query => query.trim());
  const candidates = [];
  for (const query of new Set(queries)) {
    const blobs = await searchWebBlobs(query);
    candidates.push(...collectInstagramHandles(blobs));
    const match = pickInstagramHandle(candidates, name);
    if (match) return match;
  }
  return pickInstagramHandle(candidates, name);
}

async function fillInstagramFromSearch(items, city) {
  const missing = items
    .filter(item => item.nome && !item.instagram)
    .slice(0, INSTAGRAM_SEARCH_LIMIT);

  if (!missing.length) return;

  const found = await mapLimit(missing, 3, item => searchInstagramHandle(item, city));
  missing.forEach((item, index) => {
    if (found[index]) item.instagram = found[index];
  });
}

function calculateConfidence(record) {
  let score = 0;

  if (record.nome) score += 20;
  if (record.endereco) score += 20;
  if (record.telefone) score += 20;
  if (record.site) score += 20;
  if (record.email) score += 10;
  if (record.instagram || record.facebook) score += 10;

  if (score >= 70) return { score, nivel: "alta" };
  if (score >= 45) return { score, nivel: "media" };
  return { score, nivel: "baixa" };
}

async function enrichBusiness(record, city) {
  const enriched = { ...record };

  if (isInstagramUrl(enriched.site) && !enriched.instagram) {
    enriched.instagram = extractInstagramHandle(enriched.site);
  }

  const website = await validateWebsite(
    enriched.site && !isInstagramUrl(enriched.site) ? enriched.site : null
  );
  enriched.validacao_site = website;

  if (enriched.site && !isInstagramUrl(enriched.site) && (!enriched.instagram || !enriched.telefone || !enriched.whatsapp)) {
    applySiteContacts(enriched, await fetchSiteContacts(enriched.site));
  }

  if (!enriched.instagram) {
    enriched.instagram = await searchInstagramHandle(enriched, city || enriched.cidade);
  }

  enriched.confianca = calculateConfidence(enriched);
  enriched.atualizado_em = new Date().toISOString();

  return enriched;
}

module.exports = {
  searchBusinesses,
  searchGooglePlaces,
  mapGooglePlace,
  toWhatsAppNumber,
  enrichBusiness,
  validateWebsite,
  calculateConfidence,
  collectInstagramHandles,
  pickInstagramHandle,
  searchInstagramHandle,
  buildOverpassQuery
};
