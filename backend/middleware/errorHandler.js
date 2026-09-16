/* Erro de API com status HTTP conhecido. Mensagens de 4xx/503 são seguras
   para o cliente; erros 500 nunca expõem detalhes internos. */
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function notFound(req, res) {
  res.status(404).json({ success: false, message: 'Rota não encontrada.' });
}

/* eslint-disable-next-line no-unused-vars */
function errorHandler(err, req, res, next) {
  const status = (err && err.status) || 500;
  if (status >= 500) {
    // Detalhes internos ficam apenas no log do servidor.
    console.error('[erro]', err && err.message ? err.message : err);
  }
  const message =
    status === 500
      ? 'Não foi possível realizar a operação.'
      : (err && err.message) || 'Requisição inválida.';
  res.status(status).json({ success: false, message });
}

module.exports = { ApiError, notFound, errorHandler };
