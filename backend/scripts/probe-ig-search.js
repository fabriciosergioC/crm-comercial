async function probe(name, url, opts = {}) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0",
        Accept: opts.accept || "text/html,application/json",
        ...(opts.headers || {})
      }
    });
    const text = await res.text();
    const ig = text.match(/instagram\.com\/[A-Za-z0-9._]+/gi) || [];
    console.log(name, "status", res.status, "len", text.length, "ig", [...new Set(ig)].slice(0, 8));
  } catch (error) {
    console.log(name, "ERR", error.message);
  }
}

const q = encodeURIComponent('Barbearia Central Ipatinga site:instagram.com');

(async () => {
  await probe("ddg", `https://html.duckduckgo.com/html/?q=${q}`);
  await probe("bing", `https://www.bing.com/search?q=${q}&setlang=pt-br`);
  await probe("searx.be", `https://searx.be/search?q=${q}&format=json`, { accept: "application/json" });
  await probe("searx.tiekoetter", `https://searx.tiekoetter.com/search?q=${q}&format=json`, { accept: "application/json" });
  await probe("paulgo", `https://paulgo.io/search?q=${q}&format=json`, { accept: "application/json" });
})();
