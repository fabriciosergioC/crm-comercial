const express = require('express');
const { isConfigured } = require('../config/supabase');

const router = express.Router();

/* GET /api/health
   Usado pelo run-crm.bat para saber se a API subiu (espera HTTP 200).
   Nunca expõe URL, chave ou qualquer credencial: apenas booleanos/estado. */
router.get('/', (req, res) => {
  res.json({
    success: true,
    status: 'ok',
    service: 'crm-backend',
    database: isConfigured ? 'configurado' : 'nao-configurado',
    time: new Date().toISOString(),
  });
});

module.exports = router;