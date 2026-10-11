(() => {
  "use strict";

  /* ---------------------------------------------------------------------
     Theme control.

     This file is the single owner of the theme. It is loaded before
     lab-notes.js on purpose, so the stored theme is applied before the app
     paints and the slider never starts in the wrong place.

     Everything that can change the theme - the slider, the Settings chips,
     a saved preference - goes through applyTheme(), so the knob, the aria
     values, the chips and the stored value can never disagree. Two controls
     fighting over the theme was the cause of the knob jumping to the left
     while a different theme was active.
     --------------------------------------------------------------------- */

  const THEME_KEY = "leetcodeDashboardTheme";
  const FADE_MS = 420;

  const themeSymbols = document.getElementById("theme-symbols");
  const themeSlider = document.getElementById("theme-slider");

  const THEMES = ["dark", "beige", "ember"];
  const THEME_LABELS = ["Emerald Night", "Pearl Light", "Ember"];

  const themeIndex = (theme) => Math.max(0, THEMES.indexOf(theme));

  const prefersReducedMotion = () =>
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Park the knob at its stop: 0 = left, 1 = middle, 2 = right, and tell
     assistive tech what it is sitting on. This runs on every theme change,
     including the ones that do not alter the theme, so a slider that is
     nudged but ends where it started still lands in the right place. */
  const syncThemeSlider = (theme, { gliding = false } = {}) => {
    const pos = themeIndex(theme);
    if (themeSymbols) themeSymbols.style.setProperty("--theme-pos", String(pos));
    if (!themeSlider) return;
    themeSlider.dataset.pos = String(pos);
    themeSlider.setAttribute("aria-valuenow", String(pos + 1));
    themeSlider.setAttribute("aria-valuetext", THEME_LABELS[pos]);
    if (!gliding) return;
    /* A soft halo while the knob travels, so the movement reads as one
       gesture with the colour change rather than two separate events. */
    themeSlider.classList.add("is-gliding");
    window.clearTimeout(themeSlider._glideTimer);
    themeSlider._glideTimer = window.setTimeout(() => themeSlider.classList.remove("is-gliding"), 620);
  };

  /* The outgoing background is painted over the incoming theme and faded
     away, so the two themes dissolve into each other. An existing layer is
     always removed first, so switching quickly can never stack sheets or
     leave one covering the app. */
  const startThemeFade = () => {
    document.querySelectorAll(".theme-fade").forEach((layer) => layer.remove());
    if (prefersReducedMotion()) return null;

    const layer = document.createElement("div");
    layer.className = "theme-fade";
    layer.setAttribute("aria-hidden", "true");
    layer.style.backgroundColor = getComputedStyle(document.body).backgroundColor;
    document.body.appendChild(layer);
    const done = () => layer.remove();
    layer.addEventListener("animationend", done, { once: true });
    window.setTimeout(done, FADE_MS + 500);
    return layer;
  };

  let applying = false;

  const applyTheme = (theme, { persist = true, glide = true } = {}) => {
    const nextTheme = THEMES.includes(theme) ? theme : "dark";
    const changed = document.body.getAttribute("data-theme") !== nextTheme;
    /* A second click on the theme that is already active must not restart the
       animation, but the slider is still re-synced so it can never drift. */
    if (applying) return nextTheme;
    applying = true;
    try {
      if (changed) startThemeFade();
      document.body.setAttribute("data-theme", nextTheme);
      syncThemeSlider(nextTheme, { gliding: glide && changed });

      if (persist) {
        try {
          localStorage.setItem(THEME_KEY, nextTheme);
        } catch {
          /* private mode */
        }
      }

      /* Anyone else that cares - the Settings chips, the code editor - is told
         what happened, whichever control caused it. */
      window.dispatchEvent(new CustomEvent("quanta:themechange", { detail: { theme: nextTheme, changed } }));
    } finally {
      applying = false;
    }
    return nextTheme;
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

  /* Paint the stored theme before the rest of the app starts. */
  applyTheme(loadTheme(), { persist: false, glide: false });

  /* The only way in from outside this file. The Settings chips call this, so
     a chip press and a slider drag take exactly the same path. */
  window.QuantaTheme = {
    set: (theme, options) => applyTheme(theme, options),
    get: () => document.body.getAttribute("data-theme") || "dark",
    themes: THEMES.slice()
  };

  if (!themeSlider) return;

  /* Which stop does this x coordinate fall on? Left third, middle third,
     right third. */
  const themeAt = (clientX) => {
    const rect = themeSlider.getBoundingClientRect();
    if (!rect.width) return THEMES[themeIndex(document.body.getAttribute("data-theme"))];
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return THEMES[Math.min(2, Math.round(ratio * 2))];
  };

  let themeDragging = false;
  let themeDragChoice = null;
  let themeDragOrigin = null;

  const endThemeDrag = (event) => {
    if (!themeDragging) return;
    themeDragging = false;
    themeSlider.classList.remove("is-dragging");
    /* A release outside the bar still counts: the pointer is captured, and
       this window-level listener is the safety net if it ever is not. */
    const finalX = event && typeof event.clientX === "number" ? event.clientX : null;
    const choice = finalX === null ? themeDragChoice : themeAt(finalX);
    applyTheme(choice || document.body.getAttribute("data-theme") || "dark");
    themeDragChoice = null;
    themeDragOrigin = null;
  };

  themeSlider.addEventListener("pointerdown", (event) => {
    themeDragging = true;
    themeDragOrigin = { x: event.clientX, y: event.clientY };
    try {
      themeSlider.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic events have no active pointer to capture */
    }
    themeDragChoice = themeAt(event.clientX);
    applyTheme(themeDragChoice);
    event.preventDefault();
  });

  themeSlider.addEventListener("pointermove", (event) => {
    if (!themeDragging) return;
    /* Only real movement switches the knob to finger-tracking; a small wobble
       keeps the smooth slide so the bar never jumps under the finger. */
    if (!themeDragOrigin) themeDragOrigin = { x: event.clientX, y: event.clientY };
    if (
      !themeSlider.classList.contains("is-dragging") &&
      Math.abs(event.clientX - themeDragOrigin.x) + Math.abs(event.clientY - themeDragOrigin.y) > 4
    ) {
      themeSlider.classList.add("is-dragging");
    }
    themeDragChoice = themeAt(event.clientX);
    /* While the finger is down the knob follows it exactly; the colour still
       changes at the nearest stop. */
    themeDragChoice && applyTheme(themeDragChoice, { glide: false });
  });

  themeSlider.addEventListener("pointerup", endThemeDrag);
  themeSlider.addEventListener("pointercancel", endThemeDrag);
  /* If the pointer is released anywhere at all, the bar settles rather than
     staying stuck in the dragging state. */
  window.addEventListener("pointerup", endThemeDrag);
  window.addEventListener("blur", () => endThemeDrag(null));

  themeSlider.addEventListener("keydown", (event) => {
    const current = themeIndex(document.body.getAttribute("data-theme"));
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