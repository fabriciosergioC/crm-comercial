const q = encodeURIComponent("Barbearia do Zé Ipatinga instagram");
(async () => {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${q}`, {
    headers: { "User-Agent": "Mozilla/5.0 CRM-Enriquecimento/1.0", Accept: "text/html" }
  });
  const html = await res.text();
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
  console.log("hrefs", hrefs.length);
  console.log(hrefs.filter((h) => /uddg|instagram|instagr/i.test(h)).slice(0, 15));
  const uddg = hrefs
    .map((h) => {
      try {
        return new URL(h, "https://duckduckgo.com").searchParams.get("uddg");
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  console.log("uddg", uddg.slice(0, 10));
})();
