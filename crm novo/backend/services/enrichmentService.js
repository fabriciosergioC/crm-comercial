const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

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
    throw new Error("Cidade não encontrada no OpenStreetMap.");
  }

  return {
    lat: Number(data[0].lat),
    lon: Number(data[0].lon),
    displayName: data[0].display_name
  };
}

function buildOverpassQuery(lat, lon, radius, term) {
  const safeTerm = String(term || "")
    .replace(/\\/g, "")
    .replace(/"/g, '\\"');

  return `
[out:json][timeout:30];
(
  nwr(around:${Number(radius)},${lat},${lon})["name"]["shop"~"hairdresser|beauty"];
  nwr(around:${Number(radius)},${lat},${lon})["name"]["amenity"~"clinic|doctors"];
  nwr(around:${Number(radius)},${lat},${lon})["name"]["office"];
  nwr(around:${Number(radius)},${lat},${lon})["name"]["craft"];
  nwr(around:${Number(radius)},${lat},${lon})["name"~"${safeTerm}",i];
);
out center tags;
`;
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
        body
      });

      if (!response.ok) {
        throw new Error(`Overpass HTTP ${response.status}`);
      }

      return response.json();
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
    categoria: firstTag(tags, ["shop", "amenity", "office", "craft"]),
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

async function searchBusinesses({ city, state = "MG", radius = 10000, term }) {
  if (!city) throw new Error("Informe a cidade.");
  if (!term) throw new Error("Informe o segmento ou termo de busca.");

  const location = await geocodeCity(city, state);
  const query = buildOverpassQuery(
    location.lat,
    location.lon,
    Math.min(Math.max(Number(radius), 100), 50000),
    term
  );

  const data = await queryOverpass(query);
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

  return {
    origem: "OpenStreetMap + Overpass",
    localizacao: location,
    total: unique.length,
    resultados: unique
  };
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
