(() => {
  "use strict";

  const THEME_KEY = "leetcodeDashboardTheme";

  const themeToggle = document.getElementById("theme-toggle-input");

  const applyTheme = (theme, shouldPersist = true) => {
    const nextTheme = theme === "beige" ? "beige" : "dark";
    document.body.setAttribute("data-theme", nextTheme);
    if (themeToggle) themeToggle.checked = nextTheme === "beige";

    if (!shouldPersist) return;
    try {
      localStorage.setItem(THEME_KEY, nextTheme);
    } catch {
      /* private mode */
    }
  };

  const loadTheme = () => {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === "beige" || saved === "light") return "beige";
      return "dark";
    } catch {
      return "dark";
    }
  };

  applyTheme(loadTheme(), false);

  themeToggle?.addEventListener("change", (event) => {
    applyTheme(event.target.checked ? "beige" : "dark");
  });
})();
