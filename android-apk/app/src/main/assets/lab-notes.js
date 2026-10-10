(() => {
  "use strict";

  const byId = (id) => document.getElementById(id);
  const escapeHtml = (value) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  /* Same-origin API base that also works when the app is opened directly
     from the file system (file://), where "/api/..." would hit the local
     disk instead of the Quanta server. */
  const API_BASE =
    location.protocol === "http:" || location.protocol === "https:"
      ? ""
      : `${location.protocol === "file:" ? "http:" : location.protocol}//localhost:3000`;

  /* Two deliberately separate addresses:
     - quantaApiBaseUrl      → online problem database / hosted HTTPS API
     - quantaRunServerUrl    → the PC that compiles Java/C/C++/Python        */
  const API_BASE_KEY = "quantaApiBaseUrl";

  const stripTrailingSlash = (value) => String(value || "").trim().replace(/\/+$/, "");

  /* Base for the problem catalog and LeetCode metadata endpoints. The saved
     Online API address wins; otherwise the compiler-server address is reused
     (keeps the existing Android behaviour); otherwise the app's own host. */
  const getApiBase = () => {
    try {
      const explicit = localStorage.getItem(API_BASE_KEY);
      if (explicit) return stripTrailingSlash(explicit);
      const legacy = localStorage.getItem("quantaRunServerUrl");
      if (legacy) return stripTrailingSlash(legacy);
    } catch {
      /* private mode */
    }
    return API_BASE;
  };

  /* Explicit value only — used to seed the Settings input, so an empty field
     always means "use this app's own server". */
  const getConfiguredApiBase = () => {
    try {
      return stripTrailingSlash(localStorage.getItem(API_BASE_KEY) || "");
    } catch {
      return "";
    }
  };

  /* ------------------------------ dom refs ----------------------------- */

  const labEditorNode = byId("java-monaco-editor");
  const labTabs = byId("java-session-tabs");
  const labDiagnostics = byId("java-diagnostics") || document.createElement("div"); // box removed — safe detached stub
  const labAutoSaveToggle = byId("java-auto-save-toggle");
  const labInlineExplainToggle = null; // Diagnostics toggle removed from the Lab toolbar
  const labCreateForm = byId("java-create-form");
  const labProgramNameInput = byId("java-program-name-input");
  const labLanguageSelect = byId("java-language-select");
  const labNewProgramBtn = byId("java-new-session-btn");
  const labRenameBtn = byId("java-rename-session-btn");
  const labDeleteBtn = byId("java-delete-session-btn");
  const labRunBtn = byId("run-output-btn") || byId("run-java-session-btn"); // Run lives in the output header
  const labZoomOutBtn = byId("java-zoom-out-btn");
  const labZoomInBtn = byId("java-zoom-in-btn");
  const labRunStatus = null; // status chip removed — Run button state shows progress
  const labOutput = byId("java-output");
  const labStdin = byId("java-stdin");
  const labStdinToggle = byId("java-stdin-toggle");
  const labSaveBtn = byId("save-java-file-btn");
  const labCloseBtn = null; // page, not modal
  const labLayout = byId("java-lab-layout");
  const labMobileEditorTab = byId("lab-mobile-editor-tab");
  const labMobileOutputTab = byId("lab-mobile-output-tab");
  const labMobileSwitch = byId("lab-mobile-switch");

  /* -------------------------- navigation / pages ------------------------- */

  const appNav = byId("app-nav");
  const appPages = byId("app-pages");
  const navButtons = appNav ? Array.from(appNav.querySelectorAll(".nav-btn")) : [];
  const pageSections = Array.from(document.querySelectorAll(".page[data-page-id]"));
  let currentPage = "quantalab";

  const showPage = (pageId, { resetScroll = true } = {}) => {
    const target = pageSections.find((section) => section.dataset.pageId === pageId);
    if (!target) return;
    /* Leaving the home page always restores the maximized workspace. */
    document.body.classList.remove("lc-detail-maximized");
    pageSections.forEach((section) => {
      section.hidden = section.dataset.pageId !== pageId;
    });
    navButtons.forEach((btn) => {
      const isActive = btn.dataset.page === pageId;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-current", isActive ? "page" : "false");
    });
    currentPage = pageId;
    if (resetScroll) {
      // The active page scrolls inside .app-pages (fixed-viewport shell).
      window.scrollTo({ top: 0, behavior: "auto" });
      appPages?.scrollTo({ top: 0, behavior: "auto" });
    }

    if (pageId === "lab") void openLabPage();
    if (pageId === "quantalab") renderLcAll();
    if (pageId === "notes") renderPersonalNotes();
    if (pageId === "lab" || pageId === "quantalab") relayoutMonacoEditors();
    if (pageId !== "lab") clearLanguageAccent();
    /* Hidden pages measure 0x0, so stored split sizes could not be applied
       while they were hidden — restore them once the page is visible. */
    if (pageId === "lab" || pageId === "quantalab") window.setTimeout(() => qlSplits?.applyAll(), 80);
  };

  const goHome = () => {
    showPage("quantalab", { resetScroll: true });
    /* Clicking the Quanta logo/name must always land at the very top of the
       home page — never a remembered scroll position (all viewports). */
    requestAnimationFrame(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
      appPages?.scrollTo({ top: 0, behavior: "auto" });
      document.querySelector(".page--quantalab")?.scrollTo?.({ top: 0, behavior: "auto" });
    });
    /* Navigate only — never leave a pressed/focused/clicked visual state on
       the QUANTA home button (mobile taps can keep :focus/:active alive).
       Runs right after the click and again once the tap settles. */
    const clearHomePress = () => {
      try { document.activeElement?.blur?.(); } catch {}
    };
    window.setTimeout(clearHomePress, 0);
    window.setTimeout(clearHomePress, 120);
  };

  /* Monaco measures itself while pages are hidden (display:none) and can stay
     at its minimum size when a page/tab becomes visible again — force a
     re-layout whenever an editor-bearing view is shown. */
  const relayoutMonacoEditors = () => {
    const run = () => {
      try {
        window.monaco?.editor?.getEditors?.().forEach((editor) => editor.layout());
      } catch {}
      /* Keep the description-divider overlay pinned to the real pane edge
         after every layout recalculation (maximize/restore, drags, tab and
         page switches). */
      try { syncDescDividerOverlay(); } catch {}
      try { queueDescDividerSync(); } catch {}
    };
    run();
    requestAnimationFrame(run);
    window.setTimeout(run, 120);
  };

  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      if (page === "settings") {
        syncSettingsUi();
        showPage("settings");
        return;
      }
      if (page === "about") {
        const buildEl = byId("about-build-date");
        if (buildEl && !buildEl.textContent) buildEl.textContent = new Date().toISOString().slice(0, 10);
        refreshAboutInfo();
        showPage("about");
        return;
      }
      showPage(page);
    });
  });

  const topbarHomeBtn = byId("topbar-home-btn");
  topbarHomeBtn?.addEventListener("click", goHome);

  const notesAddTopicBtn = byId("notes-add-topic-btn");
  const lcProblemList = byId("lc-problem-list");
  const lcEmpty = byId("lc-empty");
  const lcSearchInput = byId("lc-search-input");
  const lcDifficultyChips = byId("lc-difficulty-chips");
  const lcStatusFilter = byId("lc-status-filter");
  const lcLayout = byId("lc-layout");
  const lcDetail = byId("lc-detail");
  const lcDetailTitle = byId("lc-detail-title");
  const lcDetailMeta = byId("lc-detail-meta");
  const lcDetailLink = byId("lc-detail-link");
  const lcDetailSolvedBtn = byId("lc-detail-solved");
  const lcDetailStarBtn = byId("lc-detail-star");
  const lcDetailDeleteBtn = byId("lc-detail-delete");
  const lcDetailMaxBtn = byId("lc-detail-maximize");
  const lcDetailBackBtn = byId("lc-detail-back");
  const lcProgressChip = byId("lc-progress-chip");
  const qlTabNotes = byId("ql-tab-notes");
  const qlTabCode = byId("ql-tab-code");
  const qlViewNotes = byId("ql-view-notes");
  const qlViewCode = byId("ql-view-code");
  const qlCodeLanguage = byId("ql-code-language");
  const qlCodeStatus = byId("ql-code-status");
  const qlCodeRunBtn = byId("ql-code-run-btn");
  const qlCodeSaveBtn = byId("ql-code-save-btn");
  const qlCodeSolvedBadge = byId("ql-code-solved-badge");
  const qlCodeSplit = byId("ql-code-split") || document.querySelector(".ql-code-split");
  const qlDescBody = byId("ql-desc-body");
  const qlDescDiff = byId("ql-desc-diff");
  const qlDescLink = byId("lc-detail-link-desc");
  const qlMonacoNode = byId("ql-monaco-editor");
  const qlStdin = byId("ql-stdin");
  const qlStdinToggle = byId("ql-stdin-toggle");
  const qlCodeOutput = byId("ql-code-output");
  const notesToolbar = byId("notes-toolbar");
  const notesColorInput = byId("notes-color-input");
  const notesHighlightInput = byId("notes-highlight-input");
  const notesHeadingSelect = byId("notes-heading-select");
  const notesFontSizeSelect = byId("notes-font-size-select");
  const notesInsertLinkBtn = byId("notes-insert-link-btn");
  const notesInsertCodeBtn = byId("notes-insert-code-btn");
  const notesInsertTableBtn = byId("notes-insert-table-btn");
  const notesFindReplaceToggleBtn = byId("notes-find-replace-toggle-btn");
  const notesFindReplace = byId("notes-find-replace");
  const notesFindInput = byId("notes-find-input");
  const notesReplaceInput = byId("notes-replace-input");
  const notesFindNextBtn = byId("notes-find-next-btn");
  const notesReplaceBtn = byId("notes-replace-btn");
  const notesReplaceAllBtn = byId("notes-replace-all-btn");
  const notesAddSectionBtn = byId("notes-add-section-btn");
  const notesSaveBtn = byId("notes-save-btn");
  const notesExportTxtBtn = byId("notes-export-txt-btn");
  const notesWordCount = byId("notes-word-count");
  const notesSectionsList = byId("notes-sections-list");

  const required = [
    labEditorNode, labTabs,
    labAutoSaveToggle, labCreateForm, labProgramNameInput,
    labLanguageSelect, labNewProgramBtn, labRenameBtn, labDeleteBtn, labRunBtn,
    labZoomOutBtn, labZoomInBtn, labOutput, labSaveBtn,
    notesAddTopicBtn, lcProblemList, lcDetail, lcDetailTitle,
    notesAddSectionBtn, notesSaveBtn, notesExportTxtBtn,
    notesWordCount, notesSectionsList, qlTabNotes, qlTabCode, qlViewNotes,
    qlViewCode, qlCodeLanguage, qlCodeRunBtn, qlMonacoNode, qlCodeOutput
  ];
  if (!required.every(Boolean)) return;

  /* ----------------------------- settings ------------------------------- */

  const settingsModal = null; // settings is a page now, not a modal
  const settingsDialog = null;
  const settingsCloseBtn = null;
  const settingsThemeDarkBtn = byId("settings-theme-dark");
  const settingsLangThemeToggle = byId("settings-langtheme-toggle");
  const settingsThemeBeigeBtn = byId("settings-theme-beige");
  const settingsThemeEmberBtn = byId("settings-theme-ember");
  const settingsGlowToggle = byId("settings-glow-toggle");
  const settingsAutosaveToggle = byId("settings-autosave-toggle");
  const settingsDiagnosticsToggle = byId("settings-diagnostics-toggle");
  const settingsFontDecreaseBtn = byId("settings-font-decrease");
  const settingsFontIncreaseBtn = byId("settings-font-increase");
  const settingsFontSizeValue = byId("settings-font-size-value");
  const settingsExportBtn = byId("settings-export-btn");
  const settingsResetBtn = byId("settings-reset-btn");
  const settingsDefaultLanguageSelect = byId("settings-default-language");
  const settingsTabSizeSelect = byId("settings-tab-size");
  const settingsWordWrapToggle = byId("settings-wordwrap-toggle");
  const settingsLineNumbersToggle = byId("settings-linenumbers-toggle");
  const settingsEditorThemeSelect = byId("settings-editor-theme");
  const settingsMinimapToggle = byId("settings-minimap-toggle");
  const settingsLayoutResetBtn = byId("settings-layout-reset");
  const aboutBtn = null; // About is a page now, not a modal
  const aboutModal = null;
  const aboutDialog = null;
  const aboutCloseBtn = null;
  const dialogHomeBtns = Array.from(document.querySelectorAll(".dialog-avatar-btn"));
  const GLOW_KEY = "leetcodeDashboardGlow";

  const setDialogHidden = (modal, dialog, hidden) => {
    if (!modal || !dialog) return;
    modal.hidden = hidden;
    if (hidden) dialog.classList.remove("is-fullscreen");
  };

  /* ------------------------------ exit confirm --------------------------- */

  const isAndroidWrapper = () => {
    try {
      return typeof window.QuantaApp?.closeApp === "function";
    } catch {
      return false;
    }
  };
  const closeWindow = () => {
    if (isAndroidWrapper()) {
      try {
        window.QuantaApp.closeApp();
        return;
      } catch {
        /* fall through to window.close */
      }
    }
    window.close();
  };

  /* Exit now asks for confirmation first: Yes leaves the app immediately,
     No closes the dialog and stays on the current screen. */
  const setupExitConfirm = () => {
    const exitBtn = byId("exit-btn");
    const overlay = byId("exit-confirm-overlay");
    if (!exitBtn || !overlay) return;
    const yesBtn = byId("exit-confirm-yes");
    const noBtn = byId("exit-confirm-no");
    const setOpen = (open) => {
      overlay.hidden = !open;
    };
    exitBtn.addEventListener("click", () => setOpen(true));
    yesBtn?.addEventListener("click", () => {
      setOpen(false);
      closeWindow();
    });
    noBtn?.addEventListener("click", () => setOpen(false));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) setOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !overlay.hidden) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setOpen(false);
      }
    });
  };
  setupExitConfirm();

  /* ------------------------- mobile hamburger drawer --------------------- */

  const setupMobileNav = () => {
    const burger = byId("nav-toggle-btn");
    const nav = byId("app-nav");
    const dim = byId("nav-dim");
    if (!burger || !nav) return;
    let swallowTimer = 0;
    let swallowNextClick = false;
    const setOpen = (open) => {
      document.body.classList.toggle("nav-open", open);
      burger.setAttribute("aria-expanded", String(open));
      burger.setAttribute("aria-label", open ? "Close menu" : "Open menu");
      if (open) {
        /* Reopening cancels any pending post-close click swallow. */
        document.body.classList.remove("nav-closing");
        swallowNextClick = false;
        if (swallowTimer) {
          window.clearTimeout(swallowTimer);
          swallowTimer = 0;
        }
      }
    };
    burger.addEventListener("click", () => setOpen(!document.body.classList.contains("nav-open")));
    dim?.addEventListener("click", () => setOpen(false));
    /* Tapping outside the drawer (right side) closes it too. Capture phase,
       so the ENTIRE first touch is consumed here — before the page can see
       it: no input focus, no text cursor, no :active/pressed state on a
       button, no synthesized mouse/click events on whatever sits underneath
       (problem rows, filters, Notes search, the Lab editor, …). */
    document.addEventListener("pointerdown", (event) => {
      /* A fresh gesture always re-arms normal interaction: the swallow only
         ever covers the click of the gesture that closed the panel, even if
         the browser suppressed that click entirely. */
      if (swallowNextClick) {
        swallowNextClick = false;
        document.body.classList.remove("nav-closing");
        if (swallowTimer) {
          window.clearTimeout(swallowTimer);
          swallowTimer = 0;
        }
      }
      if (!document.body.classList.contains("nav-open")) return;
      if (nav.contains(event.target) || burger.contains(event.target)) return;
      setOpen(false);
      /* First touch = close the panel, nothing else. */
      event.preventDefault();
      event.stopImmediatePropagation();
      /* Keep the dim layer painting the backdrop while the panel animates
         out (CSS) and swallow the click this same gesture produces. */
      document.body.classList.add("nav-closing");
      swallowNextClick = true;
      if (swallowTimer) window.clearTimeout(swallowTimer);
      swallowTimer = window.setTimeout(() => {
        document.body.classList.remove("nav-closing");
        swallowNextClick = false;
        swallowTimer = 0;
      }, 300);
    }, true);
    nav.querySelectorAll(".nav-btn").forEach((btn) => {
      btn.addEventListener("click", () => setOpen(false));
    });
    /* First tap outside ONLY closes: kill the click that follows the closing
       tap so nothing underneath receives it (capture phase, before any page
       handler can react). One-shot: the very next separate tap — even during
       the close animation — passes through untouched, and the burger always
       stays tappable. */
    document.addEventListener("click", (event) => {
      if (!swallowNextClick) return;
      if (burger.contains(event.target)) {
        swallowNextClick = false;
        return;
      }
      swallowNextClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && document.body.classList.contains("nav-open")) setOpen(false);
    });
    window.matchMedia("(min-width: 761px)").addEventListener("change", (mq) => {
      if (mq.matches) setOpen(false);
    });
    /* Move the theme toggle into the drawer on phones; restore on desktop. */
    const themeToggle = byId("theme-toggle-input");
    const themeSlot = byId("nav-drawer-theme-slot");
    const themeOriginal = themeToggle?.closest(".theme-toggle")?.parentElement;
    const applyPlacement = () => {
      if (!themeToggle || !themeSlot) return;
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      if (mobile && themeToggle.closest(".top-bar")) {
        themeSlot.appendChild(themeToggle.closest(".theme-toggle"));
      } else if (!mobile && !themeToggle.closest(".top-bar") && themeOriginal) {
        themeOriginal.appendChild(themeToggle.closest(".theme-toggle"));
      }
    };
    applyPlacement();
    window.matchMedia("(max-width: 760px)").addEventListener("change", applyPlacement);
  };
  setupMobileNav();

  const releaseDialogFocus = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };

  const applyGlowPreference = (enabled) => {
    document.body.classList.toggle("no-glow", !enabled);
    try {
      localStorage.setItem(GLOW_KEY, enabled ? "on" : "off");
    } catch {
      /* private mode */
    }
  };

  const getGlowPreference = () => {
    try {
      return localStorage.getItem(GLOW_KEY) !== "off";
    } catch {
      return true;
    }
  };

  const syncSettingsUi = () => {
    const theme = document.body.getAttribute("data-theme");
    if (settingsLangThemeToggle) settingsLangThemeToggle.checked = labState.languageThemes !== false;
    /* Three themes now: the active chip is the exact match, so only one chip
       is ever highlighted. Unknown/legacy values fall back to Emerald Night. */
    const activeTheme = theme === "beige" || theme === "ember" ? theme : "dark";
    settingsThemeDarkBtn?.setAttribute("aria-checked", String(activeTheme === "dark"));
    settingsThemeBeigeBtn?.setAttribute("aria-checked", String(activeTheme === "beige"));
    settingsThemeEmberBtn?.setAttribute("aria-checked", String(activeTheme === "ember"));
    settingsThemeDarkBtn?.classList.toggle("is-active", activeTheme === "dark");
    settingsThemeBeigeBtn?.classList.toggle("is-active", activeTheme === "beige");
    settingsThemeEmberBtn?.classList.toggle("is-active", activeTheme === "ember");
    if (settingsGlowToggle) settingsGlowToggle.checked = getGlowPreference();
    if (settingsAutosaveToggle) settingsAutosaveToggle.checked = labState.autoSave;
    if (settingsDiagnosticsToggle) settingsDiagnosticsToggle.checked = labState.inlineExplain;
    if (settingsFontSizeValue) settingsFontSizeValue.textContent = `${labState.editorFontSize} px`;
    if (settingsDefaultLanguageSelect) settingsDefaultLanguageSelect.value = labState.defaultLanguage || DEFAULT_LANGUAGE;
    if (settingsTabSizeSelect) settingsTabSizeSelect.value = String(labState.tabSize || 4);
    if (settingsWordWrapToggle) settingsWordWrapToggle.checked = labState.wordWrap !== false;
    if (settingsLineNumbersToggle) settingsLineNumbersToggle.checked = labState.lineNumbers !== false;
    if (settingsEditorThemeSelect) settingsEditorThemeSelect.value = labState.editorTheme || "auto";
    if (settingsMinimapToggle) settingsMinimapToggle.checked = labState.showMinimap !== false;
    /* The two connection fields are seeded once at boot; refresh them here so
       a reopened Settings page never shows a stale address after a save, a
       reset, or a change made in another tab. Skip while the user is typing. */
    const apiField = byId("settings-api-base");
    const runField = byId("settings-run-server");
    if (apiField && document.activeElement !== apiField) apiField.value = getConfiguredApiBase();
    if (runField && document.activeElement !== runField) runField.value = getRunServerBase();
  };

  applyGlowPreference(getGlowPreference());

  /* ----------------------------- constants ------------------------------ */

  const JAVA_STATE_KEY = "leetcodeDashboardJavaLabStateV4";
  const NOTES_STATE_KEY = "leetcodeDashboardNotesStateV2";
  const FOCUSABLE_SELECTOR = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const DEFAULT_LANGUAGE = "java";
  const DEFAULT_EDITOR_FONT_SIZE = 14;
  const MIN_EDITOR_FONT_SIZE = 10;
  const MAX_EDITOR_FONT_SIZE = 28;

  const LANGUAGE_DEFS = {
    java: {
      label: "Java",
      extension: ".java",
      monaco: "java",
      mime: "text/x-java-source",
      runnable: "server",
      template: (name) => {
        const className = sanitizeJavaClassName(name || "Main");
        return `public class ${className} {\n    public static void main(String[] args) {\n        System.out.println("Hello, ${className}!");\n    }\n}\n`;
      }
    },
    javascript: {
      label: "JavaScript",
      extension: ".js",
      monaco: "javascript",
      mime: "text/javascript",
      runnable: "browser",
      template: () => `function main() {\n    console.log("Hello, JavaScript!");\n}\n\nmain();\n`
    },
    python: {
      label: "Python",
      extension: ".py",
      monaco: "python",
      mime: "text/x-python",
      runnable: "server",
      template: () => `def main():\n    print("Hello, Python!")\n\n\nif __name__ == "__main__":\n    main()\n`
    },
    c: {
      label: "C",
      extension: ".c",
      monaco: "c",
      mime: "text/x-csrc",
      runnable: "server",
      template: () => `#include <stdio.h>\n\nint main(void) {\n    printf("Hello, C!\\n");\n    return 0;\n}\n`
    },
    cpp: {
      label: "C++",
      extension: ".cpp",
      monaco: "cpp",
      mime: "text/x-c++src",
      runnable: "server",
      template: () => `#include <iostream>\n\nint main() {\n    std::cout << "Hello, C++!" << std::endl;\n    return 0;\n}\n`
    }
  };
  const LANGUAGE_IDS = new Set(Object.keys(LANGUAGE_DEFS));

  /* ---------------------------- generic helpers ------------------------- */

  const readJson = (key, fallbackFactory) => {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallbackFactory();
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : fallbackFactory();
    } catch {
      return fallbackFactory();
    }
  };

  const writeJson = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // quota or privacy mode — non-fatal
    }
  };

  const randomId = (prefix) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

  const getLanguageDef = (language) => LANGUAGE_DEFS[language] || LANGUAGE_DEFS[DEFAULT_LANGUAGE];
  const normalizeLanguage = (language) => (LANGUAGE_IDS.has(language) ? language : DEFAULT_LANGUAGE);

  const sanitizeProgramBaseName = (value) =>
    String(value || "")
      .trim()
      .replace(/\.(java|js|py|c|cpp|cc|cxx|hpp|h|txt)$/i, "")
      .replace(/[\\/:*?"<>|]/g, "")
      .replace(/\s+/g, "_")
      .slice(0, 60);

  const getProgramFileName = (value, language = DEFAULT_LANGUAGE) => {
    const def = getLanguageDef(normalizeLanguage(language));
    return `${sanitizeProgramBaseName(value) || "Program"}${def.extension}`;
  };

  const sanitizeJavaClassName = (value) => {
    const cleaned = String(value || "Main").replace(/[^A-Za-z0-9_$]/g, "");
    return /^[A-Za-z_$]/.test(cleaned) ? cleaned : `Main${cleaned || "Class"}`;
  };

  const buildStarterTemplate = (language, name) => getLanguageDef(language).template(sanitizeProgramBaseName(name));

  const downloadBlob = (fileName, blob) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const getFocusableElements = (container) =>
    Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      (node) => !node.hasAttribute("disabled") && node.offsetParent !== null
    );

  /* ------------------------------ lab state ----------------------------- */

  const defaultLabState = () => ({
    sessions: [],
    activeSessionId: "",
    autoSave: true,
    inlineExplain: true,
    languageThemes: true,
    editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
    defaultLanguage: DEFAULT_LANGUAGE,
    tabSize: 4,
    wordWrap: true,
    lineNumbers: true,
    showMinimap: true,
    editorTheme: "auto"
  });

  const labStateRaw = readJson(JAVA_STATE_KEY, defaultLabState);

  const labState = {
    sessions: Array.isArray(labStateRaw.sessions)
      ? labStateRaw.sessions
          .filter((item) => item && typeof item === "object")
          .map((item) => ({
            id: String(item.id || randomId("s")),
            name: getProgramFileName(item.name || "", normalizeLanguage(item.language)),
            language: normalizeLanguage(item.language),
            code: typeof item.code === "string" ? item.code : "",
            createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString(),
            updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : new Date().toISOString()
          }))
      : [],
    activeSessionId: typeof labStateRaw.activeSessionId === "string" ? labStateRaw.activeSessionId : "",
    autoSave: labStateRaw.autoSave !== false,
    inlineExplain: labStateRaw.inlineExplain !== false,
    languageThemes: labStateRaw.languageThemes !== false,
    editorFontSize: Math.min(
      MAX_EDITOR_FONT_SIZE,
      Math.max(MIN_EDITOR_FONT_SIZE, Number(labStateRaw.editorFontSize) || DEFAULT_EDITOR_FONT_SIZE)
    ),
    defaultLanguage: normalizeLanguage(labStateRaw.defaultLanguage) || DEFAULT_LANGUAGE,
    tabSize: [2, 4, 8].includes(Number(labStateRaw.tabSize)) ? Number(labStateRaw.tabSize) : 4,
    wordWrap: labStateRaw.wordWrap !== false,
    lineNumbers: labStateRaw.lineNumbers !== false,
    showMinimap: labStateRaw.showMinimap !== false,
    editorTheme: ["auto", "vs-dark", "vs", "hc-black"].includes(labStateRaw.editorTheme)
      ? labStateRaw.editorTheme
      : "auto"
  };

  let runCapabilities = null;
  /* True when the compiler server could not be answered at all (PC off, wrong
     address, phone on mobile data). The Run button must say so instead of
     claiming a toolchain is missing — that message sent people hunting for a
     JDK that was never the problem. */
  let runServerUnreachable = false;
  /* Base whose last capabilities probe failed (either runner), so Run can tell
     "the online runner is unreachable too" apart from "it answered but has no
     toolchain for this language". */
  let lastCapabilitiesFailureBase = null;
  let isRunning = false;
  let lastFocusedElement = null;
  let activeNotesEditable = null;
  let selectMobileView = null;
  const labModels = new Map();
  const labFileHandles = new Map();
  const notesFileHandles = new Map();

  const persistLabState = (force = false) => {
    if (!force && !labState.autoSave) return;
    writeJson(JAVA_STATE_KEY, {
      sessions: labState.sessions,
      activeSessionId: labState.activeSessionId,
      autoSave: labState.autoSave,
      inlineExplain: labState.inlineExplain,
      languageThemes: labState.languageThemes,
      editorFontSize: labState.editorFontSize,
      defaultLanguage: labState.defaultLanguage,
      tabSize: labState.tabSize,
      wordWrap: labState.wordWrap,
      lineNumbers: labState.lineNumbers,
      showMinimap: labState.showMinimap,
      editorTheme: labState.editorTheme
    });
  };

  const ensureActiveSession = () => {
    if (!labState.sessions.length) {
      labState.activeSessionId = "";
      return "";
    }
    if (!labState.sessions.some((session) => session.id === labState.activeSessionId)) {
      labState.activeSessionId = labState.sessions[0].id;
    }
    return labState.activeSessionId;
  };

  const getActiveSession = () => labState.sessions.find((session) => session.id === labState.activeSessionId) || null;

  const createSession = (name, language, customCode) => {
    const normalizedLanguage = normalizeLanguage(language || labState.defaultLanguage || DEFAULT_LANGUAGE);
    const fileName = getProgramFileName(name, normalizedLanguage);
    const session = {
      id: randomId("s"),
      name: fileName,
      language: normalizedLanguage,
      code: typeof customCode === "string" ? customCode : buildStarterTemplate(normalizedLanguage, fileName),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    labState.sessions.push(session);
    labState.activeSessionId = session.id;
    persistLabState(true);
    return session;
  };

  const removeSession = (sessionId) => {
    const index = labState.sessions.findIndex((session) => session.id === sessionId);
    if (index < 0) return;

    const [removed] = labState.sessions.splice(index, 1);
    const model = labModels.get(sessionId);
    if (model) {
      model.dispose();
      labModels.delete(sessionId);
    }
    labFileHandles.delete(sessionId);

    if (removed.id === labState.activeSessionId) {
      labState.activeSessionId = labState.sessions[index]?.id || labState.sessions[index - 1]?.id || "";
    }
    persistLabState(true);
  };

  /* ----------------------------- diagnostics ---------------------------- */

  const indexToLineCol = (source, index) => {
    const safe = Math.max(0, Math.min(index, source.length));
    const prefix = source.slice(0, safe);
    const lines = prefix.split("\n");
    return { line: lines.length, col: (lines[lines.length - 1] || "").length + 1 };
  };

  const markerSeverity = () =>
    window.monaco?.MarkerSeverity
      ? { error: window.monaco.MarkerSeverity.Error, warning: window.monaco.MarkerSeverity.Warning }
      : { error: 8, warning: 4 };

  const buildDiagnostics = (session) => {
    const text = String(session?.code || "");
    const severity = markerSeverity();
    const markers = [];

    const addMarker = (index, length, message, sev) => {
      const pos = indexToLineCol(text, index);
      markers.push({
        startLineNumber: pos.line,
        startColumn: pos.col,
        endLineNumber: pos.line,
        endColumn: pos.col + Math.max(1, length),
        message,
        severity: sev
      });
    };

    const braceStack = [];
    const parenStack = [];
    const bracketStack = [];
    let inLineComment = false;
    let inBlockComment = false;
    let inDouble = false;
    let inSingle = false;
    let escaped = false;

    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      const next = text[i + 1];
      if (inLineComment) {
        if (ch === "\n") inLineComment = false;
        continue;
      }
      if (inBlockComment) {
        if (ch === "*" && next === "/") {
          inBlockComment = false;
          i += 1;
        }
        continue;
      }
      if (inDouble) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === '"') inDouble = false;
        continue;
      }
      if (inSingle) {
        if (escaped) { escaped = false; continue; }
        if (ch === "\\") { escaped = true; continue; }
        if (ch === "'") inSingle = false;
        continue;
      }
      if (ch === "/" && next === "/") { inLineComment = true; i += 1; continue; }
      if (ch === "/" && next === "*") { inBlockComment = true; i += 1; continue; }
      if (ch === '"') { inDouble = true; escaped = false; continue; }
      if (ch === "'") { inSingle = true; escaped = false; continue; }

      if (ch === "{") braceStack.push(i);
      if (ch === "}") {
        const open = braceStack.pop();
        if (typeof open !== "number") addMarker(i, 1, "Unmatched closing brace '}'", severity.error);
      }
      if (ch === "(") parenStack.push(i);
      if (ch === ")") {
        const open = parenStack.pop();
        if (typeof open !== "number") addMarker(i, 1, "Unmatched closing parenthesis ')'", severity.error);
      }
      if (ch === "[") bracketStack.push(i);
      if (ch === "]") {
        const open = bracketStack.pop();
        if (typeof open !== "number") addMarker(i, 1, "Unmatched closing bracket ']'", severity.error);
      }
    }

    [
      [braceStack, "Opening brace '{' is never closed"],
      [parenStack, "Opening parenthesis '(' is never closed"],
      [bracketStack, "Opening bracket '[' is never closed"]
    ].forEach(([stack, message]) => {
      stack.forEach((open) => addMarker(open, 1, message, severity.error));
    });

    const language = normalizeLanguage(session?.language);
    if (["java", "c", "cpp", "javascript"].includes(language)) {
      const skipStarts =
        /^(if|for|while|switch|catch|class|interface|enum|try|else|do|finally|import|package|@|function|const|let|var|#include|using|namespace|int\s+main|public|private|protected|static)\b/;
      const lines = text.split("\n");
      lines.forEach((line, idx) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (/^(\/\/|\*|\/\*|#)/.test(trimmed)) return;
        if (/[;{}:,]$/.test(trimmed)) return;
        if (skipStarts.test(trimmed)) return;
        if (trimmed.endsWith(")") || trimmed.endsWith("]")) return;

        addMarker(idx, Math.max(1, line.length - line.replace(/^\s+/, "").length + 1), "Possible missing semicolon ';'", severity.warning);
      });
    }

    if (language === "java" && session?.name) {
      const classMatch = text.match(/\bpublic\s+class\s+([A-Za-z_$][\w$]*)\b/);
      if (classMatch) {
        const className = classMatch[1];
        const expected = sanitizeJavaClassName(session.name.replace(/\.java$/i, ""));
        if (className !== expected) {
          const index = (classMatch.index || 0) + classMatch[0].lastIndexOf(className);
          addMarker(
            index,
            className.length,
            `Public class '${className}' should match file name '${expected}.java'.`,
            severity.warning
          );
        }
      }
    }

    return markers;
  };

  const renderDiagnostics = (markers) => {
    labDiagnostics.innerHTML = "";
    if (!markers.length) {
      const ok = document.createElement("p");
      ok.className = "java-diag-ok";
      ok.textContent = "No issues found. Syntax looks clean.";
      labDiagnostics.appendChild(ok);
      return;
    }
    const list = document.createElement("ul");
    list.className = "java-diag-list";
    markers.forEach((marker) => {
      const item = document.createElement("li");
      item.className = marker.severity >= 8 ? "java-diag-item java-diag-item--error" : "java-diag-item java-diag-item--warn";
      item.dataset.line = String(marker.startLineNumber);
      item.dataset.col = String(marker.startColumn);
      item.textContent = `L${marker.startLineNumber}:C${marker.startColumn} — ${marker.message}`;
      list.appendChild(item);
    });
    labDiagnostics.appendChild(list);
  };

  const runDiagnostics = () => {
    const active = getActiveSession();
    if (!active) {
      renderDiagnostics([]);
      return;
    }
    if (!labState.inlineExplain) {
      if (window.monaco?.editor && labEditor?.getModel()) {
        window.monaco.editor.setModelMarkers(labEditor.getModel(), "leetcode-lab", []);
      }
      labDiagnostics.innerHTML = '<p class="java-diag-ok">Diagnostics are turned off.</p>';
      return;
    }
    const markers = buildDiagnostics(active);
    const model = labEditor?.getModel();
    if (window.monaco?.editor && model) {
      window.monaco.editor.setModelMarkers(model, "leetcode-lab", markers);
    }
    renderDiagnostics(markers);
  };

  /* ------------------------------- monaco ------------------------------- */

  let labEditor = null;
  let monacoReadyPromise = null;

  const ensureMonaco = () => {
    if (window.monaco?.editor) return Promise.resolve(window.monaco);
    if (monacoReadyPromise) return monacoReadyPromise;

    monacoReadyPromise = new Promise((resolve, reject) => {
      if (typeof window.require !== "function") {
        reject(new Error("Monaco loader unavailable"));
        return;
      }
      const vsBase = `${window.__QUANTA_ASSET_BASE__ || ""}vendor/monaco/min/vs`;
      const absBase = new URL(vsBase, window.location.href).href;
      // Same-origin: spawn the real worker directly so its default module
      // baseUrl ("../../../" from vs/base/worker/) resolves correctly.
      window.MonacoEnvironment = {
        getWorker: (_moduleId, label) =>
          new Worker(`${absBase}/base/worker/workerMain.js`, { name: label || "monaco-worker" })
      };
      window.require.config({
        paths: { vs: vsBase }
      });
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
    });
    return monacoReadyPromise;
  };

  /* -------- language-based editor themes (appearance only) -------- */

  let languageThemesDefined = false;
  const defineLanguageThemes = () => {
    if (!window.monaco || languageThemesDefined) return;
    languageThemesDefined = true;
    const rule = (token, color) => ({ token, foreground: color });
    const javaRules = [rule("string", "e8a25a"), rule("string.escape", "e8a25a"), rule("annotation", "c084fc"), rule("type", "7dd3fc"), rule("keyword", "38bdf8")];
    const jsRules = [rule("string", "a5d6a7"), rule("keyword", "64b5f6"), rule("number", "ffb74d"), rule("comment", "7a8b85"), rule("delimiter", "b0ccc4")];
    const pyRules = [rule("string", "c3e88d"), rule("string.escape", "c3e88d"), rule("keyword", "82aaff"), rule("number", "f78c6c"), rule("comment", "6a737d"), rule("decorator", "c792ea"), rule("type.identifier", "ffcb6b")];
    const cRules = [rule("string", "ce9178"), rule("keyword", "dcdcaa"), rule("keyword.directive", "c586c0"), rule("number", "b5cea8"), rule("comment", "6a9955")];
    window.monaco.editor.defineTheme("quanta-java", { base: "vs-dark", inherit: true, rules: javaRules, colors: { "editor.background": "#0e1a16" } });
    window.monaco.editor.defineTheme("quanta-js", { base: "vs-dark", inherit: true, rules: jsRules, colors: { "editor.background": "#14181d" } });
    window.monaco.editor.defineTheme("quanta-python", { base: "vs-dark", inherit: true, rules: pyRules, colors: { "editor.background": "#101a21" } });
    window.monaco.editor.defineTheme("quanta-c", { base: "vs-dark", inherit: true, rules: cRules, colors: { "editor.background": "#161419" } });
    window.monaco.editor.defineTheme("quanta-cpp", { base: "vs-dark", inherit: true, rules: [...cRules, rule("type", "4ec9b0")], colors: { "editor.background": "#141a1e" } });
    /* Ember app theme: charcoal editor with warm orange/amber tokens so the
       code pane matches the rest of the Ember chrome. */
    window.monaco.editor.defineTheme("quanta-ember", {
      base: "vs-dark",
      inherit: true,
      rules: [
        rule("keyword", "fb923c"),
        rule("keyword.control", "f97316"),
        rule("string", "fcd34d"),
        rule("string.escape", "fdba74"),
        rule("number", "fdba74"),
        rule("type", "fbbf24"),
        rule("type.identifier", "fbbf24"),
        rule("comment", "9c9186"),
        rule("delimiter", "e7e5e4"),
        rule("identifier", "f5efe8")
      ],
      colors: {
        "editor.background": "#171310",
        "editor.foreground": "#f5efe8",
        "editor.lineHighlightBackground": "#201a15",
        "editor.selectionBackground": "#7c3f14",
        "editorCursor.foreground": "#fb923c",
        "editorLineNumber.foreground": "#6f655b",
        "editorLineNumber.activeForeground": "#fb923c",
        "editorIndentGuide.background": "#2b231c",
        "editorIndentGuide.activeBackground": "#4a3c30"
      }
    });
  };

  /* Lab accent theming: five language accents (CSS vars), layout untouched. */
  const LAB_LANG_CLASSES = ["lab-lang-java", "lab-lang-javascript", "lab-lang-python", "lab-lang-c", "lab-lang-cpp"];
  const applyLanguageAccent = (language) => {
    const normalized = normalizeLanguage(language);
    LAB_LANG_CLASSES.forEach((cls) => document.body.classList.remove(cls));
    document.body.classList.add(`lab-lang-${normalized}`);
  };
  const clearLanguageAccent = () => {
    LAB_LANG_CLASSES.forEach((cls) => document.body.classList.remove(cls));
  };

  const applyLanguageTheme = (language) => {
    if (!window.monaco?.editor) return;
    defineLanguageThemes();
    applyLanguageAccent(language);
    const appTheme = document.body.getAttribute("data-theme");
    const customPref = labState.editorTheme && labState.editorTheme !== "auto" ? labState.editorTheme : "";
    let theme;
    if (customPref) {
      theme = customPref;
    } else if (appTheme === "beige") {
      theme = "vs";
    } else if (appTheme === "ember") {
      /* The chosen app theme wins over per-language colors, exactly like the
         light theme does — Ember keeps its own charcoal + warm editor. */
      theme = "quanta-ember";
    } else if (labState.languageThemes !== false) {
      theme = { java: "quanta-java", javascript: "quanta-js", python: "quanta-python", c: "quanta-c", cpp: "quanta-cpp" }[language] || "vs-dark";
    } else {
      theme = "vs-dark";
    }
    window.monaco.editor.setTheme(theme);
  };

  const syncMonacoTheme = () => {
    if (!window.monaco?.editor) return;
    defineLanguageThemes(); /* idempotent — ensures quanta-ember exists */
    const appThemeAttr = document.body.getAttribute("data-theme");
    const appTheme =
      appThemeAttr === "beige" ? "vs" : appThemeAttr === "ember" ? "quanta-ember" : "vs-dark";
    const resolved = labState.editorTheme && labState.editorTheme !== "auto" ? labState.editorTheme : appTheme;
    window.monaco.editor.setTheme(resolved);
  };

  const getOrCreateModel = (session) => {
    if (!window.monaco?.editor) return null;
    const existing = labModels.get(session.id);
    if (existing) return existing;
    const model = window.monaco.editor.createModel(session.code || "", getLanguageDef(session.language).monaco);
    labModels.set(session.id, model);
    return model;
  };

  const ensureLabEditor = async () => {
    const monaco = await ensureMonaco();
    syncMonacoTheme();
    if (labEditor) return;

    labEditor = monaco.editor.create(labEditorNode, {
      value: "",
      language: getLanguageDef(DEFAULT_LANGUAGE).monaco,
      automaticLayout: true,
      tabSize: 4,
      insertSpaces: true,
      bracketPairColorization: { enabled: true },
      autoClosingBrackets: "always",
      autoClosingQuotes: "always",
      autoIndent: "full",
      formatOnPaste: true,
      formatOnType: true,
      minimap: { enabled: labState.showMinimap !== false && window.matchMedia("(min-width: 1024px)").matches },
      fontSize: labState.editorFontSize,
      lineHeight: 1.6,
      fontFamily: "Consolas, 'Courier New', monospace",
      wordWrap: labState.wordWrap !== false ? "on" : "off",
      lineNumbers: labState.lineNumbers !== false ? "on" : "off",
      scrollBeyondLastLine: false,
      renderValidationDecorations: "on",
      padding: { top: 10, bottom: 10 },
      scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
    });

    labEditor.onDidChangeModelContent(() => {
      const active = getActiveSession();
      if (!active) return;
      active.code = labEditor.getValue();
      active.updatedAt = new Date().toISOString();
      if (labState.inlineExplain) runDiagnostics();
      persistLabState();
    });
  };

  /* ------------------------------ run flow ------------------------------ */

  const setRunStatus = (text, kind = "") => {
    // The dedicated status chip is gone; the Run button itself carries state.
    if (!labRunStatus) return;
    labRunStatus.textContent = text;
    labRunStatus.className = `run-status${kind ? ` run-status--${kind}` : ""}`;
  };

  const setRunButtonState = (state) => {
    const btn = document.getElementById("run-output-btn");
    if (!btn) return;
    btn.classList.toggle("is-running", state === "running");
    btn.classList.toggle("is-error", state === "error");
    btn.classList.toggle("is-success", state === "success");
    const label = btn.querySelector("span");
    if (label) label.textContent = state === "running" ? "Running…" : "Run";
    btn.disabled = state === "running";
  };

  const RUN_SERVER_KEY = "quantaRunServerUrl";

  let labToastNode = null;
  let labToastTimer = 0;
  const showLabToast = (message) => {
    if (!labToastNode) {
      labToastNode = document.createElement("div");
      labToastNode.className = "lab-toast";
      labToastNode.setAttribute("role", "status");
      document.body.appendChild(labToastNode);
    }
    labToastNode.textContent = String(message);
    labToastNode.classList.add("lab-toast--visible");
    window.clearTimeout(labToastTimer);
    labToastTimer = window.setTimeout(() => labToastNode.classList.remove("lab-toast--visible"), 2600);
  };

  const getRunServerBase = () => {
    /* An address saved in Settings always wins — including when the app is
       served over http(s), which is the case once the dashboard is hosted and
       compilation must still happen on this PC. */
    try {
      const configured = localStorage.getItem(RUN_SERVER_KEY);
      if (configured) return stripTrailingSlash(configured);
    } catch {
      /* private mode */
    }
    if (window.location.protocol === "http:" || window.location.protocol === "https:") return "";
    /* file:// (or another non-web scheme): fall back to the local server. */
    return API_BASE;
  };

  /* A DIFFERENT runner to try when the configured compiler server cannot take
     the job: the Online API address (a hosted server compiles through Judge0
     even with no toolchain of its own), or — on the website, when a custom
     compiler server is configured — this origin's own runner. Returns null
     when there is nothing different to try, so Run reports the real problem
     instead of probing the same dead address twice. This is what lets a phone
     run Java/C/C++/Python with the laptop off, as long as there is internet. */
  const getRunFallbackBase = () => {
    const runBase = getRunServerBase();
    const configured = getConfiguredApiBase();
    if (configured && configured !== runBase) return configured;
    const isWrapper =
      document.documentElement.classList.contains("quanta-native-shell") ||
      /QuantaAndroid\//.test(navigator.userAgent);
    if (!isWrapper && (window.location.protocol === "http:" || window.location.protocol === "https:") && runBase) {
      return "";
    }
    return null;
  };

  /* Capabilities probe for one runner base. The primary (configured) base is
     cached in memory; a probe of an alternate base is never cached, so a
     runner that comes back is picked up on the very next Run. A custom
     http:// address (a machine on the LAN) gets a short timeout so a
     switched-off PC cannot stall Run for a minute; hosted addresses get a
     long one because a free server may be cold-starting. */
  const fetchRunCapabilities = async (baseOverride) => {
    const primaryBase = getRunServerBase();
    const base = baseOverride !== undefined ? baseOverride : primaryBase;
    const isPrimary = base === primaryBase;
    if (isPrimary && runCapabilities) return runCapabilities;
    const closedCaps = { javascript: "browser", c: false, cpp: false, java: false, python: false };
    if (!base && window.location.protocol === "file:") {
      if (isPrimary) runCapabilities = closedCaps;
      return closedCaps;
    }
    const timeoutMs = base.startsWith("http://") ? 10000 : 75000;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(`${base}/api/run/capabilities`, {
        cache: "no-store",
        signal: controller ? controller.signal : undefined
      });
      if (!response.ok) throw new Error("capabilities unavailable");
      const caps = await response.json();
      if (isPrimary) {
        runCapabilities = caps;
        runServerUnreachable = false;
      }
      if (lastCapabilitiesFailureBase === base) lastCapabilitiesFailureBase = null;
      return caps;
    } catch {
      /* The server did not answer. The languages stay closed for this attempt,
         but the failure is remembered so Run can report "cannot reach the
         server". The primary answer is deliberately not cached as a permanent
         truth: fixing the address in Settings must recover on the next Run,
         with no reload. */
      lastCapabilitiesFailureBase = base;
      if (isPrimary) {
        runServerUnreachable = true;
        runCapabilities = closedCaps;
      }
      return closedCaps;
    } finally {
      if (timer) window.clearTimeout(timer);
    }
  };

  const appendOutput = (text) => {
    if (labOutput.textContent === "Ready.") {
      labOutput.textContent = "";
    }
    labOutput.textContent += text;
    labOutput.scrollTop = labOutput.scrollHeight;
  };

  const runJavaScriptLocally = (code, stdin) =>
    new Promise((resolve) => {
      if (typeof Worker !== "function") {
        resolve({ ok: false, stdout: "", stderr: "Web Workers are not available in this browser.", timedOut: false });
        return;
      }

      const workerSource = `
        self.onmessage = (event) => {
          const { code, stdin } = event.data;
          const logs = [];
          const format = (value) => {
            if (typeof value === "string") return value;
            if (value instanceof Error) return value.stack || value.message;
            try { return JSON.stringify(value, null, 2); } catch { return String(value); }
          };
          const formatArgs = (args) => args.map(format).join(" ");
          const push = (prefix) => (...args) => {
            const line = formatArgs(args);
            logs.push(prefix ? prefix + line : line);
          };
          const makeConsole = {
            log: push(false),
            info: push(false),
            debug: push(false),
            warn: push("Warning: "),
            error: push("Error: ")
          };
          const stdinLines = String(stdin || "").split("\\n");
          let stdinIndex = 0;
          const readStdinLine = () => (stdinIndex < stdinLines.length ? stdinLines[stdinIndex++] : "");
          try {
            const fn = new Function(
              "console", "prompt", "confirm", "alert", "readline",
              '"use strict";\\n' + code
            );
            fn(makeConsole, readStdinLine, () => false, () => {}, readStdinLine);
            self.postMessage({ ok: true, stdout: logs.join("\\n"), stderr: "", timedOut: false });
          } catch (error) {
            const message = error && (error.stack || error.message) ? (error.stack || error.message) : String(error);
            self.postMessage({ ok: false, stdout: logs.join("\\n"), stderr: message, timedOut: false });
          }
        };
      `;

      const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
      const worker = new Worker(url);
      const finish = (result) => {
        window.clearTimeout(timeoutId);
        worker.terminate();
        URL.revokeObjectURL(url);
        resolve(result);
      };
      const timeoutId = window.setTimeout(
        () => finish({ ok: false, stdout: "", stderr: "Execution stopped after 5 seconds (possible infinite loop).", timedOut: true }),
        5000
      );

      worker.onmessage = (event) => finish(event.data || { ok: true, stdout: "", stderr: "" });
      worker.onerror = (event) => finish({ ok: false, stdout: "", stderr: event.message || "JavaScript runtime error.", timedOut: false });
      worker.postMessage({ code: String(code || ""), stdin: String(stdin || "") });
    });

  const runOnServer = async (language, code, stdin, baseOverride) => {
    const base = baseOverride !== undefined ? baseOverride : getRunServerBase();
    let response;
    try {
      response = await fetch(`${base}/api/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language, code, stdin })
      });
    } catch {
      /* Network-level failure (PC off, wrong LAN IP, no Wi-Fi): the phone
         showed a raw "Unexpected error: Failed to fetch" before. Now a
         short, friendly line — your code is still auto-saved. */
      if (baseOverride === undefined) {
        /* This runner stopped answering after an earlier successful probe
           (the PC went to sleep). Drop the cached capabilities so the next
           Run re-probes with its short timeout — and falls back — instead of
           hanging again on the dead address. */
        runCapabilities = null;
        runServerUnreachable = true;
      }
      return {
        ok: false,
        stdout: "",
        stderr:
          `Cannot reach the compiler server (${base || "same origin"}). ` +
          (baseOverride !== undefined
            ? "Check your internet connection and try again. "
            : base
              ? "Check that the PC is running Quanta and both devices are on the same Wi-Fi. "
              : "Check your connection and try again. ") +
          "Your code is saved on this device.",
        timedOut: false,
        phase: "network"
      };
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, stdout: "", stderr: data?.error || `Run request failed (${response.status}).`, timedOut: false };
    }
    if (!data || typeof data !== "object") {
      return { ok: false, stdout: "", stderr: "The compiler server sent an unexpected reply. Update the app and the PC server to the latest version.", timedOut: false };
    }
    return data;
  };

  const missingToolchainMessage = (language) => {
    const def = getLanguageDef(language);
    const tool = language === "java" ? "a JDK (javac)" : language === "python" ? "Python 3" : "the GCC toolchain (gcc/g++)";
    return (
      `${def.label} needs ${tool} installed on the PC that runs Quanta.\n` +
      `Install it there once, then press Run again. Your code is saved on this device.`
    );
  };

  /* Shared executor used by both the Lab page and per-problem code view.
     Runner chain: JavaScript always runs in this browser; compiled languages
     go to the configured compiler server first (the PC on the same Wi-Fi is
     fastest, unlimited, and works with no internet at all), then — when it
     cannot run the language or does not answer — to a different runner: the
     Online API address, which compiles through Judge0 even from a hosted
     server with no toolchain. That second step is what lets a phone run
     Java/C/C++/Python with the laptop off, as long as there is internet. */
  const executeCode = async (language, code, stdin) => {
    if (language === "javascript") {
      return runJavaScriptLocally(code, stdin);
    }
    const capabilities = await fetchRunCapabilities();
    if (capabilities[language]) {
      const result = await runOnServer(language, code, stdin);
      if (result.phase !== "network") return result;
      /* Probed OK earlier but the run could not be delivered (the PC went
         away in between). Try the other runner once before reporting. */
      const fallbackBase = getRunFallbackBase();
      if (fallbackBase !== null) {
        const fallbackCapabilities = await fetchRunCapabilities(fallbackBase);
        if (fallbackCapabilities[language]) return runOnServer(language, code, stdin, fallbackBase);
      }
      return result;
    }

    /* The configured server is unreachable or has no toolchain for this
       language — try the other runner before giving up. */
    const fallbackBase = getRunFallbackBase();
    let fallbackTried = false;
    let fallbackDown = false;
    if (fallbackBase !== null) {
      fallbackTried = true;
      const fallbackCapabilities = await fetchRunCapabilities(fallbackBase);
      fallbackDown = lastCapabilitiesFailureBase === fallbackBase;
      if (fallbackCapabilities[language]) return runOnServer(language, code, stdin, fallbackBase);
    }

    if (runServerUnreachable) {
      /* Nothing was actually compiled — the configured server never answered.
         Say where it was looking and how to point it back at the built-in
         runner, so nobody wastes time installing a toolchain. */
      const base = getRunServerBase();
      return {
        ok: false,
        stdout: "",
        stderr:
          fallbackTried && fallbackDown
            ? `No runner answered — neither the compiler server (${base || "same origin"}) nor the online runner (${fallbackBase}) replied. Check your internet connection, or run Quanta on the PC on the same Wi-Fi. Your code is saved on this device.`
            : `Cannot reach the compiler server (${base || "this website's own runner"}). ` +
              (base
                ? "Check the address in Settings → Compiler server, or clear the field to use this website's own runner. "
                : "Check your connection and try again. ") +
              "Your code is saved on this device.",
        timedOut: false,
        phase: "network"
      };
    }
    /* Both runners answered, but neither can run this language. */
    return { ok: false, stdout: "", stderr: missingToolchainMessage(language), timedOut: false };
  };

  const uniqueUntitledName = (language) => {
    const base = "Untitled";
    let candidate = base;
    let counter = 2;
    const isTaken = () =>
      labState.sessions.some((session) => session.name.toLowerCase() === getProgramFileName(candidate, language).toLowerCase());
    while (isTaken()) {
      candidate = `${base} ${counter}`;
      counter += 1;
    }
    return candidate;
  };

  const runActiveSession = async () => {
    let active = getActiveSession();
    if (!active && labEditor) {
      /* The editor is on screen and editable before any program exists, so a
         program typed straight into it used to be refused with "Create or open
         a program first." Take what was written and save it as a program —
         that is what the person typing obviously intended. */
      const draft = String(labEditor.getValue() || "");
      if (draft.trim()) {
        const language = normalizeLanguage(labLanguageSelect.value);
        const session = createSession(uniqueUntitledName(language), language, draft);
        renderTabs();
        activateSession(session.id);
        active = session;
      }
    }
    if (!active) {
      setRunStatus("No program", "error");
      labOutput.textContent =
        "Create or open a program first — or type your code in the editor and press Run; it will be saved as a new program.";
      return;
    }
    if (isRunning) return;
    isRunning = true;
    labRunBtn.disabled = true;
    setRunButtonState("running");
    setRunStatus("Running…", "running");
    labOutput.textContent = "";

    if (labEditor) {
      active.code = labEditor.getValue();
      active.updatedAt = new Date().toISOString();
      persistLabState(true);
    }
    runDiagnostics();

    const stdin = labStdin && !labStdin.hidden ? labStdin.value : "";
    const language = active.language;

    try {
      const result = await executeCode(language, active.code, stdin);

      if (result.stdout) appendOutput(result.stdout.replace(/\n$/, "") + "\n");
      if (result.stderr) appendOutput(result.stderr.replace(/\n$/, "") + "\n");
      if (!result.stdout && !result.stderr) appendOutput("(no output)\n");

      if (selectMobileView && window.matchMedia("(max-width: 760px)").matches) {
        selectMobileView("output");
      }

      if (result.timedOut) setRunStatus("Timed out", "error");
      else if (result.ok) setRunStatus("Finished", "success");
      else if (result.phase === "compile") setRunStatus("Compile error", "error");
      else if (result.phase === "network") setRunStatus("Offline", "error");
      else setRunStatus("Error", "error");
    } catch (error) {
      appendOutput(`Unexpected error: ${error?.message || error}\n`);
      setRunStatus("Error", "error");
    } finally {
      isRunning = false;
      labRunBtn.disabled = false;
      setRunButtonState("idle");
    }
  };

  /* ---------------------------- lab rendering --------------------------- */

  const renderTabs = () => {
    labTabs.innerHTML = "";
    const fragment = document.createDocumentFragment();

    labState.sessions.forEach((session) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `java-session-tab${session.id === labState.activeSessionId ? " is-active" : ""}`;
      tab.dataset.sessionId = session.id;
      tab.draggable = true;
      tab.title = session.name;

      const dot = document.createElement("span");
      dot.className = "java-session-tab__lang";
      dot.style.background = {
        java: "#f89820",
        javascript: "#f7df1e",
        python: "#3776ab",
        c: "#7986cb",
        cpp: "#6d9ecc"
      }[session.language] || "#94a3b8";

      const label = document.createElement("span");
      label.className = "java-session-tab__name";
      label.textContent = session.name;

      const close = document.createElement("span");
      close.className = "java-session-tab__close";
      close.dataset.closeId = session.id;
      close.setAttribute("role", "button");
      close.setAttribute("aria-label", `Close ${session.name}`);
      close.textContent = "×";

      tab.append(dot, label, close);
      fragment.appendChild(tab);
    });

    labTabs.appendChild(fragment);
  };

  const activateSession = (sessionId) => {
    const session = labState.sessions.find((item) => item.id === sessionId);
    if (!session) return;

    labState.activeSessionId = session.id;
    renderTabs();
    labProgramNameInput.value = sanitizeProgramBaseName(session.name);
    labLanguageSelect.value = normalizeLanguage(session.language);
    setRunStatus(`${getLanguageDef(session.language).label} ready`, "");

    if (labEditor) {
      const model = getOrCreateModel(session);
      if (model) {
        labEditor.setModel(model);
        labEditor.updateOptions({ fontSize: labState.editorFontSize });
      }
    }

    if (labState.languageThemes !== false) applyLanguageTheme(session.language);
    else clearLanguageAccent();
    runDiagnostics();
    persistLabState(true);
  };

  const resetLabWorkspace = () => {
    renderTabs();
    if (labEditor && window.monaco?.editor) {
      labEditor.setModel(window.monaco.editor.createModel("", "plaintext"));
    }
    labProgramNameInput.value = "";
    labLanguageSelect.value = labState.defaultLanguage || DEFAULT_LANGUAGE;
    setRunStatus("Ready", "");
    labOutput.textContent = "";
    labDiagnostics.innerHTML = '<p class="java-diag-ok">No program open.</p>';
    labProgramNameInput.focus();
  };

  const createSessionFromForm = () => {
    const programName = sanitizeProgramBaseName(labProgramNameInput.value);
    const language = normalizeLanguage(labLanguageSelect.value);

    if (!programName) {
      labProgramNameInput.focus();
      setRunStatus("Name required", "error");
      labOutput.textContent = "Enter a program name, choose a language, then press Create.\nThe starter template loads automatically.";
      return;
    }

    const fileName = getProgramFileName(programName, language);
    const existing = labState.sessions.find((session) => session.name.toLowerCase() === fileName.toLowerCase());
    if (existing) {
      activateSession(existing.id);
      setRunStatus("Opened existing program", "success");
      return;
    }

    const session = createSession(programName, language);
    renderTabs();
    activateSession(session.id);
    setRunStatus("Created", "success");
    labOutput.textContent = `${getLanguageDef(language).label} starter template loaded. Press Run to execute it.`;
  };

  const renameActiveSession = () => {
    const active = getActiveSession();
    if (!active) return;

    const input = window.prompt("Rename program:", sanitizeProgramBaseName(active.name));
    if (input === null) return;

    const cleaned = sanitizeProgramBaseName(input);
    if (!cleaned) return;

    active.name = getProgramFileName(cleaned, active.language);
    active.updatedAt = new Date().toISOString();
    renderTabs();
    labProgramNameInput.value = cleaned;
    persistLabState(true);
    runDiagnostics();
  };

  const deleteActiveSession = () => {
    const active = getActiveSession();
    if (!active) return;
    if (!window.confirm(`Delete "${active.name}"? This cannot be undone.`)) return;

    removeSession(active.id);
    if (labState.activeSessionId) {
      activateSession(labState.activeSessionId);
    } else {
      resetLabWorkspace();
    }
  };

  const reorderSessions = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    const fromIndex = labState.sessions.findIndex((session) => session.id === fromId);
    const toIndex = labState.sessions.findIndex((session) => session.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;

    const [moved] = labState.sessions.splice(fromIndex, 1);
    labState.sessions.splice(toIndex, 0, moved);
    renderTabs();
    persistLabState(true);
  };

  const saveActiveSessionToFile = async () => {
    const active = getActiveSession();
    if (!active) {
      setRunStatus("No program", "error");
      return;
    }
    if (labEditor) {
      active.code = labEditor.getValue();
      active.updatedAt = new Date().toISOString();
    }
    persistLabState(true);

    const def = getLanguageDef(active.language);
    const fileName = getProgramFileName(active.name, active.language);

    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle =
          labFileHandles.get(active.id) ||
          (await window.showSaveFilePicker({
            suggestedName: fileName,
            types: [{ description: `${def.label} Source File`, accept: { [def.mime]: [def.extension], "text/plain": [def.extension] } }]
          }));
        const writable = await handle.createWritable();
        await writable.write(active.code || "");
        await writable.close();
        labFileHandles.set(active.id, handle);
        setRunStatus("Saved", "success");
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }

    downloadBlob(fileName, new Blob([active.code || ""], { type: `${def.mime};charset=utf-8` }));
    setRunStatus("Downloaded", "success");
  };

  const setEditorZoom = (delta) => {
    labState.editorFontSize = Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, labState.editorFontSize + delta));
    if (labEditor) {
      labEditor.updateOptions({ fontSize: labState.editorFontSize });
    }
    persistLabState(true);
  };

  /* ---------------------------- lab open/close -------------------------- */

  let labPageInitialized = false;

  const openLabPage = async () => {
    labAutoSaveToggle.checked = labState.autoSave;

    ensureActiveSession();
    renderTabs();

    try {
      await ensureLabEditor();
      syncMonacoTheme();
      if (labState.activeSessionId) {
        activateSession(labState.activeSessionId);
      } else {
        labProgramNameInput.value = "";
        labLanguageSelect.value = labState.defaultLanguage || DEFAULT_LANGUAGE;
        setRunStatus("Ready", "");
        labOutput.textContent = "";
      }
      labPageInitialized = true;
    } catch {
      labDiagnostics.innerHTML =
        '<p class="java-diag-item java-diag-item--error">The code editor could not load. Reload the page and try again.</p>';
    }
  };

  /* ----------------------- leetcode tracker state ----------------------- */

  const LC_STATE_KEY = "quantaLeetCodeStateV1";

  const seedProblems = () => {
    const p = (num, slug, name, difficulty) => ({
      id: `seed-${num}`,
      num,
      name,
      url: `https://leetcode.com/problems/${slug}/`,
      difficulty,
      solved: false,
      notes: [{ id: randomId("nsec"), title: "Approach", html: "", collapsed: false }],
      code: {}
    });
    return [
      p(1, "two-sum", "Two Sum", "Easy"),
      p(9, "palindrome-number", "Palindrome Number", "Easy"),
      p(13, "roman-to-integer", "Roman to Integer", "Easy"),
      p(14, "longest-common-prefix", "Longest Common Prefix", "Easy"),
      p(20, "valid-parentheses", "Valid Parentheses", "Easy"),
      p(21, "merge-two-sorted-lists", "Merge Two Sorted Lists", "Easy"),
      p(26, "remove-duplicates-from-sorted-array", "Remove Duplicates from Sorted Array", "Easy"),
      p(27, "remove-element", "Remove Element", "Easy"),
      p(28, "find-the-index-of-the-first-occurrence-in-a-string", "Find the Index of the First Occurrence in a String", "Easy"),
      p(35, "search-insert-position", "Search Insert Position", "Easy"),
      p(53, "maximum-subarray", "Maximum Subarray", "Medium"),
      p(58, "length-of-last-word", "Length of Last Word", "Easy"),
      p(66, "plus-one", "Plus One", "Easy"),
      p(67, "add-binary", "Add Binary", "Easy"),
      p(69, "sqrtx", "Sqrt(x)", "Easy"),
      p(70, "climbing-stairs", "Climbing Stairs", "Easy"),
      p(83, "remove-duplicates-from-sorted-list", "Remove Duplicates from Sorted List", "Easy"),
      p(88, "merge-sorted-array", "Merge Sorted Array", "Easy"),
      p(94, "binary-tree-inorder-traversal", "Binary Tree Inorder Traversal", "Easy"),
      p(100, "same-tree", "Same Tree", "Easy"),
      p(101, "symmetric-tree", "Symmetric Tree", "Easy"),
      p(104, "maximum-depth-of-binary-tree", "Maximum Depth of Binary Tree", "Easy"),
      p(108, "convert-sorted-array-to-binary-search-tree", "Convert Sorted Array to Binary Search Tree", "Easy"),
      p(110, "balanced-binary-tree", "Balanced Binary Tree", "Easy"),
      p(111, "minimum-depth-of-binary-tree", "Minimum Depth of Binary Tree", "Easy"),
      p(112, "path-sum", "Path Sum", "Easy"),
      p(118, "pascals-triangle", "Pascal's Triangle", "Easy"),
      p(119, "pascals-triangle-ii", "Pascal's Triangle II", "Easy"),
      p(121, "best-time-to-buy-and-sell-stock", "Best Time to Buy and Sell Stock", "Easy"),
      p(125, "valid-palindrome", "Valid Palindrome", "Easy"),
      p(136, "single-number", "Single Number", "Easy"),
      p(141, "linked-list-cycle", "Linked List Cycle", "Easy"),
      p(144, "binary-tree-preorder-traversal", "Binary Tree Preorder Traversal", "Easy"),
      p(145, "binary-tree-postorder-traversal", "Binary Tree Postorder Traversal", "Easy"),
      p(155, "min-stack", "Min Stack", "Medium"),
      p(160, "intersection-of-two-linked-lists", "Intersection of Two Linked Lists", "Easy"),
      p(167, "two-sum-ii-input-array-is-sorted", "Two Sum II - Input Array Is Sorted", "Medium"),
      p(169, "majority-element", "Majority Element", "Easy"),
      p(171, "excel-sheet-column-number", "Excel Sheet Column Number", "Easy"),
      p(190, "reverse-bits", "Reverse Bits", "Easy"),
      p(191, "number-of-1-bits", "Number of 1 Bits", "Easy"),
      p(202, "happy-number", "Happy Number", "Easy"),
      p(203, "remove-linked-list-elements", "Remove Linked List Elements", "Easy"),
      p(205, "isomorphic-strings", "Isomorphic Strings", "Easy"),
      p(206, "reverse-linked-list", "Reverse Linked List", "Easy"),
      p(217, "contains-duplicate", "Contains Duplicate", "Easy"),
      p(219, "contains-duplicate-ii", "Contains Duplicate II", "Easy"),
      p(226, "invert-binary-tree", "Invert Binary Tree", "Easy"),
      p(231, "power-of-two", "Power of Two", "Easy"),
      p(232, "implement-queue-using-stacks", "Implement Queue using Stacks", "Easy"),
      p(234, "palindrome-linked-list", "Palindrome Linked List", "Easy"),
      p(237, "delete-node-in-a-linked-list", "Delete Node in a Linked List", "Medium"),
      p(242, "valid-anagram", "Valid Anagram", "Easy"),
      p(257, "binary-tree-paths", "Binary Tree Paths", "Easy"),
      p(258, "add-digits", "Add Digits", "Easy"),
      p(263, "ugly-number", "Ugly Number", "Easy"),
      p(268, "missing-number", "Missing Number", "Easy"),
      p(278, "first-bad-version", "First Bad Version", "Easy"),
      p(283, "move-zeroes", "Move Zeroes", "Easy"),
      p(290, "word-pattern", "Word Pattern", "Easy"),
      p(292, "nim-game", "Nim Game", "Easy"),
      p(303, "range-sum-query-immutable", "Range Sum Query - Immutable", "Easy"),
      p(326, "power-of-three", "Power of Three", "Easy"),
      p(338, "counting-bits", "Counting Bits", "Easy"),
      p(342, "power-of-four", "Power of Four", "Easy"),
      p(344, "reverse-string", "Reverse String", "Easy"),
      p(345, "reverse-vowels-of-a-string", "Reverse Vowels of a String", "Easy"),
      p(349, "intersection-of-two-arrays", "Intersection of Two Arrays", "Easy"),
      p(350, "intersection-of-two-arrays-ii", "Intersection of Two Arrays II", "Easy"),
      p(367, "valid-perfect-square", "Valid Perfect Square", "Easy"),
      p(374, "guess-number-higher-or-lower", "Guess Number Higher or Lower", "Easy"),
      p(383, "ransom-note", "Ransom Note", "Easy"),
      p(387, "first-unique-character-in-a-string", "First Unique Character in a String", "Easy"),
      p(389, "find-the-difference", "Find the Difference", "Easy"),
      p(392, "is-subsequence", "Is Subsequence", "Easy"),
      p(404, "sum-of-left-leaves", "Sum of Left Leaves", "Easy"),
      p(409, "longest-palindrome", "Longest Palindrome", "Easy"),
      p(412, "fizz-buzz", "Fizz Buzz", "Easy"),
      p(414, "third-maximum-number", "Third Maximum Number", "Easy"),
      p(415, "add-strings", "Add Strings", "Easy"),
      p(434, "number-of-segments-in-a-string", "Number of Segments in a String", "Easy"),
      p(441, "arranging-coins", "Arranging Coins", "Easy"),
      p(443, "string-compression", "String Compression", "Medium"),
      p(448, "find-all-numbers-disappeared-in-an-array", "Find All Numbers Disappeared in an Array", "Easy"),
      p(455, "assign-cookies", "Assign Cookies", "Easy"),
      p(459, "repeated-substring-pattern", "Repeated Substring Pattern", "Easy"),
      p(461, "hamming-distance", "Hamming Distance", "Easy"),
      p(463, "island-perimeter", "Island Perimeter", "Easy"),
      p(476, "number-complement", "Number Complement", "Easy"),
      p(482, "license-key-formatting", "License Key Formatting", "Easy"),
      p(485, "max-consecutive-ones", "Max Consecutive Ones", "Easy"),
      p(492, "construct-the-rectangle", "Construct the Rectangle", "Easy"),
      p(496, "next-greater-element-i", "Next Greater Element I", "Easy"),
      p(501, "find-mode-in-binary-search-tree", "Find Mode in Binary Search Tree", "Easy"),
      p(504, "base-7", "Base 7", "Easy"),
      p(507, "perfect-number", "Perfect Number", "Easy"),
      p(509, "fibonacci-number", "Fibonacci Number", "Easy"),
      p(520, "detect-capital", "Detect Capital", "Easy"),
      p(521, "longest-uncommon-subsequence-i", "Longest Uncommon Subsequence I", "Easy"),
      p(530, "minimum-absolute-difference-in-bst", "Minimum Absolute Difference in BST", "Easy"),
      p(541, "reverse-string-ii", "Reverse String II", "Easy"),
      p(543, "diameter-of-binary-tree", "Diameter of Binary Tree", "Easy"),
      p(551, "student-attendance-record-i", "Student Attendance Record I", "Easy"),
      p(557, "reverse-words-in-a-string-iii", "Reverse Words in a String III", "Easy"),
      p(559, "maximum-depth-of-n-ary-tree", "Maximum Depth of N-ary Tree", "Easy"),
      p(561, "array-partition", "Array Partition", "Easy"),
      p(566, "reshape-the-matrix", "Reshape the Matrix", "Easy"),
      p(563, "binary-tree-tilt", "Binary Tree Tilt", "Easy"),
      p(572, "subtree-of-another-tree", "Subtree of Another Tree", "Easy"),
      p(575, "distribute-candies", "Distribute Candies", "Easy"),
      p(589, "n-ary-tree-preorder-traversal", "N-ary Tree Preorder Traversal", "Easy"),
      p(590, "n-ary-tree-postorder-traversal", "N-ary Tree Postorder Traversal", "Easy"),
      p(594, "longest-harmonious-subsequence", "Longest Harmonious Subsequence", "Easy"),
      p(598, "range-addition-ii", "Range Addition II", "Easy"),
      p(599, "minimum-index-sum-of-two-lists", "Minimum Index Sum of Two Lists", "Easy"),
      p(605, "can-place-flowers", "Can Place Flowers", "Easy"),
      p(606, "construct-string-from-binary-tree", "Construct String from Binary Tree", "Easy"),
      p(617, "merge-two-binary-trees", "Merge Two Binary Trees", "Easy"),
      p(628, "maximum-product-of-three-numbers", "Maximum Product of Three Numbers", "Easy"),
      p(637, "average-of-levels-in-binary-tree", "Average of Levels in Binary Tree", "Easy"),
      p(643, "maximum-average-subarray-i", "Maximum Average Subarray I", "Easy"),
      p(645, "set-mismatch", "Set Mismatch", "Easy"),
      p(647, "palindromic-substrings", "Palindromic Substrings", "Medium"),
      p(653, "two-sum-iv-input-is-a-bst", "Two Sum IV - Input is a BST", "Easy"),
      p(657, "robot-return-to-origin", "Robot Return to Origin", "Easy"),
      p(661, "image-smoother", "Image Smoother", "Easy"),
      p(671, "second-minimum-node-in-a-binary-tree", "Second Minimum Node In a Binary Tree", "Easy"),
      p(674, "longest-continuous-increasing-subsequence", "Longest Continuous Increasing Subsequence", "Easy"),
      p(680, "valid-palindrome-ii", "Valid Palindrome II", "Easy"),
      p(682, "baseball-game", "Baseball Game", "Easy"),
      p(687, "longest-univalue-path", "Longest Univalue Path", "Medium"),
      p(693, "binary-number-with-alternating-bits", "Binary Number with Alternating Bits", "Easy"),
      p(696, "count-binary-substrings", "Count Binary Substrings", "Easy"),
      p(697, "degree-of-an-array", "Degree of an Array", "Easy"),
      p(700, "search-in-a-binary-search-tree", "Search in a Binary Search Tree", "Easy"),
      p(703, "kth-largest-element-in-a-stream", "Kth Largest Element in a Stream", "Easy"),
      p(704, "binary-search", "Binary Search", "Easy"),
      p(705, "design-hashset", "Design HashSet", "Easy"),
      p(706, "design-hashmap", "Design HashMap", "Easy"),
      p(709, "to-lower-case", "To Lower Case", "Easy"),
      p(716, "max-stack", "Max Stack", "Hard"),
      p(717, "1-bit-and-2-bit-characters", "1-bit and 2-bit Characters", "Easy"),
      p(720, "longest-word-in-dictionary", "Longest Word in Dictionary", "Easy"),
      p(724, "find-pivot-index", "Find Pivot Index", "Easy"),
      p(728, "self-dividing-numbers", "Self Dividing Numbers", "Easy"),
      p(733, "flood-fill", "Flood Fill", "Easy"),
      p(734, "sentence-similarity", "Sentence Similarity", "Easy"),
      p(744, "find-smallest-letter-greater-than-target", "Find Smallest Letter Greater Than Target", "Easy"),
      p(746, "min-cost-climbing-stairs", "Min Cost Climbing Stairs", "Easy"),
      p(747, "largest-number-at-least-twice-of-others", "Largest Number At Least Twice of Others", "Easy"),
      p(748, "shortest-completing-word", "Shortest Completing Word", "Easy"),
      p(754, "reach-a-number", "Reach a Number", "Medium"),
      p(760, "find-anagram-mappings", "Find Anagram Mappings", "Easy"),
      p(762, "prime-number-of-set-bits-in-binary-representation", "Prime Number of Set Bits in Binary Representation", "Easy"),
      p(766, "toeplitz-matrix", "Toeplitz Matrix", "Easy"),
      p(771, "jewels-and-stones", "Jewels and Stones", "Easy"),
      p(783, "minimum-distance-between-bst-nodes", "Minimum Distance Between BST Nodes", "Easy"),
      p(788, "rotated-digits", "Rotated Digits", "Medium"),
      p(796, "rotate-string", "Rotate String", "Easy"),
      p(804, "unique-morse-code-words", "Unique Morse Code Words", "Easy"),
      p(806, "number-of-lines-to-write-string", "Number of Lines To Write String", "Easy"),
      p(812, "largest-triangle-area", "Largest Triangle Area", "Easy"),
      p(819, "most-common-word", "Most Common Word", "Easy"),
      p(821, "shortest-distance-to-a-character", "Shortest Distance to a Character", "Easy"),
      p(824, "goat-latin", "Goat Latin", "Easy"),
      p(830, "positions-of-large-groups", "Positions of Large Groups", "Easy"),
      p(832, "flipping-an-image", "Flipping an Image", "Easy"),
      p(836, "rectangle-overlap", "Rectangle Overlap", "Easy"),
      p(840, "magic-squares-in-grid", "Magic Squares In Grid", "Easy"),
      p(844, "backspace-string-compare", "Backspace String Compare", "Easy"),
      p(849, "maximize-distance-to-closest-person", "Maximize Distance to Closest Person", "Medium"),
      p(852, "peak-index-in-a-mountain-array", "Peak Index in a Mountain Array", "Medium"),
      p(859, "buddy-strings", "Buddy Strings", "Easy"),
      p(860, "lemonade-change", "Lemonade Change", "Easy"),
      p(868, "binary-gap", "Binary Gap", "Easy"),
      p(872, "leaf-similar-trees", "Leaf-Similar Trees", "Easy"),
      p(876, "middle-of-the-linked-list", "Middle of the Linked List", "Easy"),
      p(883, "projection-area-of-3d-shapes", "Projection Area of 3D Shapes", "Easy"),
      p(884, "uncommon-words-from-two-sentences", "Uncommon Words from Two Sentences", "Easy"),
      p(888, "fair-candy-swap", "Fair Candy Swap", "Easy"),
      p(892, "surface-area-of-3d-shapes", "Surface Area of 3D Shapes", "Easy"),
      p(896, "monotonic-array", "Monotonic Array", "Easy"),
      p(897, "increasing-order-search-tree", "Increasing Order Search Tree", "Easy"),
      p(905, "sort-array-by-parity", "Sort Array By Parity", "Easy"),
      p(908, "smallest-range-i", "Smallest Range I", "Easy"),
      p(914, "x-of-a-kind-in-a-deck-of-cards", "X of a Kind in a Deck of Cards", "Easy"),
      p(917, "reverse-only-letters", "Reverse Only Letters", "Easy"),
      p(922, "sort-array-by-parity-ii", "Sort Array By Parity II", "Easy"),
      p(925, "long-pressed-name", "Long Pressed Name", "Easy"),
      p(929, "unique-email-addresses", "Unique Email Addresses", "Easy"),
      p(933, "number-of-recent-calls", "Number of Recent Calls", "Easy"),
      p(938, "range-sum-of-bst", "Range Sum of BST", "Easy"),
      p(941, "valid-mountain-array", "Valid Mountain Array", "Easy"),
      p(942, "di-string-match", "DI String Match", "Easy"),
      p(944, "delete-columns-to-make-sorted", "Delete Columns to Make Sorted", "Easy"),
      p(953, "verifying-an-alien-dictionary", "Verifying an Alien Dictionary", "Easy"),
      p(961, "n-repeated-element-in-size-2n-array", "N-Repeated Element in Size 2N Array", "Easy"),
      p(965, "univalued-binary-tree", "Univalued Binary Tree", "Easy"),
      p(970, "powerful-integers", "Powerful Integers", "Easy"),
      p(973, "k-closest-points-to-origin", "K Closest Points to Origin", "Medium"),
      p(977, "squares-of-a-sorted-array", "Squares of a Sorted Array", "Easy"),
      p(989, "add-to-array-form-of-integer", "Add to Array Form of Integer", "Easy"),
      p(993, "cousins-in-binary-tree", "Cousins in Binary Tree", "Easy"),
      p(997, "find-the-town-judge", "Find the Town Judge", "Easy"),
      p(1002, "find-common-characters", "Find Common Characters", "Easy"),
      p(1009, "complement-of-base-10-integer", "Complement of Base 10 Integer", "Easy"),
      p(1010, "pairs-of-songs-with-total-durations-divisible-by-60", "Pairs of Songs With Total Durations Divisible by 60", "Medium"),
      p(1013, "partition-array-into-three-parts-with-equal-sum", "Partition Array Into Three Parts With Equal Sum", "Easy"),
      p(1021, "remove-outermost-parentheses", "Remove Outermost Parentheses", "Easy"),
      p(1022, "sum-of-root-to-leaf-binary-numbers", "Sum of Root To Leaf Binary Numbers", "Easy"),
      p(1025, "divisor-game", "Divisor Game", "Easy"),
      p(1030, "matrix-cells-in-distance-order", "Matrix Cells in Distance Order", "Easy"),
      p(1037, "valid-boomerang", "Valid Boomerang", "Easy"),
      p(1046, "last-stone-weight", "Last Stone Weight", "Easy"),
      p(1047, "remove-all-adjacent-duplicates-in-string", "Remove All Adjacent Duplicates In String", "Easy"),
      p(1051, "height-checker", "Height Checker", "Easy"),
      p(1071, "greatest-common-divisor-of-strings", "Greatest Common Divisor of Strings", "Easy"),
      p(1078, "occurrences-after-bigram", "Occurrences After Bigram", "Easy"),
      p(1089, "duplicate-zeros", "Duplicate Zeros", "Easy"),
      p(1103, "distribute-candies-to-people", "Distribute Candies to People", "Easy"),
      p(1108, "defanging-an-ip-address", "Defanging an IP Address", "Easy"),
      p(1119, "remove-vowels-from-a-string", "Remove Vowels from a String", "Easy"),
      p(1122, "relative-sort-array", "Relative Sort Array", "Easy"),
      p(1128, "number-of-equivalent-domino-pairs", "Number of Equivalent Domino Pairs", "Easy"),
      p(1137, "n-th-tribonacci-number", "N-th Tribonacci Number", "Easy"),
      p(1154, "day-of-the-year", "Day of the Year", "Easy"),
      p(1160, "find-words-that-can-be-formed-by-characters", "Find Words That Can Be Formed by Characters", "Easy"),
      p(1170, "compare-strings-by-frequency-of-the-smallest-character", "Compare Strings by Frequency of the Smallest Character", "Medium"),
      p(1184, "distance-between-bus-stops", "Distance Between Bus Stops", "Easy"),
      p(1185, "day-of-the-week", "Day of the Week", "Easy"),
      p(1189, "maximum-number-of-balloons", "Maximum Number of Balloons", "Easy"),
      p(1200, "minimum-absolute-difference", "Minimum Absolute Difference", "Easy"),
      p(1207, "unique-number-of-occurrences", "Unique Number of Occurrences", "Easy"),
      p(1217, "minimum-cost-to-move-chips-to-the-same-position", "Minimum Cost to Move Chips to The Same Position", "Easy"),
      p(1221, "split-a-string-in-balanced-strings", "Split a String in Balanced Strings", "Easy"),
      p(1232, "check-if-it-is-a-straight-line", "Check If It Is a Straight Line", "Easy"),
      p(1237, "find-positive-integer-solution-for-a-given-equation", "Find Positive Integer Solution for a Given Equation", "Medium"),
      p(1250, "check-if-it-is-a-good-array", "Check If It Is a Good Array", "Hard"),
      p(1252, "cells-with-odd-values-in-a-matrix", "Cells with Odd Values in a Matrix", "Easy"),
      p(1260, "shift-2d-grid", "Shift 2D Grid", "Easy"),
      p(1266, "minimum-time-visiting-all-points", "Minimum Time Visiting All Points", "Easy"),
      p(1275, "find-winner-on-a-tic-tac-toe-game", "Find Winner on a Tic Tac Toe Game", "Easy"),
      p(1281, "subtract-the-product-and-sum-of-digits-of-an-integer", "Subtract the Product and Sum of Digits of an Integer", "Easy"),
      p(1287, "element-appearing-more-than-25-in-sorted-array", "Element Appearing More Than 25% In Sorted Array", "Easy"),
      p(1290, "convert-binary-number-in-a-linked-list-to-integer", "Convert Binary Number in a Linked List to Integer", "Easy"),
      p(1295, "find-numbers-with-even-number-of-digits", "Find Numbers with Even Number of Digits", "Easy"),
      p(1299, "replace-elements-with-greatest-element-on-right-side", "Replace Elements with Greatest Element on Right Side", "Easy"),
      p(1304, "find-n-unique-integers-sum-up-to-zero", "Find N Unique Integers Sum up to Zero", "Easy"),
      p(1309, "decrypt-string-from-alphabet-to-integer-mapping", "Decrypt String from Alphabet to Integer Mapping", "Easy"),
      p(1313, "decompress-run-length-encoded-list", "Decompress Run-Length Encoded List", "Easy"),
      p(1317, "convert-integer-to-the-sum-of-two-no-zero-integers", "Convert Integer to the Sum of Two No-Zero Integers", "Easy"),
      p(1323, "maximum-69-number", "Maximum 69 Number", "Easy"),
      p(1331, "rank-transform-of-an-array", "Rank Transform of an Array", "Easy"),
      p(1332, "remove-palindromic-subsequences", "Remove Palindromic Subsequences", "Easy"),
      p(1337, "the-k-weakest-rows-in-a-matrix", "The K Weakest Rows in a Matrix", "Easy"),
      p(1342, "number-of-steps-to-reduce-a-number-to-zero", "Number of Steps to Reduce a Number to Zero", "Easy"),
      p(1346, "check-if-n-and-its-double-exist", "Check If N and Its Double Exist", "Easy"),
      p(1351, "count-negative-numbers-in-a-sorted-matrix", "Count Negative Numbers in a Sorted Matrix", "Easy"),
      p(1356, "sort-integers-by-the-number-of-1-bits", "Sort Integers by The Number of 1 Bits", "Easy"),
      p(1360, "number-of-days-between-two-dates", "Number of Days Between Two Dates", "Easy"),
      p(1365, "how-many-numbers-are-smaller-than-the-current-number", "How Many Numbers Are Smaller Than the Current Number", "Easy"),
      p(1370, "increasing-decreasing-string", "Increasing Decreasing String", "Easy"),
      p(1374, "generate-a-string-with-characters-that-have-odd-counts", "Generate a String With Characters That Have Odd Counts", "Easy"),
      p(1379, "find-a-corresponding-node-of-a-binary-tree-in-a-clone-of-that-tree", "Find a Corresponding Node of a Binary Tree in a Clone of That Tree", "Medium"),
      p(1380, "lucky-numbers-in-a-matrix", "Lucky Numbers in a Matrix", "Easy"),
      p(1385, "find-the-distance-value-between-two-arrays", "Find the Distance Value Between Two Arrays", "Easy"),
      p(1389, "create-target-array-in-the-given-order", "Create Target Array in the Given Order", "Easy"),
      p(1394, "find-lucky-integer-in-an-array", "Find Lucky Integer in an Array", "Easy"),
      p(1399, "count-largest-group", "Count Largest Group", "Easy"),
      p(1403, "minimum-subsequence-in-non-increasing-order", "Minimum Subsequence in Non-Increasing Order", "Easy"),
      p(1408, "string-matching-in-an-array", "String Matching in an Array", "Easy"),
      p(1413, "minimum-value-to-get-positive-step-by-step-sum", "Minimum Value to Get Positive Step by Step Sum", "Easy"),
      p(1417, "reformat-the-string", "Reformat The String", "Easy"),
      p(1422, "maximum-score-after-splitting-a-string", "Maximum Score After Splitting a String", "Easy"),
      p(1431, "kids-with-the-greatest-number-of-candies", "Kids With the Greatest Number of Candies", "Easy"),
      p(1436, "destination-city", "Destination City", "Easy"),
      p(1441, "build-an-array-with-stack-operations", "Build an Array With Stack Operations", "Easy"),
      p(1446, "consecutive-characters", "Consecutive Characters", "Easy"),
      p(1450, "number-of-students-doing-homework-at-a-given-time", "Number of Students Doing Homework at a Given Time", "Easy"),
      p(1455, "check-if-a-word-occurs-as-a-prefix-of-any-word-in-a-sentence", "Check If a Word Occurs As a Prefix of Any Word in a Sentence", "Easy"),
      p(1460, "make-two-arrays-equal-by-reversing-sub-arrays", "Make Two Arrays Equal by Reversing Sub-arrays", "Easy"),
      p(1464, "maximum-product-of-two-elements-in-an-array", "Maximum Product of Two Elements in an Array", "Easy"),
      p(1469, "find-all-the-lonely-nodes", "Find All The Lonely Nodes", "Easy"),
      p(1470, "shuffle-the-array", "Shuffle the Array", "Easy"),
      p(1475, "final-prices-with-a-special-discount-in-a-shop", "Final Prices With a Special Discount in a Shop", "Easy"),
      p(1480, "running-sum-of-1d-array", "Running Sum of 1d Array", "Easy"),
      p(1486, "xor-operation-in-an-array", "XOR Operation in an Array", "Easy"),
      p(1491, "average-salary-excluding-the-minimum-and-maximum-salary", "Average Salary Excluding the Minimum and Maximum Salary", "Easy"),
      p(1496, "path-crossing", "Path Crossing", "Easy"),
      p(1502, "can-make-arithmetic-progression-from-sequence", "Can Make Arithmetic Progression From Sequence", "Easy"),
      p(1507, "reformat-date", "Reformat Date", "Easy"),
      p(1512, "number-of-good-pairs", "Number of Good Pairs", "Easy"),
      p(1518, "water-bottles", "Water Bottles", "Easy"),
      p(1523, "count-odd-numbers-in-an-interval-range", "Count Odd Numbers in an Interval Range", "Easy"),
      p(1528, "shuffle-string", "Shuffle String", "Easy"),
      p(1534, "count-good-triplets", "Count Good Triplets", "Easy"),
      p(1539, "kth-missing-positive-number", "Kth Missing Positive Number", "Easy"),
      p(1544, "make-the-string-great", "Make The String Great", "Easy"),
      p(1550, "three-consecutive-odds", "Three Consecutive Odds", "Easy"),
      p(1556, "thousand-separator", "Thousand Separator", "Easy"),
      p(1560, "most-visited-sector-in-a-circular-track", "Most Visited Sector in a Circular Track", "Easy"),
      p(1566, "detect-pattern-of-length-m-repeated-k-or-more-times", "Detect Pattern of Length M Repeated K or More Times", "Easy"),
      p(1572, "matrix-diagonal-sum", "Matrix Diagonal Sum", "Easy"),
      p(1576, "replace-all-s-to-avoid-consecutive-repeating-characters", "Replace All ?'s to Avoid Consecutive Repeating Characters", "Easy"),
      p(1582, "special-positions-in-a-binary-matrix", "Special Positions in a Binary Matrix", "Easy"),
      p(1588, "sum-of-all-odd-length-subarrays", "Sum of All Odd Length Subarrays", "Easy"),
      p(1592, "rearrange-spaces-between-words", "Rearrange Spaces Between Words", "Easy"),
      p(1598, "crawler-log-folder", "Crawler Log Folder", "Easy"),
      p(1603, "design-parking-system", "Design Parking System", "Easy"),
      p(1608, "special-array-with-x-elements-greater-than-or-equal-x", "Special Array With X Elements Greater Than or Equal X", "Easy"),
      p(1614, "maximum-nesting-depth-of-the-parentheses", "Maximum Nesting Depth of the Parentheses", "Easy"),
      p(1620, "coordinate-with-maximum-network-quality", "Coordinate With Maximum Network Quality", "Medium"),
      p(1624, "largest-substring-between-two-equal-characters", "Largest Substring Between Two Equal Characters", "Easy"),
      p(1629, "slowest-key", "Slowest Key", "Easy"),
      p(1633, "percentage-of-letter-in-string", "Percentage of Letter in String", "Easy"),
      p(1636, "sort-array-by-increasing-frequency", "Sort Array by Increasing Frequency", "Easy"),
      p(1637, "widest-vertical-area-between-two-points-containing-no-points", "Widest Vertical Area Between Two Points Containing No Points", "Medium"),
      p(1640, "check-array-formation-through-concatenation", "Check Array Formation Through Concatenation", "Easy"),
      p(1646, "get-maximum-in-generated-array", "Get Maximum in Generated Array", "Easy"),
      p(1652, "defuse-the-bomb", "Defuse the Bomb", "Easy"),
      p(1656, "design-an-ordered-stream", "Design an Ordered Stream", "Easy"),
      p(1662, "check-if-two-string-arrays-are-equivalent", "Check If Two String Arrays are Equivalent", "Easy"),
      p(1668, "maximum-repeating-substring", "Maximum Repeating Substring", "Easy"),
      p(1672, "richest-customer-wealth", "Richest Customer Wealth", "Easy"),
      p(1678, "goal-parser-interpretation", "Goal Parser Interpretation", "Easy"),
      p(1684, "count-the-number-of-consistent-strings", "Count the Number of Consistent Strings", "Easy"),
      p(1688, "count-of-matches-in-tournament", "Count of Matches in Tournament", "Easy"),
      p(1694, "reformat-phone-number", "Reformat Phone Number", "Easy"),
      p(1700, "number-of-students-unable-to-eat-lunch", "Number of Students Unable to Eat Lunch", "Easy"),
      p(1704, "determine-if-string-halves-are-alike", "Determine if String Halves Are Alike", "Easy"),
      p(1710, "maximum-units-on-a-truck", "Maximum Units on a Truck", "Easy"),
      p(1716, "calculate-money-in-leetcode-bank", "Calculate Money in LeetCode Bank", "Easy"),
      p(1720, "decode-xored-array", "Decode XORed Array", "Easy"),
      p(1725, "number-of-rectangles-that-can-form-the-largest-square", "Number Of Rectangles That Can Form The Largest Square", "Easy"),
      p(1732, "find-the-highest-altitude", "Find the Highest Altitude", "Easy"),
      p(1736, "latest-time-by-replacing-hidden-digits", "Latest Time by Replacing Hidden Digits", "Easy"),
      p(1741, "find-total-time-spent-by-each-employee", "Find Total Time Spent by Each Employee", "Easy"),
      p(1742, "maximum-number-of-balls-in-a-box", "Maximum Number of Balls in a Box", "Easy"),
      p(1748, "sum-of-unique-elements", "Sum of Unique Elements", "Easy"),
      p(1752, "check-if-array-is-sorted-and-rotated", "Check if Array Is Sorted and Rotated", "Easy"),
      p(1758, "minimum-changes-to-make-alternating-binary-string", "Minimum Changes To Make Alternating Binary String", "Easy"),
      p(1763, "sum-of-prefix-scores-of-strings", "Sum of Prefix Scores of Strings", "Hard"),
      p(1768, "merge-strings-alternately", "Merge Strings Alternately", "Easy"),
      p(1773, "count-items-matching-a-rule", "Count Items Matching a Rule", "Easy"),
      p(1779, "find-nearest-point-that-has-the-same-x-or-y-coordinate", "Find Nearest Point That Has the Same X or Y Coordinate", "Easy"),
      p(1784, "check-if-binary-string-has-at-most-one-segment-of-ones", "Check if Binary String Has at Most One Segment of Ones", "Easy"),
      p(1790, "check-if-one-string-swap-can-make-strings-equal", "Check if One String Swap Can Make Strings Equal", "Easy"),
      p(1791, "find-center-of-star-graph", "Find Center of Star Graph", "Easy"),
      p(1796, "second-largest-digit-in-a-string", "Second Largest Digit in a String", "Easy"),
      p(1800, "maximum-ascending-subarray-sum", "Maximum Ascending Subarray Sum", "Easy"),
      p(1805, "number-of-different-integers-in-a-string", "Number of Different Integers in a String", "Easy"),
      p(1812, "determine-color-of-a-chessboard-square", "Determine Color of a Chessboard Square", "Easy"),
      p(1816, "truncate-sentence", "Truncate Sentence", "Easy"),
      p(1822, "sign-of-the-product-of-an-array", "Sign of the Product of an Array", "Easy"),
      p(1827, "minimum-operations-to-make-the-array-increasing", "Minimum Operations to Make the Array Increasing", "Easy"),
      p(1832, "check-if-the-sentence-is-pangram", "Check if the Sentence Is Pangram", "Easy"),
      p(1837, "sum-of-digits-in-base-k", "Sum of Digits in Base K", "Easy"),
      p(1844, "replace-all-digits-with-characters", "Replace All Digits with Characters", "Easy"),
      p(1848, "minimum-distance-to-the-target-element", "Minimum Distance to the Target Element", "Easy"),
      p(1854, "maximum-population-year", "Maximum Population Year", "Easy"),
      p(1859, "sorting-the-sentence", "Sorting the Sentence", "Easy"),
      p(1863, "sum-of-all-subset-xor-totals", "Sum of All Subset XOR Totals", "Easy"),
      p(1869, "longer-contiguous-segments-of-ones-than-zeros", "Longer Contiguous Segments of Ones than Zeros", "Easy"),
      p(1876, "substrings-of-size-three-with-distinct-characters", "Substrings of Size Three with Distinct Characters", "Easy"),
      p(1880, "check-if-word-equals-summation-of-two-words", "Check if Word Equals Summation of Two Words", "Easy"),
      p(1886, "determine-whether-matrix-can-be-obtained-by-rotation", "Determine Whether Matrix Can Be Obtained By Rotation", "Easy"),
      p(1893, "check-if-all-the-integers-in-a-range-are-covered", "Check if All the Integers in a Range Are Covered", "Easy"),
      p(1897, "redistribute-characters-to-make-all-strings-equal", "Redistribute Characters to Make All Strings Equal", "Easy"),
      p(1903, "largest-odd-number-in-string", "Largest Odd Number in String", "Easy"),
      p(1909, "remove-one-element-to-make-the-array-strictly-increasing", "Remove One Element to Make the Array Strictly Increasing", "Easy"),
      p(1913, "maximum-product-difference-between-two-pairs", "Maximum Product Difference Between Two Pairs", "Easy"),
      p(1920, "build-array-from-permutation", "Build Array from Permutation", "Easy"),
      p(1925, "count-square-sum-triples", "Count Square Sum Triples", "Easy"),
      p(1929, "concatenation-of-array", "Concatenation of Array", "Easy"),
      p(1935, "maximum-number-of-words-you-can-type", "Maximum Number of Words You Can Type", "Easy"),
      p(1941, "check-if-all-characters-have-equal-number-of-occurrences", "Check if All Characters Have Equal Number of Occurrences", "Easy"),
      p(1945, "sum-of-digits-of-string-after-convert", "Sum of Digits of String After Convert", "Easy"),
      p(1952, "three-divisors", "Three Divisors", "Easy"),
      p(1957, "delete-characters-to-make-fancy-string", "Delete Characters to Make Fancy String", "Easy"),
      p(1961, "check-if-string-is-a-prefix-of-array", "Check If String Is a Prefix of Array", "Easy"),
      p(1967, "number-of-strings-that-appear-as-substrings-in-word", "Number of Strings That Appear as Substrings in Word", "Easy"),
      p(1971, "find-if-path-exists-in-graph", "Find if Path Exists in Graph", "Easy"),
      p(1974, "minimum-time-to-type-word-using-special-typewriter", "Minimum Time to Type Word Using Special Typewriter", "Easy"),
      p(1979, "find-greatest-common-divisor-of-array", "Find Greatest Common Divisor of Array", "Easy"),
      p(1984, "minimum-difference-between-highest-and-lowest-of-k-scores", "Minimum Difference Between Highest and Lowest of K Scores", "Easy"),
      p(1988, "find-cutoff-score-for-each-school", "Find Cutoff Score for Each School", "Medium"),
      p(1991, "find-the-middle-index-in-array", "Find the Middle Index in Array", "Easy"),
      p(1995, "count-special-quadruplets", "Count Special Quadruplets", "Easy"),
      p(2000, "reverse-prefix-of-word", "Reverse Prefix of Word", "Easy"),
      p(2006, "count-number-of-pairs-with-absolute-difference-k", "Count Number of Pairs With Absolute Difference K", "Easy"),
      p(2011, "final-value-of-variable-after-performing-operations", "Final Value of Variable After Performing Operations", "Easy"),
      p(2016, "maximum-difference-between-increasing-elements", "Maximum Difference Between Increasing Elements", "Easy"),
      p(2022, "convert-1d-array-into-2d-array", "Convert 1D Array Into 2D Array", "Easy"),
      p(2027, "minimum-moves-to-convert-string", "Minimum Moves to Convert String", "Easy"),
      p(2032, "two-out-of-three", "Two Out of Three", "Easy"),
      p(2037, "minimum-number-of-moves-to-seat-everyone", "Minimum Number of Moves to Seat Everyone", "Easy"),
      p(2042, "check-if-numbers-are-ascending-in-a-sentence", "Check if Numbers Are Ascending in a Sentence", "Easy"),
      p(2047, "number-of-valid-words-in-a-sentence", "Number of Valid Words in a Sentence", "Easy"),
      p(2053, "kth-distinct-string-in-an-array", "Kth Distinct String in an Array", "Easy"),
      p(2057, "smallest-index-with-equal-value", "Smallest Index With Equal Value", "Easy"),
      p(2062, "count-vowel-substrings-of-a-string", "Count Vowel Substrings of a String", "Easy"),
      p(2068, "check-whether-two-strings-are-almost-equivalent", "Check Whether Two Strings are Almost Equivalent", "Easy"),
      p(2073, "time-needed-to-buy-tickets", "Time Needed to Buy Tickets", "Easy"),
      p(2078, "two-furthest-houses-with-different-colors", "Two Furthest Houses With Different Colors", "Easy"),
      p(2085, "count-common-words-with-one-occurrence", "Count Common Words With One Occurrence", "Easy"),
      p(2089, "find-target-indices-after-sorting-array", "Find Target Indices After Sorting Array", "Easy"),
      p(2094, "finding-3-digit-even-numbers", "Finding 3-Digit Even Numbers", "Easy"),
      p(2099, "find-subsequence-of-length-k-with-the-largest-sum", "Find Subsequence of Length K With the Largest Sum", "Easy"),
      p(2103, "rings-and-rods", "Rings and Rods", "Easy"),
      p(2108, "find-first-palindromic-string-in-the-array", "Find First Palindromic String in the Array", "Easy"),
      p(2114, "maximum-number-of-words-found-in-sentences", "Maximum Number of Words Found in Sentences", "Easy"),
      p(2119, "a-number-after-a-double-reversal", "A Number After a Double Reversal", "Easy"),
      p(2124, "check-if-all-as-appears-before-all-bs", "Check if All A's Appears Before All B's", "Easy"),
      p(2129, "capitalize-the-title", "Capitalize the Title", "Easy"),
      p(2133, "check-if-every-row-and-column-contains-all-numbers", "Check if Every Row and Column Contains All Numbers", "Easy"),
      p(2138, "divide-a-string-into-groups-of-size-k", "Divide a String Into Groups of Size k", "Easy"),
      p(2144, "minimum-cost-of-buying-candies-with-discount", "Minimum Cost of Buying Candies With Discount", "Easy"),
      p(2148, "count-elements-with-strictly-smaller-and-greater-elements", "Count Elements With Strictly Smaller and Greater Elements", "Easy"),
      p(2154, "keep-multiplying-found-values-by-two", "Keep Multiplying Found Values by Two", "Easy"),
      p(2159, "two-out-of-three-approach", "Two Out of Three", "Easy"),
      p(2160, "minimum-sum-of-four-digit-number-after-splitting-digits", "Minimum Sum of Four Digit Number After Splitting Digits", "Easy"),
      p(2164, "sort-even-and-odd-indices-independently", "Sort Even and Odd Indices Independently", "Easy"),
      p(2169, "count-operations-to-obtain-zero", "Count Operations to Obtain Zero", "Easy"),
      p(2176, "count-equal-and-divisible-pairs-in-an-array", "Count Equal and Divisible Pairs in an Array", "Easy"),
      p(2180, "count-integers-with-even-digit-sum", "Count Integers With Even Digit Sum", "Easy"),
      p(2185, "counting-words-with-a-given-prefix", "Counting Words With a Given Prefix", "Easy"),
      p(2190, "nums-divisible-by-4-and-6", "Nums Divisible by 4 and 6", "Easy"),
      p(2194, "cells-in-a-range-on-an-excel-sheet", "Cells in a Range on an Excel Sheet", "Easy"),
      p(2199, "finding-the-users-active-minutes", "Finding the Users Active Minutes", "Medium"),
      p(2200, "find-all-k-distant-indices-in-an-array", "Find All K-Distant Indices in an Array", "Easy"),
      p(2206, "divide-array-into-equal-pairs", "Divide Array Into Equal Pairs", "Easy"),
      p(2210, "count-hills-and-valleys-in-an-array", "Count Hills and Valleys in an Array", "Easy"),
      p(2215, "find-the-difference-of-two-arrays", "Find the Difference of Two Arrays", "Easy"),
      p(2220, "minimum-bit-flips-to-convert-number", "Minimum Bit Flips to Convert Number", "Easy"),
      p(2224, "minimum-number-of-operations-to-convert-time", "Minimum Number of Operations to Convert Time", "Easy"),
      p(2229, "check-if-an-array-is-consecutive", "Check if an Array Is Consecutive", "Medium"),
      p(2231, "largest-number-after-digit-swaps-by-parity", "Largest Number After Digit Swaps By Parity", "Easy"),
      p(2235, "add-two-integers", "Add Two Integers", "Easy"),
      p(2236, "root-equals-sum-of-children", "Root Equals Sum of Children", "Easy"),
      p(2239, "find-closest-number-to-zero", "Find Closest Number to Zero", "Easy"),
      p(2243, "calculate-digit-sum-of-a-string", "Calculate Digit Sum of a String", "Easy"),
      p(2248, "intersection-of-multiple-arrays", "Intersection of Multiple Arrays", "Easy"),
      p(2255, "count-prefixes-of-a-given-string", "Count Prefixes of a Given String", "Easy"),
      p(2259, "remove-digit-from-number-to-maximize-result", "Remove Digit From Number to Maximize Result", "Easy"),
      p(2264, "largest-3-same-digit-number-in-string", "Largest 3-Same-Digit Number in String", "Easy"),
      p(2269, "find-the-k-beauty-of-a-number", "Find the K-Beauty of a Number", "Easy"),
      p(2273, "find-resultant-array-after-removing-anagrams", "Find Resultant Array After Removing Anagrams", "Easy"),
      p(2278, "percentage-of-letter-in-string-ii", "Percentage of Letter in String", "Easy"),
      p(2283, "check-if-number-has-equal-digit-count-and-digit-value", "Check if Number Has Equal Digit Count and Digit Value", "Easy"),
      p(2287, "rearrange-characters-to-make-target-string", "Rearrange Characters to Make Target String", "Easy"),
      p(2293, "min-max-game", "Min Max Game", "Easy"),
      p(2299, "strong-password-checker-ii", "Strong Password Checker II", "Easy"),
      p(2303, "calculate-amount-paid-in-taxes", "Calculate Amount Paid in Taxes", "Easy"),
      p(2309, "greatest-english-letter-in-upper-and-lower-case", "Greatest English Letter in Upper and Lower Case", "Easy"),
      p(2315, "count-asterisks", "Count Asterisks", "Easy"),
      p(2319, "check-if-matrix-is-x-matrix", "Check if Matrix Is X-Matrix", "Easy"),
      p(2325, "decode-the-message", "Decode the Message", "Easy"),
      p(2331, "evaluate-boolean-binary-tree", "Evaluate Boolean Binary Tree", "Easy"),
      p(2335, "minimum-amount-of-time-to-fill-cups", "Minimum Amount of Time to Fill Cups", "Easy"),
      p(2339, "atheletes-and-trainers-approach", "Atheletes and Trainers", "Easy"),
      p(2341, "maximum-number-of-pairs-in-array", "Maximum Number of Pairs in Array", "Easy"),
      p(2347, "best-poker-hand", "Best Poker Hand", "Easy"),
      p(2351, "first-letter-to-appear-twice", "First Letter to Appear Twice", "Easy"),
      p(2357, "make-array-zero-by-subtracting-equal-amounts", "Make Array Zero by Subtracting Equal Amounts", "Easy"),
      p(2363, "merge-similar-items", "Merge Similar Items", "Easy"),
      p(2367, "number-of-arithmetic-triplets", "Number of Arithmetic Triplets", "Easy"),
      p(2373, "largest-local-values-in-a-matrix", "Largest Local Values in a Matrix", "Easy"),
      p(2379, "minimum-recolors-to-get-k-consecutive-black-blocks", "Minimum Recolors to Get K Consecutive Black Blocks", "Easy"),
      p(2383, "minimum-hours-of-training-to-win-a-competition", "Minimum Hours of Training to Win a Competition", "Easy"),
      p(2389, "longest-subsequence-with-limited-sum", "Longest Subsequence With Limited Sum", "Easy"),
      p(2395, "find-subarrays-with-equal-sum", "Find Subarrays With Equal Sum", "Easy"),
      p(2399, "check-distances-between-same-letters", "Check Distances Between Same Letters", "Easy"),
      p(2404, "most-frequent-even-element", "Most Frequent Even Element", "Easy"),
      p(2409, "count-days-spent-together", "Count Days Spent Together", "Easy"),
      p(2413, "smallest-even-multiple", "Smallest Even Multiple", "Easy"),
      p(2418, "sort-the-people", "Sort the People", "Easy"),
      p(2423, "remove-letter-to-equalize-frequency", "Remove Letter To Equalize Frequency", "Easy"),
      p(2427, "number-of-common-factors", "Number of Common Factors", "Easy"),
      p(2432, "the-employee-that-worked-on-the-longest-task", "The Employee That Worked on the Longest Task", "Easy"),
      p(2437, "number-of-valid-clock-times", "Number of Valid Clock Times", "Easy"),
      p(2441, "largest-positive-integer-that-exists-with-its-negative", "Largest Positive Integer That Exists With Its Negative", "Easy"),
      p(2446, "determine-if-two-events-have-conflict", "Determine if Two Events Have Conflict", "Easy"),
      p(2451, "odd-string-difference", "Odd String Difference", "Easy"),
      p(2455, "average-value-of-even-numbers-that-are-divisible-by-three", "Average Value of Even Numbers That Are Divisible by Three", "Easy"),
      p(2460, "apply-operations-to-an-array", "Apply Operations to an Array", "Easy"),
      p(2465, "number-of-distinct-averages", "Number of Distinct Averages", "Easy"),
      p(2469, "convert-the-temperature", "Convert the Temperature", "Easy"),
      p(2475, "number-of-unequal-triplets-in-array", "Number of Unequal Triplets in Array", "Easy"),
      p(2481, "minimum-cuts-to-divide-a-circle", "Minimum Cuts to Divide a Circle", "Easy"),
      p(2485, "find-the-pivot-integer", "Find the Pivot Integer", "Easy"),
      p(2490, "circular-sentence", "Circular Sentence", "Easy"),
      p(2496, "maximum-value-of-a-string-in-an-array", "Maximum Value of a String in an Array", "Easy"),
      p(2500, "delete-greatest-value-in-each-row", "Delete Greatest Value in Each Row", "Easy"),
      p(2506, "count-pairs-of-similar-strings", "Count Pairs of Similar Strings", "Easy"),
      p(2511, "maximum-enemy-forts-that-can-be-captured", "Maximum Enemy Forts That Can Be Captured", "Easy"),
      p(2515, "shortest-distance-to-target-string-in-a-circular-array", "Shortest Distance to Target String in a Circular Array", "Easy"),
      p(2520, "count-the-digits-that-divide-a-number", "Count the Digits That Divide a Number", "Easy"),
      p(2525, "categorize-box-according-to-criteria", "Categorize Box According to Criteria", "Easy"),
      p(2529, "maximum-count-of-positive-integer-and-negative-integer", "Maximum Count of Positive Integer and Negative Integer", "Easy"),
      p(2535, "difference-between-element-sum-and-digit-sum-of-an-array", "Difference Between Element Sum and Digit Sum of an Array", "Easy"),
      p(2540, "minimum-common-value", "Minimum Common Value", "Easy"),
      p(2544, "alternating-digit-sum", "Alternating Digit Sum", "Easy"),
      p(2549, "count-distinct-numbers-on-board", "Count Distinct Numbers on Board", "Easy"),
      p(2553, "separate-the-digits-in-an-array", "Separate the Digits in an Array", "Easy"),
      p(2558, "take-gifts-from-the-richest-pile", "Take Gifts From the Richest Pile", "Easy"),
      p(2562, "find-the-array-concatenation-value", "Find the Array Concatenation Value", "Easy"),
      p(2566, "maximum-difference-by-remapping-a-digit", "Maximum Difference by Remapping a Digit", "Easy"),
      p(2570, "merge-two-2d-arrays-by-summing-values", "Merge Two 2D Arrays by Summing Values", "Easy"),
      p(2574, "left-and-right-sum-differences", "Left and Right Sum Differences", "Easy"),
      p(2578, "split-with-minimum-sum", "Split With Minimum Sum", "Easy"),
      p(2582, "pass-the-pillow", "Pass the Pillow", "Easy"),
      p(2586, "count-the-number-of-vowel-strings-in-range", "Count the Number of Vowel Strings in Range", "Easy"),
      p(2591, "distribute-money-to-maximum-children", "Distribute Money to Maximum Children", "Easy"),
      p(2595, "number-of-even-and-odd-bits", "Number of Even and Odd Bits", "Easy"),
      p(2600, "k-items-with-the-maximum-sum", "K Items With the Maximum Sum", "Easy"),
      p(2605, "form-smallest-number-from-two-digit-arrays", "Form Smallest Number From Two Digit Arrays", "Easy"),
      p(2609, "find-the-longest-balanced-substring-of-a-binary-string", "Find the Longest Balanced Substring of a Binary String", "Easy"),
      p(2614, "prime-in-diagonal", "Prime in Diagonal", "Easy"),
      p(2619, "array-prototype-last", "Array Prototype Last", "Easy"),
      p(2620, "counter", "Counter", "Easy"),
      p(2621, "sleep", "Sleep", "Easy"),
      p(2626, "array-reduce-transformation", "Array Reduce Transformation", "Easy"),
      p(2629, "function-composition", "Function Composition", "Easy"),
      p(2634, "filter-elements-from-array", "Filter Elements from Array", "Easy"),
      p(2635, "apply-transform-over-each-element-in-array", "Apply Transform Over Each Element in Array", "Easy"),
      p(2642, "design-graph-with-shortest-path-calculator", "Design Graph With Shortest Path Calculator", "Hard"),
      p(2648, "generate-fibonacci-sequence", "Generate Fibonacci Sequence", "Easy"),
      p(2649, "nested-array-generator", "Nested Array Generator", "Medium"),
      p(2665, "counter-ii", "Counter II", "Easy"),
      p(2666, "allow-one-function-call", "Allow One Function Call", "Medium"),
      p(2667, "create-hello-world-function", "Create Hello World Function", "Easy"),
      p(2676, "throttle", "Throttle", "Medium"),
      p(2677, "chunk-array", "Chunk Array", "Easy"),
      p(2695, "array-wrapper", "Array Wrapper", "Easy"),
      p(2703, "return-length-of-arguments-passed", "Return Length of Arguments Passed", "Easy"),
      p(2704, "to-be-or-not-to-be", "To Be Or Not To Be", "Easy"),
      p(2705, "compact-object", "Compact Object", "Medium"),
      p(2710, "remove-trailing-zeros-from-a-string", "Remove Trailing Zeros From a String", "Easy"),
      p(2715, "timeout-cancellation", "Timeout Cancellation", "Easy"),
      p(2716, "minimize-string-length", "Minimize String Length", "Easy"),
      p(2721, "execute-asynchronous-functions-in-parallel", "Execute Asynchronous Functions in Parallel", "Medium"),
      p(2724, "sort-by", "Sort By", "Easy"),
      p(2726, "calculator-with-method-chaining", "Calculator with Method Chaining", "Medium"),
      p(2727, "is-object-empty", "Is Object Empty", "Easy"),
      p(2732, "find-a-good-subset-of-the-matrix", "Find a Good Subset of the Matrix", "Hard"),
      p(2733, "neither-minimum-nor-maximum", "Neither Minimum nor Maximum", "Easy"),
      p(2739, "total-distance-traveled", "Total Distance Traveled", "Medium"),
      p(2742, "painting-the-walls", "Painting the Walls", "Hard"),
      p(2744, "find-maximum-number-of-string-pairs", "Find Maximum Number of String Pairs", "Easy"),
      p(2748, "number-of-beautiful-pairs", "Number of Beautiful Pairs", "Easy"),
      p(2756, "query-batching", "Query Batching", "Medium"),
      p(2769, "find-the-maximum-achievable-number", "Find the Maximum Achievable Number", "Easy"),
      p(2773, "height-of-special-binary-tree", "Height of Special Binary Tree", "Medium"),
      p(2778, "sum-of-squares-of-special-elements", "Sum of Squares of Special Elements", "Easy"),
      p(2784, "check-if-array-is-good", "Check if Array is Good", "Easy"),
      p(2788, "split-strings-by-separator", "Split Strings by Separator", "Easy"),
      p(2792, "count-nodes-that-are-good-enough", "Count Nodes That Are Good Enough", "Medium"),
      p(2798, "number-of-employees-who-met-the-target", "Number of Employees Who Met the Target", "Easy"),
      p(2802, "find-the-k-th-lucky-number", "Find The K-th Lucky Number", "Medium"),
      p(2806, "account-balance-after-rounded-purchase", "Account Balance After Rounded Purchase", "Easy"),
      p(2810, "faulty-keyboard", "Faulty Keyboard", "Easy"),
      p(2815, "max-pair-sum-in-an-array", "Max Pair Sum in an Array", "Easy"),
      p(2824, "count-pairs-whose-sum-is-less-than-target", "Count Pairs Whose Sum is Less than Target", "Easy"),
      p(2828, "check-if-a-string-is-an-acronym-of-words", "Check if a String Is an Acronym of Words", "Easy"),
      p(2833, "furthest-point-from-origin", "Furthest Point From Origin", "Easy"),
      p(2843, "count-symmetric-integers", "Count Symmetric Integers", "Medium"),
      p(2848, "points-that-intersect-with-segments", "Points That Intersect With Segments", "Easy"),
      p(2855, "minimum-right-shifts-to-sort-the-array", "Minimum Right Shifts to Sort the Array", "Medium"),
      p(2864, "maximum-odd-binary-number", "Maximum Odd Binary Number", "Easy"),
      p(2869, "minimum-operations-to-collect-elements", "Minimum Operations to Collect Elements", "Easy"),
      p(2873, "maximum-value-of-an-ordered-triplet-i", "Maximum Value of an Ordered Triplet I", "Easy"),
      p(2877, "create-a-data-structure-from-a-matrix", "Create a Data Structure From a Matrix", "Medium"),
      p(2879, "declare-the-result-of-a-statement", "Declare the Result of a Statement", "Easy"),
      p(2883, "data-selection", "Data Selection", "Medium"),
      p(2894, "divisible-and-non-divisible-sums-difference", "Divisible and Non-Divisible Sums Difference", "Easy"),
      p(2899, "last-visited-integers", "Last Visited Integers", "Easy"),
      p(2903, "find-indices-with-index-and-value-difference-i", "Find Indices With Index and Value Difference I", "Easy"),
      p(2908, "minimum-sum-of-mountain-triplets-i", "Minimum Sum of Mountain Triplets I", "Easy"),
      p(2913, "subarrays-distinct-element-sum-of-squares-i", "Subarrays Distinct Element Sum of Squares I", "Easy"),
      p(2917, "find-the-integer-added-to-array-i", "Find the Integer Added to Array I", "Easy"),
      p(2923, "find-champion-i", "Find Champion I", "Easy"),
      p(2928, "distribute-candies-among-children-i", "Distribute Candies Among Children I", "Easy"),
      p(2932, "maximum-strong-pair-xor-i", "Maximum Strong Pair XOR I", "Easy"),
      p(2937, "prefix-and-suffix-search-iii", "Prefix and Suffix Search III", "Medium"),
      p(2942, "find-words-containing-character", "Find Words Containing Character", "Easy"),
      p(2946, "matrix-similarity-after-cyclic-shifts", "Matrix Similarity After Cyclic Shifts", "Easy"),
      p(2951, "find-the-peaks", "Find the Peaks", "Easy"),
      p(2956, "find-common-elements-between-two-arrays", "Find Common Elements Between Two Arrays", "Easy"),
      p(2960, "count-tested-devices", "Count Tested Devices", "Easy"),
      p(2965, "find-missing-and-repeated-values", "Find Missing and Repeated Values", "Easy"),
      p(2970, "count-the-number-of-incremovable-subarrays-i", "Count the Number of Incremovable Subarrays I", "Easy"),
      p(2974, "minimum-number-game", "Minimum Number Game", "Easy"),
      p(2980, "check-if-bitwise-or-has-trailing-zeros", "Check if Bitwise OR Has Trailing Zeros", "Easy"),
      p(2984, "find-peak-hours", "Find Peak Hours", "Medium"),
      p(3005, "count-elements-with-maximum-frequency", "Count Elements With Maximum Frequency", "Easy"),
      p(3010, "divide-an-array-into-subarrays-with-minimum-cost-i", "Divide an Array Into Subarrays With Minimum Cost I", "Easy"),
      p(3014, "minimum-number-of-pushes-to-type-word-i", "Minimum Number of Pushes to Type Word I", "Easy"),
      p(3019, "number-of-changing-keys", "Number of Changing Keys", "Easy"),
      p(3024, "type-of-triangle", "Type of Triangle", "Easy"),
      p(3028, "ant-on-the-boundary", "Ant on the Boundary", "Easy"),
      p(3032, "count-numbers-with-unique-digits-ii", "Count Numbers With Unique Digits II", "Easy"),
      p(3033, "modify-the-matrix", "Modify the Matrix", "Easy"),
      p(3038, "maximum-number-of-operations-with-the-same-score-i", "Maximum Number of Operations With the Same Score I", "Easy"),
      p(3042, "count-prefix-and-suffix-pairs-i", "Count Prefix and Suffix Pairs I", "Easy"),
      p(3046, "split-the-array", "Split the Array", "Easy"),
      p(3056, "snaps-in-a-grid", "Snaps in a Grid", "Medium"),
      p(3057, "employees-project-allocation", "Employees Project Allocation", "Hard"),
      p(3058, "friends-with-odd-sum-of-tags", "Friends With Odd Sum of Tags", "Medium"),
      p(3062, "winner-of-the-linked-list-game", "Winner of the Linked List Game", "Easy"),
      p(3063, "linked-list-frequency", "Linked List Frequency", "Easy"),
      p(3069, "distribute-elements-into-two-arrays-i", "Distribute Elements Into Two Arrays I", "Easy"),
      p(3073, "maximum-triplets-sum-in-an-array", "Maximum Triplet Sum in an Array", "Medium"),
      p(3079, "encrypt-the-string-i", "Encrypt the String I", "Medium"),
      p(3084, "count-substrings-starting-and-ending-with-given-character", "Count Substrings Starting and Ending with Given Character", "Medium"),
      p(3089, "find-employees-process-tasks-approach", "Find Employees Process Tasks", "Easy"),
      p(3095, "shortest-subarray-with-or-at-least-k-i", "Shortest Subarray With OR at Least K I", "Easy"),
      p(3099, "harshad-number", "Harshad Number", "Easy"),
      p(3101, "count-alternating-subarrays", "Count Alternating Subarrays", "Medium"),
      p(3105, "longest-strictly-increasing-or-strictly-decreasing-subarray", "Longest Strictly Increasing Or Strictly Decreasing Subarray", "Easy"),
      p(3110, "score-of-a-string", "Score of a String", "Easy"),
      p(3114, "latest-time-you-can-obtain-after-replacing-characters", "Latest Time You Can Obtain After Replacing Characters", "Easy"),
      p(3115, "maximum-prime-difference", "Maximum Prime Difference", "Medium"),
      p(3120, "count-the-number-of-special-characters-i", "Count the Number of Special Characters I", "Easy"),
      p(3125, "maximum-number-that-makes-result-of-bitwise-and-zero", "Maximum Number That Makes Result of Bitwise AND Zero", "Medium"),
      p(3131, "find-the-integer-added-to-array-ii", "Find the Integer Added to Array II", "Medium"),
      p(3136, "valid-word", "Valid Word", "Easy"),
      p(3141, "maximum-string-happiness", "Maximum String Happiness", "Hard"),
      p(3146, "permutation-difference-between-two-strings", "Permutation Difference Between Two Strings", "Easy"),
      p(3151, "special-array-i", "Special Array I", "Easy"),
      p(3158, "find-the-xor-of-numbers-which-appear-twice", "Find the XOR of Numbers Which Appear Twice", "Easy"),
      p(3162, "find-the-number-of-good-pairs-i", "Find the Number of Good Pairs I", "Easy"),
      p(3163, "string-compression-iii", "String Compression III", "Medium"),
      p(3168, "minimum-number-of-chairs-in-a-waiting-room", "Minimum Number of Chairs in a Waiting Room", "Easy"),
      p(3173, "bitwise-or-of-adjacent-elements", "Bitwise OR of Adjacent Elements", "Easy"),
      p(3174, "clear-digits", "Clear Digits", "Easy"),
      p(3178, "find-the-child-who-has-the-ball-after-k-seconds", "Find the Child Who Has the Ball After K Seconds", "Easy"),
      p(3180, "maximum-total-reward-using-operations-i", "Maximum Total Reward Using Operations I", "Medium"),
      p(3184, "count-pairs-that-form-a-good-day-i", "Count Pairs That Form a Good Day I", "Easy"),
      p(3189, "minimum-moves-to-get-a-peaceful-board", "Minimum Moves to Get a Peaceful Board", "Medium"),
      p(3190, "find-minimum-operations-to-make-all-elements-divisible-by-three", "Find Minimum Operations to Make All Elements Divisible by Three", "Easy"),
      p(3194, "minimum-average-of-smallest-and-largest-values", "Minimum Average of Smallest and Largest Values", "Easy"),
      p(3199, "count-triplets-with-even-xor-pairs-i", "Count Triplets With Even XOR Pairs I", "Medium"),
      p(3200, "maximum-heights-of-a-triangle", "Maximum Heights of a Triangle", "Easy"),
      p(3204, "bitwise-user-permissions-analysis", "Bitwise User Permissions Analysis", "Medium"),
      p(3206, "alternating-groups-i", "Alternating Groups I", "Easy"),
      p(3210, "find-the-encrypted-string", "Find the Encrypted String", "Medium"),
      p(3211, "generate-binary-strings-without-adjacent-zeros", "Generate Binary Strings Without Adjacent Zeros", "Medium"),
      p(3216, "lexicographically-smallest-string-after-swap", "Lexicographically Smallest String After Swap", "Easy"),
      p(3222, "find-the-winning-player-in-coin-game", "Find the Winning Player in Coin Game", "Medium"),
      p(3226, "number-of-bit-changes-to-make-two-integers-equal", "Number of Bit Changes to Make Two Integers Equal", "Medium"),
      p(3232, "find-if-digit-game-can-be-won", "Find if Digit Game Can Be Won", "Easy"),
      p(3237, "alt-and-tab-simulation", "Alt and Tab Simulation", "Medium"),
      p(3242, "design-neighbor-sum-service", "Design Neighbor Sum Service", "Easy"),
      p(3243, "shortest-distance-after-road-addition-queries-i", "Shortest Distance After Road Addition Queries I", "Medium"),
      p(3250, "find-the-encrypted-string-ii", "Find the Encrypted String II", "Medium"),
      p(3254, "find-the-power-of-k-size-subarrays-i", "Find the Power of K-Size Subarrays I", "Medium"),
      p(3258, "count-substrings-that-satisfy-k-constraint-i", "Count Substrings That Satisfy K-Constraint I", "Easy"),
      p(3264, "final-array-state-after-k-multiplication-operations-i", "Final Array State After K Multiplication Operations I", "Easy"),
      p(3269, "constructing-two-increasing-arrays", "Constructing Two Increasing Arrays", "Medium"),
      p(3273, "maximum-amount-of-money-robot-can-earn-ii", "Maximum Amount of Money Robot Can Earn II", "Medium"),
      p(3274, "check-if-two-chessboard-squares-have-the-same-color", "Check if Two Chessboard Squares Have the Same Color", "Easy"),
      p(3280, "convert-date-to-binary", "Convert Date to Binary", "Easy"),
      p(3284, "sum-of-consecutive-subsequences", "Sum of Consecutive Subsequences", "Medium"),
      p(3289, "the-two-sneaky-numbers-of-digitville", "The Two Sneaky Numbers of Digitville", "Easy"),
      p(3293, "final-product-id-weighted-sum", "Final Product Id Weighted Sum", "Medium"),
      p(3297, "count-substrings-that-can-be-rearranged-to-contain-a-string-i", "Count Substrings That Can Be Rearranged to Contain a String I", "Medium"),
      p(3300, "minimum-element-after-replacement-with-digit-sum", "Minimum Element After Replacement With Digit Sum", "Easy"),
      p(3304, "find-the-first-player-to-win-k-games-in-a-row", "Find the First Player to Win K Games in a Row", "Medium"),
      p(3309, "maximum-possible-number-by-binary-concatenation", "Maximum Possible Number by Binary Concatenation", "Medium"),
      p(3314, "construct-the-minimum-bitwise-array-i", "Construct the Minimum Bitwise Array I", "Easy"),
      p(3318, "find-x-sum-of-all-k-long-subarrays-i", "Find X-Sum of All K-Long Subarrays I", "Easy"),
      p(3324, "find-the-sequence-of-strings-appeared-on-the-screen", "Find the Sequence of Strings Appeared on the Screen", "Medium"),
      p(3329, "count-increasing-quadruplets", "Count Increasing Quadruplets", "Hard"),
      p(3330, "find-the-original-typed-string-i", "Find the Original Typed String I", "Easy"),
      p(3334, "find-the-maximum-factor-score-of-array", "Find the Maximum Factor Score of Array", "Medium"),
      p(3339, "find-the-number-of-k-even-arrays", "Find the Number of K-Even Arrays", "Medium"),
      p(3340, "check-balanced-string", "Check Balanced String", "Easy"),
      p(3345, "smallest-divisible-digit-product-i", "Smallest Divisible Digit Product I", "Easy"),
      p(3350, "adjacent-increasing-subarrays-detection-ii", "Adjacent Increasing Subarrays Detection II", "Medium"),
      p(3355, "zero-array-transformation-i", "Zero Array Transformation I", "Medium"),
      p(3360, "remove-removable-indices", "Remove Removable Indices", "Easy"),
      p(3364, "minimum-positive-sum-subarray", "Minimum Positive Sum Subarray", "Medium"),
      p(3369, "count-vowel-strings-in-ranges", "Count Vowel Strings in Ranges", "Medium"),
      p(3373, "maximize-the-number-of-ideal-nodes", "Maximize the Number of Ideal Nodes", "Hard"),
      p(3374, "first-letter-capitalization", "First Letter Capitalization", "Medium"),
      p(3379, "transformed-array", "Transformed Array", "Easy"),
      p(3384, "beauty-of-a-matrix", "Beauty of a Matrix", "Medium"),
      p(3389, "minimum-area-rectangle-in-2d-space", "Minimum Area Rectangle in 2D Space", "Medium"),
      p(3394, "check-if-grid-can-be-cut-into-sections", "Check if Grid Can Be Cut Into Sections", "Medium"),
      p(3396, "minimum-number-of-operations-to-make-elements-in-array-distinct", "Minimum Number of Operations to Make Elements in Array Distinct", "Easy"),
      p(3400, "maximum-count-of-non-overlapping-palindromic-substrings", "Maximum Count of Non-Overlapping Palindromic Substrings", "Medium"),
      p(3405, "count-the-number-of-inversions", "Count the Number of Inversions", "Hard"),
      p(3410, "maximize-the-total-height-of-unique-towers", "Maximize the Total Height of Unique Towers", "Medium"),
      p(3415, "longest-common-prefix-of-k-strings-after-removal", "Longest Common Prefix of K Strings After Removal", "Hard"),
      p(3417, "zigzag-grid-traversal-with-skip", "Zigzag Grid Traversal With Skip", "Easy"),
      p(3422, "minimum-operations-to-make-array-equal-ii", "Minimum Operations to Make Array Equal II", "Medium"),
      p(3427, "sum-of-variable-length-subarrays", "Sum of Variable Length Subarrays", "Easy"),
      p(3432, "count-partitions-with-even-sum-difference", "Count Partitions With Even Sum Difference", "Easy"),
      p(3437, "zigzag-grid-traversal-with-skip-ii", "Zigzag Grid Traversal With Skip II", "Medium"),
      p(3442, "maximum-differences-between-node-and-ancestor", "Maximum Differences Between Node and Ancestor", "Medium"),
      p(3447, "the-maze-runner", "The Maze Runner", "Medium"),
      p(3452, "sum-of-good-numbers", "Sum of Good Numbers", "Easy"),
      p(3457, "eat-pizzas", "Eat Pizzas", "Medium"),
      p(3462, "maximum-sum-with-at-most-k-elements", "Maximum Sum With At Most K Elements", "Medium"),
      p(3467, "transform-array-by-parity", "Transform Array by Parity", "Easy"),
      p(3471, "find-the-largest-almost-missing-integer", "Find the Largest Almost Missing Integer", "Medium"),
      p(3477, "fruits-into-baskets-ii", "Fruits Into Baskets II", "Easy"),
      p(3483, "unique-3-digit-even-numbers", "Unique 3-Digit Even Numbers", "Medium"),
      p(3487, "maximum-unique-subarray-sum-after-deletion", "Maximum Unique Subarray Sum After Deletion", "Medium"),
      p(3492, "maximum-containers-on-a-ship", "Maximum Containers on a Ship", "Easy"),
      p(3497, "analyze-assignment-groups", "Analyze Assignment Groups", "Medium"),
      p(3502, "minimum-cost-to-reach-every-position", "Minimum Cost to Reach Every Position", "Easy"),
      p(3507, "minimum-pair-removal-to-sort-array-i", "Minimum Pair Removal to Sort Array I", "Easy"),
      p(3512, "minimum-cost-to-reach-every-position-ii", "Minimum Cost to Reach Every Position II", "Medium"),
      p(3516, "find-closest-person", "Find Closest Person", "Easy"),
      p(3521, "find-product-recommendation-pairs", "Find Product Recommendation Pairs", "Medium"),
      p(3526, "range-xor-queries-with-sweeping", "Range XOR Queries With Sweeping", "Medium"),
      p(3531, "count-covered-buildings", "Count Covered Buildings", "Medium"),
      p(3536, "maximum-product-of-two-digits", "Maximum Product of Two Digits", "Easy"),
      p(3541, "find-most-frequent-vowel-and-consonant", "Find Most Frequent Vowel and Consonant", "Easy"),
      p(3546, "equal-sum-grid-partition-i", "Equal Sum Grid Partition I", "Medium"),
      p(3550, "ability-to-send-messages", "Ability to Send Messages", "Medium"),
      p(3555, "smallest-subarray-to-sort-in-every-sliding-window", "Smallest Subarray to Sort in Every Sliding Window", "Medium"),
      p(3560, "find-number-of-ways-to-reach-the-k-th-stair", "Find Number of Ways to Reach the K-th Stair", "Medium"),
      p(3565, "parallel-vertex-cover", "Parallel Vertex Cover", "Medium"),
      p(3570, "object-approval-system", "Object Approval System", "Medium"),
      p(3575, "maximum-good-subtree-score", "Maximum Good Subtree Score", "Hard"),
      p(3580, "find-consistently-logging-employees", "Find Consistently Logging Employees", "Medium"),
      p(3585, "event-merger", "Event Merger", "Medium"),
      p(3591, "check-if-any-element-has-prime-frequency", "Check if Any Element Has Prime Frequency", "Easy"),
      p(3596, "minimum-cost-path-with-alternating-directions-i", "Minimum Cost Path With Alternating Directions I", "Medium"),
      p(3601, "find-players-with-zero-or-one-losses-ii", "Find Players With Zero or One Losses II", "Medium"),
      p(3606, "coupon-code-validator", "Coupon Code Validator", "Medium"),
      p(3611, "find-the-maximum-length-of-a-good-subsequence-i", "Find the Maximum Length of a Good Subsequence I", "Medium"),
      p(3616, "number-of-student-replacements", "Number of Student Replacements", "Medium"),
      p(3620, "network-recovery-pathways", "Network Recovery Pathways", "Medium"),
      p(3625, "count-number-of-trapezoids-i", "Count Number of Trapezoids I", "Medium"),
      p(3630, "partition-array-for-maximum-xor-and-and", "Partition Array for Maximum XOR and AND", "Hard"),
      p(3634, "best-room-allocation-method", "Best Room Allocation Method", "Medium"),
      p(3639, "minimum-time-to-activate-string-fragments", "Minimum Time to Activate String Fragments", "Medium"),
      p(3643, "landings-approach", "Landings Approach", "Easy"),
      p(3648, "minimum-sensors-to-cover-grid", "Minimum Sensors to Cover Grid", "Medium"),
      p(3652, "best-visited-places-in-a-mall", "Best Visited Places in a Mall", "Medium"),
      p(3657, "find-well-formed-paragraphs", "Find Well-Formed Paragraphs", "Medium"),
      p(3662, "filter-characters-by-frequency", "Filter Characters by Frequency", "Medium"),
      p(3667, "restore-finishing-order", "Restore Finishing Order", "Easy"),
      p(3672, "sum-of-adjacent-primes", "Sum of Adjacent Primes", "Medium"),
      p(3677, "count-binary-palindromic-numbers", "Count Binary Palindromic Numbers", "Hard"),
      p(3681, "maximum-xor-of-subsequences", "Maximum XOR of Subsequences", "Hard"),
      p(3686, "number-of-stable-subsequences", "Number of Stable Subsequences", "Hard"),
      p(3691, "maximize-activity-selection-with-discount", "Maximize Activity Selection With Discount", "Medium"),
      p(3696, "maximum-distance-between-unequal-words-in-array-i", "Maximum Distance Between Unequal Words in Array I", "Easy"),
      p(3701, "compute-alternating-sum", "Compute Alternating Sum", "Easy"),
      p(3706, "car-fleet-ii-approach", "Car Fleet II Approach", "Hard"),
      p(3711, "maximum-deletions-on-a-string", "Maximum Deletions on a String", "Hard"),
      p(3716, "maximize-sum-of-at-most-k-distinct-subarrays", "Maximize Sum of At Most K Distinct Subarrays", "Medium"),
      p(3721, "longest-balanced-subarray-ii", "Longest Balanced Subarray II", "Hard"),
      p(3726, "remove-zeros", "Remove Zeros", "Medium"),
      p(3731, "subtract-abc", "Subtract ABC", "Medium"),
      p(3736, "interleaved-adjacent-groups", "Interleaved Adjacent Groups", "Medium"),
      p(3741, "minimum-difficulty-of-a-job-schedule-ii", "Minimum Difficulty of a Job Schedule II", "Hard"),
      p(3746, "minimum-string-length-after-removing-substrings", "Minimum String Length After Removing Substrings", "Easy"),
      p(3751, "total-waviness-of-numbers-i", "Total Waviness of Numbers I", "Medium"),
      p(3756, "paint-the-grid", "Paint the Grid", "Medium"),
      p(3761, "minimum-difference-in-indices-after-same-element-removals", "Minimum Difference in Indices After Same Element Removals", "Medium"),
      p(3766, "minimum-moves-to-clean-the-classroom", "Minimum Moves to Clean the Classroom", "Medium"),
      p(3771, "total-sum-of-subarray-power", "Total Sum of Subarray Power", "Hard"),
      p(3776, "vector-cross-product", "Vector Cross Product", "Medium"),
      p(3781, "maximum-score-after-applying-operations", "Maximum Score After Applying Operations", "Medium"),
      p(3786, "total-characters-in-string-after-transformations-ii", "Total Characters in String After Transformations II", "Hard"),
      p(3791, "count-merged-overlapping-intervals", "Count Merged Overlapping Intervals", "Medium"),
      p(3796, "find-maximum-area-of-a-triangle", "Find Maximum Area of a Triangle", "Medium"),
      p(3801, "collect-elements-in-row-major-order", "Collect Elements in Row-Major Order", "Medium"),
      p(3806, "swap-to-make-equal-strings", "Swap to Make Equal Strings", "Medium"),
      p(3811, "gcd-of-sequential-prefix-xors", "GCD of Sequential Prefix XORs", "Hard"),
      p(3816, "close-equal-character-pairs", "Close Equal Character Pairs", "Medium"),
      p(3821, "reverse-yang-hui-triangle-ii", "Reverse Yang Hui Triangle II", "Medium"),
      p(3826, "vowel-spellchecker-ii", "Vowel Spellchecker II", "Medium"),
      p(3831, "find-the-lexicographically-largest-valid-sequence", "Find the Lexicographically Largest Valid Sequence", "Medium"),
      p(3836, "choose-k-flips-to-maximize-xor", "Choose K Flips to Maximize XOR", "Hard"),
      p(3841, "paint-special-elements-in-grid", "Paint Special Elements in Grid", "Medium"),
      p(3846, "destroy-sequential-targets-ii", "Destroy Sequential Targets II", "Hard")
    ];
  };

  const normalizeLcProblems = (raw) => {
    const seen = new Set();
    const list = [];
    (Array.isArray(raw) ? raw : []).forEach((item) => {
      if (!item || typeof item !== "object") return;
      const num = Number(item.num);
      const url = typeof item.url === "string" ? item.url.trim() : "";
      if (!Number.isFinite(num) || !url || seen.has(url)) return;
      seen.add(url);
      list.push({
        id: String(item.id || `p-${num}-${url.slice(-12)}`),
        num,
        name: String(item.name || `Problem ${num}`).trim() || `Problem ${num}`,
        url,
        difficulty: ["Easy", "Medium", "Hard"].includes(item.difficulty) ? item.difficulty : "Medium",
        solved: Boolean(item.solved),
        added: Boolean(item.added),
        bookmarked: item.bookmarked === true,
        langSolved: item.langSolved && typeof item.langSolved === "object" ? item.langSolved : {},
        code: item.code && typeof item.code === "object" ? item.code : {},
        notes: Array.isArray(item.notes) && item.notes.length
          ? item.notes
              .filter((entry) => entry && typeof entry === "object")
              .map((entry) => ({
                id: String(entry.id || randomId("nsec")),
                title: String(entry.title || "Section").trim() || "Section",
                html: typeof entry.html === "string" ? entry.html : "",
                collapsed: Boolean(entry.collapsed)
              }))
          : [{ id: randomId("nsec"), title: "Approach", html: "", collapsed: false }]
      });
    });
    return list;
  };

  const normalizeLcState = () => {
    const raw = readJson(LC_STATE_KEY, () => ({}));
    const seeds = normalizeLcProblems(seedProblems());
    const savedList = Array.isArray(raw.problems)
      ? raw.problems.filter((item) => item && typeof item === "object" && typeof item.url === "string")
      : [];
    const savedMap = new Map();
    savedList.forEach((item) => savedMap.set(item.url, item));

    /* Saved data is the source of truth: it carries user code, per-language
       solved flags, notes, and the added marker. Seeds only supply metadata
       for problems the user has never touched. */
    const merged = seeds.map((seed) => {
      const saved = savedMap.get(seed.url);
      return saved
        ? {
            ...seed,
            solved: Boolean(saved.solved),
            added: Boolean(saved.added),
            bookmarked: saved.bookmarked === true,
            langSolved: saved.langSolved && typeof saved.langSolved === "object" ? saved.langSolved : {},
            code: saved.code && typeof saved.code === "object" ? saved.code : {},
            notes: Array.isArray(saved.notes) && saved.notes.length
              ? saved.notes
                  .filter((entry) => entry && typeof entry === "object")
                  .map((entry) => ({
                    id: String(entry.id || randomId("nsec")),
                    title: String(entry.title || "Section").trim() || "Section",
                    html: typeof entry.html === "string" ? entry.html : "",
                    collapsed: Boolean(entry.collapsed)
                  }))
              : seed.notes
          }
        : seed;
    });

    const seedUrls = new Set(merged.map((problem) => problem.url));
    /* User-added problems persist across reloads. A non-seed problem survives
       when it was explicitly added, or when it carries real user content
       (legacy data may hold saved templates without the added marker). */
    const extras = savedList.filter((item) => {
      if (seedUrls.has(item.url)) return false;
      if (item.added) return true;
      const hasUserCode =
        item.solved ||
        (item.langSolved && Object.values(item.langSolved).some(Boolean)) ||
        Object.values(item.code || {}).some((code) => typeof code === "string" && code.trim());
      return hasUserCode;
    });
    // Canonical order by LeetCode number, name as tie-breaker.
    const ordered = [...merged, ...normalizeLcProblems(extras)].sort(
      (a, b) => (a.num === b.num ? a.name.localeCompare(b.name) : a.num - b.num)
    );
    return { problems: ordered, activeProblemId: raw.activeProblemId || "" };
  };

  const lcState = normalizeLcState();

  const persistLcState = () => writeJson(LC_STATE_KEY, lcState);

  const getActiveLcProblem = () =>
    lcState.problems.find((problem) => problem.id === lcState.activeProblemId) || null;

  const extractLcProblemInfo = (urlText) => {
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch {
      return null;
    }
    if (!/(^|\.)leetcode\.com$/i.test(parsed.hostname)) return null;
    const match = (parsed.pathname || "").match(/\/problems\/([^/?#]+)/i);
    if (!match || !match[1]) return null;
    const slug = match[1].trim().toLowerCase();
    if (!slug) return null;
    const numMatch = slug.match(/^(\d+)[-.](.+)$/);
    const num = numMatch ? Number(numMatch[1]) : 0;
    const fallbackName = slug
      .replace(/^\d+[-.]/, "")
      .split("-")
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    return {
      slug,
      url: `https://leetcode.com/problems/${slug}/`,
      num: numMatch ? Number(numMatch[1]) : 0,
      name: fallbackName || `Problem ${num}`
    };
  };

  const lcFilter = { query: "", difficulty: "all", status: "all" };
  const visibleLcProblems = () => {
    const query = lcFilter.query.trim().toLowerCase();
    return lcState.problems.filter((problem) => {
      if (lcFilter.difficulty !== "all" && problem.difficulty !== lcFilter.difficulty) return false;
      if (lcFilter.status === "solved" && !problemIsSolved(problem)) return false;
      if (lcFilter.status === "unsolved" && problemIsSolved(problem)) return false;
      if (lcFilter.status === "starred" && problem.bookmarked !== true) return false;
      if (!query) return true;
      // Exact program-number search: "51" matches only problem 51, never 151/251/2051.
      if (/^#?\d+$/.test(query)) return String(problem.num) === query.replace(/^#/, "");
      return (
        problem.name.toLowerCase().includes(query) ||
        (query.length >= 3 && problem.url.toLowerCase().includes(query))
      );
    });
  };

  const sortLcProblems = (problems) =>
    [...problems].sort((a, b) => (a.num === b.num ? a.name.localeCompare(b.name) : a.num - b.num));

  /* ------------- LeetCode-style per-problem code skeletons --------------- */

  const lcVarName = (name) => {
    const cleaned = String(name || "").replace(/[^A-Za-z0-9 ]/g, " ").trim();
    const parts = cleaned.split(/\s+/).filter(Boolean);
    if (!parts.length) return "solve";
    return parts
      .map((part, index) =>
        index === 0
          ? part.charAt(0).toLowerCase() + part.slice(1)
          : part.charAt(0).toUpperCase() + part.slice(1)
      )
      .join("");
  };

  // Real LeetCode starter code for the seeded problems; falls back to a
  // function skeleton named after the problem for anything else.
  const LC_SKELETONS = {
    "two-sum": {
      javascript: "var twoSum = function(nums, target) {\n    \n};\n",
      python: "class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        \n",
      java: "class Solution {\n    public int[] twoSum(int[] nums, int target) {\n        \n    }\n}\n",
      c: "/**\n * Note: The returned array must be malloced, assume caller calls free().\n */\nint* twoSum(int* nums, int numsSize, int target, int* returnSize) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    vector<int> twoSum(vector<int>& nums, int target) {\n        \n    }\n};\n"
    },
    "palindrome-number": {
      javascript: "var isPalindrome = function(x) {\n    \n};\n",
      python: "class Solution:\n    def isPalindrome(self, x: int) -> bool:\n        \n",
      java: "class Solution {\n    public boolean isPalindrome(int x) {\n        \n    }\n}\n",
      c: "bool isPalindrome(int x) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    bool isPalindrome(int x) {\n        \n    }\n};\n"
    },
    "roman-to-integer": {
      javascript: "var romanToInt = function(s) {\n    \n};\n",
      python: "class Solution:\n    def romanToInt(self, s: str) -> int:\n        \n",
      java: "class Solution {\n    public int romanToInt(String s) {\n        \n    }\n}\n",
      c: "int romanToInt(char* s) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    int romanToInt(string s) {\n        \n    }\n};\n"
    },
    "longest-common-prefix": {
      javascript: "var longestCommonPrefix = function(strs) {\n    \n};\n",
      python: "class Solution:\n    def longestCommonPrefix(self, strs: List[str]) -> str:\n        \n",
      java: "class Solution {\n    public String longestCommonPrefix(String[] strs) {\n        \n    }\n}\n",
      c: "char* longestCommonPrefix(char** strs, int strsSize) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    string longestCommonPrefix(vector<string>& strs) {\n        \n    }\n};\n"
    },
    "valid-parentheses": {
      javascript: "var isValid = function(s) {\n    \n};\n",
      python: "class Solution:\n    def isValid(self, s: str) -> bool:\n        \n",
      java: "class Solution {\n    public boolean isValid(String s) {\n        \n    }\n}\n",
      c: "bool isValid(char* s) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    bool isValid(string s) {\n        \n    }\n};\n"
    },
    "merge-two-sorted-lists": {
      javascript: "/**\n * Definition for singly-linked list.\n * function ListNode(val, next) {\n *     this.val = (val===undefined ? 0 : val)\n *     this.next = (next===undefined ? null : next)\n * }\n */\nvar mergeTwoLists = function(list1, list2) {\n    \n};\n",
      python: "# Definition for singly-linked list.\n# class ListNode:\n#     def __init__(self, val=0, next=None):\n#         self.val = val\n#         self.next = next\nclass Solution:\n    def mergeTwoLists(self, list1: Optional[ListNode], list2: Optional[ListNode]) -> Optional[ListNode]:\n        \n",
      java: "/**\n * Definition for singly-linked list.\n * public class ListNode {\n *     int val;\n *     ListNode next;\n *     ListNode() {}\n *     ListNode(int val) { this.val = val; }\n *     ListNode(int val, ListNode next) { this.val = val; this.next = next; }\n * }\n */\nclass Solution {\n    public ListNode mergeTwoLists(ListNode list1, ListNode list2) {\n        \n    }\n}\n",
      c: "/**\n * Definition for singly-linked list.\n * struct ListNode {\n *     int val;\n *     struct ListNode *next;\n * };\n */\nstruct ListNode* mergeTwoLists(struct ListNode* list1, struct ListNode* list2) {\n    \n}\n",
      cpp: "/**\n * Definition for singly-linked list.\n * struct ListNode {\n *     int val;\n *     ListNode *next;\n *     ListNode() : val(0), next(nullptr) {}\n *     ListNode(int x) : val(x), next(nullptr) {}\n *     ListNode(int x, ListNode *next) : val(x), next(next) {}\n * };\n */\nclass Solution {\npublic:\n    ListNode* mergeTwoLists(ListNode* list1, ListNode* list2) {\n        \n    }\n};\n"
    },
    "remove-duplicates-from-sorted-array": {
      javascript: "var removeDuplicates = function(nums) {\n    \n};\n",
      python: "class Solution:\n    def removeDuplicates(self, nums: List[int]) -> int:\n        \n",
      java: "class Solution {\n    public int removeDuplicates(int[] nums) {\n        \n    }\n}\n",
      c: "int removeDuplicates(int* nums, int numsSize) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    int removeDuplicates(vector<int>& nums) {\n        \n    }\n};\n"
    },
    "remove-element": {
      javascript: "var removeElement = function(nums, val) {\n    \n};\n",
      python: "class Solution:\n    def removeElement(self, nums: List[int], val: int) -> int:\n        \n",
      java: "class Solution {\n    public int removeElement(int[] nums, int val) {\n        \n    }\n}\n",
      c: "int removeElement(int* nums, int numsSize, int val) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    int removeElement(vector<int>& nums, int val) {\n        \n    }\n};\n"
    },
    "search-insert-position": {
      javascript: "var searchInsert = function(nums, target) {\n    \n};\n",
      python: "class Solution:\n    def searchInsert(self, nums: List[int], target: int) -> int:\n        \n",
      java: "class Solution {\n    public int searchInsert(int[] nums, int target) {\n        \n    }\n}\n",
      c: "int searchInsert(int* nums, int numsSize, int target) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    int searchInsert(vector<int>& nums, int target) {\n        \n    }\n};\n"
    },
    "maximum-subarray": {
      javascript: "var maxSubArray = function(nums) {\n    \n};\n",
      python: "class Solution:\n    def maxSubArray(self, nums: List[int]) -> int:\n        \n",
      java: "class Solution {\n    public int maxSubArray(int[] nums) {\n        \n    }\n}\n",
      c: "int maxSubArray(int* nums, int numsSize) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    int maxSubArray(vector<int>& nums) {\n        \n    }\n};\n"
    },
    "climbing-stairs": {
      javascript: "var climbStairs = function(n) {\n    \n};\n",
      python: "class Solution:\n    def climbStairs(self, n: int) -> int:\n        \n",
      java: "class Solution {\n    public int climbStairs(int n) {\n        \n    }\n}\n",
      c: "int climbStairs(int n) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    int climbStairs(int n) {\n        \n    }\n};\n"
    },
    "add-binary": {
      javascript: "var addBinary = function(a, b) {\n    \n};\n",
      python: "class Solution:\n    def addBinary(self, a: str, b: str) -> str:\n        \n",
      java: "class Solution {\n    public String addBinary(String a, String b) {\n        \n    }\n}\n",
      c: "char* addBinary(char* a, char* b) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    string addBinary(string a, string b) {\n        \n    }\n};\n"
    },
    "plus-one": {
      javascript: "var plusOne = function(digits) {\n    \n};\n",
      python: "class Solution:\n    def plusOne(self, digits: List[int]) -> List[int]:\n        \n",
      java: "class Solution {\n    public int[] plusOne(int[] digits) {\n        \n    }\n}\n",
      c: "/**\n * Note: The returned array must be malloced, assume caller calls free().\n */\nint* plusOne(int* digits, int digitsSize, int* returnSize) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    vector<int> plusOne(vector<int>& digits) {\n        \n    }\n};\n"
    },
    "length-of-last-word": {
      javascript: "var lengthOfLastWord = function(s) {\n    \n};\n",
      python: "class Solution:\n    def lengthOfLastWord(self, s: str) -> int:\n        \n",
      java: "class Solution {\n    public int lengthOfLastWord(String s) {\n        \n    }\n}\n",
      c: "int lengthOfLastWord(char* s) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    int lengthOfLastWord(string s) {\n        \n    }\n};\n"
    },
    "sqrtx": {
      javascript: "var mySqrt = function(x) {\n    \n};\n",
      python: "class Solution:\n    def mySqrt(self, x: int) -> int:\n        \n",
      java: "class Solution {\n    public int mySqrt(int x) {\n        \n    }\n}\n",
      c: "int mySqrt(int x) {\n    \n}\n",
      cpp: "class Solution {\npublic:\n    int mySqrt(int x) {\n        \n    }\n};\n"
    },
    "remove-duplicates-from-sorted-list": {
      javascript: "/**\n * Definition for singly-linked list.\n * function ListNode(val, next) {\n *     this.val = (val===undefined ? 0 : val)\n *     this.next = (next===undefined ? null : next)\n * }\n */\nvar deleteDuplicates = function(head) {\n    \n};\n",
      python: "# Definition for singly-linked list.\n# class ListNode:\n#     def __init__(self, val=0, next=None):\n#         self.val = val\n#         self.next = next\nclass Solution:\n    def deleteDuplicates(self, head: Optional[ListNode]) -> Optional[ListNode]:\n        \n",
      java: "/**\n * Definition for singly-linked list.\n * public class ListNode {\n *     int val;\n *     ListNode next;\n *     ListNode() {}\n *     ListNode(int val) { this.val = val; }\n *     ListNode(int val, ListNode next) { this.val = val; this.next = next; }\n * }\n */\nclass Solution {\n    public ListNode deleteDuplicates(ListNode head) {\n        \n    }\n}\n",
      c: "/**\n * Definition for singly-linked list.\n * struct ListNode {\n *     int val;\n *     struct ListNode *next;\n * };\n */\nstruct ListNode* deleteDuplicates(struct ListNode* head) {\n    \n}\n",
      cpp: "/**\n * Definition for singly-linked list.\n * struct ListNode {\n *     int val;\n *     ListNode *next;\n *     ListNode() : val(0), next(nullptr) {}\n *     ListNode(int x) : val(x), next(nullptr) {}\n *     ListNode(int x, ListNode *next) : val(x), next(next) {}\n * };\n */\nclass Solution {\npublic:\n    ListNode* deleteDuplicates(ListNode* head) {\n        \n    }\n};\n"
    }
  };

  // slug -> { num, name, difficulty } for canonical LeetCode metadata lookup.
  const LC_SLUG_INFO = (() => {
    const map = new Map();
    seedProblems().forEach((item) => {
      const slug = String(item.url || "").split("/problems/")[1] || "";
      map.set(slug.replace(/\/$/, ""), { num: item.num, name: item.name, difficulty: item.difficulty });
    });
    return map;
  })();

  /* True when `code` is byte-identical to the pristine skeleton (ignoring a
     trailing newline). Such code is NOT user work and must not be saved.
     Also matches the official LeetCode starter code once it has been fetched
     for the problem, so a swapped-in skeleton is equally protected. */

  const slugKey = (url) => (String(url || "").split("/problems/")[1] || "").replace(/\/$/, "");

  /* Fetched skeletons (slug -> skeletons map) are process-wide so a swap
     made while viewing one problem is reusable for every other problem.
     Declared before lcSkeletonMatches, which reads them. */
  const lcOfficialSkeletons = new Map();
  const lcSkeletonPending = new Map();

  const lcSkeletonMatches = (problem, language, code) => {
    if (typeof code !== "string" || !code.trim()) return false;
    const generic = lcSkeleton(language, problem);
    if (code.trimEnd() === generic.trimEnd()) return true;
    const slug = slugKey(problem?.url);
    const official = slug ? lcOfficialSkeletons.get(slug) : null;
    return Boolean(official && typeof official[language] === "string" && code.trimEnd() === official[language].trimEnd());
  };

  const lcSkeleton = (language, problem) => {
    const lang = LANGUAGE_IDS.has(language) ? language : DEFAULT_LANGUAGE;
    const slug = String(problem?.url || "").split("/problems/")[1] || "";
    const key = slug.replace(/\/$/, "");
    const preset = LC_SKELETONS[key];
    if (preset && preset[lang]) return preset[lang];
    const fn = lcVarName(problem?.name);
    const skeletons = {
      javascript: `var ${fn} = function() {\n    \n};\n`,
      python: `class Solution:\n    def ${fn}(self) :\n        \n`,
      java: `class Solution {\n    public void ${fn}() {\n        \n    }\n}\n`,
      c: `void ${fn}() {\n    \n}\n`,
      cpp: `class Solution {\npublic:\n    void ${fn}() {\n        \n    }\n};\n`
    };
    return skeletons[lang];
  };

  /* One-time data heal: an earlier version auto-saved pristine skeletons as
     if they were user code. Real solutions are never byte-identical to the
     skeleton, so dropping exact skeleton copies cannot lose user work. */
  lcState.problems.forEach((problem) => {
    if (!problem.code || typeof problem.code !== "object") return;
    Object.keys(problem.code).forEach((language) => {
      if (lcSkeletonMatches(problem, language, problem.code[language])) {
        delete problem.code[language];
      }
    });
  });

  /* ---------------- official LeetCode starter-code fetch ---------------- */

  const modelIsPristine = (model) => {
    if (!model) return false;
    const value = model.getValue();
    if (value.trim() && model.getLanguageId() !== "plaintext") {
      // A model counts as pristine when it still holds an untouched skeleton.
      const problem = getActiveLcProblem();
      const lang = model.getLanguageId();
      const langId = LANGUAGE_IDS.has(lang) ? lang : null;
      if (!problem || !langId) return false;
      if (lcSkeletonMatches(problem, langId, value)) return true;
    }
    return !value.trim();
  };

  const fetchOfficialSkeleton = async (problem) => {
    const slug = slugKey(problem?.url);
    if (!slug) return null;
    if (lcOfficialSkeletons.has(slug)) return lcOfficialSkeletons.get(slug);
    if (lcSkeletonPending.has(slug)) return lcSkeletonPending.get(slug);
    const promise = (async () => {
      try {
        const response = await fetch(`${getApiBase()}/api/lc-skeleton?slug=${encodeURIComponent(slug)}`);
        const payload = await response.json();
        if (payload?.ok && payload.skeletons && typeof payload.skeletons === "object") {
          lcOfficialSkeletons.set(slug, payload.skeletons);
          return payload.skeletons;
        }
      } catch {
        /* offline / blocked — generic fallback stays in place */
      } finally {
        lcSkeletonPending.delete(slug);
      }
      return null;
    })();
    lcSkeletonPending.set(slug, promise);
    return promise;
  };

  /* Swap a pristine model's contents for the official LeetCode starter code.
     Only untouched models are replaced — user code is never overwritten. */
  const upgradePristineModelToOfficial = (problem, language, model) => {
    if (!model) return;
    const official = lcOfficialSkeletons.get(slugKey(problem?.url));
    const code = official ? official[language] : null;
    if (typeof code !== "string" || !code.trim()) return;
    if (model.getValue() === code) return;
    if (!modelIsPristine(model)) return;
    const viewState = qlEditor && qlEditor.getModel() === model ? qlEditor.saveViewState() : null;
    model.setValue(code);
    if (viewState && qlEditor && qlEditor.getModel() === model) qlEditor.restoreViewState(viewState);
  };

  /* A problem counts as solved when any of its per-language solutions is
     solved. Legacy data without language-level state falls back to the old
     problem-level flag. */
  const problemIsSolved = (problem) => {
    if (!problem) return false;
    if (problem.langSolved && typeof problem.langSolved === "object") {
      return Object.values(problem.langSolved).some(Boolean);
    }
    return Boolean(problem.solved);
  };

  const currentLangLabel = () => {
    try {
      return getLanguageDef(qlActiveLanguage).label;
    } catch {
      return qlActiveLanguage;
    }
  };

  const renderLcProblemList = () => {
    lcProblemList.innerHTML = "";
    const problems = sortLcProblems(visibleLcProblems());
    const solvedCount = lcState.problems.filter((problem) => problemIsSolved(problem)).length;

    if (lcProgressChip) {
      lcProgressChip.textContent = `${solvedCount} / ${lcState.problems.length} solved`;
    }

    if (!problems.length) {
      lcEmpty.hidden = false;
      return;
    }
    lcEmpty.hidden = true;

    const fragment = document.createDocumentFragment();
    problems.forEach((problem) => {
      const row = document.createElement("div");
      const rowSolved = problemIsSolved(problem);
      row.className = `lc-problem-row${problem.id === lcState.activeProblemId ? " is-active" : ""}${rowSolved ? " is-solved" : ""}`;
      row.dataset.problemId = problem.id;
      row.setAttribute("role", "listitem");

      const numEl = document.createElement("span");
      numEl.className = "lc-problem-num";
      numEl.textContent = String(problem.num || "—");

      const main = document.createElement("div");
      main.className = "lc-problem-main";

      const nameBtn = document.createElement("button");
      nameBtn.type = "button";
      nameBtn.className = "lc-problem-name";
      nameBtn.textContent = problem.name;
      nameBtn.setAttribute("aria-label", `Open notes for ${problem.name}`);

      const metaRow = document.createElement("div");
      metaRow.className = "lc-problem-meta";
      const diffBadge = document.createElement("span");
      diffBadge.className = `lc-diff lc-diff--${problem.difficulty.toLowerCase()}`;
      diffBadge.textContent = problem.difficulty;
      metaRow.append(diffBadge);

      if (rowSolved) {
        const solvedTick = document.createElement("span");
        solvedTick.className = "lc-solved-tick";
        solvedTick.title = "Solved";
        solvedTick.setAttribute("aria-label", "Solved");
        solvedTick.innerHTML =
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 16.2-3.5-3.5L4 14.2 9 19 20 8l-1.4-1.4L9 16.2Z"/></svg>';
        metaRow.append(solvedTick);
      }

      /* Star toggle — marks a problem for revision without opening it. */
      const starBtn = document.createElement("button");
      starBtn.type = "button";
      starBtn.className = `lc-row-star${problem.bookmarked === true ? " is-starred" : ""}`;
      starBtn.textContent = problem.bookmarked === true ? "★" : "☆";
      starBtn.title = problem.bookmarked === true ? "Remove star" : "Star for revision";
      starBtn.setAttribute("aria-label", `${starBtn.title} — ${problem.name}`);
      starBtn.setAttribute("aria-pressed", String(problem.bookmarked === true));
      metaRow.append(starBtn);

      const openLink = document.createElement("a");
      openLink.className = "lc-problem-link";
      openLink.href = problem.url;
      openLink.target = "_blank";
      openLink.rel = "noopener noreferrer";
      openLink.setAttribute("aria-label", `Open ${problem.name} on LeetCode`);
      openLink.setAttribute("title", "Open on LeetCode");
      openLink.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12ZM8 13h8v-2H8v2Zm9-6h-4v1.9h4a3.1 3.1 0 1 1 0 6.2h-4V17h4a5 5 0 0 0 0-10Z"/></svg>';
      metaRow.append(openLink);

      main.append(nameBtn, metaRow);
      row.append(numEl, main);
      fragment.appendChild(row);
    });
    lcProblemList.appendChild(fragment);
  };

  const renderLcDetail = () => {
    const problem = getActiveLcProblem();
    const detailEmpty = byId("lc-detail-empty");
    if (!problem) {
      lcDetail.hidden = true;
      if (detailEmpty) detailEmpty.hidden = false;
      return;
    }
    if (detailEmpty) detailEmpty.hidden = true;
    lcDetail.hidden = false;
    lcDetailTitle.textContent = problem.name;
    const detailSolved = problemIsSolved(problem);
    lcDetailMeta.textContent = `${problem.num ? `#${problem.num} · ` : ""}${problem.difficulty}${detailSolved ? ` · Solved ✓ (${currentLangLabel()})` : ""}`;
    lcDetailLink.href = problem.url;
    lcDetailLink.title = `Open ${problem.name} on LeetCode`;
    const langSolvedNow = Boolean(problem.langSolved?.[qlActiveLanguage]);
    lcDetailSolvedBtn.textContent = langSolvedNow ? `Unsolved (${currentLangLabel()})` : `Solved (${currentLangLabel()})`;
    lcDetailSolvedBtn.classList.toggle("is-solved", langSolvedNow);
    const starredNow = problem.bookmarked === true;
    if (lcDetailStarBtn) {
      lcDetailStarBtn.textContent = starredNow ? "★ Starred" : "☆ Star";
      lcDetailStarBtn.classList.toggle("is-active", starredNow);
      lcDetailStarBtn.setAttribute("aria-pressed", String(starredNow));
      lcDetailStarBtn.title = starredNow ? "Remove star" : "Star for revision";
    }
    const savedBadge = byId("lc-detail-saved");
    if (savedBadge) savedBadge.hidden = !getProblemCode(problem, qlActiveLanguage).trim();
    renderNotesSections();
    renderQlCodeView();
  };

  const renderLcAll = () => {
    renderLcProblemList();
    renderLcDetail();
  };

  const selectLcProblem = (problemId) => {
    lcState.activeProblemId = problemId;
    persistLcState();
    renderLcProblemList();
    renderLcDetail();
    if (window.innerWidth <= 900) lcLayout.classList.add("show-detail");
    /* The detail pane may just have become measurable — re-apply any stored
       split size for the description divider. */
    window.setTimeout(() => qlSplits?.applyAll(), 80);
  };

  const backToLcList = () => {
    lcLayout.classList.remove("show-detail");
  };

  /* --------------------- Add Problem (in-app dialog) --------------------- */

  const lcAddOverlay = byId("lc-add-overlay");
  const lcAddUrlInput = byId("lc-add-url-input");
  const lcAddNameInput = byId("lc-add-name-input");
  const lcAddError = byId("lc-add-error");
  const lcAddCancelBtn = byId("lc-add-cancel-btn");
  const lcAddConfirmBtn = byId("lc-add-confirm-btn");

  const setLcAddOpen = (open) => {
    if (!lcAddOverlay) return;
    lcAddOverlay.hidden = !open;
    document.body.classList.toggle("has-open-dialog", open);
    if (open) {
      lcAddUrlInput.value = "";
      if (lcAddNameInput) lcAddNameInput.value = "";
      lcAddError.hidden = true;
      requestAnimationFrame(() => lcAddUrlInput.focus());
    }
  };

  const showLcAddError = (message) => {
    if (!lcAddError) return;
    lcAddError.textContent = message;
    lcAddError.hidden = false;
  };

  const confirmAddLcProblem = async () => {
    const value = String(lcAddUrlInput?.value || "").trim();
    if (!value) {
      showLcAddError("Paste a LeetCode problem link first.");
      return;
    }
    const info = extractLcProblemInfo(value);
    if (!info) {
      showLcAddError("That does not look like a LeetCode problem link. Example: https://leetcode.com/problems/two-sum/");
      return;
    }
    if (lcState.problems.some((problem) => problem.url === info.url)) {
      showLcAddError("This problem is already in your list.");
      return;
    }
    /* Optional number/name field: "4. Median of Two Sorted Arrays" wins over
       auto-detected metadata so the problem lands exactly where the user
       expects in the ascending order. */
    const nameValue = String(lcAddNameInput?.value || "").trim();
    let overrideNum = 0;
    let overrideName = "";
    if (nameValue) {
      const nameMatch = nameValue.match(/^\s*#?(\d+)\.?\s*(.*)$/);
      if (nameMatch) {
        overrideNum = Number(nameMatch[1]);
        overrideName = nameMatch[2].trim();
      } else {
        overrideName = nameValue;
      }
      if (overrideNum) {
        const clash = lcState.problems.find((problem) => problem.num === overrideNum);
        if (clash && clash.url !== info.url) {
          showLcAddError(`Program ${overrideNum} (${clash.name}) is already in your list.`);
          return;
        }
      }
    }
    // Canonical metadata: built-in slug map first, then LeetCode's GraphQL
    // API via the local server. Skipped when the user typed their own
    // number — trust their input over a network guess.
    let known = overrideNum ? null : LC_SLUG_INFO.get(slugKey(info.url)) || null;
    if (!known) {
      if (lcAddConfirmBtn) {
        lcAddConfirmBtn.disabled = true;
        lcAddConfirmBtn.textContent = "Looking up…";
      }
      try {
        const response = await fetch(`${getApiBase()}/api/lc-lookup?slug=${encodeURIComponent(info.slug)}`);
        const payload = await response.json();
        if (payload?.ok) {
          known = { num: Number(payload.num), name: payload.name, difficulty: payload.difficulty };
        }
      } catch {
        /* offline — fall back to the slug-derived info below */
      } finally {
        if (lcAddConfirmBtn) {
          lcAddConfirmBtn.disabled = false;
          lcAddConfirmBtn.textContent = "Add";
        }
      }
    }
    const problem = {
      id: randomId("p"),
      num: overrideNum || (known ? known.num : info.num || 0),
      name: overrideName || (known ? known.name : info.name),
      url: info.url,
      difficulty: known ? known.difficulty : "Medium",
      solved: false,
      added: true,
      langSolved: {},
      code: {},
      notes: [{ id: randomId("nsec"), title: "Approach", html: "", collapsed: false }]
    };
    if (!problem.num) problem.num = Math.max(0, ...lcState.problems.map((item) => item.num)) + 1;
    // Insert at the position that keeps ascending LeetCode-number order
    // (ties broken by name, matching the list's sortLcProblems ordering).
    const insertAt = lcState.problems.findIndex(
      (item) => item.num > problem.num || (item.num === problem.num && item.name.localeCompare(problem.name) > 0)
    );
    if (insertAt === -1) lcState.problems.push(problem);
    else lcState.problems.splice(insertAt, 0, problem);
    lcState.activeProblemId = problem.id;
    persistLcState();
    renderLcProblemList();
    renderLcDetail();
    setLcAddOpen(false);
    showLabToast(`Added "${problem.name}"`);
    if (/^#?\d+$/.test(lcFilter.query.trim()) && String(problem.num) !== lcFilter.query.trim().replace(/^#/, "")) {
      lcSearchInput.value = "";
      lcFilter.query = "";
      renderLcProblemList();
    }
  };

  lcAddCancelBtn?.addEventListener("click", () => setLcAddOpen(false));
  lcAddOverlay?.addEventListener("click", (event) => {
    if (event.target === lcAddOverlay) setLcAddOpen(false);
  });
  lcAddConfirmBtn?.addEventListener("click", confirmAddLcProblem);
  lcAddUrlInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmAddLcProblem();
    }
  });
  lcAddNameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmAddLcProblem();
    }
  });

  const addLcProblemFromInput = () => setLcAddOpen(true);

  const deleteActiveLcProblem = () => {
    const problem = getActiveLcProblem();
    if (!problem) {
      showLabToast("Open a problem first, then delete it.");
      return;
    }
    if (!window.confirm(`Remove "${problem.name}" from your list? Your notes and code on it will be deleted.`)) return;
    qlModels.forEach((model) => model.dispose());
    qlModels.clear();
    qlModelsByProblem.clear();
    lcState.problems = lcState.problems.filter((entry) => entry.id !== problem.id);
    lcState.activeProblemId = "";
    persistLcState();
    renderLcAll();
  };

  const toggleActiveLcSolved = () => {
    const problem = getActiveLcProblem();
    if (!problem) return;
    // Solved state is tracked per language, independently.
    if (!problem.langSolved || typeof problem.langSolved !== "object") problem.langSolved = {};
    problem.langSolved[qlActiveLanguage] = !problem.langSolved[qlActiveLanguage];
    // Keep the legacy top-level flag in sync for older views/backups.
    problem.solved = Object.values(problem.langSolved).some(Boolean);
    persistLcState();
    renderLcProblemList();
    renderLcDetail();
  };

  /* Star problems for revision. Stored as `bookmarked` on the problem so old
     backups and older app versions simply see "not starred" — no migration. */
  const toggleLcStar = (problemId) => {
    const problem = lcState.problems.find((entry) => entry.id === problemId);
    if (!problem) return;
    problem.bookmarked = problem.bookmarked !== true;
    persistLcState();
    renderLcProblemList();
    renderLcDetail();
    showLabToast(problem.bookmarked ? `Starred ${problem.name}` : `Removed star from ${problem.name}`);
  };

  const toggleActiveLcStar = () => {
    const problem = getActiveLcProblem();
    if (problem) toggleLcStar(problem.id);
  };

  /* ----------------- per-problem code (per-language) --------------------- */

  const qlModels = new Map();          // "problemId|language" -> monaco model
  const qlModelsByProblem = new Map(); // problemId -> Set of models
  let qlEditor = null;
  let qlActiveLanguage = localStorageQuantaCodeLang();
  let qlIsRunning = false;

  function localStorageQuantaCodeLang() {
    try {
      const saved = localStorage.getItem("quantaProblemCodeLang");
      return LANGUAGE_IDS.has(saved) ? saved : DEFAULT_LANGUAGE;
    } catch {
      return DEFAULT_LANGUAGE;
    }
  }

  const getProblemCode = (problem, language) => {
    if (!problem) return "";
    if (!problem.code || typeof problem.code !== "object") problem.code = {};
    if (typeof problem.code[language] === "string") return problem.code[language];
    return "";
  };

  const setProblemCode = (problem, language, code) => {
    if (!problem) return;
    if (!problem.code || typeof problem.code !== "object") problem.code = {};
    problem.code[language] = code;
  };

  const qlModelKey = (problemId, language) => `${problemId}|${language}`;

  const getOrCreateQlModel = (problem, language) => {
    if (!window.monaco?.editor) return null;
    const key = qlModelKey(problem.id, language);
    const existing = qlModels.get(key);
    if (existing) return existing;
    const code = getProblemCode(problem, language);
    const initial = code || lcSkeleton(language, problem);
    const model = window.monaco.editor.createModel(initial, getLanguageDef(language).monaco);
    qlModels.set(key, model);
    if (!qlModelsByProblem.has(problem.id)) qlModelsByProblem.set(problem.id, new Set());
    qlModelsByProblem.get(problem.id).add(model);
    /* Replace the generic fallback with the real LeetCode starter code once
       it arrives (only if the user has not started typing). */
    if (!code) {
      fetchOfficialSkeleton(problem).then((skeletons) => {
        if (skeletons) upgradePristineModelToOfficial(problem, language, model);
      });
    }
    return model;
  };

  const ensureQlEditor = async () => {
    const monaco = await ensureMonaco();
    syncMonacoTheme();
    if (qlEditor) return;
    qlEditor = monaco.editor.create(qlMonacoNode, {
      value: "",
      language: getLanguageDef(qlActiveLanguage).monaco,
      automaticLayout: true,
      tabSize: labState.tabSize || 4,
      insertSpaces: true,
      bracketPairColorization: { enabled: true },
      autoClosingBrackets: "always",
      autoClosingQuotes: "always",
      autoIndent: "full",
      minimap: { enabled: false },
      fontSize: labState.editorFontSize || DEFAULT_EDITOR_FONT_SIZE,
      lineHeight: 1.6,
      fontFamily: "Consolas, 'Courier New', monospace",
      wordWrap: labState.wordWrap !== false ? "on" : "off",
      lineNumbers: labState.lineNumbers !== false ? "on" : "off",
      scrollBeyondLastLine: false,
      padding: { top: 10, bottom: 10 },
      scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10, horizontalScrollbarSize: 10 }
    });

    let saveTimer = 0;
    qlEditor.onDidChangeModelContent(() => {
      const problem = getActiveLcProblem();
      if (!problem) return;
      const value = qlEditor.getValue();
      // A pristine skeleton is not user code — never persist it as a solution.
      if (lcSkeletonMatches(problem, qlActiveLanguage, value)) return;
      setProblemCode(problem, qlActiveLanguage, value);
      if (qlCodeStatus) qlCodeStatus.textContent = "Unsaved";
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        persistLcState();
        if (qlCodeStatus) qlCodeStatus.textContent = "Saved";
      }, 600);
    });
  };

  const renderQlCodeView = async () => {
    const problem = getActiveLcProblem();
    qlCodeLanguage.value = qlActiveLanguage;
    if (!problem) {
      if (qlEditor) qlEditor.setModel(window.monaco.editor.createModel("", "plaintext"));
      return;
    }
    try {
      await ensureQlEditor();
    } catch {
      return;
    }
    if (labState.languageThemes !== false) applyLanguageTheme(qlActiveLanguage);
    else clearLanguageAccent();
    const model = getOrCreateQlModel(problem, qlActiveLanguage);
    if (model && qlEditor) qlEditor.setModel(model);
    if (model && qlEditor) upgradePristineModelToOfficial(problem, qlActiveLanguage, model);
    relayoutMonacoEditors();
    const hasSaved = Boolean(getProblemCode(problem, qlActiveLanguage).trim());
    if (qlCodeStatus) qlCodeStatus.textContent = hasSaved ? "Saved" : "Skeleton";
    /* Per-language solved badge inside the workspace. */
    if (qlCodeSolvedBadge) {
      const solvedNow = Boolean(problem.langSolved?.[qlActiveLanguage]);
      qlCodeSolvedBadge.textContent = solvedNow ? "Solved ✅" : "Unsolved";
      qlCodeSolvedBadge.classList.toggle("is-solved", solvedNow);
    }
    /* The pristine skeleton is NOT user code — never write it into
       problem.code. Saving happens only when the user actually edits. */
    loadQlDescription(problem);
  };

  /* ------------- split-view problem description (LeetCode HTML) --------- */
  /* Descriptions are cached on this device, so they open instantly and keep
     working with no internet. Fresh copies come from the Quanta database API
     first and from the LeetCode proxy second. The sync badge tells the user
     whether what they are reading is a saved copy or a fresh one. */

  const DESC_CACHE_KEY = "quantaDescCacheV1";
  const DESC_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; /* refresh after 7 days */
  const DESC_CACHE_MAX = 400; /* newest N statements kept when trimming */
  const DESC_FETCH_TIMEOUT_MS = 10000;
  const DESC_FETCH_ATTEMPTS = 2;

  let qlDescToken = 0;
  let descCache = null; /* Map<slug, { html, at, source }> */
  const inflightDesc = new Map(); /* slug → Promise: never two requests for one problem */

  const readDescCache = () => {
    if (descCache) return descCache;
    descCache = new Map();
    try {
      const raw = JSON.parse(localStorage.getItem(DESC_CACHE_KEY) || "{}");
      Object.entries(raw || {}).forEach(([slug, entry]) => {
        if (entry && typeof entry.html === "string" && entry.html) {
          descCache.set(slug, {
            html: entry.html,
            at: Number(entry.at) || 0,
            source: entry.source || "cache"
          });
        }
      });
    } catch {
      /* corrupted or unavailable storage — start empty, nothing is lost */
    }
    return descCache;
  };

  const writeDescCache = () => {
    try {
      const trimmed = [...readDescCache().entries()]
        .sort((a, b) => (a[1].at || 0) - (b[1].at || 0))
        .slice(-DESC_CACHE_MAX);
      const payload = {};
      trimmed.forEach(([slug, entry]) => {
        payload[slug] = entry;
      });
      localStorage.setItem(DESC_CACHE_KEY, JSON.stringify(payload));
    } catch {
      /* quota exceeded / private mode — the in-memory copy still works */
    }
  };

  /* Returns true when the stored copy actually changed. */
  const rememberDescription = (slug, html, source) => {
    const cache = readDescCache();
    const previous = cache.get(slug);
    if (previous && previous.html === html) return false;
    cache.set(slug, { html, at: Date.now(), source: source || "synced" });
    writeDescCache();
    return true;
  };

  const setDescStatus = (text, kind = "") => {
    const node = byId("ql-desc-sync");
    if (!node) return;
    node.textContent = text || "";
    node.className = `ql-desc-sync${kind ? ` ql-desc-sync--${kind}` : ""}`;
    node.hidden = !text;
  };

  /* Timeout + one retry, but a 404 is a final answer and is never retried. */
  const fetchJson = async (url) => {
    const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
    let lastError = null;
    for (let attempt = 0; attempt < DESC_FETCH_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: hasTimeout ? AbortSignal.timeout(DESC_FETCH_TIMEOUT_MS) : undefined
        });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < DESC_FETCH_ATTEMPTS - 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  };

  /* Bundled offline statements: offline-pack.js (generated by
     scripts/export-offline-pack.js) holds every statement the database has,
     so they can be read with no internet, no laptop and no server at all.
     It is loaded lazily — only after both network sources have already
     failed — so online sessions never pay for parsing it. */
  let offlinePackPromise = null;
  const loadOfflinePack = () => {
    if (window.QUANTA_OFFLINE_PACK) return Promise.resolve(window.QUANTA_OFFLINE_PACK);
    if (offlinePackPromise) return offlinePackPromise;
    offlinePackPromise = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "offline-pack.js";
      script.async = true;
      script.onload = () => resolve(window.QUANTA_OFFLINE_PACK || null);
      script.onerror = () => {
        offlinePackPromise = null; /* retried on the next statement */
        resolve(null);
      };
      document.head.appendChild(script);
    });
    return offlinePackPromise;
  };

  /* One shared in-flight promise per slug, so switching tabs/problems quickly
     never fires duplicate requests for the same statement. */
  const requestDescription = (slug) => {
    if (inflightDesc.has(slug)) return inflightDesc.get(slug);

    const promise = (async () => {
      const base = getApiBase();

      /* 1) Quanta's own database — stable, and independent of LeetCode. */
      try {
        const payload = await fetchJson(`${base}/api/problems/${encodeURIComponent(slug)}`);
        const html = payload?.ok && payload.problem ? String(payload.problem.descriptionHtml || "") : "";
        if (html) return { html, source: "database" };
      } catch {
        /* API unreachable or offline → try the LeetCode proxy next */
      }

      /* 2) LeetCode proxy on the same server (fills the database over time). */
      try {
        const payload = await fetchJson(`${base}/api/lc-description?slug=${encodeURIComponent(slug)}`);
        if (payload?.ok && payload.html) {
          return { html: String(payload.html), source: payload.source === "database" ? "database" : "leetcode" };
        }
      } catch {
        /* both sources unavailable → the bundled copy below is the last resort */
      }

      /* 3) Bundled offline copy — used only when the network failed, so an
         offline device (no laptop, no server, airplane mode) still shows the
         statement instead of an error. */
      const pack = await loadOfflinePack();
      if (pack && typeof pack[slug] === "string" && pack[slug]) {
        return { html: pack[slug], source: "offline-pack" };
      }
      return null;
    })().finally(() => {
      inflightDesc.delete(slug);
    });

    inflightDesc.set(slug, promise);
    return promise;
  };

  const describeUnavailable = (offline) =>
    offline
      ? '<p class="ql-desc-empty">You are offline and this statement has not been saved on this device yet. It will load automatically once you are connected.</p>'
      : '<p class="ql-desc-empty">Description unavailable right now. Check your connection, or open it on LeetCode for the full statement.</p>';

  const renderDescHtml = (html) => {
    if (!qlDescBody) return;
    const holder = document.createElement("div");
    holder.innerHTML = html;
    holder.querySelectorAll("script, style, iframe, object, embed, link, meta").forEach((node) => node.remove());
    holder.querySelectorAll("*").forEach((node) => {
      Array.from(node.attributes).forEach((attr) => {
        const isSafeHref = attr.name === "href" && /^https:\/\//i.test(attr.value);
        if (!isSafeHref) node.removeAttribute(attr.name);
      });
    });
    holder.querySelectorAll("pre").forEach((pre) => {
      if (!pre.querySelector("code")) {
        const code = document.createElement("code");
        while (pre.firstChild) code.appendChild(pre.firstChild);
        pre.appendChild(code);
      }
    });
    qlDescBody.innerHTML = "";
    while (holder.firstChild) qlDescBody.appendChild(holder.firstChild);
  };

  const loadQlDescription = (problem) => {
    if (!qlDescBody || !problem) return;
    if (qlDescDiff) qlDescDiff.textContent = `${problem.num ? `#${problem.num} · ` : ""}${problem.difficulty}`;
    if (qlDescLink) qlDescLink.href = problem.url;
    const slug = slugKey(problem.url);
    if (!slug) {
      setDescStatus("");
      qlDescBody.innerHTML = '<p class="ql-desc-empty">No description available for custom problems. Open it on LeetCode for the full statement.</p>';
      return;
    }

    qlDescToken += 1;
    const token = qlDescToken;
    const offline = location.protocol === "file:" || navigator.onLine === false;
    const cached = readDescCache().get(slug);

    /* Cache first: the saved statement renders immediately, then a fresh copy
       is fetched in the background only when it is old enough to be stale. */
    if (cached) {
      renderDescHtml(cached.html);
      const age = Date.now() - (cached.at || 0);
      if (age > DESC_CACHE_TTL_MS) {
        setDescStatus("Saved on this device · refreshing…", "cached");
        refreshDescription(slug, token);
      } else {
        setDescStatus("Saved on this device", "cached");
      }
      return;
    }

    setDescStatus("Syncing…", "syncing");
    qlDescBody.innerHTML = '<p class="ql-desc-loading">Loading problem description…</p>';
    requestDescription(slug).then((result) => {
      if (token !== qlDescToken) return; /* stale — another problem took over */
      if (result && result.html) {
        rememberDescription(slug, result.html, result.source);
        renderDescHtml(result.html);
        setDescStatus(
          result.source === "offline-pack"
            ? "Bundled with the app"
            : result.source === "database"
              ? "Synced from database"
              : "Synced from LeetCode",
          result.source === "offline-pack" ? "cached" : "synced"
        );
      } else {
        setDescStatus("");
        qlDescBody.innerHTML = describeUnavailable(offline);
      }
    });
  };

  /* Background refresh for an old cached statement. It never blocks the view
     and never replaces text with an error — the saved copy stays readable. */
  const refreshDescription = (slug, token) => {
    requestDescription(slug).then((result) => {
      if (token !== qlDescToken) return;
      if (result && result.html) {
        const changed = rememberDescription(slug, result.html, result.source);
        if (changed) renderDescHtml(result.html);
        setDescStatus("Saved on this device · up to date", "cached");
      } else {
        setDescStatus("Saved on this device · offline copy", "cached");
      }
    });
  };

  qlCodeSaveBtn?.addEventListener("click", () => {
    const problem = getActiveLcProblem();
    if (!problem || !qlEditor) return;
    const value = qlEditor.getValue();
    if (lcSkeletonMatches(problem, qlActiveLanguage, value)) {
      if (qlCodeStatus) qlCodeStatus.textContent = "Nothing to save";
      return;
    }
    setProblemCode(problem, qlActiveLanguage, value);
    persistLcState(true);
    if (qlCodeStatus) qlCodeStatus.textContent = "Saved";
    const savedBadge = byId("lc-detail-saved");
    if (savedBadge) savedBadge.hidden = false;
  });

  qlCodeLanguage?.addEventListener("change", (event) => {
    qlActiveLanguage = normalizeLanguage(event.target.value);
    try {
      localStorage.setItem("quantaProblemCodeLang", qlActiveLanguage);
    } catch {}
    // Keep the solved button / meta in sync with the selected language.
    renderLcDetail();
  });

  settingsLangThemeToggle?.addEventListener("change", (event) => {
    labState.languageThemes = event.target.checked;
    persistLabState(true);
    if (event.target.checked) {
      if (currentPage === "lab" && getActiveSession()) applyLanguageTheme(getActiveSession().language);
      else void renderQlCodeView();
    } else {
      syncMonacoTheme();
      clearLanguageAccent();
    }
  });

  labLanguageSelect?.addEventListener("change", () => {
    // Live accent preview for the program being created.
    if (labState.languageThemes !== false) applyLanguageAccent(labLanguageSelect.value);
  });

  const runQlCode = async () => {
    const problem = getActiveLcProblem();
    if (!problem || qlIsRunning) return;
    if (!qlEditor) await ensureQlEditor();
    const code = qlEditor ? qlEditor.getValue() : getProblemCode(problem, qlActiveLanguage);
    // Running a pristine skeleton must not mark it as a saved solution.
    if (!lcSkeletonMatches(problem, qlActiveLanguage, code)) {
      setProblemCode(problem, qlActiveLanguage, code);
      persistLcState(true);
    }

    qlIsRunning = true;
    qlCodeRunBtn.disabled = true;
    qlCodeOutput.textContent = "";
    setQlStatus("Running…", "running");

    const stdin = qlStdin && !qlStdin.hidden ? qlStdin.value : "";
    try {
      const result = await executeCode(qlActiveLanguage, code, stdin);
      if (result.stdout) appendQlOutput(result.stdout.replace(/\n$/, "") + "\n");
      if (result.stderr) appendQlOutput(result.stderr.replace(/\n$/, "") + "\n");
      if (!result.stdout && !result.stderr) appendQlOutput("(no output)\n");
      if (result.timedOut) setQlStatus("Timed out", "error");
      else if (result.ok) setQlStatus("Finished", "success");
      else if (result.phase === "compile") setQlStatus("Compile error", "error");
      else if (result.phase === "network") setQlStatus("Offline", "error");
      else setQlStatus("Error", "error");
    } catch (error) {
      appendQlOutput(`Unexpected error: ${error?.message || error}\n`);
      setQlStatus("Error", "error");
    } finally {
      qlIsRunning = false;
      qlCodeRunBtn.disabled = false;
    }
  };

  const setQlStatus = (text, kind = "") => {
    qlCodeStatus.textContent = text;
    qlCodeStatus.className = `ql-code-status${kind ? ` ql-code-status--${kind}` : ""}`;
  };

  const appendQlOutput = (text) => {
    if (qlCodeOutput.textContent === "Ready.") qlCodeOutput.textContent = "";
    qlCodeOutput.textContent += text;
    qlCodeOutput.scrollTop = qlCodeOutput.scrollHeight;
  };

  qlCodeRunBtn?.addEventListener("click", () => void runQlCode());
  if (qlStdinToggle && qlStdin) {
    qlStdinToggle.addEventListener("change", () => {
      qlStdin.hidden = !qlStdinToggle.checked;
    });
  }

  /* ------------------------- detail tabs (notes/code) -------------------- */

  const selectQlTab = (tab) => {
    const isNotes = tab === "notes";
    qlTabNotes.classList.toggle("is-active", isNotes);
    qlTabCode.classList.toggle("is-active", !isNotes);
    qlTabNotes.setAttribute("aria-selected", String(isNotes));
    qlTabCode.setAttribute("aria-selected", String(!isNotes));
    qlViewNotes.hidden = !isNotes;
    qlViewCode.hidden = isNotes;
    if (!isNotes) void renderQlCodeView();
    relayoutMonacoEditors();
    if (!isNotes) queueDescDividerSync();
  };

  qlTabNotes?.addEventListener("click", () => selectQlTab("notes"));
  qlTabCode?.addEventListener("click", () => selectQlTab("code"));

  /* ------------------- per-problem notes (rich text) --------------------- */

  const saveSectionFromDom = (sectionId, titleInput, editorNode) => {
    const problem = getActiveLcProblem();
    if (!problem) return;
    const section = problem.notes.find((entry) => entry.id === sectionId);
    if (!section) return;
    section.title = String(titleInput?.value || section.title || "Section").trim() || "Section";
    section.html = String(editorNode?.innerHTML || "");
    updateNotesWordCount();
    persistLcState();
  };

  const updateNotesWordCount = () => {
    const problem = getActiveLcProblem();
    if (!problem) {
      notesWordCount.textContent = "0 words · 0 chars";
      return;
    }
    let words = 0;
    let chars = 0;
    problem.notes.forEach((section) => {
      const holder = document.createElement("div");
      holder.innerHTML = section.html || "";
      const text = holder.textContent || "";
      chars += text.length;
      words += text.trim() ? text.trim().split(/\s+/).length : 0;
    });
    notesWordCount.textContent = `${words} words · ${chars} chars`;
  };

  if (lcProblemList) {
    lcProblemList.addEventListener("click", (event) => {
      const row = event.target.closest(".lc-problem-row");
      if (!row) return;
      if (event.target.closest("a")) return;
      /* Star buttons toggle in place instead of opening the problem. */
      if (event.target.closest(".lc-row-star")) {
        toggleLcStar(row.dataset.problemId || "");
        return;
      }
      selectLcProblem(row.dataset.problemId || "");
    });
  }

  lcSearchInput?.addEventListener("input", (event) => {
    lcFilter.query = event.target.value;
    renderLcProblemList();
  });

  lcDifficultyChips?.addEventListener("click", (event) => {
    const chip = event.target.closest(".lc-chip");
    if (!chip) return;
    lcFilter.difficulty = chip.dataset.difficulty || "all";
    lcDifficultyChips.querySelectorAll(".lc-chip").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.difficulty === lcFilter.difficulty);
    });
    renderLcProblemList();
  });

  lcStatusFilter?.addEventListener("change", (event) => {
    lcFilter.status = event.target.value;
    renderLcProblemList();
  });

  lcDetailBackBtn?.addEventListener("click", backToLcList);
  lcDetailSolvedBtn?.addEventListener("click", toggleActiveLcSolved);
  lcDetailStarBtn?.addEventListener("click", toggleActiveLcStar);
  lcDetailDeleteBtn?.addEventListener("click", deleteActiveLcProblem);

  /* --------- Maximize / restore the Notes & Code workspace --------------- */
  /* Expands the detail box over the problem list (desktop grid); restoring
     returns to the normal split. A class on <body> drives the CSS so the
     state survives detail re-renders. */
  const setLcDetailMaximized = (maximized) => {
    document.body.classList.toggle("lc-detail-maximized", maximized);
    if (lcDetailMaxBtn) {
      lcDetailMaxBtn.setAttribute("aria-label", maximized ? "Restore notes and code size" : "Maximize notes and code");
      lcDetailMaxBtn.title = maximized ? "Restore" : "Maximize";
    }
    /* The box changed width dramatically: re-apply the split size stored for
       THIS mode (or fall back to the 50/50 default) and re-measure Monaco so
       every element — including the Open LeetCode button — sits correctly
       inside its section after the transition. */
    window.setTimeout(() => {
      if (qlSplits.values[qlSplits.activeKey(qlSplits.handles.find((h) => h.key === "qlDescW"))] !== undefined) {
        qlSplits.apply("qlDescW");
      } else {
        document.querySelector(".ql-code-split")?.style.removeProperty("--split-a");
        /* The overlay's inline offset must go too, or it would keep the old
           position while the panes return to the 50/50 default. */
        const overlay = byId("ql-desc-resizer");
        if (overlay) overlay.style.removeProperty("left");
      }
      relayoutMonacoEditors();
      /* Re-derive the divider from real pane geometry once the mode change
         has settled (queued frames cover the transition both ways). */
      queueDescDividerSync();
    }, 120);
    queueDescDividerSync();
  };

  lcDetailMaxBtn?.addEventListener("click", () => {
    setLcDetailMaximized(!document.body.classList.contains("lc-detail-maximized"));
  });



  const renderNotesSections = () => {
    notesSectionsList.innerHTML = "";
    const problem = getActiveLcProblem();
    if (!problem) {
      updateNotesWordCount();
      return;
    }

    const fragment = document.createDocumentFragment();
    problem.notes.forEach((section) => {
      const card = document.createElement("article");
      card.className = `notes-section-card${section.collapsed ? " is-collapsed" : ""}`;
      card.dataset.sectionId = section.id;
      card.draggable = true;

      const head = document.createElement("div");
      head.className = "notes-section-head";

      const titleInput = document.createElement("input");
      titleInput.type = "text";
      titleInput.className = "notes-section-title";
      titleInput.value = section.title;
      titleInput.placeholder = "Section title";

      const controls = document.createElement("div");
      controls.className = "notes-section-controls";

      const mkBtn = (action, innerHTML, cls, ariaLabel) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.dataset.action = action;
        btn.innerHTML = innerHTML;
        if (cls) btn.className = cls;
        if (ariaLabel) btn.setAttribute("aria-label", ariaLabel);
        btn.setAttribute("title", ariaLabel || action);
        return btn;
      };

      controls.append(
        mkBtn(
          "collapse",
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5H7Z"/></svg>',
          "notes-section-btn notes-section-btn--icon",
          section.collapsed ? "Expand section" : "Collapse section"
        ),
        mkBtn(
          "up",
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 5 7 7-1.4 1.4L13 8.8V19h-2V8.8l-4.6 4.6L5 12l7-7Z"/></svg>',
          "notes-section-btn notes-section-btn--icon",
          "Move section up"
        ),
        mkBtn(
          "down",
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19 5 12l1.4-1.4L11 15.2V5h2v10.2l4.6-4.6L19 12l-7 7Z"/></svg>',
          "notes-section-btn notes-section-btn--icon",
          "Move section down"
        ),
        mkBtn(
          "delete",
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12ZM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4Z"/></svg>',
          "notes-section-btn notes-section-btn--icon notes-section-btn--danger",
          "Delete section"
        )
      );

      const collapseBtn = controls.children[0];
      if (collapseBtn) collapseBtn.classList.add("notes-section-btn--collapse");

      const editor = document.createElement("div");
      editor.className = "notes-section-editor";
      editor.contentEditable = "true";
      editor.dataset.sectionId = section.id;
      editor.innerHTML = section.html || "";
      editor.setAttribute("aria-label", `${section.title} content`);

      titleInput.addEventListener("input", () => saveSectionFromDom(section.id, titleInput, editor));
      editor.addEventListener("input", () => saveSectionFromDom(section.id, titleInput, editor));
      editor.addEventListener("focus", () => {
        activeNotesEditable = editor;
      });

      controls.addEventListener("click", (event) => {
        const action = event.target.closest("button")?.dataset.action;
        if (!action) return;
        if (action === "collapse") toggleSectionCollapse(section.id);
        if (action === "up") moveSection(section.id, "up");
        if (action === "down") moveSection(section.id, "down");
        if (action === "delete") deleteSection(section.id);
      });

      card.addEventListener("dragstart", (event) => {
        event.dataTransfer?.setData("text/plain", section.id);
      });
      card.addEventListener("dragover", (event) => event.preventDefault());
      card.addEventListener("drop", (event) => {
        event.preventDefault();
        reorderSections(event.dataTransfer?.getData("text/plain") || "", section.id);
      });

      head.append(titleInput, controls);
      card.append(head, editor);
      fragment.appendChild(card);
    });

    notesSectionsList.appendChild(fragment);
    updateNotesWordCount();
  };

  const createNewNotesSection = () => {
    const problem = getActiveLcProblem();
    if (!problem) return;
    problem.notes.push({
      id: randomId("nsec"),
      title: `Section ${problem.notes.length + 1}`,
      html: "",
      collapsed: false
    });
    persistLcState();
    renderNotesSections();
  };

  const moveSection = (sectionId, direction) => {
    const problem = getActiveLcProblem();
    if (!problem) return;
    const index = problem.notes.findIndex((section) => section.id === sectionId);
    const targetIndex = direction === "up" ? index - 1 : index + 1;
    if (index < 0 || targetIndex < 0 || targetIndex >= problem.notes.length) return;

    const [moved] = problem.notes.splice(index, 1);
    problem.notes.splice(targetIndex, 0, moved);
    persistLcState();
    renderNotesSections();
  };

  const toggleSectionCollapse = (sectionId) => {
    const problem = getActiveLcProblem();
    if (!problem) return;
    const section = problem.notes.find((entry) => entry.id === sectionId);
    if (!section) return;
    section.collapsed = !section.collapsed;
    persistLcState();
    renderNotesSections();
  };

  const deleteSection = (sectionId) => {
    const problem = getActiveLcProblem();
    if (!problem) return;
    if (problem.notes.length <= 1) {
      showLabToast("A problem needs at least one note section.");
      return;
    }
    problem.notes = problem.notes.filter((entry) => entry.id !== sectionId);
    persistLcState();
    renderNotesSections();
  };

  const reorderSections = (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    const problem = getActiveLcProblem();
    if (!problem) return;
    const fromIndex = problem.notes.findIndex((section) => section.id === fromId);
    const toIndex = problem.notes.findIndex((section) => section.id === toId);
    if (fromIndex < 0 || toIndex < 0) return;

    const [moved] = problem.notes.splice(fromIndex, 1);
    problem.notes.splice(toIndex, 0, moved);
    persistLcState();
    renderNotesSections();
  };

  const applyNotesCommand = (command, value = null) => {
    if (!activeNotesEditable || !activeNotesEditable.isConnected) {
      activeNotesEditable = notesSectionsList.querySelector(".notes-section-editor");
    }
    if (!activeNotesEditable) return;

    activeNotesEditable.focus();
    try {
      document.execCommand(command, false, value);
    } catch {
      // command unsupported
    }
    const sectionId = activeNotesEditable.dataset.sectionId || "";
    const titleInput = activeNotesEditable.closest(".notes-section-card")?.querySelector(".notes-section-title");
    saveSectionFromDom(sectionId, titleInput, activeNotesEditable);
  };

  const handleNotesToolbarClick = (event) => {
    const button = event.target.closest("button[data-cmd]");
    if (!button) return;
    applyNotesCommand(button.dataset.cmd);
  };

  const toggleFindReplace = () => {
    notesFindReplace.hidden = !notesFindReplace.hidden;
    if (!notesFindReplace.hidden) notesFindInput.focus();
  };

  const findNext = () => {
    const query = notesFindInput.value.trim();
    if (!query) return;
    if (!activeNotesEditable || !activeNotesEditable.isConnected) {
      activeNotesEditable = notesSectionsList.querySelector(".notes-section-editor");
    }
    if (!activeNotesEditable) return;
    activeNotesEditable.focus();
    try {
      if (typeof window.find !== "function") throw new Error("unsupported");
      window.find(query, false, false, true, false, false, false);
    } catch {
      /* Android WebView has no window.find — pop a toast, never an alert. */
      showLabToast("Find is not supported here. Use your keyboard's Ctrl+F.");
    }
  };

  const replaceCurrent = () => {
    const query = notesFindInput.value;
    if (!query) return;
    const replacement = notesReplaceInput.value;

    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return;

    if (String(selection.toString()) !== query) {
      findNext();
      return;
    }

    document.execCommand("insertText", false, replacement);
    const sectionId = activeNotesEditable?.dataset.sectionId || "";
    const titleInput = activeNotesEditable?.closest(".notes-section-card")?.querySelector(".notes-section-title");
    saveSectionFromDom(sectionId, titleInput, activeNotesEditable);
  };

  const replaceAll = () => {
    const query = notesFindInput.value;
    if (!query) return;
    const replacement = notesReplaceInput.value;
    const problem = getActiveLcProblem();
    if (!problem) return;

    problem.notes.forEach((section) => {
      const holder = document.createElement("div");
      holder.innerHTML = section.html || "";
      const text = holder.textContent || "";
      section.html = escapeHtml(text.split(query).join(replacement)).replace(/\n/g, "<br>");
    });

    persistLcState();
    renderNotesSections();
  };

  const getProblemExportHtml = () => {
    const problem = getActiveLcProblem();
    if (!problem) return "";
    const sectionsHtml = problem.notes
      .map((section) => `<section><h3>${escapeHtml(section.title)}</h3><div>${section.html || ""}</div></section>`)
      .join("\n");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(problem.name)}</title></head><body><h1>${escapeHtml(problem.name)}</h1><p><a href="${escapeHtml(problem.url)}">${escapeHtml(problem.url)}</a> · ${escapeHtml(problem.difficulty)}</p>${sectionsHtml}</body></html>`;
  };

  const sanitizeNotesFileName = (value, ext = ".html") => {
    const base = String(value || "Notes").trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, "_") || "Notes";
    return `${base}${ext}`;
  };

  const saveNotesTopicToWorkspace = async () => {
    const problem = getActiveLcProblem();
    if (!problem) {
      showLabToast("Open a problem first, then save its notes.");
      return;
    }

    const fileName = sanitizeNotesFileName(`${problem.num ? problem.num + "_" : ""}${problem.name}`, ".html");
    const content = getProblemExportHtml();

    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle =
          notesFileHandles.get(problem.id) ||
          (await window.showSaveFilePicker({
            suggestedName: fileName,
            types: [{ description: "HTML Document", accept: { "text/html": [".html"], "text/plain": [".txt"] } }]
          }));
        const writable = await handle.createWritable();
        await writable.write(content);
        await writable.close();
        notesFileHandles.set(problem.id, handle);
        return;
      } catch (error) {
        if (error && error.name === "AbortError") return;
      }
    }

    downloadBlob(fileName, new Blob([content], { type: "text/html;charset=utf-8" }));
  };

  const exportNotesTxt = () => {
    const problem = getActiveLcProblem();
    if (!problem) {
      showLabToast("Open a problem first, then export its notes.");
      return;
    }
    const body = problem.notes
      .map((section) => {
        const holder = document.createElement("div");
        holder.innerHTML = section.html || "";
        return `${section.title}\n${holder.textContent || ""}`;
      })
      .join("\n\n");
    downloadBlob(
      sanitizeNotesFileName(`${problem.num ? problem.num + "_" : ""}${problem.name}`, ".txt"),
      new Blob([`${problem.name}\n${problem.url}\n\n${body}`], { type: "text/plain;charset=utf-8" })
    );
  };

  /* ------------------- personal notes (language notepad) ------------------ */

  const NP_STATE_KEY = "quantaPersonalNotesV1";
  const NP_LANG_KEY = "quantaPersonalNotesLang";
  const npLangTabsWrap = byId("np-language-tabs");
  const npNewBtn = byId("np-new-note-btn");
  const npSearchInput = byId("np-search-input");
  const npNoteList = byId("np-note-list");
  const npEmpty = byId("np-empty");
  const npPlaceholder = byId("np-placeholder");
  const npEditor = byId("np-editor");
  const npNoteTitle = byId("np-note-title");
  const npNoteEditor = byId("np-note-editor");
  const npDeleteBtn = byId("np-delete-note-btn");
  const npWordCount = byId("np-word-count");
  const npSaveBtn = byId("np-save-btn");
  const npExportTxtBtn = byId("np-export-txt-btn");

  const defaultNpState = () => ({
    languages: {},
    activeLanguage: DEFAULT_LANGUAGE,
    activeNoteId: {}
  });

  const normalizeNpState = () => {
    const raw = readJson(NP_STATE_KEY, defaultNpState);
    const state = defaultNpState();
    state.activeLanguage = LANGUAGE_IDS.has(raw.activeLanguage) ? raw.activeLanguage : DEFAULT_LANGUAGE;
    LANGUAGE_IDS.forEach((lang) => {
      const list = Array.isArray(raw.languages?.[lang]) ? raw.languages[lang] : [];
      state.languages[lang] = list
        .filter((note) => note && typeof note === "object")
        .map((note) => ({
          id: String(note.id || randomId("np")),
          title: String(note.title || "Untitled").trim() || "Untitled",
          html: typeof note.html === "string" ? note.html : "",
          updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : new Date().toISOString()
        }));
      const savedActive = raw.activeNoteId?.[lang];
      if (typeof savedActive === "string" && state.languages[lang].some((n) => n.id === savedActive)) {
        state.activeNoteId[lang] = savedActive;
      }
    });
    return state;
  };

  const npState = normalizeNpState();

  const persistNpState = () => writeJson(NP_STATE_KEY, npState);

  let npActiveLanguage = (() => {
    try {
      const saved = localStorage.getItem(NP_LANG_KEY);
      return LANGUAGE_IDS.has(saved) ? saved : npState.activeLanguage;
    } catch {
      return npState.activeLanguage;
    }
  })();

  const npNotesFor = (lang) => npState.languages[lang] || (npState.languages[lang] = []);
  const npActiveNote = () => {
    const list = npNotesFor(npActiveLanguage);
    const activeId = npState.activeNoteId[npActiveLanguage];
    return list.find((note) => note.id === activeId) || null;
  };

  const npLangLabel = (lang) => getLanguageDef(lang).label;

  const npFindDuplicateTitle = (list, title, ignoreId = "") =>
    list.find(
      (note) => note.id !== ignoreId && (note.title || "").trim().toLowerCase() === String(title || "").trim().toLowerCase()
    ) || null;

  const renderNpLangTabs = () => {
    npLangTabsWrap.querySelectorAll(".np-lang-tab").forEach((tab) => {
      const isActive = tab.dataset.lang === npActiveLanguage;
      tab.classList.toggle("is-active", isActive);
      tab.setAttribute("aria-selected", String(isActive));
    });
  };

  const renderNpList = () => {
    npNoteList.innerHTML = "";
    const query = (npSearchInput.value || "").trim().toLowerCase();
    const notes = npNotesFor(npActiveLanguage);
    const visible = query
      ? notes.filter((note) => {
          const holder = document.createElement("div");
          holder.innerHTML = note.html || "";
          const text = (holder.textContent || "").toLowerCase();
          return note.title.toLowerCase().includes(query) || text.includes(query);
        })
      : notes;

    if (!visible.length) {
      npEmpty.hidden = false;
      npEmpty.textContent = query
        ? `No ${npLangLabel(npActiveLanguage)} notes match your search.`
        : `No ${npLangLabel(npActiveLanguage)} notes yet. Create your first one.`;
    } else {
      npEmpty.hidden = true;
    }

    const fragment = document.createDocumentFragment();
    const activeId = npState.activeNoteId[npActiveLanguage];
    visible.forEach((note) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = `np-note-row${note.id === activeId ? " is-active" : ""}`;
      row.dataset.noteId = note.id;
      row.setAttribute("role", "listitem");

      const title = document.createElement("span");
      title.className = "np-note-row__title";
      title.textContent = note.title;

      const date = document.createElement("span");
      date.className = "np-note-row__date";
      const parsed = new Date(note.updatedAt);
      date.textContent = Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleDateString();

      row.append(title, date);
      fragment.appendChild(row);
    });
    npNoteList.appendChild(fragment);
  };

  let npSaveTimer = 0;

  const saveNpFromDom = () => {
    const note = npActiveNote();
    if (!note) return false;
    const nextTitle = (npNoteTitle.value || "").trim() || "Untitled";
    const duplicate = npFindDuplicateTitle(npNotesFor(npActiveLanguage), nextTitle, note.id);
    if (duplicate) {
      showLabToast("A note with this name already exists. Please choose a different name.");
      npNoteTitle.value = note.title;
      updateNpWordCount();
      return false;
    }
    note.title = nextTitle;
    note.html = npNoteEditor.innerHTML || "";
    note.updatedAt = new Date().toISOString();
    updateNpWordCount();
    persistNpState();
    return true;
  };

  const updateNpWordCount = () => {
    const note = npActiveNote();
    if (!note) {
      npWordCount.textContent = "0 words · 0 chars";
      return;
    }
    let text;
    if (!npEditor.hidden) {
      text = npNoteEditor.textContent || "";
    } else {
      const holder = document.createElement("div");
      holder.innerHTML = note.html || "";
      text = holder.textContent || "";
    }
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    npWordCount.textContent = `${words} words · ${text.length} chars`;
  };

  const renderNpEditor = () => {
    const note = npActiveNote();
    if (!note) {
      npPlaceholder.hidden = false;
      npEditor.hidden = true;
      return;
    }
    npPlaceholder.hidden = true;
    npEditor.hidden = false;
    npNoteTitle.value = note.title;
    npNoteEditor.innerHTML = note.html || "";
    updateNpWordCount();
  };

  const renderPersonalNotes = () => {
    renderNpLangTabs();
    renderNpList();
    renderNpEditor();
  };

  const selectNpNote = (noteId) => {
    npState.activeNoteId[npActiveLanguage] = noteId;
    persistNpState();
    renderNpList();
    renderNpEditor();
  };

  const createNpNote = () => {
    const list = npNotesFor(npActiveLanguage);
    const title = `New ${npLangLabel(npActiveLanguage)} note`;
    if (npFindDuplicateTitle(list, title)) {
      showLabToast("A note with this name already exists. Please choose a different name.");
      return;
    }
    const note = {
      id: randomId("np"),
      title,
      html: "",
      updatedAt: new Date().toISOString()
    };
    list.unshift(note);
    npState.activeNoteId[npActiveLanguage] = note.id;
    persistNpState();
    renderNpList();
    renderNpEditor();
    npNoteTitle.focus();
    npNoteTitle.select();
  };

  const deleteNpActiveNote = () => {
    const note = npActiveNote();
    if (!note) {
      showLabToast("Select a note first, then delete it.");
      return;
    }
    if (!window.confirm(`Delete note "${note.title}"? This cannot be undone.`)) return;
    const list = npNotesFor(npActiveLanguage);
    const index = list.findIndex((entry) => entry.id === note.id);
    list.splice(index, 1);
    const next = list[index] || list[index - 1] || null;
    if (next) npState.activeNoteId[npActiveLanguage] = next.id;
    else delete npState.activeNoteId[npActiveLanguage];
    persistNpState();
    renderNpList();
    renderNpEditor();
  };

  npLangTabsWrap?.addEventListener("click", (event) => {
    const tab = event.target.closest(".np-lang-tab");
    if (!tab) return;
    npActiveLanguage = normalizeLanguage(tab.dataset.lang);
    npState.activeLanguage = npActiveLanguage;
    try {
      localStorage.setItem(NP_LANG_KEY, npActiveLanguage);
    } catch {}
    persistNpState();
    renderPersonalNotes();
  });

  npNewBtn?.addEventListener("click", createNpNote);
  npDeleteBtn?.addEventListener("click", deleteNpActiveNote);
  npSearchInput?.addEventListener("input", renderNpList);

  npNoteList?.addEventListener("click", (event) => {
    const row = event.target.closest(".np-note-row");
    if (!row) return;
    selectNpNote(row.dataset.noteId || "");
  });

  npNoteTitle?.addEventListener("input", () => {
    window.clearTimeout(npSaveTimer);
    npSaveTimer = window.setTimeout(saveNpFromDom, 400);
  });

  npNoteEditor?.addEventListener("input", () => {
    window.clearTimeout(npSaveTimer);
    npSaveTimer = window.setTimeout(saveNpFromDom, 400);
  });

  const npExportHtml = () => {
    const note = npActiveNote();
    if (!note) return "";
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(note.title)}</title></head><body><h1>${escapeHtml(note.title)}</h1><p>${escapeHtml(npLangLabel(npActiveLanguage))} notes</p><div>${note.html || ""}</div></body></html>`;
  };

  npSaveBtn?.addEventListener("click", () => {
    const note = npActiveNote();
    if (!note) {
      showLabToast("Select a note first.");
      return;
    }
    if (!saveNpFromDom()) return; // duplicate/empty — warning already shown
    persistNpState();
    showLabToast("Note saved to this device");
  });

  const npExportHtmlBtn = byId("np-export-html-btn");
  npExportHtmlBtn?.addEventListener("click", () => {
    const note = npActiveNote();
    if (!note) {
      showLabToast("Select a note first.");
      return;
    }
    if (!saveNpFromDom()) return; // don't export a note whose save failed
    downloadBlob(
      sanitizeNotesFileName(note.title, ".html"),
      new Blob([npExportHtml()], { type: "text/html;charset=utf-8" })
    );
  });

  npExportTxtBtn?.addEventListener("click", () => {
    const note = npActiveNote();
    if (!note) {
      showLabToast("Select a note first.");
      return;
    }
    if (!saveNpFromDom()) return; // don't export a note whose save failed
    const holder = document.createElement("div");
    holder.innerHTML = note.html || "";
    downloadBlob(
      sanitizeNotesFileName(note.title, ".txt"),
      new Blob([`${note.title}\n\n${holder.textContent || ""}`], { type: "text/plain;charset=utf-8" })
    );
  });

  /* ------------------------------ keyboard ------------------------------ */

  const handleGlobalKeys = (event) => {
    if (event.key === "Escape" && currentPage === "quantalab" && lcLayout.classList.contains("show-detail")) {
      event.preventDefault();
      backToLcList();
      return;
    }
    if (event.key === "Escape" && currentPage === "quantalab" && document.body.classList.contains("lc-detail-maximized")) {
      event.preventDefault();
      setLcDetailMaximized(false);
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && currentPage === "lab") {
      event.preventDefault();
      void runActiveSession();
      return;
    }
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && currentPage === "quantalab" && !qlViewCode.hidden) {
      event.preventDefault();
      void runQlCode();
    }
  };

  /* ------------------------------ bindings ------------------------------ */

  labSaveBtn.addEventListener("click", () => void saveActiveSessionToFile());
  labCreateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    createSessionFromForm();
  });

  labNewProgramBtn.addEventListener("click", () => {
    labProgramNameInput.value = "";
    labLanguageSelect.value = labState.defaultLanguage || DEFAULT_LANGUAGE;
    labProgramNameInput.focus();
  });

  labRenameBtn.addEventListener("click", renameActiveSession);
  labDeleteBtn.addEventListener("click", deleteActiveSession);
  /* labRunBtn IS #run-output-btn (line 61); attaching here once avoids two
     identical listeners firing on the same click. */
  labRunBtn.addEventListener("click", () => void runActiveSession());
  byId("run-mobile-btn")?.addEventListener("click", () => void runActiveSession());
  labZoomOutBtn.addEventListener("click", () => setEditorZoom(-1));
  labZoomInBtn.addEventListener("click", () => setEditorZoom(1));

  labAutoSaveToggle.addEventListener("change", (event) => {
    labState.autoSave = event.target.checked;
    persistLabState(true);
  });

  // Diagnostics toggle was removed from the Lab toolbar; keep the feature
  // controllable from Settings only.

  labTabs.addEventListener("click", (event) => {
    const close = event.target.closest("[data-close-id]");
    if (close) {
      const sessionId = close.dataset.closeId;
      if (sessionId === labState.activeSessionId) {
        deleteActiveSession();
      } else {
        removeSession(sessionId);
        renderTabs();
      }
      return;
    }
    const tab = event.target.closest("button[data-session-id]");
    if (tab) activateSession(tab.dataset.sessionId || "");
  });

  labTabs.addEventListener("dragstart", (event) => {
    const tab = event.target.closest("button[data-session-id]");
    if (!tab) return;
    event.dataTransfer?.setData("text/plain", tab.dataset.sessionId || "");
  });
  labTabs.addEventListener("dragover", (event) => event.preventDefault());
  labTabs.addEventListener("drop", (event) => {
    event.preventDefault();
    const tab = event.target.closest("button[data-session-id]");
    if (!tab) return;
    reorderSessions(event.dataTransfer?.getData("text/plain") || "", tab.dataset.sessionId || "");
  });

  if (labStdinToggle && labStdin) {
    labStdinToggle.addEventListener("change", () => {
      labStdin.hidden = !labStdinToggle.checked;
    });
  }

  if (labMobileEditorTab && labMobileOutputTab && labMobileSwitch && labLayout) {
    selectMobileView = (view) => {
      labMobileEditorTab.classList.toggle("is-active", view === "editor");
      labMobileOutputTab.classList.toggle("is-active", view === "output");
      labMobileEditorTab.setAttribute("aria-selected", String(view === "editor"));
      labMobileOutputTab.setAttribute("aria-selected", String(view === "output"));
      labLayout.classList.toggle("show-output", view === "output");
      if (view === "editor") relayoutMonacoEditors();
    };
    labMobileEditorTab.addEventListener("click", () => selectMobileView("editor"));
    labMobileOutputTab.addEventListener("click", () => selectMobileView("output"));
  }

  const themeToggle = byId("theme-toggle-input");
  if (themeToggle) {
    themeToggle.addEventListener("change", () =>
      window.setTimeout(() => {
        // Re-resolve the editor theme without losing per-language theming.
        if (labState.languageThemes !== false && currentPage === "lab" && getActiveSession()) {
          applyLanguageTheme(getActiveSession().language);
        } else if (labState.languageThemes !== false && currentPage === "quantalab" && !qlViewCode.hidden) {
          void renderQlCodeView();
        } else {
          syncMonacoTheme();
        }
      }, 0)
    );
  }

  notesAddTopicBtn.addEventListener("click", addLcProblemFromInput);

  notesToolbar.addEventListener("click", handleNotesToolbarClick);
  notesColorInput.addEventListener("input", (event) => applyNotesCommand("foreColor", event.target.value));
  notesHighlightInput.addEventListener("input", (event) => applyNotesCommand("hiliteColor", event.target.value));
  notesHeadingSelect.addEventListener("change", (event) => applyNotesCommand("formatBlock", event.target.value));
  notesFontSizeSelect.addEventListener("change", (event) => applyNotesCommand("fontSize", event.target.value));

  notesInsertLinkBtn.addEventListener("click", () => {
    const url = window.prompt("Link URL:");
    if (!url) return;
    applyNotesCommand("createLink", url);
  });

  notesInsertCodeBtn.addEventListener("click", () => {
    applyNotesCommand("insertHTML", "<pre><code>// code</code></pre><p></p>");
  });

  if (notesInsertTableBtn) {
    notesInsertTableBtn.addEventListener("click", () => {
      applyNotesCommand(
        "insertHTML",
        '<table border="1" style="border-collapse:collapse;width:100%"><tr><th>Column 1</th><th>Column 2</th></tr><tr><td>Value</td><td>Value</td></tr></table><p></p>'
      );
    });
  }

  notesFindReplaceToggleBtn.addEventListener("click", toggleFindReplace);
  notesFindNextBtn.addEventListener("click", findNext);
  notesReplaceBtn.addEventListener("click", replaceCurrent);
  notesReplaceAllBtn.addEventListener("click", replaceAll);

  notesAddSectionBtn.addEventListener("click", createNewNotesSection);
  notesSaveBtn.addEventListener("click", () => {
    const problem = getActiveLcProblem();
    if (!problem) {
      showLabToast("Open a problem first, then save its notes.");
      return;
    }
    persistLcState();
    showLabToast("Notes saved on this device");
  });
  notesExportTxtBtn.addEventListener("click", exportNotesTxt);

  const notesExportHtmlBtn = byId("notes-export-html-btn");
  notesExportHtmlBtn?.addEventListener("click", () => void saveNotesTopicToWorkspace());

  /* --------------------------- settings events -------------------------- */

  /* Settings and About are full pages now — no modal wiring needed. */

  dialogHomeBtns.forEach((dialogHomeBtn) => {
    dialogHomeBtn?.addEventListener("click", goHome);
  });

  const selectThemeFromSettings = (theme) => {
    document.body.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("leetcodeDashboardTheme", theme);
    } catch {
      /* private mode */
    }
    const mainToggle = byId("theme-toggle-input");
    if (mainToggle) mainToggle.checked = theme === "beige";
    syncSettingsUi();
    if (labState.languageThemes !== false && (currentPage === "lab" || currentPage === "quantalab")) {
      if (currentPage === "lab" && getActiveSession()) applyLanguageTheme(getActiveSession().language);
      else void renderQlCodeView();
    } else {
      syncMonacoTheme();
    }
  };

  settingsThemeDarkBtn?.addEventListener("click", () => selectThemeFromSettings("dark"));
  settingsThemeBeigeBtn?.addEventListener("click", () => selectThemeFromSettings("beige"));
  settingsThemeEmberBtn?.addEventListener("click", () => selectThemeFromSettings("ember"));

  settingsGlowToggle?.addEventListener("change", (event) => applyGlowPreference(event.target.checked));

  settingsAutosaveToggle?.addEventListener("change", (event) => {
    labState.autoSave = event.target.checked;
    const labToggle = byId("java-auto-save-toggle");
    if (labToggle) labToggle.checked = event.target.checked;
    persistLabState(true);
  });

  settingsDiagnosticsToggle?.addEventListener("change", (event) => {
    labState.inlineExplain = event.target.checked;
    const labToggle = byId("java-inline-explain-toggle");
    if (labToggle) labToggle.checked = event.target.checked;
    if (event.target.checked) {
      runDiagnostics();
    } else if (window.monaco?.editor && labEditor?.getModel()) {
      window.monaco.editor.setModelMarkers(labEditor.getModel(), "leetcode-lab", []);
    }
    persistLabState(true);
  });

  const nudgeFontSize = (delta) => {
    setEditorZoom(delta);
    if (settingsFontSizeValue) settingsFontSizeValue.textContent = `${labState.editorFontSize} px`;
  };

  settingsFontDecreaseBtn?.addEventListener("click", () => nudgeFontSize(-1));
  settingsFontIncreaseBtn?.addEventListener("click", () => nudgeFontSize(1));

  settingsDefaultLanguageSelect?.addEventListener("change", (event) => {
    labState.defaultLanguage = normalizeLanguage(event.target.value);
    persistLabState(true);
  });

  settingsTabSizeSelect?.addEventListener("change", (event) => {
    labState.tabSize = [2, 4, 8].includes(Number(event.target.value)) ? Number(event.target.value) : 4;
    labEditor?.updateOptions({ tabSize: labState.tabSize });
    labState.sessions.forEach((session) => {
      const model = labModels.get(session.id);
      if (model) model.updateOptions({ tabSize: labState.tabSize });
    });
    persistLabState(true);
  });

  settingsWordWrapToggle?.addEventListener("change", (event) => {
    labState.wordWrap = event.target.checked;
    labEditor?.updateOptions({ wordWrap: event.target.checked ? "on" : "off" });
    persistLabState(true);
  });

  settingsLineNumbersToggle?.addEventListener("change", (event) => {
    labState.lineNumbers = event.target.checked;
    labEditor?.updateOptions({ lineNumbers: event.target.checked ? "on" : "off" });
    persistLabState(true);
  });

  settingsEditorThemeSelect?.addEventListener("change", (event) => {
    labState.editorTheme = event.target.value;
    syncMonacoTheme();
    persistLabState(true);
  });

  settingsMinimapToggle?.addEventListener("change", (event) => {
    labState.showMinimap = event.target.checked;
    const enabled = labState.showMinimap && window.matchMedia("(min-width: 1024px)").matches;
    labEditor?.updateOptions({ minimap: { enabled } });
    persistLabState(true);
  });

  /* Reset every draggable divider back to its default split — the same
     cleanup a double-click on a divider performs, for all four at once. */
  settingsLayoutResetBtn?.addEventListener("click", () => {
    try {
      localStorage.removeItem(qlSplits.store);
      localStorage.removeItem("quantaSplitSizesV1");
    } catch {}
    qlSplits.read();
    qlSplits.handles.forEach((spec) => {
      if (!spec.el) return;
      spec.layout()?.style.removeProperty(spec.mode === "x" ? "--split-a" : "--split-row-a");
      spec.el.style.removeProperty("left");
    });
    qlSplits.write();
    document.querySelector(".ql-code-split")?.style.removeProperty("--split-a");
    syncDescDividerOverlay();
    relayoutMonacoEditors();
    showLabToast("Workspace layout reset to defaults");
  });

  const updateAboutStats = () => {
    const set = (id, value) => {
      const node = byId(id);
      if (node) node.textContent = String(value);
    };
    const problems = readJson(LC_STATE_KEY, () => ({}));
    const problemList = Array.isArray(problems.problems) ? problems.problems : [];
    const solved = problemList.filter((item) =>
      item && typeof item === "object" &&
      (item.solved === true || (item.langSolved && typeof item.langSolved === "object" && Object.values(item.langSolved).some(Boolean)))
    ).length;
    const lab = readJson(JAVA_STATE_KEY, () => ({}));
    const programCount = Array.isArray(lab.sessions) ? lab.sessions.length : 0;
    const starred = problemList.filter((item) => item && typeof item === "object" && item.bookmarked === true).length;
    const personal = readJson(NP_STATE_KEY, () => ({}));
    let noteCount = 0;
    if (personal.languages && typeof personal.languages === "object") {
      Object.values(personal.languages).forEach((list) => {
        if (Array.isArray(list)) noteCount += list.length;
      });
    }
    set("about-stat-problems", problemList.length);
    set("about-stat-solved", solved);
    set("about-stat-starred", starred);
    set("about-stat-programs", programCount);
    set("about-stat-notes", noteCount);
  };

  const formatStorageBytes = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  /* Real localStorage usage — measured, never a placeholder. */
  const updateAboutStorage = () => {
    const node = byId("about-storage-usage");
    if (!node) return;
    try {
      let bytes = 0;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || "";
        bytes += (key.length + (localStorage.getItem(key) || "").length) * 2;
      }
      node.textContent = `${formatStorageBytes(bytes)} used`;
      node.title = `${localStorage.length} items in localStorage on this device`;
    } catch {
      node.textContent = "Unavailable";
      node.title = "Browser storage cannot be read";
    }
  };

  /* Where statements actually come from: the bundle shipped with the app plus
     whatever has been cached on this device. Loading the bundle here also
     primes it, so statements keep working with no network afterwards. */
  const updateAboutStatements = async () => {
    const node = byId("about-statements-source");
    if (!node) return;
    const cached = readDescCache().size;
    const pack = await loadOfflinePack();
    const bundled = pack ? Object.keys(pack).length : 0;
    if (bundled) {
      node.textContent = `${bundled} bundled · ${cached} saved`;
      node.title = "Bundled = offline pack shipped with the app; saved = cached on this device";
    } else if (cached) {
      node.textContent = `${cached} saved on this device`;
      node.title = "The offline bundle could not load right now — showing the device cache only";
    } else {
      node.textContent = "None cached yet";
      node.title = "Statements load from the online database and are saved on this device";
    }
  };

  /* Checked against the API's /health endpoint every time About opens, so
     this box never claims a database connection that was not verified. */
  const refreshAboutDatabase = async () => {
    const node = byId("about-db-status");
    if (!node) return;
    const base = getApiBase();
    node.textContent = "Checking…";
    const startedAt = Date.now();
    const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
    try {
      const response = await fetch(`${base}/health`, {
        cache: "no-store",
        signal: hasTimeout ? AbortSignal.timeout(8000) : undefined
      });
      if (!response.ok) throw new Error("bad status");
      const payload = await response.json();
      if (!payload || payload.ok !== true) throw new Error("unexpected payload");
      const elapsed = Date.now() - startedAt;
      const db = payload.database;
      node.title = `${base || window.location.origin} · checked at ${new Date().toLocaleTimeString()}`;
      if (db && db.ok === true) {
        node.textContent = `Connected · ${elapsed} ms`;
      } else if (db && db.configured === false) {
        node.textContent = "API online · database not configured";
      } else {
        node.textContent = "API online · database unreachable";
      }
    } catch {
      node.title = base;
      node.textContent = "Could not verify right now";
    }
  };

  const refreshAboutInfo = () => {
    updateAboutStats();
    updateAboutStorage();
    void updateAboutStatements();
    void refreshAboutDatabase();
  };

  const settingsRunServerInput = byId("settings-run-server");
  const settingsRunServerSave = byId("settings-run-server-save");
  const settingsRunServerTest = byId("settings-run-server-test");

  /* About page actions: refresh the live info, jump back to the workspace. */
  byId("about-refresh-stats")?.addEventListener("click", () => {
    refreshAboutInfo();
    showLabToast("About info refreshed");
  });
  byId("about-open-quantalab")?.addEventListener("click", goHome);

  const applyRunServerUrl = (value) => {
    const trimmed = String(value || "").trim().replace(/\/+$/, "");
    try {
      if (trimmed) localStorage.setItem(RUN_SERVER_KEY, trimmed);
      else localStorage.removeItem(RUN_SERVER_KEY);
    } catch {}
    runCapabilities = null;
    runServerUnreachable = false;
    const label = trimmed || "app host";
    showLabToast(`Compiler server: ${label}`);
  };

  if (settingsRunServerInput) {
    settingsRunServerInput.value = getRunServerBase();
  }
  settingsRunServerSave?.addEventListener("click", () => {
    const value = settingsRunServerInput.value.trim();
    if (value && !/^https?:\/\//i.test(value)) {
      showLabToast("Address must start with http:// or https://");
      return;
    }
    applyRunServerUrl(value);
  });
  settingsRunServerTest?.addEventListener("click", async () => {
    const value = settingsRunServerInput.value.trim().replace(/\/+$/, "");
    if (value && !/^https?:\/\//i.test(value)) {
      showLabToast("Address must start with http:// or https://");
      return;
    }
    try {
      const response = await fetch(`${value}/api/run/capabilities`, { cache: "no-store" });
      if (!response.ok) throw new Error("bad status");
      const caps = await response.json();
      const usable = Object.entries(caps).filter(([, v]) => v && v !== false).map(([k]) => k);
      showLabToast(`Connected — ${usable.join(", ")}`);
    } catch {
      showLabToast("Could not reach that server");
    }
  });

  /* ---------------------- online API (problem database) ------------------ */
  const settingsApiBaseInput = byId("settings-api-base");
  const settingsApiBaseSave = byId("settings-api-base-save");
  const settingsApiBaseTest = byId("settings-api-base-test");

  if (settingsApiBaseInput) settingsApiBaseInput.value = getConfiguredApiBase();

  settingsApiBaseSave?.addEventListener("click", () => {
    const value = stripTrailingSlash(settingsApiBaseInput.value);
    if (value && !/^https?:\/\//i.test(value)) {
      showLabToast("Address must start with http:// or https://");
      return;
    }
    try {
      if (value) localStorage.setItem(API_BASE_KEY, value);
      else localStorage.removeItem(API_BASE_KEY);
    } catch {
      /* private mode */
    }
    settingsApiBaseInput.value = value;
    showLabToast(`Online API: ${value || "this app's server"}`);
  });

  settingsApiBaseTest?.addEventListener("click", async () => {
    const configured = stripTrailingSlash(settingsApiBaseInput.value);
    if (configured && !/^https?:\/\//i.test(configured)) {
      showLabToast("Address must start with http:// or https://");
      return;
    }
    const base = configured || getApiBase();
    const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
    try {
      const response = await fetch(`${base}/health`, {
        cache: "no-store",
        signal: hasTimeout ? AbortSignal.timeout(8000) : undefined
      });
      if (!response.ok) throw new Error("bad status");
      const payload = await response.json();
      if (!payload?.ok) throw new Error("unexpected payload");
      const dbState = payload.database?.ok ? "database OK" : "database unreachable";
      showLabToast(`API online — ${dbState}`);
    } catch {
      showLabToast("Could not reach that API");
    }
  });

  settingsExportBtn?.addEventListener("click", () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      problems: readJson("leetcodeDashboardProblems", () => ({})),
      goal: readJson("leetcodeDashboardWeeklyGoal", () => null),
      lab: readJson(JAVA_STATE_KEY, () => null),
      leetcode: readJson(LC_STATE_KEY, () => null)
    };
    downloadBlob(
      `leetcode-dashboard-backup-${new Date().toISOString().slice(0, 10)}.json`,
      new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    );
  });

  settingsResetBtn?.addEventListener("click", () => {
    if (!window.confirm("Delete ALL problems, notes and programs? This cannot be undone.")) return;
    try {
      localStorage.clear();
    } catch {
      /* private mode */
    }
    window.location.reload();
  });

  document.addEventListener("keydown", handleGlobalKeys);

  /* --------------------- draggable box dividers (v17) --------------------- */
  /* Mouse + touch drag on the thin dividers between boxes. Sizes persist in
     localStorage and are restored on load. Percentages keep the layout
     responsive and guarantee minimum sizes so no box can vanish. */

  const qlSplits = {
    /* V2: V1 stored the clamped DISPLAY value on every restore, so a layout
       applied while the track was transiently short (mobile URL bar, keyboard,
       a snapped window, a hidden tab) permanently narrowed the saved size —
       the panes ratcheted smaller on every visit and could never grow back. */
    store: "quantaSplitSizesV2",
    values: {},
    handles: [
      /* Quanta Lab problem detail: description | workspace width. */
      {
        el: byId("ql-desc-resizer"),
        mode: "x",
        key: "qlDescW",
        layout: () => byId("ql-problem-desc")?.parentElement,
        start: () => byId("ql-problem-desc"),
        minStart: 220,
        minEnd: 380,
        trackExtra: 12
      },
      /* Quanta Lab page: problem list | detail width. */
      {
        el: byId("lc-list-resizer"),
        mode: "x",
        key: "lcListW",
        layout: () => lcLayout,
        start: () => lcLayout?.querySelector(".lc-list-pane"),
        minStart: 240,
        minEnd: 460,
        trackExtra: 34
      },
      /* Lab page: editor | output width. */
      {
        el: byId("lab-col-resizer"),
        mode: "x",
        key: "labColW",
        layout: () => labLayout,
        start: () => byId("java-editor-pane"),
        minStart: 240,
        minEnd: 240,
        trackExtra: 34
      },
      /* Lab page (narrow screens): editor | output height. */
      {
        el: byId("lab-row-resizer"),
        mode: "y",
        key: "labRowH",
        layout: () => labLayout,
        start: () => byId("java-editor-pane"),
        minStart: 160,
        minEnd: 140,
        trackExtra: 34
      }
    ],
    read() {
      try {
        this.values = JSON.parse(localStorage.getItem(this.store) || "{}");
      } catch {
        this.values = {};
      }
      /* V1 numbers may already be ratcheted, so they are dropped rather than
         imported: the CSS defaults are the only trustworthy baseline.
         removeItem is idempotent, so this is safe on every read. */
      try {
        if (localStorage.getItem("quantaSplitSizesV1")) {
          localStorage.removeItem("quantaSplitSizesV1");
        }
      } catch {}
    },
    write() {
      try {
        localStorage.setItem(this.store, JSON.stringify(this.values));
      } catch {}
    },
    /* Maximized mode uses its own stored sizes (a wider box needs different
       percentages) so normal-mode sizes are never corrupted. */
    activeKey(spec) {
      const maximized = document.body.classList.contains("lc-detail-maximized");
      return maximized && (spec.key === "qlDescW" || spec.key === "lcListW") ? `${spec.key}.max` : spec.key;
    },
    apply(key) {
      const spec = this.handles.find((h) => h.key === key);
      const value = Number(this.values[this.activeKey(spec)]);
      if (!spec || !Number.isFinite(value)) return;
      const layout = spec.layout();
      const track = layout ? (spec.mode === "x" ? layout.clientWidth : layout.clientHeight) : 0;
      /* Vertical splits are stored in px; re-express them as a percentage of
         the current track so they re-clamp after viewport changes. */
      const pct = spec.mode === "y" && track ? (value / track) * 100 : value;
      applySplit(spec, pct);
    },
    applyAll() {
      this.handles.forEach((spec) => {
        if (this.values[spec.key] !== undefined) this.apply(spec.key);
      });
    }
  };

  const splitInlineVar = (layout, mode, displayValue) => {
    if (!layout) return;
    layout.style.setProperty(mode === "x" ? "--split-a" : "--split-row-a", displayValue);
  };

  /* The Code-tab divider is an absolutely-positioned overlay. Keep its x
     position derived from the REAL pane geometry (not just the CSS var) so
     it can never drift onto the header buttons after mode changes.
     v30 hardening: the divider is clamped strictly BETWEEN the description
     (Notes) pane and the workspace (Code) pane — it may sit only inside the
     grid gap, never inside the Code area, never over the header buttons —
     and it is hidden entirely whenever real geometry is not measurable
     (mid-transition, stacked mobile layout, hidden page). */
  const syncDescDividerOverlay = () => {
    const resizer = byId("ql-desc-resizer");
    const desc = byId("ql-problem-desc");
    if (!resizer || !desc) return;
    const split = desc.parentElement;
    if (!split) return;
    const splitR = split.getBoundingClientRect();
    const descR = desc.getBoundingClientRect();
    const codeR = (split.querySelector(".ql-code-main") || desc.nextElementSibling).getBoundingClientRect();
    /* Not measurable (hidden page, mid-transition) -> no visible divider. */
    if (!splitR.width || !descR.width || !codeR.width) {
      resizer.style.opacity = "0";
      resizer.style.pointerEvents = "none";
      return;
    }
    /* Horizontal split (<=1100px): panes stack, so there is no vertical
       seam to grab — park the overlay off-screen and disable it. */
    if (codeR.top >= descR.bottom - 1) {
      resizer.style.left = "-9999px";
      resizer.style.opacity = "0";
      resizer.style.pointerEvents = "none";
      /* The label swap still tracks the pane width while stacked. */
      desc.classList.toggle("is-narrow", descR.width < 340);
      return;
    }
    /* The seam lives strictly between the two panes. Center on the gap and
       clamp so the 10px-wide hit area can never cross either pane edge:
       fully inside the gap means descR.right <= center-5 and center+5 <= codeR.left. */
    const rawCenter = (descR.right + codeR.left) / 2;
    /* The VISIBLE bar is only ~2px wide and centered, so allow the hit area
       to kiss each pane edge by half a pixel-step while keeping the drawn
       line fully inside the gap. Needs a >=9px seam to stay active. */
    const minCenter = descR.right + 4.5;
    const maxCenter = codeR.left - 4.5;
    const hasGap = maxCenter >= minCenter;
    const center = Math.min(maxCenter, Math.max(minCenter, rawCenter));
    const left = Math.round(center - splitR.left - 5);
    resizer.style.left = `${left}px`;
    resizer.style.opacity = hasGap ? "" : "0";
    resizer.style.pointerEvents = hasGap ? "" : "none";
    /* Narrow description pane: swap the header link to its short label so
       it always fits the row (see v32 CSS). */
    desc.classList.toggle("is-narrow", descR.width < 340);
  };

  /* Run the divider sync when the browser has settled the layout (rAF) and
     once more after transitions so maximize/restore always lands correct. */
  const queueDescDividerSync = () => {
    requestAnimationFrame(syncDescDividerOverlay);
    window.setTimeout(syncDescDividerOverlay, 140);
    window.setTimeout(syncDescDividerOverlay, 320);
  };

  const applySplit = (spec, value, commit = false) => {
    const layout = spec.layout();
    if (!layout) return;
    const track = spec.mode === "x" ? layout.clientWidth : layout.clientHeight;
    if (!track) return;
    let display;
    let stored;
    if (spec.mode === "y") {
      /* Percentages are meaningless for rows inside an auto-height page:
         apply px, clamped against the current track. */
      const target = (value / 100) * track;
      const floor = spec.minStart;
      const ceil = track - spec.minEnd - (spec.trackExtra || 0);
      /* A track too short for both minimums (mobile URL bar, snapped window)
         has no legal px size; fall back to the plain percentage clamped into
         the track instead of forcing a value that overflows it. */
      const px = ceil > floor ? Math.max(floor, Math.min(ceil, target)) : Math.max(0, Math.min(track, target));
      display = `${Math.round(px * 10) / 10}px`;
      stored = px;
    } else {
      const pct = clampSplitPercent(spec, value);
      display = `${pct}%`;
      stored = pct;
    }
    splitInlineVar(layout, spec.mode, display);
    /* Only a LIVE DRAG may change the stored preference. Restoring clamps
       against the CURRENT track, which can be transiently short (mobile URL
       bar, keyboard, a snapped window, a hidden tab); writing that clamped
       value back would ratchet the saved layout narrower on every visit —
       the exact "page keeps shrinking" bug — and it could never grow back.
       Restores are display-only: the display re-clamps, the preference stays. */
    if (commit) qlSplits.values[qlSplits.activeKey(spec)] = stored;
    if (spec.key === "qlDescW") queueDescDividerSync();
  };

  const clampSplitPercent = (spec, value) => {
    const layout = spec.layout();
    if (!layout) return value;
    const track = spec.mode === "x" ? layout.clientWidth : layout.clientHeight;
    if (!track) return value;
    /* Percentage tracks resolve against the grid's full content box:
       the first pane is exactly P% of it, while the last pane is what
       remains after the percent track, the grid gaps and the 10px
       divider track (3-track layouts) — so only the end side needs the
       extra allowance (trackExtra: 12 for 2-track, 34 for 3-track). */
    const minStartPct = (spec.minStart / track) * 100;
    const minEndPct = ((spec.minEnd + (spec.trackExtra || 0)) / track) * 100;
    /* Below the width where both minimums fit, the floor sits ABOVE the
       ceiling and Math.max would force the floor — smearing a nonsense
       percentage over the panes (and, with write-back, saving it). Keep the
       caller's value on tracks that cannot honour both minimums. */
    if (minStartPct + minEndPct > 100) return value;
    return Math.max(minStartPct, Math.min(100 - minEndPct, value));
  };

  const initSplitHandle = (spec) => {
    const handle = spec.el;
    if (!handle) return;
    let dragging = false;
    let startPointer = 0;
    let startPercent = 50;
    let trackSize = 0;

    const pointerDown = (event) => {
      const layout = spec.layout();
      if (!layout) return;
      const isTouch = event.type === "touchstart";
      if (!isTouch && event.button !== 0) return;
      const point = isTouch ? event.touches[0] : event;
      if (!point) return;
      event.preventDefault();
      dragging = true;
      startPointer = spec.mode === "x" ? point.clientX : point.clientY;
      trackSize = spec.mode === "x" ? layout.clientWidth : layout.clientHeight;
      const startEl = spec.start();
      const startSize = startEl ? (spec.mode === "x" ? startEl.getBoundingClientRect().width : startEl.getBoundingClientRect().height) : trackSize / 2;
      startPercent = trackSize ? (startSize / trackSize) * 100 : 50;
      document.body.classList.add("is-resizing");
      document.body.style.cursor = spec.mode === "x" ? "col-resize" : "row-resize";
      handle.classList.add("is-dragging");
      if (!isTouch) {
        window.addEventListener("pointermove", pointerMove);
        window.addEventListener("pointerup", pointerUp);
        window.addEventListener("pointercancel", pointerUp);
      } else {
        window.addEventListener("touchmove", pointerMove, { passive: false });
        window.addEventListener("touchend", pointerUp);
        window.addEventListener("touchcancel", pointerUp);
      }
    };

    const pointerMove = (event) => {
      if (!dragging) return;
      const point =
        event.type === "touchmove"
          ? event.touches[0]
          : event.type === "touchend"
            ? event.changedTouches[0]
            : event;
      if (!point) return;
      event.preventDefault();
      const deltaPct = trackSize ? (((spec.mode === "x" ? point.clientX : point.clientY) - startPointer) / trackSize) * 100 : 0;
      /* commit: this is the user's gesture, so it — and only it — may update
         the stored preference. */
      applySplit(spec, startPercent + deltaPct, true);
      if (spec.mode === "x") relayoutMonacoEditors();
      if (spec.key === "qlDescW") syncDescDividerOverlay();
    };

    const pointerUp = () => {
      if (!dragging) return;
      dragging = false;
      document.body.classList.remove("is-resizing");
      document.body.style.removeProperty("cursor");
      handle.classList.remove("is-dragging");
      /* Keep the maximized-mode and normal-mode sizes independent: whichever
         mode the drag happened in, the other mode's stored value is stale. */
      if (spec.key === "qlDescW") {
        const alt = document.body.classList.contains("lc-detail-maximized") ? "qlDescW" : "qlDescW.max";
        delete qlSplits.values[alt];
      }
      window.removeEventListener("pointermove", pointerMove);
      window.removeEventListener("pointerup", pointerUp);
      window.removeEventListener("pointercancel", pointerUp);
      window.removeEventListener("touchmove", pointerMove);
      window.removeEventListener("touchend", pointerUp);
      window.removeEventListener("touchcancel", pointerUp);
      qlSplits.write();
      relayoutMonacoEditors();
      /* One last geometry-derived sync after the drag settles. */
      if (spec.key === "qlDescW") queueDescDividerSync();
    };

    handle.addEventListener("pointerdown", pointerDown);
    handle.addEventListener("touchstart", pointerDown, { passive: false });
    handle.addEventListener("dragstart", (event) => event.preventDefault());
    handle.addEventListener("dblclick", () => {
      const layout = spec.layout();
      if (layout) {
        layout.style.removeProperty(spec.mode === "x" ? "--split-a" : "--split-row-a");
        delete qlSplits.values[spec.key];
        delete qlSplits.values[`${spec.key}.max`];
        qlSplits.write();
        if (spec.key === "qlDescW") {
          handle.style.removeProperty("left");
          syncDescDividerOverlay();
        }
        relayoutMonacoEditors();
      }
    });
  };

  /* --------- nested-box scroll chaining fallback ------------------------- */
  /* Browsers hand wheel scrolling from a box at its top/bottom limit to the
     main page automatically once "overscroll-behavior" allows it, but the
     hand-off is compositor-driven and can miss events. This small fallback
     guarantees the requested behavior: the box scrolls first; once it hits
     its limit, continued wheeling moves the main page — mouse never has to
     leave the box. */
  const chainScrollTargets = [
    "lc-problem-list",     /* LeetCode programs list */
    "notes-sections-list", /* Notes tab sections */
    "ql-desc-body",        /* Code tab description */
    "java-output",         /* Lab output */
    "java-session-tabs",   /* Lab programs list */
    "np-note-list"         /* Personal notes list */
  ];
  chainScrollTargets.forEach((targetId) => {
    const el = byId(targetId);
    if (!el) return;
    el.addEventListener(
      "wheel",
      (event) => {
        if (!event.deltaY || event.ctrlKey) return;
        const goingUp = event.deltaY < 0;
        const atTop = el.scrollTop <= 0;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        if ((goingUp && !atTop) || (!goingUp && !atBottom)) return; /* box still scrolls natively */
        /* Hand the wheel to the nearest ancestor that can still scroll —
           normally the main page. */
        let node = el.parentElement;
        while (node && node !== document.body) {
          const style = getComputedStyle(node);
          const scrollable = /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
          if (scrollable) {
            const canUp = node.scrollTop > 0;
            const canDown = node.scrollTop + node.clientHeight < node.scrollHeight - 1;
            if ((goingUp && canUp) || (!goingUp && canDown)) {
              event.preventDefault();
              node.scrollTop += event.deltaY;
              return;
            }
          }
          node = node.parentElement;
        }
      },
      { passive: false }
    );
  });

  qlSplits.read();
  qlSplits.handles.forEach((spec) => {
    if (spec.el) initSplitHandle(spec);
    if (qlSplits.values[spec.key] !== undefined) qlSplits.apply(spec.key);
  });
  window.addEventListener("resize", () => {
    queueDescDividerSync();
    window.setTimeout(() => {
      /* Re-express the saved splits against the NEW track so the px minimums
         (240/380/460) are honoured while the window is being narrowed, not
         only at boot or page-switch. Display-only — stored sizes untouched. */
      qlSplits.applyAll();
      relayoutMonacoEditors();
      syncDescDividerOverlay();
    }, 120);
  });
  const lcMediaQuery = window.matchMedia("(max-width: 760px)");
  lcMediaQuery.addEventListener("change", () => {
    lcLayout.classList.remove("show-detail");
    relayoutMonacoEditors();
    queueDescDividerSync();
  });

  /* ------------------------------- splash -------------------------------- */

  const runSplash = () => {
    const splash = byId("app-splash");
    if (!splash) return;
    requestAnimationFrame(() => splash.classList.add("is-visible"));
    window.setTimeout(() => {
      splash.classList.add("is-hidden");
      window.setTimeout(() => splash.remove(), 600);
    }, 1800);
  };
  runSplash();

  /* -------------------------------- init -------------------------------- */

  ensureActiveSession();
  labAutoSaveToggle.checked = labState.autoSave;
  renderTabs();
  renderLcAll();
  renderPersonalNotes();
  showPage("quantalab", { resetScroll: true });
  void fetchRunCapabilities();
})();
