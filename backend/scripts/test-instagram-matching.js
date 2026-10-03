#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const {
  collectInstagramHandles,
  enrichBusiness,
  pickInstagramHandle,
  searchInstagramHandle,
  buildOverpassQuery,
} = require('../services/enrichmentService');

async function main() {
  const barberQuery = buildOverpassQuery(-19.5, -42.5, 10000, 'barbearia');
  assert.match(barberQuery, /\["shop"="hairdresser"\]/);
  assert.match(barberQuery, /\["craft"="hairdresser"\]/);
  assert.doesNotMatch(barberQuery, /beauty|cosmetics|massage/);

  assert.deepEqual(
    collectInstagramHandles(['https%3A%2F%2Fwww.instagram.com%2Frafaelabarbosa%2F']),
    ['@rafaelabarbosa']
  );
  assert.equal(
    pickInstagramHandle(['@salaooficial'], 'Centro Estética Rafaela Barbosa'),
    null,
    'Não associa um perfil genérico sem correspondência suficiente.'
  );

  const originalFetch = global.fetch;
  const originalKeys = {
    serper: process.env.SERPER_API_KEY,
    brave: process.env.BRAVE_SEARCH_API_KEY,
    google: process.env.GOOGLE_CSE_API_KEY,
    googleCx: process.env.GOOGLE_CSE_CX,
  };
  delete process.env.SERPER_API_KEY;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.GOOGLE_CSE_API_KEY;
  delete process.env.GOOGLE_CSE_CX;

  const webQueries = [];
  global.fetch = async input => {
    const url = new URL(input);
    if (url.hostname === 'query.wikidata.org') {
      return new Response(JSON.stringify({ results: { bindings: [] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.hostname === 'html.duckduckgo.com') {
      const query = url.searchParams.get('q');
      webQueries.push(query);
      const html = webQueries.length === 1
        ? '<html>sem resultados</html>'
        : '<a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.instagram.com%2Frafaelabarbosa%2F">perfil</a>';
      return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } });
    }
    throw new Error(`Requisição inesperada: ${url.hostname}`);
  };

  try {
    const handle = await searchInstagramHandle({
      nome: 'Centro Estética Rafaela Barbosa',
      cidade: 'Ipatinga',
    });
    assert.equal(handle, '@rafaelabarbosa');
    assert.equal(webQueries.length, 2, 'Tenta outra formulação quando a primeira não acha perfil.');

    process.env.SERPER_API_KEY = 'test-serper-key';
    const serperQueries = [];
    global.fetch = async (input, options = {}) => {
      const url = new URL(input);
      if (url.hostname === 'query.wikidata.org') {
        return new Response(JSON.stringify({ results: { bindings: [] } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.hostname === 'google.serper.dev') {
        const body = JSON.parse(options.body);
        serperQueries.push(body.q);
        return new Response(JSON.stringify({
          organic: [{
            link: 'https://www.instagram.com/barbearia_henrick/',
            title: 'Barbearia Henrick - Ipatinga (@barbearia_henrick)',
            snippet: 'Barbearia em Ipatinga',
          }],
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`Requisição inesperada: ${url.hostname}`);
    };

    const enriched = await enrichBusiness({ nome: 'Barbearia Henrick' }, 'Ipatinga');
    assert.equal(enriched.instagram, '@barbearia_henrick');
    assert.match(serperQueries[0], /Ipatinga/);
  } finally {
    global.fetch = originalFetch;
    if (originalKeys.serper !== undefined) process.env.SERPER_API_KEY = originalKeys.serper;
    if (originalKeys.brave !== undefined) process.env.BRAVE_SEARCH_API_KEY = originalKeys.brave;
    if (originalKeys.google !== undefined) process.env.GOOGLE_CSE_API_KEY = originalKeys.google;
    if (originalKeys.googleCx !== undefined) process.env.GOOGLE_CSE_CX = originalKeys.googleCx;
  }

  console.log('OK: variações de busca, URLs codificadas e correspondência conservadora.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
