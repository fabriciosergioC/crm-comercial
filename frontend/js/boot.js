    (function () {
      function mostrarErro(msg) {
        document.getElementById("boot-erro-detalhe").textContent = msg;
        document.getElementById("boot-erro").style.display = "block";
      }
      try {
        if (typeof React === "undefined") return mostrarErro("O React não carregou (window.React ausente).");
        if (typeof ReactDOM === "undefined" || typeof ReactDOM.createRoot !== "function") return mostrarErro("O ReactDOM não carregou corretamente (createRoot ausente).");
        if (typeof Babel === "undefined") return mostrarErro("O Babel não carregou (window.Babel ausente).");
        var source = document.getElementById("app-source").textContent;
        var compiled = Babel.transform(source, {
          presets: [["react", { runtime: "classic" }]]
        }).code;
        (0, eval)(compiled);
      } catch (err) {
        console.error(err);
        mostrarErro((err && err.stack) || String(err));
      }
    })();
