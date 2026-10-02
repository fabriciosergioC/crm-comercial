# Módulo de Enriquecimento — CRM

Este módulo foi separado para encaixar no CRM existente sem substituir o frontend/backend atual.

## 1. Backend

Copie:

- backend/services/enrichmentService.js
- backend/routes/enrichmentRoutes.js

para as respectivas pastas do CRM.

No arquivo `backend/routes/index.js`, registre a rota usando o mesmo padrão das demais rotas. Exemplo:

```js
const enrichmentRoutes = require("./enrichmentRoutes");
router.use("/enrichment", enrichmentRoutes);
```

Se o seu `routes/index.js` usar `app.use` diretamente, mantenha o padrão já existente:

```js
app.use("/api/enrichment", enrichmentRoutes);
```

Não use os dois ao mesmo tempo.

## 2. Frontend

Adicione:

- frontend/js/enrichment.js
- frontend/css/enrichment.css

No HTML da área onde deseja colocar o módulo:

```html
<link rel="stylesheet" href="./css/enrichment.css">
<script src="./js/enrichment.js"></script>
```

## 3. Teste rápido

Com o backend rodando:

GET:

`/api/enrichment/search?city=Ipatinga&state=MG&radius=10000&term=barbearia`

O retorno será uma lista de empresas encontradas no OpenStreetMap/Overpass.

## 4. Enriquecimento

Envie:

```json
{
  "records": [
    {
      "nome": "Empresa Exemplo",
      "telefone": "31999999999",
      "site": "https://exemplo.com.br",
      "endereco": "Rua Exemplo, 100"
    }
  ]
}
```

para:

`POST /api/enrichment/enrich`

## 5. Supabase

Execute:

`backend/database/004_enrichment.sql`

A tabela `lead_enrichments` foi criada separadamente para evitar alteração imediata na tabela atual de leads.

Depois que o módulo for validado, faça a ligação com o `lead_id` da tabela de leads existente.

## 6. O que este módulo já faz

- Geocodificação da cidade via Nominatim.
- Busca de estabelecimentos via Overpass.
- Nome.
- Categoria.
- Endereço.
- CEP.
- Cidade.
- Coordenadas.
- Telefone quando cadastrado no OSM.
- Site quando cadastrado no OSM.
- E-mail quando cadastrado no OSM.
- Instagram/Facebook quando explicitamente cadastrados no OSM.
- Validação básica do site.
- Cálculo de nível de confiança.
- Enriquecimento individual ou em lote de até 50 registros por chamada.

## 7. O que NÃO deve ser tratado como garantia

OpenStreetMap não garante que todos os estabelecimentos terão telefone, site, Instagram ou WhatsApp.

O nível de confiança é apenas uma classificação operacional do CRM, não uma garantia de que a informação está correta.

## 8. Próxima integração recomendada

Depois de testar a busca:

Captador → Selecionar empresas → Enriquecer → Revisar → Criar lead → Supabase → Funil.

Evite criar automaticamente milhares de leads antes de validar duplicidade e os campos da tabela `leads` existente.
