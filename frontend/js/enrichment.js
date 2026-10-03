window.CRMEnrichment = (() => {
  /* Mesma regra de getApiBaseUrl() do index.html: o módulo monta
     `${base}/api/enrichment/...`, então aqui a base sai sem o sufixo /api. */
  function resolveApiBase() {
    if (window.API_BASE_URL) return String(window.API_BASE_URL).replace(/\/+$/, "");

    if (window.CRM_API_URL && window.CRM_API_URL.trim()) {
      return window.CRM_API_URL.trim().replace(/\/+$/, "").replace(/\/api$/, "");
    }

    if (typeof window.location !== "undefined") {
      // Aberto direto do disco (file://) — backend em http://localhost:3001.
      if (window.location.protocol === "file:") return "http://localhost:3001";
      // Live Server (5500) ou outra porta local: backend na 3001.
      if (
        (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") &&
        window.location.port !== "3001"
      ) {
        return "http://localhost:3001";
      }
    }

    // Mesmo domínio (Vercel/proxy /api) — base vazia usa caminho relativo.
    return "";
  }

  // Resolvido a cada chamada: config.js (CRM_API_URL) carrega depois deste arquivo.
  const apiBase = () => resolveApiBase();

  async function search({ city, state = "MG", radius = 10000, term, source }) {
    const params = new URLSearchParams({
      city,
      state,
      radius: String(radius),
      term
    });
    if (source) params.set("source", source);

    const response = await fetch(
      `${apiBase()}/api/enrichment/search?${params.toString()}`
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || data.message || "Erro ao buscar empresas.");
    }

    return data;
  }

  async function enrich(records, city) {
    const response = await fetch(`${apiBase()}/api/enrichment/enrich`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ records, city })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || data.message || "Erro no enriquecimento.");
    }

    return data;
  }

  function confidenceBadge(item) {
    const confidence = item?.confianca?.nivel || "baixa";
    const labels = {
      alta: "🟢 Alta",
      media: "🟡 Média",
      baixa: "🔴 Baixa"
    };

    return labels[confidence] || labels.baixa;
  }

  return {
    search,
    enrich,
    confidenceBadge
  };
})();
