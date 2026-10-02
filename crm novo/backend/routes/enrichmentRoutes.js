const express = require("express");
const router = express.Router();

const {
  searchBusinesses,
  enrichBusiness
} = require("../services/enrichmentService");

// GET /api/enrichment/search?city=Ipatinga&state=MG&radius=10000&term=barbearia
router.get("/search", async (req, res, next) => {
  try {
    const result = await searchBusinesses({
      city: req.query.city,
      state: req.query.state || "MG",
      radius: Number(req.query.radius || 10000),
      term: req.query.term
    });

    res.json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

// POST /api/enrichment/enrich
router.post("/enrich", async (req, res, next) => {
  try {
    const { records } = req.body || {};

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        success: false,
        error: "Envie records como uma lista de empresas."
      });
    }

    // Limite inicial para evitar consultas excessivas.
    const limited = records.slice(0, 50);
    const enriched = [];

    for (const record of limited) {
      enriched.push(await enrichBusiness(record));
    }

    res.json({
      success: true,
      total: enriched.length,
      resultados: enriched
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
