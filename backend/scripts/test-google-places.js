#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const {
  searchBusinesses,
  searchGooglePlaces,
  mapGooglePlace,
  toWhatsAppNumber
} = require("../services/enrichmentService");

async function main() {
  assert.equal(toWhatsAppNumber("+55 31 98888-7777"), "5531988887777");
  assert.equal(toWhatsAppNumber("+1 202 555 0147"), "12025550147");
  assert.equal(toWhatsAppNumber("(31) 98888-7777"), "5531988887777");
  assert.equal(toWhatsAppNumber("123"), null);

  const mapped = mapGooglePlace({
    id: "ChIJexample",
    displayName: { text: "Academia Exemplo" },
    internationalPhoneNumber: "+55 31 98888-7777",
    location: { latitude: -19.5, longitude: -42.5 }
  });
  assert.equal(mapped.google_place_id, "ChIJexample");
  assert.equal(mapped.whatsapp, "+5531988887777");
  assert.equal(mapped.whatsapp_nao_verificado, true);
  assert.equal(mapped.whatsapp_link, "https://wa.me/5531988887777");

  const originalFetch = global.fetch;
  const envKeys = [
    "GOOGLE_PLACES_API_KEY",
    "SERPER_API_KEY",
    "BRAVE_SEARCH_API_KEY",
    "GOOGLE_CSE_API_KEY",
    "GOOGLE_CSE_CX"
  ];
  const originalEnv = Object.fromEntries(
    envKeys.map(key => [key, process.env[key]])
  );
  process.env.GOOGLE_PLACES_API_KEY = "test-places-key";
  for (const key of envKeys.slice(1)) delete process.env[key];

  const requests = [];
  global.fetch = async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, options });

    if (url.hostname === "nominatim.openstreetmap.org") {
      return new Response(JSON.stringify([{ lat: "-19.5", lon: "-42.5" }]), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.hostname === "places.googleapis.com") {
      return new Response(JSON.stringify({
        places: [{
          id: "ChIJexample",
          displayName: { text: "Academia Exemplo" },
          primaryTypeDisplayName: { text: "Academia" },
          formattedAddress: "Rua Exemplo, 10, Cidade Teste",
          internationalPhoneNumber: "+55 31 98888-7777",
          location: { latitude: -19.5, longitude: -42.5 },
          addressComponents: [{
            longText: "Cidade Teste",
            types: ["locality", "political"]
          }]
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.hostname === "overpass-api.de") {
      return new Response(JSON.stringify({
        elements: [{
          id: 123,
          type: "node",
          lat: -19.5,
          lon: -42.5,
          tags: {
            name: "Barbearia OpenStreetMap",
            shop: "hairdresser",
            "contact:whatsapp": "+55 31 97777-6666",
            "contact:instagram": "barbearia_osm",
            "addr:city": "Cidade Teste"
          }
        }]
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.hostname === "query.wikidata.org") {
      return new Response(JSON.stringify({ results: { bindings: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (url.hostname === "html.duckduckgo.com") {
      return new Response("<html></html>", {
        status: 200,
        headers: { "Content-Type": "text/html" }
      });
    }

    throw new Error(`Requisição inesperada: ${url.hostname}`);
  };

  try {
    const result = await searchBusinesses({
      city: "Cidade Teste",
      state: "MG",
      radius: 12000,
      term: "academia"
    });

    const placesRequest = requests.find(
      request => request.url.hostname === "places.googleapis.com"
    );
    assert.ok(placesRequest, "consulta o Google Places com a chave configurada");
    assert.equal(placesRequest.options.headers["X-Goog-Api-Key"], "test-places-key");
    assert.match(placesRequest.options.headers["X-Goog-FieldMask"], /places\.internationalPhoneNumber/);
    assert.equal(placesRequest.url.search, "", "não coloca a chave na URL");

    const requestBody = JSON.parse(placesRequest.options.body);
    assert.match(requestBody.textQuery, /academia, Cidade Teste, MG/);
    assert.equal(requestBody.locationBias.circle.radius, 12000);
    assert.equal(result.origem, "Google Places");
    assert.equal(result.resultados[0].whatsapp, "+5531988887777");
    assert.equal(result.resultados[0].whatsapp_nao_verificado, true);
    assert.equal(result.resultados[0].endereco, "Rua Exemplo, 10, Cidade Teste");

    const repeatedResult = await searchBusinesses({
      city: "Cidade Teste",
      state: "MG",
      radius: 12000,
      term: "academia"
    });
    assert.equal(repeatedResult.cacheado, undefined);
    assert.equal(
      requests.filter(request => request.url.hostname === "places.googleapis.com").length,
      2,
      "consulta Google Places em cada busca, sem cache"
    );

    const osmResult = await searchBusinesses({
      city: "Cidade Teste",
      state: "MG",
      radius: 12000,
      term: "barbearia",
      source: "openstreetmap"
    });
    assert.equal(osmResult.origem, "OpenStreetMap + Overpass");
    assert.equal(osmResult.resultados[0].whatsapp, "+5531977776666");
    assert.equal(
      requests.filter(request => request.url.hostname === "places.googleapis.com").length,
      2,
      "a busca OpenStreetMap não consulta Places mesmo com chave configurada"
    );

    global.fetch = async input => {
      const url = new URL(input);
      if (url.hostname !== "places.googleapis.com") {
        throw new Error(`Requisição inesperada: ${url.hostname}`);
      }
      return new Response(JSON.stringify({
        error: {
          code: 401,
          status: "UNAUTHENTICATED",
          message: "API key not valid"
        }
      }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    };

    await assert.rejects(
      searchGooglePlaces({
        city: "Cidade Teste",
        state: "MG",
        radius: 12000,
        term: "academia",
        location: { lat: -19.5, lon: -42.5 }
      }),
      error => {
        assert.match(error.message, /rejeitou a chave \(401\)/);
        assert.match(error.message, /backend\/.env/);
        assert.doesNotMatch(error.message, /test-places-key/);
        return true;
      }
    );

    console.log("OK: busca Google Places, campos de contato e WhatsApp não verificado.");
  } finally {
    global.fetch = originalFetch;
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
