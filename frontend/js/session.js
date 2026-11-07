/* ============================================================================
   Sessão do CRM no navegador (arquivo carregado antes de todo o resto).
   ----------------------------------------------------------------------------
   Por que existe: o link do túnel ngrok é um endereço público. O backend agora
   exige um token assinado para entregar dados (leads, conversas, propostas), e
   esse token é obtido no login. Sem ele, a resposta é 401 e a tela volta para a
   entrada, pedindo a senha de novo.

   Para quem usa não muda nada: a equipe só abre o link e digita a senha que
   você já entrega. Nenhum código, chave ou token precisa ser copiado à mão —
   o cookie httpOnly do backend faz o transporte sozinho, e este arquivo ainda
   manda o token no cabeçalho x-crm-session quando o site é aberto de fora do
   backend (pelo disco, ou por outra porta local).

   Ele também é o único lugar que sabe detectar o "sessão expirou": em vez de
   revisar as dezenas de chamadas espalhadas pelo app, o fetch é envolvido uma
   vez aqui e avisa o React pelo evento "crm:sem-sessao".
   ========================================================================== */
(function () {
  const STORE_KEY = "crm_api_session";
  const HEADER = "x-crm-session";
  const UNAUTHORIZED_EVENT = "crm:sem-sessao";

  function readToken() {
    try {
      return window.sessionStorage.getItem(STORE_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function writeToken(token) {
    try {
      if (token) window.sessionStorage.setItem(STORE_KEY, String(token));
      else window.sessionStorage.removeItem(STORE_KEY);
    } catch (error) {
      /* navegação particular sem sessionStorage: o cookie httpOnly continua
         funcionando, então o acesso pela internet não depende daqui */
    }
  }

  /* Só mexe em pedidos que são do backend do CRM: mesmo endereço da página
     ("" ou /api), a porta 3001, ou qualquer host *.ngrok.app / ngrok-free.app
     do túnel. Nada de adicionar cabeçalho em requisição de site externo, que
     provocaria verificação CORS e quebraria o que funciona hoje. */
  function isCrmRequest(rawUrl) {
    const url = String(rawUrl || "");
    if (/^(https?:)?\/\//i.test(url) || (typeof window !== "undefined" && /^wss?:/i.test(url))) {
      try {
        const parsed = new URL(url, window.location.href);
        if (parsed.origin === window.location.origin) return true;
        if (/:3001$/.test(parsed.origin)) return true;
        if (/ngrok/i.test(parsed.hostname)) return true;
        return false;
      } catch (error) {
        return false;
      }
    }
    if (!url) return false;
    if (url.charAt(0) === "/" || /^[.]/.test(url)) return true;
    return false;
  }

  function isAuthEndpoint(rawUrl) {
    return /\/auth\/(login|status|change-password|logout)/i.test(String(rawUrl || ""));
  }

  function targetOf(input) {
    if (typeof input === "string") return input;
    if (input && typeof input.url === "string") return input.url;
    return "";
  }

  function installFetchPatch() {
    if (typeof window === "undefined" || !window.fetch || window.__crmFetchPatched) return;
    const original = window.fetch.bind(window);
    window.__crmFetchPatched = true;

    window.fetch = function patched(input, init) {
      const rawUrl = targetOf(input);
      const crmCall = isCrmRequest(rawUrl) || (input && typeof input === "object" && isCrmRequest(input.url));
      if (!crmCall) return original(input, init);

      const token = readToken();
      let options = init || {};
      if (token) {
        const headers = new Headers(options.headers || (input && input.headers) || undefined);
        if (!headers.has(HEADER)) headers.set(HEADER, token);
        options = Object.assign({}, options, { headers });
      }

      /* Nada de forçar credentials:"include" aqui: em pedido cross-origin
         (página aberta do disco ou pelo Live Server na 5500 chamando a 3001) o
         navegador só aceita cookies se o backend responder com
         Access-Control-Allow-Credentials, que ele não envia — e a resposta
         inteira seria bloqueada. Pela internet (link do ngrok) a página e a API
         são a MESMA origem, então o cookie httpOnly viaja sozinho; nos outros
         casos vale o cabeçalho acima ou o Host localhost, que é liberado. */

      const isLoginAttempt = isAuthEndpoint(rawUrl);

      return original(input, options).then((response) => {
        if (!isLoginAttempt && response && response.status === 401) {
          Promise.resolve()
            .then(() => response.clone().json())
            .then((body) => {
              if (body && body.sessionExpired === true) {
                window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, { detail: body.message || "" }));
              }
            })
            .catch(() => { /* resposta sem JSON (proxy, falha de rede): não inventa expiração */ });
        }
        return response;
      });
    };
  }

  installFetchPatch();

  window.CrmSession = {
    HEADER,
    UNAUTHORIZED_EVENT,
    get: readToken,
    set: writeToken,
    clear: () => writeToken(""),
    onUnauthorized: (handler) => {
      if (typeof window === "undefined" || typeof handler !== "function") return () => {};
      window.addEventListener(UNAUTHORIZED_EVENT, handler);
      return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
    },
  };
})();
