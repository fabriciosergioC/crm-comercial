window.CRMEnrichment = (() => {
  const apiBase = window.API_BASE_URL || "";

  async function search({ city, state = "MG", radius = 10000, term }) {
    const params = new URLSearchParams({
      city,
      state,
      radius: String(radius),
      term
    });

    const response = await fetch(
      `${apiBase}/api/enrichment/search?${params.toString()}`
    );

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Erro ao buscar empresas.");
    }

    return data;
  }

  async function enrich(records) {
    const response = await fetch(`${apiBase}/api/enrichment/enrich`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ records })
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      throw new Error(data.error || "Erro no enriquecimento.");
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
