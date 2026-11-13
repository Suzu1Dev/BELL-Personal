// Applies the saved theme before first paint. It is an external, blocking
// script because the Content-Security-Policy forbids inline scripts.
(function () {
  try {
    var theme = window.localStorage.getItem("bell-personal.theme");
    if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
  } catch (error) {
    // Storage is blocked: follow the system setting.
  }
})();
