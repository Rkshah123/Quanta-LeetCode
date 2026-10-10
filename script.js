(() => {
  "use strict";

  const THEME_KEY = "leetcodeDashboardTheme";

  const themeSymbols = document.getElementById("theme-symbols");
  const themeSlider = document.getElementById("theme-slider");

  const THEMES = ["dark", "beige", "ember"];
  const THEME_LABELS = ["Emerald Night", "Pearl Light", "Ember"];

  /* Park the knob at its stop: 0 = left (black), 1 = middle (white),
     2 = right (ember), and tell assistive tech the current value. */
  const syncThemeSlider = (theme) => {
    const pos = Math.max(0, THEMES.indexOf(theme));
    if (themeSymbols) themeSymbols.style.setProperty("--theme-pos", String(pos));
    if (themeSlider) {
      themeSlider.dataset.pos = String(pos);
      themeSlider.setAttribute("aria-valuenow", String(pos + 1));
      themeSlider.setAttribute("aria-valuetext", THEME_LABELS[pos]);
    }
  };

  const applyTheme = (theme, shouldPersist = true) => {
    const nextTheme = THEMES.includes(theme) ? theme : "dark";
    document.body.setAttribute("data-theme", nextTheme);
    syncThemeSlider(nextTheme);

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
      if (saved === "ember") return "ember";
      return "dark";
    } catch {
      return "dark";
    }
  };

  applyTheme(loadTheme(), false);

  /* Which stop does this x coordinate fall on? Left third = black,
     middle third = white, right third = ember. */
  const themeAt = (clientX) => {
    const rect = themeSlider?.getBoundingClientRect();
    if (!rect || !rect.width) return "dark";
    const ratio = (clientX - rect.left) / rect.width;
    return THEMES[ratio < 1 / 3 ? 0 : ratio < 2 / 3 ? 1 : 2];
  };

  let themeDragging = false;
  let themeDragChoice = null;
  let themeDragOrigin = null;

  themeSlider?.addEventListener("pointerdown", (event) => {
    themeDragging = true;
    themeDragOrigin = { x: event.clientX, y: event.clientY };
    try {
      themeSlider.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic events have no active pointer to capture */
    }
    themeDragChoice = themeAt(event.clientX);
    applyTheme(themeDragChoice, false);
    event.preventDefault();
  });

  themeSlider?.addEventListener("pointermove", (event) => {
    if (!themeDragging) return;
    /* Only a real movement switches the knob to finger-tracking; a simple tap
       keeps the smooth slide so the bar never jumps under the finger. */
    if (
      !themeSlider.classList.contains("is-dragging") &&
      Math.abs(event.clientX - themeDragOrigin.x) + Math.abs(event.clientY - themeDragOrigin.y) > 4
    ) {
      themeSlider.classList.add("is-dragging");
    }
    themeDragChoice = themeAt(event.clientX);
    applyTheme(themeDragChoice, false);
  });

  const endThemeDrag = () => {
    if (!themeDragging) return;
    themeDragging = false;
    themeSlider.classList.remove("is-dragging");
    applyTheme(themeDragChoice || document.body.getAttribute("data-theme") || "dark");
    themeDragChoice = null;
  };

  themeSlider?.addEventListener("pointerup", endThemeDrag);
  themeSlider?.addEventListener("pointercancel", endThemeDrag);

  themeSlider?.addEventListener("keydown", (event) => {
    const current = Math.max(0, THEMES.indexOf(document.body.getAttribute("data-theme")));
    let next = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = Math.max(0, current - 1);
    else if (event.key === "ArrowRight" || event.key === "ArrowUp") next = Math.min(THEMES.length - 1, current + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = THEMES.length - 1;
    if (next === null) return;
    event.preventDefault();
    applyTheme(THEMES[next]);
  });
})();
