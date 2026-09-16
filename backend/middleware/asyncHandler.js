/* Envolve handlers async para que rejeições caiam no errorHandler central
   (o Express 4 não captura promessas rejeitadas por si só). */
module.exports = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
