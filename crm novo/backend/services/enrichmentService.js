const { ApiError } = require("../middleware/errorHandler");

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

/* O Overpass público cobra bastante por consulta longa: uma união de 12
   cláusulas estoura o timeout do servidor e devolve "remark" num HTTP 200.
   Por isso a busca roda em DUAS consultas menores (categorias + nome do
   termo) em paralelo, com merge no final. Se só uma falhar, devolve a
   parcial; se as duas falharem, 502 honesto — nunca lista vazia fingindo
   sucesso. */
const QUERY_TIMEOUT_MS = 40000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const searchCache = new Map();

function normalizePhone(value) {
  if (!value) return null;
  return String(value).replace(/[^\d+]/g, "") || null;
}

function firstTag(tags = {}, keys = []) {
  for (const key of keys) {
    if (tags[key]) return String(tags[key]).trim();
  }
  return null;
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

/* Consulta 1: categorias de negócio conhecidas (usa índice de tag — rápida).
   Consulta 2: regex do termo sobre o nome, sempre ANTES de uma tag concreta,
   para o Overpass usar o índice em vez de varrer todos os elementos do raio. */
function buildOverpassQueries(lat, lon, radius, term) {
  const safeTerm = String(term || "")
    .replace(/\\/g, "")
    .replace(/"/g, '\\"')
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const around = `around:${Number(radius)},${lat},${lon}`;

  const categories = `
[out:json][timeout:30];
(
  nwr(${around})["name"]["shop"~"hairdresser|beauty|massage"];
  nwr(${around})["name"]["amenity"~"clinic|doctors|pharmacy"];
  nwr(${around})["name"]["office"];
  nwr(${around})["name"]["craft"];
  nwr(${around})["name"]["healthcare"];
);
out center tags;
`;

  const termName = `
[out:json][timeout:25];
(
  nwr(${around})["name"~"${safeTerm}",i]["shop"];
  nwr(${around})["name"~"${safeTerm}",i]["craft"];
  nwr(${around})["name"~"${safeTerm}",i]["amenity"];
  nwr(${around})["name"~"${safeTerm}",i]["office"];
  nwr(${around})["name"~"${safeTerm}",i]["healthcare"];
  nwr(${around})["name"~"${safeTerm}",i]["leisure"];
  nwr(${around})["name"~"${safeTerm}",i]["tourism"];
);
out center tags;
`;

  return { categories, termName };
}

async function queryOverpass(query) {
  let lastError;

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
      lastError = error;
    }
  }

  throw lastError || new Error("Nenhum servidor Overpass respondeu.");
}

function mapElement(element) {
  const tags = element.tags || {};
  const center = element.center || {
    lat: element.lat,
    lon: element.lon
  };

  return {
    osm_id: element.id,
    osm_type: element.type,
    nome: tags.name || null,
    categoria: firstTag(tags, ["shop", "amenity", "office", "craft", "healthcare"]),
    telefone: normalizePhone(firstTag(tags, [
      "contact:phone", "phone", "contact:mobile", "mobile"
    ])),
    site: firstTag(tags, ["contact:website", "website", "url"]),
    email: firstTag(tags, ["contact:email", "email"]),
    instagram: firstTag(tags, ["contact:instagram", "instagram"]),
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

async function searchBusinesses({ city, state = "MG", radius = 10000, term }) {
  if (!city) throw new ApiError(400, "Informe a cidade.");
  if (!term) throw new ApiError(400, "Informe o segmento ou termo de busca.");

  const location = await geocodeCity(city, state);
  const safeRadius = Math.min(Math.max(Number(radius) || 10000, 100), 50000);

  const cacheKey = `${location.lat}:${location.lon}:${safeRadius}:${String(term).trim().toLowerCase()}`;
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cacheado: true };

  const queries = buildOverpassQueries(location.lat, location.lon, safeRadius, term);

  const [byCategory, byName] = await Promise.allSettled([
    queryOverpass(queries.categories),
    queryOverpass(queries.termName)
  ]);

  const parciais = [];
  if (byCategory.status === "fulfilled") {
    parciais.push(...(byCategory.value.elements || []));
  } else {
    console.warn("[enrichment] consulta de categorias falhou:", byCategory.reason.message);
  }
  if (byName.status === "fulfilled") {
    parciais.push(...(byName.value.elements || []));
  } else {
    console.warn("[enrichment] consulta por nome falhou:", byName.reason.message);
  }

  if (byCategory.status === "rejected" && byName.status === "rejected") {
    throw new ApiError(
      502,
      "O OpenStreetMap (Overpass) não respondeu. Tente novamente em instantes."
    );
  }

  const results = parciais.map(mapElement);

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

  const payload = {
    origem: "OpenStreetMap + Overpass",
    localizacao: location,
    parcial:
      byCategory.status === "rejected" || byName.status === "rejected"
        ? true
        : undefined,
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

async function enrichBusiness(record) {
  const website = await validateWebsite(record.site);

  const enriched = {
    ...record,
    validacao_site: website
  };

  enriched.confianca = calculateConfidence(enriched);
  enriched.atualizado_em = new Date().toISOString();

  return enriched;
}

module.exports = {
  searchBusinesses,
  enrichBusiness,
  validateWebsite,
  calculateConfidence
};
