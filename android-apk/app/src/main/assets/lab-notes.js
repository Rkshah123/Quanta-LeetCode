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
  /* The mock interview's editor/output split. It has its own editor and its own
     output box, but it is driven by the same resizer machinery as the Lab's -
     see the handles in qlSplits - so the divider behaves identically. */
  const mockWorkspace = byId("mock-workspace");
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
    if (pageId === "progress") void renderProgressPage();
    if (pageId === "settings") void runConnectionDiagnostics();
    if (pageId === "revision") void loadRevisionDashboard();
    /* The visualizer keeps its step position when you leave and come back, so
       nothing needs re-running here - but a hidden page has no size, and the
       stage is laid out in percentages, so it redraws on show either way. */
    if (pageId === "visualizer") vizRenderFrame();
    /* Rebuilt on every visit: solving a problem elsewhere in the app changes
       what a good suggestion is, so a cached list would go stale the moment
       the user solved anything. */
    if (pageId === "discovery") discoveryRefresh();
  /* The mock interview's editor is built on the first visit, not at start-up.
     A second Monaco instance is a real memory cost and most sessions never open
     the interview, so nobody should pay for it before asking. Safe to call on
     every visit: ensureMockEditor() returns immediately once it exists. */
  if (pageId === "mock") {
    void ensureMockEditor().catch(() => {
      if (mockEditorNode && !mockEditor) {
        mockEditorNode.innerHTML =
          '<p class="ql-desc-empty">The code editor could not start on this device, so code cannot be typed here. The problem and the clock are unaffected.</p>';
      }
    });
  }
    /* The arena's clock starts on show and stops on leave, and its contest list
       is refetched each visit - a countdown you have to reload to trust is not
       worth having. */
    if (pageId === "arena") arenaOnShow();
    else arenaOnHide();
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
        /* Filled from version.js rather than typed into the markup, which is how the
           About page came to say 1.0.0 while the installed package was 1.2.0 - the one
           screen whose whole job is saying what you are running.
        
           The markup still carries the number as a fallback for the moment before this
           runs, and android-apk/build.sh rewrites that one line to whatever version it is
           packaging, so the two cannot drift apart silently a second time. */
        const versionEl = byId("about-version");
        if (versionEl && window.QUANTA_VERSION) versionEl.textContent = window.QUANTA_VERSION;
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
  const lcSearchClear = byId("lc-search-clear");
  const lcFiltersToggle = byId("lc-filters-toggle");
  const lcFiltersPanel = byId("lc-filters-panel");
  const lcFiltersClear = byId("lc-filters-clear");
  const lcFiltersCount = byId("lc-filters-count");
  const lcActiveFilters = byId("lc-active-filters");
  const lcResultCount = byId("lc-result-count");
  const lcRevisionFilter = byId("lc-revision-filter");
  const lcSortSelect = byId("lc-sort-select");
  const lcOfflineNote = byId("lc-offline-note");
  let lcSearchDebounce = 0;
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
  const qlTabSolutions = byId("ql-tab-solutions");
  const qlViewSolutions = byId("ql-view-solutions");
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
    /* Move the theme symbols into the drawer on phones; restore on desktop. */
    const themeSymbols = byId("theme-symbols");
    const themeSlot = byId("nav-drawer-theme-slot");
    const themeOriginal = themeSymbols?.parentElement;
    const applyPlacement = () => {
      if (!themeSymbols || !themeSlot) return;
      const mobile = window.matchMedia("(max-width: 760px)").matches;
      if (mobile && themeSymbols.closest(".top-bar")) {
        themeSlot.appendChild(themeSymbols);
      } else if (!mobile && !themeSymbols.closest(".top-bar") && themeOriginal) {
        themeOriginal.appendChild(themeSymbols);
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

  /* The catalog is generated from the database by scripts/sync-catalog-seeds.js.
     `num` is the LeetCode problem number and is unique, which is why it was
     once safe to use as the id. That stopped being true when the catalog grew
     to more than one platform: Codeforces problems have no LeetCode number, so
     every one of them would have arrived as num 0 and shared the id `seed-0`,
     silently merging 1,300 distinct problems into one.

     So the id is derived from the slug, which is unique per platform and is
     already what every other part of the app keys on (revision, notes,
     solutions, the API all address a problem by slug). `platform` and `url`
     are carried through so a Codeforces row links to Codeforces instead of to
     a fabricated leetcode.com address built from a Codeforces slug. */
  /* Topic labels live in one table and each problem stores indices into it.
     The catalog is ~2,000 rows and most carry five or six topics, so writing
     the labels out in full would add roughly 200 KB to this file for no
     benefit. Indices keep the embedded catalog small enough to ship offline
     while still letting the app group, filter and recommend by topic with no
     network at all. */
  const SEED_TOPICS = [
    "Arrays", "Strings", "Hashing", "Two Pointers", "Sliding Window", "Prefix Sum",
    "Binary Search", "Linked List", "Stack", "Queue", "Trees", "BST", "Heaps",
    "Graphs", "Backtracking", "Greedy", "Dynamic Programming", "Tries",
    "Bit Manipulation", "Sorting", "Math", "Number Theory", "Advanced Graphs",
    "Probability", "SQL"
  ];
  const seedTopicLabels = (indices) =>
    (Array.isArray(indices) ? indices : []).map((i) => SEED_TOPICS[i]).filter(Boolean);

  const seedProblems = () => {
    /* topics and hasDescription come before platform and url on purpose.

       Rows omit the platform and url for a LeetCode problem, because the URL
       follows from the slug. With the platform first, such a row's topics array
       landed in the platform slot, and adding a trailing boolean landed that
       boolean in the url slot - where a boolean is not a string, and the row
       was dropped. 651 of the 2,020 problems disappeared from the catalog and
       the only symptom was a smaller number on the page.

       Writing the two arguments that are always present first makes every row
       readable without guesswork, and as a bonus the topics that were being
       lost now arrive. */
    const p = (num, slug, name, difficulty, topics = null, hasDescription = false, platform = "leetcode", url = "") => ({
      id: `seed-${slug}`,
      num,
      slug,
      name,
      platform,
      url: url || `https://leetcode.com/problems/${slug}/`,
      difficulty,
      topics: seedTopicLabels(topics),
      hasDescription: hasDescription === true,
      solved: false,
      notes: [{ id: randomId("nsec"), title: "Approach", html: "", collapsed: false }],
      code: {}
    });
    return [
      p(1, "two-sum", "Two Sum", "Easy", [0, 2], true),
      p(9, "palindrome-number", "Palindrome Number", "Easy", [20], true),
      p(13, "roman-to-integer", "Roman to Integer", "Easy", [1, 2, 20], true),
      p(14, "longest-common-prefix", "Longest Common Prefix", "Easy", [0, 1, 17], true),
      p(20, "valid-parentheses", "Valid Parentheses", "Easy", [1, 8], true),
      p(21, "merge-two-sorted-lists", "Merge Two Sorted Lists", "Easy", [7], true),
      p(26, "remove-duplicates-from-sorted-array", "Remove Duplicates from Sorted Array", "Easy", [0, 3], true),
      p(27, "remove-element", "Remove Element", "Easy", [0, 3], true),
      p(28, "find-the-index-of-the-first-occurrence-in-a-string", "Find the Index of the First Occurrence in a String", "Easy", [1, 3], true),
      p(35, "search-insert-position", "Search Insert Position", "Easy", [0, 6], true),
      p(53, "maximum-subarray", "Maximum Subarray", "Medium", [0, 16], true),
      p(58, "length-of-last-word", "Length of Last Word", "Easy", [1], true),
      p(66, "plus-one", "Plus One", "Easy", [0, 20], true),
      p(67, "add-binary", "Add Binary", "Easy", [1, 18, 20], true),
      p(69, "sqrtx", "Sqrt(x)", "Easy", [6, 20], true),
      p(70, "climbing-stairs", "Climbing Stairs", "Easy", [16, 20], true),
      p(83, "remove-duplicates-from-sorted-list", "Remove Duplicates from Sorted List", "Easy", [7], true),
      p(88, "merge-sorted-array", "Merge Sorted Array", "Easy", [0, 3, 19], true),
      p(94, "binary-tree-inorder-traversal", "Binary Tree Inorder Traversal", "Easy", [8, 10], true),
      p(100, "same-tree", "Same Tree", "Easy", [10], true),
      p(101, "symmetric-tree", "Symmetric Tree", "Easy", [10], true),
      p(104, "maximum-depth-of-binary-tree", "Maximum Depth of Binary Tree", "Easy", [10], true),
      p(108, "convert-sorted-array-to-binary-search-tree", "Convert Sorted Array to Binary Search Tree", "Easy", [0, 10, 11], true),
      p(110, "balanced-binary-tree", "Balanced Binary Tree", "Easy", [10], true),
      p(111, "minimum-depth-of-binary-tree", "Minimum Depth of Binary Tree", "Easy", [10], true),
      p(112, "path-sum", "Path Sum", "Easy", [10], true),
      p(118, "pascals-triangle", "Pascal's Triangle", "Easy", [0, 16], true),
      p(119, "pascals-triangle-ii", "Pascal's Triangle II", "Easy", [0, 16], true),
      p(121, "best-time-to-buy-and-sell-stock", "Best Time to Buy and Sell Stock", "Easy", [0, 16], true),
      p(125, "valid-palindrome", "Valid Palindrome", "Easy", [1, 3], true),
      p(136, "single-number", "Single Number", "Easy", [0, 18], true),
      p(141, "linked-list-cycle", "Linked List Cycle", "Easy", [2, 3, 7], true),
      p(144, "binary-tree-preorder-traversal", "Binary Tree Preorder Traversal", "Easy", [8, 10], true),
      p(145, "binary-tree-postorder-traversal", "Binary Tree Postorder Traversal", "Easy", [8, 10], true),
      p(155, "min-stack", "Min Stack", "Medium", [8], true),
      p(160, "intersection-of-two-linked-lists", "Intersection of Two Linked Lists", "Easy", [2, 3, 7], true),
      p(167, "two-sum-ii-input-array-is-sorted", "Two Sum II - Input Array Is Sorted", "Medium", [0, 3, 6], true),
      p(169, "majority-element", "Majority Element", "Easy", [0, 2, 19], true),
      p(171, "excel-sheet-column-number", "Excel Sheet Column Number", "Easy", [1, 20], true),
      p(190, "reverse-bits", "Reverse Bits", "Easy", [18], true),
      p(191, "number-of-1-bits", "Number of 1 Bits", "Easy", [18], true),
      p(202, "happy-number", "Happy Number", "Easy", [2, 3, 20], true),
      p(203, "remove-linked-list-elements", "Remove Linked List Elements", "Easy", [7], true),
      p(205, "isomorphic-strings", "Isomorphic Strings", "Easy", [1, 2], true),
      p(206, "reverse-linked-list", "Reverse Linked List", "Easy", [7], true),
      p(217, "contains-duplicate", "Contains Duplicate", "Easy", [0, 2, 19], true),
      p(219, "contains-duplicate-ii", "Contains Duplicate II", "Easy", [0, 2, 4], true),
      p(226, "invert-binary-tree", "Invert Binary Tree", "Easy", [10], true),
      p(231, "power-of-two", "Power of Two", "Easy", [18, 20], true),
      p(232, "implement-queue-using-stacks", "Implement Queue using Stacks", "Easy", [8, 9], true),
      p(234, "palindrome-linked-list", "Palindrome Linked List", "Easy", [3, 7, 8], true),
      p(237, "delete-node-in-a-linked-list", "Delete Node in a Linked List", "Medium", [7], true),
      p(242, "valid-anagram", "Valid Anagram", "Easy", [1, 2, 19], true),
      p(257, "binary-tree-paths", "Binary Tree Paths", "Easy", [1, 10, 14], true),
      p(258, "add-digits", "Add Digits", "Easy", [20, 21], true),
      p(263, "ugly-number", "Ugly Number", "Easy", [20], true),
      p(268, "missing-number", "Missing Number", "Easy", [0, 2, 6, 18, 19, 20], true),
      p(278, "first-bad-version", "First Bad Version", "Easy", [6], true),
      p(283, "move-zeroes", "Move Zeroes", "Easy", [0, 3], true),
      p(290, "word-pattern", "Word Pattern", "Easy", [1, 2], true),
      p(292, "nim-game", "Nim Game", "Easy", [20], true),
      p(303, "range-sum-query-immutable", "Range Sum Query - Immutable", "Easy", [0, 5], true),
      p(326, "power-of-three", "Power of Three", "Easy", [20], true),
      p(338, "counting-bits", "Counting Bits", "Easy", [16, 18], true),
      p(342, "power-of-four", "Power of Four", "Easy", [18, 20], true),
      p(344, "reverse-string", "Reverse String", "Easy", [1, 3], true),
      p(345, "reverse-vowels-of-a-string", "Reverse Vowels of a String", "Easy", [1, 3], true),
      p(349, "intersection-of-two-arrays", "Intersection of Two Arrays", "Easy", [0, 2, 3, 6, 19], true),
      p(350, "intersection-of-two-arrays-ii", "Intersection of Two Arrays II", "Easy", [0, 2, 3, 6, 19], true),
      p(367, "valid-perfect-square", "Valid Perfect Square", "Easy", [6, 20], true),
      p(374, "guess-number-higher-or-lower", "Guess Number Higher or Lower", "Easy", [6], true),
      p(383, "ransom-note", "Ransom Note", "Easy", [1, 2], true),
      p(387, "first-unique-character-in-a-string", "First Unique Character in a String", "Easy", [1, 2, 9], true),
      p(389, "find-the-difference", "Find the Difference", "Easy", [1, 2, 18, 19], true),
      p(392, "is-subsequence", "Is Subsequence", "Easy", [1, 3, 16], true),
      p(404, "sum-of-left-leaves", "Sum of Left Leaves", "Easy", [10], true),
      p(409, "longest-palindrome", "Longest Palindrome", "Easy", [1, 2, 15], true),
      p(412, "fizz-buzz", "Fizz Buzz", "Easy", [1, 20], true),
      p(414, "third-maximum-number", "Third Maximum Number", "Easy", [0, 19], true),
      p(415, "add-strings", "Add Strings", "Easy", [1, 20], true),
      p(434, "number-of-segments-in-a-string", "Number of Segments in a String", "Easy", [1], true),
      p(441, "arranging-coins", "Arranging Coins", "Easy", [6, 20], true),
      p(443, "string-compression", "String Compression", "Medium", [1, 3], true),
      p(448, "find-all-numbers-disappeared-in-an-array", "Find All Numbers Disappeared in an Array", "Easy", [0, 2], true),
      p(455, "assign-cookies", "Assign Cookies", "Easy", [0, 3, 15, 19], true),
      p(459, "repeated-substring-pattern", "Repeated Substring Pattern", "Easy", [1], true),
      p(461, "hamming-distance", "Hamming Distance", "Easy", [18], true),
      p(463, "island-perimeter", "Island Perimeter", "Easy", [0], true),
      p(476, "number-complement", "Number Complement", "Easy", [18], true),
      p(482, "license-key-formatting", "License Key Formatting", "Easy", [1], true),
      p(485, "max-consecutive-ones", "Max Consecutive Ones", "Easy", [0], true),
      p(492, "construct-the-rectangle", "Construct the Rectangle", "Easy", [20], true),
      p(496, "next-greater-element-i", "Next Greater Element I", "Easy", [0, 2, 8], true),
      p(501, "find-mode-in-binary-search-tree", "Find Mode in Binary Search Tree", "Easy", [10, 11], true),
      p(504, "base-7", "Base 7", "Easy", [1, 20], true),
      p(507, "perfect-number", "Perfect Number", "Easy", [20], true),
      p(509, "fibonacci-number", "Fibonacci Number", "Easy", [16, 20], true),
      p(520, "detect-capital", "Detect Capital", "Easy", [1], true),
      p(521, "longest-uncommon-subsequence-i", "Longest Uncommon Subsequence I", "Easy", [1], true),
      p(530, "minimum-absolute-difference-in-bst", "Minimum Absolute Difference in BST", "Easy", [10, 11], true),
      p(541, "reverse-string-ii", "Reverse String II", "Easy", [1, 3], true),
      p(543, "diameter-of-binary-tree", "Diameter of Binary Tree", "Easy", [10], true),
      p(551, "student-attendance-record-i", "Student Attendance Record I", "Easy", [1], true),
      p(557, "reverse-words-in-a-string-iii", "Reverse Words in a String III", "Easy", [1, 3], true),
      p(559, "maximum-depth-of-n-ary-tree", "Maximum Depth of N-ary Tree", "Easy", [10], true),
      p(561, "array-partition", "Array Partition", "Easy", [0, 15, 19], true),
      p(563, "binary-tree-tilt", "Binary Tree Tilt", "Easy", [10], true),
      p(566, "reshape-the-matrix", "Reshape the Matrix", "Easy", [0], true),
      p(572, "subtree-of-another-tree", "Subtree of Another Tree", "Easy", [2, 10], true),
      p(575, "distribute-candies", "Distribute Candies", "Easy", [0, 2], true),
      p(589, "n-ary-tree-preorder-traversal", "N-ary Tree Preorder Traversal", "Easy", [8, 10], true),
      p(590, "n-ary-tree-postorder-traversal", "N-ary Tree Postorder Traversal", "Easy", [8, 10], true),
      p(594, "longest-harmonious-subsequence", "Longest Harmonious Subsequence", "Easy", [0, 2, 4, 19], true),
      p(598, "range-addition-ii", "Range Addition II", "Easy", [0, 20], true),
      p(599, "minimum-index-sum-of-two-lists", "Minimum Index Sum of Two Lists", "Easy", [0, 1, 2], true),
      p(605, "can-place-flowers", "Can Place Flowers", "Easy", [0, 15], true),
      p(606, "construct-string-from-binary-tree", "Construct String from Binary Tree", "Medium", [1, 10], true),
      p(617, "merge-two-binary-trees", "Merge Two Binary Trees", "Easy", [10], true),
      p(628, "maximum-product-of-three-numbers", "Maximum Product of Three Numbers", "Easy", [0, 19, 20], true),
      p(637, "average-of-levels-in-binary-tree", "Average of Levels in Binary Tree", "Easy", [10], true),
      p(643, "maximum-average-subarray-i", "Maximum Average Subarray I", "Easy", [0, 4], true),
      p(645, "set-mismatch", "Set Mismatch", "Easy", [0, 2, 18, 19], true),
      p(647, "palindromic-substrings", "Palindromic Substrings", "Medium", [1, 3, 16], true),
      p(653, "two-sum-iv-input-is-a-bst", "Two Sum IV - Input is a BST", "Easy", [2, 3, 10, 11], true),
      p(657, "robot-return-to-origin", "Robot Return to Origin", "Easy", [1], true),
      p(661, "image-smoother", "Image Smoother", "Easy", [0], true),
      p(671, "second-minimum-node-in-a-binary-tree", "Second Minimum Node In a Binary Tree", "Easy", [10], true),
      p(674, "longest-continuous-increasing-subsequence", "Longest Continuous Increasing Subsequence", "Easy", [0], true),
      p(680, "valid-palindrome-ii", "Valid Palindrome II", "Easy", [1, 3, 15], true),
      p(682, "baseball-game", "Baseball Game", "Easy", [0, 8], true),
      p(687, "longest-univalue-path", "Longest Univalue Path", "Medium", [10], true),
      p(693, "binary-number-with-alternating-bits", "Binary Number with Alternating Bits", "Easy", [18], true),
      p(696, "count-binary-substrings", "Count Binary Substrings", "Easy", [1, 3], true),
      p(697, "degree-of-an-array", "Degree of an Array", "Easy", [0, 2], true),
      p(700, "search-in-a-binary-search-tree", "Search in a Binary Search Tree", "Easy", [10, 11], true),
      p(703, "kth-largest-element-in-a-stream", "Kth Largest Element in a Stream", "Easy", [10, 11], true),
      p(704, "binary-search", "Binary Search", "Easy", [0, 6], true),
      p(705, "design-hashset", "Design HashSet", "Easy", [0, 2, 7], true),
      p(706, "design-hashmap", "Design HashMap", "Easy", [0, 2, 7], true),
      p(709, "to-lower-case", "To Lower Case", "Easy", [1], true),
      p(716, "max-stack", "Max Stack", "Hard", [7, 8], false),
      p(717, "1-bit-and-2-bit-characters", "1-bit and 2-bit Characters", "Easy", [0], true),
      p(720, "longest-word-in-dictionary", "Longest Word in Dictionary", "Medium", [0, 1, 2, 17, 19], true),
      p(724, "find-pivot-index", "Find Pivot Index", "Easy", [0, 5], true),
      p(728, "self-dividing-numbers", "Self Dividing Numbers", "Easy", [20], true),
      p(733, "flood-fill", "Flood Fill", "Easy", [0], true),
      p(734, "sentence-similarity", "Sentence Similarity", "Easy", [0, 1, 2], false),
      p(744, "find-smallest-letter-greater-than-target", "Find Smallest Letter Greater Than Target", "Easy", [0, 6], true),
      p(746, "min-cost-climbing-stairs", "Min Cost Climbing Stairs", "Easy", [0, 16], true),
      p(747, "largest-number-at-least-twice-of-others", "Largest Number At Least Twice of Others", "Easy", [0, 19], true),
      p(748, "shortest-completing-word", "Shortest Completing Word", "Easy", [0, 1, 2], true),
      p(754, "reach-a-number", "Reach a Number", "Medium", [6, 20], true),
      p(760, "find-anagram-mappings", "Find Anagram Mappings", "Easy", [0, 2], false),
      p(762, "prime-number-of-set-bits-in-binary-representation", "Prime Number of Set Bits in Binary Representation", "Easy", [18, 20], true),
      p(766, "toeplitz-matrix", "Toeplitz Matrix", "Easy", [0], true),
      p(771, "jewels-and-stones", "Jewels and Stones", "Easy", [1, 2], true),
      p(783, "minimum-distance-between-bst-nodes", "Minimum Distance Between BST Nodes", "Easy", [10, 11], true),
      p(788, "rotated-digits", "Rotated Digits", "Medium", [16, 20], true),
      p(796, "rotate-string", "Rotate String", "Easy", [1], true),
      p(804, "unique-morse-code-words", "Unique Morse Code Words", "Easy", [0, 1, 2], true),
      p(806, "number-of-lines-to-write-string", "Number of Lines To Write String", "Easy", [0, 1], true),
      p(812, "largest-triangle-area", "Largest Triangle Area", "Easy", [0, 20], true),
      p(819, "most-common-word", "Most Common Word", "Easy", [0, 1, 2], true),
      p(821, "shortest-distance-to-a-character", "Shortest Distance to a Character", "Easy", [0, 1, 3], true),
      p(824, "goat-latin", "Goat Latin", "Easy", [1], true),
      p(830, "positions-of-large-groups", "Positions of Large Groups", "Easy", [1], true),
      p(832, "flipping-an-image", "Flipping an Image", "Easy", [0, 3, 18], true),
      p(836, "rectangle-overlap", "Rectangle Overlap", "Easy", [20], true),
      p(840, "magic-squares-in-grid", "Magic Squares In Grid", "Medium", [0, 2, 20], true),
      p(844, "backspace-string-compare", "Backspace String Compare", "Easy", [1, 3, 8], true),
      p(849, "maximize-distance-to-closest-person", "Maximize Distance to Closest Person", "Medium", [0], true),
      p(852, "peak-index-in-a-mountain-array", "Peak Index in a Mountain Array", "Medium", [0, 6], true),
      p(859, "buddy-strings", "Buddy Strings", "Easy", [1, 2], true),
      p(860, "lemonade-change", "Lemonade Change", "Easy", [0, 15], true),
      p(868, "binary-gap", "Binary Gap", "Easy", [18], true),
      p(872, "leaf-similar-trees", "Leaf-Similar Trees", "Easy", [10], true),
      p(876, "middle-of-the-linked-list", "Middle of the Linked List", "Easy", [3, 7], true),
      p(883, "projection-area-of-3d-shapes", "Projection Area of 3D Shapes", "Easy", [0, 20], true),
      p(884, "uncommon-words-from-two-sentences", "Uncommon Words from Two Sentences", "Easy", [1, 2], true),
      p(888, "fair-candy-swap", "Fair Candy Swap", "Easy", [0, 2, 6, 19], true),
      p(892, "surface-area-of-3d-shapes", "Surface Area of 3D Shapes", "Easy", [0, 20], true),
      p(896, "monotonic-array", "Monotonic Array", "Easy", [0], true),
      p(897, "increasing-order-search-tree", "Increasing Order Search Tree", "Easy", [8, 10, 11], true),
      p(905, "sort-array-by-parity", "Sort Array By Parity", "Easy", [0, 3, 19], true),
      p(908, "smallest-range-i", "Smallest Range I", "Easy", [0, 20], true),
      p(914, "x-of-a-kind-in-a-deck-of-cards", "X of a Kind in a Deck of Cards", "Easy", [0, 2, 20, 21], true),
      p(917, "reverse-only-letters", "Reverse Only Letters", "Easy", [1, 3], true),
      p(922, "sort-array-by-parity-ii", "Sort Array By Parity II", "Easy", [0, 3, 19], true),
      p(925, "long-pressed-name", "Long Pressed Name", "Easy", [1, 3], true),
      p(929, "unique-email-addresses", "Unique Email Addresses", "Easy", [0, 1, 2], true),
      p(933, "number-of-recent-calls", "Number of Recent Calls", "Easy", [9], true),
      p(938, "range-sum-of-bst", "Range Sum of BST", "Easy", [10, 11], true),
      p(941, "valid-mountain-array", "Valid Mountain Array", "Easy", [0], true),
      p(942, "di-string-match", "DI String Match", "Easy", [0, 1, 3, 15], true),
      p(944, "delete-columns-to-make-sorted", "Delete Columns to Make Sorted", "Easy", [0, 1], true),
      p(953, "verifying-an-alien-dictionary", "Verifying an Alien Dictionary", "Easy", [0, 1, 2], true),
      p(961, "n-repeated-element-in-size-2n-array", "N-Repeated Element in Size 2N Array", "Easy", [0, 2], true),
      p(965, "univalued-binary-tree", "Univalued Binary Tree", "Easy", [10], true),
      p(970, "powerful-integers", "Powerful Integers", "Medium", [2, 20], true),
      p(973, "k-closest-points-to-origin", "K Closest Points to Origin", "Medium", [0, 19, 20], true),
      p(977, "squares-of-a-sorted-array", "Squares of a Sorted Array", "Easy", [0, 3, 19], true),
      p(989, "add-to-array-form-of-integer", "Add to Array-Form of Integer", "Easy", [0, 20], true),
      p(993, "cousins-in-binary-tree", "Cousins in Binary Tree", "Easy", [10], true),
      p(997, "find-the-town-judge", "Find the Town Judge", "Easy", [0, 2], true),
      p(1002, "find-common-characters", "Find Common Characters", "Easy", [0, 1, 2], true),
      p(1009, "complement-of-base-10-integer", "Complement of Base 10 Integer", "Easy", [18], true),
      p(1010, "pairs-of-songs-with-total-durations-divisible-by-60", "Pairs of Songs With Total Durations Divisible by 60", "Medium", [0, 2], true),
      p(1013, "partition-array-into-three-parts-with-equal-sum", "Partition Array Into Three Parts With Equal Sum", "Easy", [0, 15], true),
      p(1021, "remove-outermost-parentheses", "Remove Outermost Parentheses", "Easy", [1, 8], true),
      p(1022, "sum-of-root-to-leaf-binary-numbers", "Sum of Root To Leaf Binary Numbers", "Easy", [10], true),
      p(1025, "divisor-game", "Divisor Game", "Easy", [16, 20], true),
      p(1030, "matrix-cells-in-distance-order", "Matrix Cells in Distance Order", "Easy", [0, 19, 20], true),
      p(1037, "valid-boomerang", "Valid Boomerang", "Easy", [0, 20], true),
      p(1046, "last-stone-weight", "Last Stone Weight", "Easy", [0], true),
      p(1047, "remove-all-adjacent-duplicates-in-string", "Remove All Adjacent Duplicates In String", "Easy", [1, 8], true),
      p(1051, "height-checker", "Height Checker", "Easy", [0, 19], true),
      p(1071, "greatest-common-divisor-of-strings", "Greatest Common Divisor of Strings", "Easy", [1, 20], true),
      p(1078, "occurrences-after-bigram", "Occurrences After Bigram", "Easy", [1], true),
      p(1089, "duplicate-zeros", "Duplicate Zeros", "Easy", [0, 3], true),
      p(1103, "distribute-candies-to-people", "Distribute Candies to People", "Easy", [20], true),
      p(1108, "defanging-an-ip-address", "Defanging an IP Address", "Easy", [1], true),
      p(1119, "remove-vowels-from-a-string", "Remove Vowels from a String", "Easy", [1], false),
      p(1122, "relative-sort-array", "Relative Sort Array", "Easy", [0, 2, 19], true),
      p(1128, "number-of-equivalent-domino-pairs", "Number of Equivalent Domino Pairs", "Easy", [0, 2], true),
      p(1137, "n-th-tribonacci-number", "N-th Tribonacci Number", "Easy", [16, 20], true),
      p(1154, "day-of-the-year", "Day of the Year", "Easy", [1, 20], true),
      p(1160, "find-words-that-can-be-formed-by-characters", "Find Words That Can Be Formed by Characters", "Easy", [0, 1, 2], true),
      p(1170, "compare-strings-by-frequency-of-the-smallest-character", "Compare Strings by Frequency of the Smallest Character", "Medium", [0, 1, 2, 6, 19], true),
      p(1184, "distance-between-bus-stops", "Distance Between Bus Stops", "Easy", [0], true),
      p(1185, "day-of-the-week", "Day of the Week", "Easy", [20], true),
      p(1189, "maximum-number-of-balloons", "Maximum Number of Balloons", "Easy", [1, 2], true),
      p(1200, "minimum-absolute-difference", "Minimum Absolute Difference", "Easy", [0, 19], true),
      p(1207, "unique-number-of-occurrences", "Unique Number of Occurrences", "Easy", [0, 2], true),
      p(1217, "minimum-cost-to-move-chips-to-the-same-position", "Minimum Cost to Move Chips to The Same Position", "Easy", [0, 15, 20], true),
      p(1221, "split-a-string-in-balanced-strings", "Split a String in Balanced Strings", "Easy", [1, 15], true),
      p(1232, "check-if-it-is-a-straight-line", "Check If It Is a Straight Line", "Easy", [0, 20], true),
      p(1237, "find-positive-integer-solution-for-a-given-equation", "Find Positive Integer Solution for a Given Equation", "Medium", [3, 6, 20], true),
      p(1250, "check-if-it-is-a-good-array", "Check If It Is a Good Array", "Hard", [0, 20, 21], true),
      p(1252, "cells-with-odd-values-in-a-matrix", "Cells with Odd Values in a Matrix", "Easy", [0, 20], true),
      p(1260, "shift-2d-grid", "Shift 2D Grid", "Easy", [0], true),
      p(1266, "minimum-time-visiting-all-points", "Minimum Time Visiting All Points", "Easy", [0, 20], true),
      p(1275, "find-winner-on-a-tic-tac-toe-game", "Find Winner on a Tic Tac Toe Game", "Easy", [0, 2], true),
      p(1281, "subtract-the-product-and-sum-of-digits-of-an-integer", "Subtract the Product and Sum of Digits of an Integer", "Easy", [20], true),
      p(1287, "element-appearing-more-than-25-in-sorted-array", "Element Appearing More Than 25% In Sorted Array", "Easy", [0], true),
      p(1290, "convert-binary-number-in-a-linked-list-to-integer", "Convert Binary Number in a Linked List to Integer", "Easy", [7, 20], true),
      p(1295, "find-numbers-with-even-number-of-digits", "Find Numbers with Even Number of Digits", "Easy", [0, 20], true),
      p(1299, "replace-elements-with-greatest-element-on-right-side", "Replace Elements with Greatest Element on Right Side", "Easy", [0], true),
      p(1304, "find-n-unique-integers-sum-up-to-zero", "Find N Unique Integers Sum up to Zero", "Easy", [0, 20], true),
      p(1309, "decrypt-string-from-alphabet-to-integer-mapping", "Decrypt String from Alphabet to Integer Mapping", "Easy", [1], true),
      p(1313, "decompress-run-length-encoded-list", "Decompress Run-Length Encoded List", "Easy", [0], true),
      p(1317, "convert-integer-to-the-sum-of-two-no-zero-integers", "Convert Integer to the Sum of Two No-Zero Integers", "Easy", [20], true),
      p(1323, "maximum-69-number", "Maximum 69 Number", "Easy", [15, 20], true),
      p(1331, "rank-transform-of-an-array", "Rank Transform of an Array", "Easy", [0, 2, 19], true),
      p(1332, "remove-palindromic-subsequences", "Remove Palindromic Subsequences", "Easy", [1, 3], true),
      p(1337, "the-k-weakest-rows-in-a-matrix", "The K Weakest Rows in a Matrix", "Easy", [0, 6, 19], true),
      p(1342, "number-of-steps-to-reduce-a-number-to-zero", "Number of Steps to Reduce a Number to Zero", "Easy", [18, 20], true),
      p(1346, "check-if-n-and-its-double-exist", "Check If N and Its Double Exist", "Easy", [0, 2, 3, 6, 19], true),
      p(1351, "count-negative-numbers-in-a-sorted-matrix", "Count Negative Numbers in a Sorted Matrix", "Easy", [0, 6], true),
      p(1356, "sort-integers-by-the-number-of-1-bits", "Sort Integers by The Number of 1 Bits", "Easy", [0, 18, 19], true),
      p(1360, "number-of-days-between-two-dates", "Number of Days Between Two Dates", "Easy", [1, 20], true),
      p(1365, "how-many-numbers-are-smaller-than-the-current-number", "How Many Numbers Are Smaller Than the Current Number", "Easy", [0, 2, 19], true),
      p(1370, "increasing-decreasing-string", "Increasing Decreasing String", "Easy", [1, 2], true),
      p(1374, "generate-a-string-with-characters-that-have-odd-counts", "Generate a String With Characters That Have Odd Counts", "Easy", [1], true),
      p(1379, "find-a-corresponding-node-of-a-binary-tree-in-a-clone-of-that-tree", "Find a Corresponding Node of a Binary Tree in a Clone of That Tree", "Easy", [10], true),
      p(1380, "lucky-numbers-in-a-matrix", "Lucky Numbers in a Matrix", "Easy", [0], true),
      p(1385, "find-the-distance-value-between-two-arrays", "Find the Distance Value Between Two Arrays", "Easy", [0, 3, 6, 19], true),
      p(1389, "create-target-array-in-the-given-order", "Create Target Array in the Given Order", "Easy", [0], true),
      p(1394, "find-lucky-integer-in-an-array", "Find Lucky Integer in an Array", "Easy", [0, 2], true),
      p(1399, "count-largest-group", "Count Largest Group", "Easy", [2, 20], true),
      p(1403, "minimum-subsequence-in-non-increasing-order", "Minimum Subsequence in Non-Increasing Order", "Easy", [0, 15, 19], true),
      p(1408, "string-matching-in-an-array", "String Matching in an Array", "Easy", [0, 1], true),
      p(1413, "minimum-value-to-get-positive-step-by-step-sum", "Minimum Value to Get Positive Step by Step Sum", "Easy", [0, 5], true),
      p(1417, "reformat-the-string", "Reformat The String", "Easy", [1], true),
      p(1422, "maximum-score-after-splitting-a-string", "Maximum Score After Splitting a String", "Easy", [1, 5], true),
      p(1431, "kids-with-the-greatest-number-of-candies", "Kids With the Greatest Number of Candies", "Easy", [0], true),
      p(1436, "destination-city", "Destination City", "Easy", [0, 1, 2], true),
      p(1441, "build-an-array-with-stack-operations", "Build an Array With Stack Operations", "Medium", [0, 8], true),
      p(1446, "consecutive-characters", "Consecutive Characters", "Easy", [1], true),
      p(1450, "number-of-students-doing-homework-at-a-given-time", "Number of Students Doing Homework at a Given Time", "Easy", [0], true),
      p(1455, "check-if-a-word-occurs-as-a-prefix-of-any-word-in-a-sentence", "Check If a Word Occurs As a Prefix of Any Word in a Sentence", "Easy", [1, 3], true),
      p(1460, "make-two-arrays-equal-by-reversing-sub-arrays", "Make Two Arrays Equal by Reversing Sub-arrays", "Easy", [], false),
      p(1464, "maximum-product-of-two-elements-in-an-array", "Maximum Product of Two Elements in an Array", "Easy", [0, 19], true),
      p(1469, "find-all-the-lonely-nodes", "Find All The Lonely Nodes", "Easy", [10], false),
      p(1470, "shuffle-the-array", "Shuffle the Array", "Easy", [0], true),
      p(1475, "final-prices-with-a-special-discount-in-a-shop", "Final Prices With a Special Discount in a Shop", "Easy", [0, 8], true),
      p(1480, "running-sum-of-1d-array", "Running Sum of 1d Array", "Easy", [0, 5], true),
      p(1486, "xor-operation-in-an-array", "XOR Operation in an Array", "Easy", [18, 20], true),
      p(1491, "average-salary-excluding-the-minimum-and-maximum-salary", "Average Salary Excluding the Minimum and Maximum Salary", "Easy", [0, 19], true),
      p(1496, "path-crossing", "Path Crossing", "Easy", [1, 2], true),
      p(1502, "can-make-arithmetic-progression-from-sequence", "Can Make Arithmetic Progression From Sequence", "Easy", [0, 19], true),
      p(1507, "reformat-date", "Reformat Date", "Easy", [1], true),
      p(1512, "number-of-good-pairs", "Number of Good Pairs", "Easy", [0, 2, 20], true),
      p(1518, "water-bottles", "Water Bottles", "Easy", [20], true),
      p(1523, "count-odd-numbers-in-an-interval-range", "Count Odd Numbers in an Interval Range", "Easy", [20], true),
      p(1528, "shuffle-string", "Shuffle String", "Easy", [0, 1], true),
      p(1534, "count-good-triplets", "Count Good Triplets", "Easy", [0], true),
      p(1539, "kth-missing-positive-number", "Kth Missing Positive Number", "Easy", [0, 6], true),
      p(1544, "make-the-string-great", "Make The String Great", "Easy", [1, 8], true),
      p(1550, "three-consecutive-odds", "Three Consecutive Odds", "Easy", [0], true),
      p(1556, "thousand-separator", "Thousand Separator", "Easy", [1], true),
      p(1560, "most-visited-sector-in-a-circular-track", "Most Visited Sector in a Circular Track", "Easy", [0], true),
      p(1566, "detect-pattern-of-length-m-repeated-k-or-more-times", "Detect Pattern of Length M Repeated K or More Times", "Easy", [0], true),
      p(1572, "matrix-diagonal-sum", "Matrix Diagonal Sum", "Easy", [0], true),
      p(1576, "replace-all-s-to-avoid-consecutive-repeating-characters", "Replace All ?'s to Avoid Consecutive Repeating Characters", "Easy", [1], true),
      p(1582, "special-positions-in-a-binary-matrix", "Special Positions in a Binary Matrix", "Easy", [0], true),
      p(1588, "sum-of-all-odd-length-subarrays", "Sum of All Odd Length Subarrays", "Easy", [0, 5, 20], true),
      p(1592, "rearrange-spaces-between-words", "Rearrange Spaces Between Words", "Easy", [1], true),
      p(1598, "crawler-log-folder", "Crawler Log Folder", "Easy", [0, 1, 8], true),
      p(1603, "design-parking-system", "Design Parking System", "Easy", [], true),
      p(1608, "special-array-with-x-elements-greater-than-or-equal-x", "Special Array With X Elements Greater Than or Equal X", "Easy", [0, 6, 19], true),
      p(1614, "maximum-nesting-depth-of-the-parentheses", "Maximum Nesting Depth of the Parentheses", "Easy", [1, 8], true),
      p(1620, "coordinate-with-maximum-network-quality", "Coordinate With Maximum Network Quality", "Medium", [0], true),
      p(1624, "largest-substring-between-two-equal-characters", "Largest Substring Between Two Equal Characters", "Easy", [1, 2], true),
      p(1629, "slowest-key", "Slowest Key", "Easy", [0, 1], true),
      p(1633, "percentage-of-letter-in-string", "Percentage of Letter in String", "Easy", [1], true),
      p(1636, "sort-array-by-increasing-frequency", "Sort Array by Increasing Frequency", "Easy", [0, 2, 19], true),
      p(1637, "widest-vertical-area-between-two-points-containing-no-points", "Widest Vertical Area Between Two Points Containing No Points", "Easy", [0, 19], true),
      p(1640, "check-array-formation-through-concatenation", "Check Array Formation Through Concatenation", "Easy", [0, 2], true),
      p(1646, "get-maximum-in-generated-array", "Get Maximum in Generated Array", "Easy", [0], true),
      p(1652, "defuse-the-bomb", "Defuse the Bomb", "Easy", [0, 4], true),
      p(1656, "design-an-ordered-stream", "Design an Ordered Stream", "Easy", [0, 2], true),
      p(1662, "check-if-two-string-arrays-are-equivalent", "Check If Two String Arrays are Equivalent", "Easy", [0, 1], true),
      p(1668, "maximum-repeating-substring", "Maximum Repeating Substring", "Easy", [1, 16], true),
      p(1672, "richest-customer-wealth", "Richest Customer Wealth", "Easy", [0], true),
      p(1678, "goal-parser-interpretation", "Goal Parser Interpretation", "Easy", [1], true),
      p(1684, "count-the-number-of-consistent-strings", "Count the Number of Consistent Strings", "Easy", [0, 1, 2, 18], true),
      p(1688, "count-of-matches-in-tournament", "Count of Matches in Tournament", "Easy", [20], true),
      p(1694, "reformat-phone-number", "Reformat Phone Number", "Easy", [1], true),
      p(1700, "number-of-students-unable-to-eat-lunch", "Number of Students Unable to Eat Lunch", "Easy", [0, 8, 9], true),
      p(1704, "determine-if-string-halves-are-alike", "Determine if String Halves Are Alike", "Easy", [1], true),
      p(1710, "maximum-units-on-a-truck", "Maximum Units on a Truck", "Easy", [0, 15, 19], true),
      p(1716, "calculate-money-in-leetcode-bank", "Calculate Money in LeetCode Bank", "Easy", [20], true),
      p(1720, "decode-xored-array", "Decode XORed Array", "Easy", [0, 18], true),
      p(1725, "number-of-rectangles-that-can-form-the-largest-square", "Number Of Rectangles That Can Form The Largest Square", "Easy", [0], true),
      p(1732, "find-the-highest-altitude", "Find the Highest Altitude", "Easy", [0, 5], true),
      p(1736, "latest-time-by-replacing-hidden-digits", "Latest Time by Replacing Hidden Digits", "Easy", [1, 15], true),
      p(1741, "find-total-time-spent-by-each-employee", "Find Total Time Spent by Each Employee", "Easy", [], true),
      p(1742, "maximum-number-of-balls-in-a-box", "Maximum Number of Balls in a Box", "Easy", [2, 20], true),
      p(1748, "sum-of-unique-elements", "Sum of Unique Elements", "Easy", [0, 2], true),
      p(1752, "check-if-array-is-sorted-and-rotated", "Check if Array Is Sorted and Rotated", "Easy", [0], true),
      p(1758, "minimum-changes-to-make-alternating-binary-string", "Minimum Changes To Make Alternating Binary String", "Easy", [1], true),
      p(1763, "sum-of-prefix-scores-of-strings", "Sum of Prefix Scores of Strings", "Hard", [0, 1, 17], true),
      p(1768, "merge-strings-alternately", "Merge Strings Alternately", "Easy", [1, 3], true),
      p(1773, "count-items-matching-a-rule", "Count Items Matching a Rule", "Easy", [0, 1], true),
      p(1779, "find-nearest-point-that-has-the-same-x-or-y-coordinate", "Find Nearest Point That Has the Same X or Y Coordinate", "Easy", [0], true),
      p(1784, "check-if-binary-string-has-at-most-one-segment-of-ones", "Check if Binary String Has at Most One Segment of Ones", "Easy", [1], true),
      p(1790, "check-if-one-string-swap-can-make-strings-equal", "Check if One String Swap Can Make Strings Equal", "Easy", [1, 2], true),
      p(1791, "find-center-of-star-graph", "Find Center of Star Graph", "Easy", [], true),
      p(1796, "second-largest-digit-in-a-string", "Second Largest Digit in a String", "Easy", [1, 2], true),
      p(1800, "maximum-ascending-subarray-sum", "Maximum Ascending Subarray Sum", "Easy", [0], true),
      p(1805, "number-of-different-integers-in-a-string", "Number of Different Integers in a String", "Easy", [1, 2], true),
      p(1812, "determine-color-of-a-chessboard-square", "Determine Color of a Chessboard Square", "Easy", [1, 20], true),
      p(1816, "truncate-sentence", "Truncate Sentence", "Easy", [0, 1], true),
      p(1822, "sign-of-the-product-of-an-array", "Sign of the Product of an Array", "Easy", [0, 20], true),
      p(1827, "minimum-operations-to-make-the-array-increasing", "Minimum Operations to Make the Array Increasing", "Easy", [0, 15], true),
      p(1832, "check-if-the-sentence-is-pangram", "Check if the Sentence Is Pangram", "Easy", [1, 2], true),
      p(1837, "sum-of-digits-in-base-k", "Sum of Digits in Base K", "Easy", [20], true),
      p(1844, "replace-all-digits-with-characters", "Replace All Digits with Characters", "Easy", [1], true),
      p(1848, "minimum-distance-to-the-target-element", "Minimum Distance to the Target Element", "Easy", [0], true),
      p(1854, "maximum-population-year", "Maximum Population Year", "Easy", [0, 5], true),
      p(1859, "sorting-the-sentence", "Sorting the Sentence", "Easy", [1, 19], true),
      p(1863, "sum-of-all-subset-xor-totals", "Sum of All Subset XOR Totals", "Easy", [0, 14, 18, 20, 23], true),
      p(1869, "longer-contiguous-segments-of-ones-than-zeros", "Longer Contiguous Segments of Ones than Zeros", "Easy", [1], true),
      p(1876, "substrings-of-size-three-with-distinct-characters", "Substrings of Size Three with Distinct Characters", "Easy", [1, 2, 4], true),
      p(1880, "check-if-word-equals-summation-of-two-words", "Check if Word Equals Summation of Two Words", "Easy", [1], true),
      p(1886, "determine-whether-matrix-can-be-obtained-by-rotation", "Determine Whether Matrix Can Be Obtained By Rotation", "Easy", [0], true),
      p(1893, "check-if-all-the-integers-in-a-range-are-covered", "Check if All the Integers in a Range Are Covered", "Easy", [0, 2, 5], true),
      p(1897, "redistribute-characters-to-make-all-strings-equal", "Redistribute Characters to Make All Strings Equal", "Easy", [1, 2], true),
      p(1903, "largest-odd-number-in-string", "Largest Odd Number in String", "Easy", [1, 15, 20], true),
      p(1909, "remove-one-element-to-make-the-array-strictly-increasing", "Remove One Element to Make the Array Strictly Increasing", "Easy", [0], true),
      p(1913, "maximum-product-difference-between-two-pairs", "Maximum Product Difference Between Two Pairs", "Easy", [0, 19], true),
      p(1920, "build-array-from-permutation", "Build Array from Permutation", "Easy", [0], true),
      p(1925, "count-square-sum-triples", "Count Square Sum Triples", "Easy", [20], true),
      p(1929, "concatenation-of-array", "Concatenation of Array", "Easy", [0], true),
      p(1935, "maximum-number-of-words-you-can-type", "Maximum Number of Words You Can Type", "Easy", [1, 2], true),
      p(1941, "check-if-all-characters-have-equal-number-of-occurrences", "Check if All Characters Have Equal Number of Occurrences", "Easy", [1, 2], true),
      p(1945, "sum-of-digits-of-string-after-convert", "Sum of Digits of String After Convert", "Easy", [1], true),
      p(1952, "three-divisors", "Three Divisors", "Easy", [20, 21], true),
      p(1957, "delete-characters-to-make-fancy-string", "Delete Characters to Make Fancy String", "Easy", [1], true),
      p(1961, "check-if-string-is-a-prefix-of-array", "Check If String Is a Prefix of Array", "Easy", [0, 1, 3], true),
      p(1967, "number-of-strings-that-appear-as-substrings-in-word", "Number of Strings That Appear as Substrings in Word", "Easy", [0, 1], true),
      p(1971, "find-if-path-exists-in-graph", "Find if Path Exists in Graph", "Easy", [], true),
      p(1974, "minimum-time-to-type-word-using-special-typewriter", "Minimum Time to Type Word Using Special Typewriter", "Easy", [1, 15], true),
      p(1979, "find-greatest-common-divisor-of-array", "Find Greatest Common Divisor of Array", "Easy", [0, 20, 21], true),
      p(1984, "minimum-difference-between-highest-and-lowest-of-k-scores", "Minimum Difference Between Highest and Lowest of K Scores", "Easy", [0, 4, 19], true),
      p(1988, "find-cutoff-score-for-each-school", "Find Cutoff Score for Each School", "Medium", [], false),
      p(1991, "find-the-middle-index-in-array", "Find the Middle Index in Array", "Easy", [0, 5], true),
      p(1995, "count-special-quadruplets", "Count Special Quadruplets", "Easy", [0, 2], true),
      p(2000, "reverse-prefix-of-word", "Reverse Prefix of Word", "Easy", [1, 3, 8], true),
      p(2006, "count-number-of-pairs-with-absolute-difference-k", "Count Number of Pairs With Absolute Difference K", "Easy", [0, 2], true),
      p(2011, "final-value-of-variable-after-performing-operations", "Final Value of Variable After Performing Operations", "Easy", [0, 1], true),
      p(2016, "maximum-difference-between-increasing-elements", "Maximum Difference Between Increasing Elements", "Easy", [0], true),
      p(2022, "convert-1d-array-into-2d-array", "Convert 1D Array Into 2D Array", "Easy", [0], true),
      p(2027, "minimum-moves-to-convert-string", "Minimum Moves to Convert String", "Easy", [1, 15], true),
      p(2032, "two-out-of-three", "Two Out of Three", "Easy", [0, 2, 18], true),
      p(2037, "minimum-number-of-moves-to-seat-everyone", "Minimum Number of Moves to Seat Everyone", "Easy", [0, 15, 19], true),
      p(2042, "check-if-numbers-are-ascending-in-a-sentence", "Check if Numbers Are Ascending in a Sentence", "Easy", [1], true),
      p(2047, "number-of-valid-words-in-a-sentence", "Number of Valid Words in a Sentence", "Easy", [1], true),
      p(2053, "kth-distinct-string-in-an-array", "Kth Distinct String in an Array", "Easy", [0, 1, 2], true),
      p(2057, "smallest-index-with-equal-value", "Smallest Index With Equal Value", "Easy", [0], true),
      p(2062, "count-vowel-substrings-of-a-string", "Count Vowel Substrings of a String", "Easy", [1, 2], true),
      p(2068, "check-whether-two-strings-are-almost-equivalent", "Check Whether Two Strings are Almost Equivalent", "Easy", [1, 2], true),
      p(2073, "time-needed-to-buy-tickets", "Time Needed to Buy Tickets", "Easy", [0, 9], true),
      p(2078, "two-furthest-houses-with-different-colors", "Two Furthest Houses With Different Colors", "Easy", [0, 15], true),
      p(2085, "count-common-words-with-one-occurrence", "Count Common Words With One Occurrence", "Easy", [0, 1, 2], true),
      p(2089, "find-target-indices-after-sorting-array", "Find Target Indices After Sorting Array", "Easy", [0, 6, 19], true),
      p(2094, "finding-3-digit-even-numbers", "Finding 3-Digit Even Numbers", "Easy", [0, 2, 19], true),
      p(2099, "find-subsequence-of-length-k-with-the-largest-sum", "Find Subsequence of Length K With the Largest Sum", "Easy", [0, 2, 19], true),
      p(2103, "rings-and-rods", "Rings and Rods", "Easy", [1, 2], true),
      p(2108, "find-first-palindromic-string-in-the-array", "Find First Palindromic String in the Array", "Easy", [0, 1, 3], true),
      p(2114, "maximum-number-of-words-found-in-sentences", "Maximum Number of Words Found in Sentences", "Easy", [0, 1], true),
      p(2119, "a-number-after-a-double-reversal", "A Number After a Double Reversal", "Easy", [20], true),
      p(2124, "check-if-all-as-appears-before-all-bs", "Check if All A's Appears Before All B's", "Easy", [1], true),
      p(2129, "capitalize-the-title", "Capitalize the Title", "Easy", [1], true),
      p(2133, "check-if-every-row-and-column-contains-all-numbers", "Check if Every Row and Column Contains All Numbers", "Easy", [0, 2], true),
      p(2138, "divide-a-string-into-groups-of-size-k", "Divide a String Into Groups of Size k", "Easy", [1], true),
      p(2144, "minimum-cost-of-buying-candies-with-discount", "Minimum Cost of Buying Candies With Discount", "Easy", [0, 15, 19], true),
      p(2148, "count-elements-with-strictly-smaller-and-greater-elements", "Count Elements With Strictly Smaller and Greater Elements", "Easy", [0, 19], true),
      p(2154, "keep-multiplying-found-values-by-two", "Keep Multiplying Found Values by Two", "Easy", [0, 2, 19], true),
      p(2159, "two-out-of-three-approach", "Two Out of Three", "Easy", [], false),
      p(2160, "minimum-sum-of-four-digit-number-after-splitting-digits", "Minimum Sum of Four Digit Number After Splitting Digits", "Easy", [15, 19, 20], true),
      p(2164, "sort-even-and-odd-indices-independently", "Sort Even and Odd Indices Independently", "Easy", [0, 19], true),
      p(2169, "count-operations-to-obtain-zero", "Count Operations to Obtain Zero", "Easy", [20], true),
      p(2176, "count-equal-and-divisible-pairs-in-an-array", "Count Equal and Divisible Pairs in an Array", "Easy", [0], true),
      p(2180, "count-integers-with-even-digit-sum", "Count Integers With Even Digit Sum", "Easy", [20], true),
      p(2185, "counting-words-with-a-given-prefix", "Counting Words With a Given Prefix", "Easy", [0, 1], true),
      p(2190, "nums-divisible-by-4-and-6", "Nums Divisible by 4 and 6", "Easy", [], false),
      p(2194, "cells-in-a-range-on-an-excel-sheet", "Cells in a Range on an Excel Sheet", "Easy", [1], true),
      p(2199, "finding-the-users-active-minutes", "Finding the Users Active Minutes", "Medium", [0, 2], true),
      p(2200, "find-all-k-distant-indices-in-an-array", "Find All K-Distant Indices in an Array", "Easy", [0, 3], true),
      p(2206, "divide-array-into-equal-pairs", "Divide Array Into Equal Pairs", "Easy", [0, 2, 18], true),
      p(2210, "count-hills-and-valleys-in-an-array", "Count Hills and Valleys in an Array", "Easy", [0], true),
      p(2215, "find-the-difference-of-two-arrays", "Find the Difference of Two Arrays", "Easy", [0, 2], true),
      p(2220, "minimum-bit-flips-to-convert-number", "Minimum Bit Flips to Convert Number", "Easy", [18], true),
      p(2224, "minimum-number-of-operations-to-convert-time", "Minimum Number of Operations to Convert Time", "Easy", [1, 15], true),
      p(2229, "check-if-an-array-is-consecutive", "Check if an Array Is Consecutive", "Easy", [0, 2, 19], false),
      p(2231, "largest-number-after-digit-swaps-by-parity", "Largest Number After Digit Swaps By Parity", "Easy", [19], true),
      p(2235, "add-two-integers", "Add Two Integers", "Easy", [20], true),
      p(2236, "root-equals-sum-of-children", "Root Equals Sum of Children", "Easy", [10], true),
      p(2239, "find-closest-number-to-zero", "Find Closest Number to Zero", "Easy", [0], true),
      p(2243, "calculate-digit-sum-of-a-string", "Calculate Digit Sum of a String", "Easy", [1], true),
      p(2248, "intersection-of-multiple-arrays", "Intersection of Multiple Arrays", "Easy", [0, 2, 19], true),
      p(2255, "count-prefixes-of-a-given-string", "Count Prefixes of a Given String", "Easy", [0, 1], true),
      p(2259, "remove-digit-from-number-to-maximize-result", "Remove Digit From Number to Maximize Result", "Easy", [1, 15], true),
      p(2264, "largest-3-same-digit-number-in-string", "Largest 3-Same-Digit Number in String", "Easy", [1], true),
      p(2269, "find-the-k-beauty-of-a-number", "Find the K-Beauty of a Number", "Easy", [1, 4, 20], true),
      p(2273, "find-resultant-array-after-removing-anagrams", "Find Resultant Array After Removing Anagrams", "Easy", [0, 1, 2, 19], true),
      p(2278, "percentage-of-letter-in-string-ii", "Percentage of Letter in String", "Easy", [], false),
      p(2283, "check-if-number-has-equal-digit-count-and-digit-value", "Check if Number Has Equal Digit Count and Digit Value", "Easy", [1, 2], true),
      p(2287, "rearrange-characters-to-make-target-string", "Rearrange Characters to Make Target String", "Easy", [1, 2], true),
      p(2293, "min-max-game", "Min Max Game", "Easy", [0], true),
      p(2299, "strong-password-checker-ii", "Strong Password Checker II", "Easy", [1], true),
      p(2303, "calculate-amount-paid-in-taxes", "Calculate Amount Paid in Taxes", "Easy", [0], true),
      p(2309, "greatest-english-letter-in-upper-and-lower-case", "Greatest English Letter in Upper and Lower Case", "Easy", [1, 2], true),
      p(2315, "count-asterisks", "Count Asterisks", "Easy", [1], true),
      p(2319, "check-if-matrix-is-x-matrix", "Check if Matrix Is X-Matrix", "Easy", [0], true),
      p(2325, "decode-the-message", "Decode the Message", "Easy", [1, 2], true),
      p(2331, "evaluate-boolean-binary-tree", "Evaluate Boolean Binary Tree", "Easy", [10], true),
      p(2335, "minimum-amount-of-time-to-fill-cups", "Minimum Amount of Time to Fill Cups", "Easy", [0, 15, 19], true),
      p(2339, "atheletes-and-trainers-approach", "Atheletes and Trainers", "Easy", [], false),
      p(2341, "maximum-number-of-pairs-in-array", "Maximum Number of Pairs in Array", "Easy", [0, 2], true),
      p(2347, "best-poker-hand", "Best Poker Hand", "Easy", [0, 2], true),
      p(2351, "first-letter-to-appear-twice", "First Letter to Appear Twice", "Easy", [1, 2, 18], true),
      p(2357, "make-array-zero-by-subtracting-equal-amounts", "Make Array Zero by Subtracting Equal Amounts", "Easy", [0, 2, 15, 19], true),
      p(2363, "merge-similar-items", "Merge Similar Items", "Easy", [0, 2, 19], true),
      p(2367, "number-of-arithmetic-triplets", "Number of Arithmetic Triplets", "Easy", [0, 2, 3], true),
      p(2373, "largest-local-values-in-a-matrix", "Largest Local Values in a Matrix", "Easy", [0], true),
      p(2379, "minimum-recolors-to-get-k-consecutive-black-blocks", "Minimum Recolors to Get K Consecutive Black Blocks", "Easy", [1, 4], true),
      p(2383, "minimum-hours-of-training-to-win-a-competition", "Minimum Hours of Training to Win a Competition", "Easy", [0, 15], true),
      p(2389, "longest-subsequence-with-limited-sum", "Longest Subsequence With Limited Sum", "Easy", [0, 5, 6, 15, 19], true),
      p(2395, "find-subarrays-with-equal-sum", "Find Subarrays With Equal Sum", "Easy", [0, 2], true),
      p(2399, "check-distances-between-same-letters", "Check Distances Between Same Letters", "Easy", [0, 1, 2], true),
      p(2404, "most-frequent-even-element", "Most Frequent Even Element", "Easy", [0, 2], true),
      p(2409, "count-days-spent-together", "Count Days Spent Together", "Easy", [1, 20], true),
      p(2413, "smallest-even-multiple", "Smallest Even Multiple", "Easy", [20, 21], true),
      p(2418, "sort-the-people", "Sort the People", "Easy", [0, 1, 2, 19], true),
      p(2423, "remove-letter-to-equalize-frequency", "Remove Letter To Equalize Frequency", "Easy", [1, 2], true),
      p(2427, "number-of-common-factors", "Number of Common Factors", "Easy", [20, 21], true),
      p(2432, "the-employee-that-worked-on-the-longest-task", "The Employee That Worked on the Longest Task", "Easy", [0], true),
      p(2437, "number-of-valid-clock-times", "Number of Valid Clock Times", "Easy", [1], true),
      p(2441, "largest-positive-integer-that-exists-with-its-negative", "Largest Positive Integer That Exists With Its Negative", "Easy", [0, 2, 3, 19], true),
      p(2446, "determine-if-two-events-have-conflict", "Determine if Two Events Have Conflict", "Easy", [0, 1], true),
      p(2451, "odd-string-difference", "Odd String Difference", "Easy", [0, 1, 2], true),
      p(2455, "average-value-of-even-numbers-that-are-divisible-by-three", "Average Value of Even Numbers That Are Divisible by Three", "Easy", [0, 20], true),
      p(2460, "apply-operations-to-an-array", "Apply Operations to an Array", "Easy", [0, 3], true),
      p(2465, "number-of-distinct-averages", "Number of Distinct Averages", "Easy", [0, 2, 3, 19], true),
      p(2469, "convert-the-temperature", "Convert the Temperature", "Easy", [20], true),
      p(2475, "number-of-unequal-triplets-in-array", "Number of Unequal Triplets in Array", "Easy", [0, 2, 19], true),
      p(2481, "minimum-cuts-to-divide-a-circle", "Minimum Cuts to Divide a Circle", "Easy", [20], true),
      p(2485, "find-the-pivot-integer", "Find the Pivot Integer", "Easy", [5, 20], true),
      p(2490, "circular-sentence", "Circular Sentence", "Easy", [1], true),
      p(2496, "maximum-value-of-a-string-in-an-array", "Maximum Value of a String in an Array", "Easy", [0, 1], true),
      p(2500, "delete-greatest-value-in-each-row", "Delete Greatest Value in Each Row", "Easy", [0, 19], true),
      p(2506, "count-pairs-of-similar-strings", "Count Pairs of Similar Strings", "Easy", [0, 1, 2, 18], true),
      p(2511, "maximum-enemy-forts-that-can-be-captured", "Maximum Enemy Forts That Can Be Captured", "Easy", [0, 3], true),
      p(2515, "shortest-distance-to-target-string-in-a-circular-array", "Shortest Distance to Target String in a Circular Array", "Easy", [0, 1], true),
      p(2520, "count-the-digits-that-divide-a-number", "Count the Digits That Divide a Number", "Easy", [20], true),
      p(2525, "categorize-box-according-to-criteria", "Categorize Box According to Criteria", "Easy", [20], true),
      p(2529, "maximum-count-of-positive-integer-and-negative-integer", "Maximum Count of Positive Integer and Negative Integer", "Easy", [0, 6], true),
      p(2535, "difference-between-element-sum-and-digit-sum-of-an-array", "Difference Between Element Sum and Digit Sum of an Array", "Easy", [0, 20], true),
      p(2540, "minimum-common-value", "Minimum Common Value", "Easy", [0, 2, 3, 6], true),
      p(2544, "alternating-digit-sum", "Alternating Digit Sum", "Easy", [20], true),
      p(2549, "count-distinct-numbers-on-board", "Count Distinct Numbers on Board", "Easy", [0, 2, 20], true),
      p(2553, "separate-the-digits-in-an-array", "Separate the Digits in an Array", "Easy", [0], true),
      p(2558, "take-gifts-from-the-richest-pile", "Take Gifts From the Richest Pile", "Easy", [0], true),
      p(2562, "find-the-array-concatenation-value", "Find the Array Concatenation Value", "Easy", [0, 3], true),
      p(2566, "maximum-difference-by-remapping-a-digit", "Maximum Difference by Remapping a Digit", "Easy", [15, 20], true),
      p(2570, "merge-two-2d-arrays-by-summing-values", "Merge Two 2D Arrays by Summing Values", "Easy", [0, 2, 3], true),
      p(2574, "left-and-right-sum-differences", "Left and Right Sum Differences", "Easy", [0, 5], true),
      p(2578, "split-with-minimum-sum", "Split With Minimum Sum", "Easy", [15, 19, 20], true),
      p(2582, "pass-the-pillow", "Pass the Pillow", "Easy", [20], true),
      p(2586, "count-the-number-of-vowel-strings-in-range", "Count the Number of Vowel Strings in Range", "Easy", [0, 1], true),
      p(2591, "distribute-money-to-maximum-children", "Distribute Money to Maximum Children", "Easy", [15, 20], true),
      p(2595, "number-of-even-and-odd-bits", "Number of Even and Odd Bits", "Easy", [18], true),
      p(2600, "k-items-with-the-maximum-sum", "K Items With the Maximum Sum", "Easy", [15, 20], true),
      p(2605, "form-smallest-number-from-two-digit-arrays", "Form Smallest Number From Two Digit Arrays", "Easy", [0, 2], true),
      p(2609, "find-the-longest-balanced-substring-of-a-binary-string", "Find the Longest Balanced Substring of a Binary String", "Easy", [1], true),
      p(2614, "prime-in-diagonal", "Prime in Diagonal", "Easy", [0, 20, 21], true),
      p(2619, "array-prototype-last", "Array Prototype Last", "Easy", [], true),
      p(2620, "counter", "Counter", "Easy", [], true),
      p(2621, "sleep", "Sleep", "Easy", [], true),
      p(2626, "array-reduce-transformation", "Array Reduce Transformation", "Easy", [], true),
      p(2629, "function-composition", "Function Composition", "Easy", [], true),
      p(2634, "filter-elements-from-array", "Filter Elements from Array", "Easy", [], true),
      p(2635, "apply-transform-over-each-element-in-array", "Apply Transform Over Each Element in Array", "Easy", [], true),
      p(2642, "design-graph-with-shortest-path-calculator", "Design Graph With Shortest Path Calculator", "Hard", [], true),
      p(2648, "generate-fibonacci-sequence", "Generate Fibonacci Sequence", "Easy", [], true),
      p(2649, "nested-array-generator", "Nested Array Generator", "Medium", [], true),
      p(2665, "counter-ii", "Counter II", "Easy", [], true),
      p(2666, "allow-one-function-call", "Allow One Function Call", "Easy", [], true),
      p(2667, "create-hello-world-function", "Create Hello World Function", "Easy", [], true),
      p(2676, "throttle", "Throttle", "Medium", [], false),
      p(2677, "chunk-array", "Chunk Array", "Easy", [], true),
      p(2695, "array-wrapper", "Array Wrapper", "Easy", [], true),
      p(2703, "return-length-of-arguments-passed", "Return Length of Arguments Passed", "Easy", [], true),
      p(2704, "to-be-or-not-to-be", "To Be Or Not To Be", "Easy", [], true),
      p(2705, "compact-object", "Compact Object", "Medium", [], true),
      p(2710, "remove-trailing-zeros-from-a-string", "Remove Trailing Zeros From a String", "Easy", [1], true),
      p(2715, "timeout-cancellation", "Timeout Cancellation", "Easy", [], true),
      p(2716, "minimize-string-length", "Minimize String Length", "Easy", [1, 2], true),
      p(2721, "execute-asynchronous-functions-in-parallel", "Execute Asynchronous Functions in Parallel", "Medium", [], true),
      p(2724, "sort-by", "Sort By", "Easy", [], true),
      p(2726, "calculator-with-method-chaining", "Calculator with Method Chaining", "Easy", [], true),
      p(2727, "is-object-empty", "Is Object Empty", "Easy", [], true),
      p(2732, "find-a-good-subset-of-the-matrix", "Find a Good Subset of the Matrix", "Hard", [0, 2, 18], true),
      p(2733, "neither-minimum-nor-maximum", "Neither Minimum nor Maximum", "Easy", [0, 19], true),
      p(2739, "total-distance-traveled", "Total Distance Traveled", "Easy", [20], true),
      p(2742, "painting-the-walls", "Painting the Walls", "Hard", [0, 16], true),
      p(2744, "find-maximum-number-of-string-pairs", "Find Maximum Number of String Pairs", "Easy", [0, 1, 2], true),
      p(2748, "number-of-beautiful-pairs", "Number of Beautiful Pairs", "Easy", [0, 2, 20, 21], true),
      p(2756, "query-batching", "Query Batching", "Hard", [], false),
      p(2769, "find-the-maximum-achievable-number", "Find the Maximum Achievable Number", "Easy", [20], true),
      p(2773, "height-of-special-binary-tree", "Height of Special Binary Tree", "Medium", [10], false),
      p(2778, "sum-of-squares-of-special-elements", "Sum of Squares of Special Elements", "Easy", [0], true),
      p(2784, "check-if-array-is-good", "Check if Array is Good", "Easy", [0, 2, 19], true),
      p(2788, "split-strings-by-separator", "Split Strings by Separator", "Easy", [0, 1], true),
      p(2792, "count-nodes-that-are-good-enough", "Count Nodes That Are Good Enough", "Medium", [], false),
      p(2798, "number-of-employees-who-met-the-target", "Number of Employees Who Met the Target", "Easy", [0], true),
      p(2802, "find-the-k-th-lucky-number", "Find The K-th Lucky Number", "Medium", [1, 18, 20], false),
      p(2806, "account-balance-after-rounded-purchase", "Account Balance After Rounded Purchase", "Easy", [20], true),
      p(2810, "faulty-keyboard", "Faulty Keyboard", "Easy", [1], true),
      p(2815, "max-pair-sum-in-an-array", "Max Pair Sum in an Array", "Easy", [0, 2], true),
      p(2824, "count-pairs-whose-sum-is-less-than-target", "Count Pairs Whose Sum is Less than Target", "Easy", [0, 3, 6, 19], true),
      p(2828, "check-if-a-string-is-an-acronym-of-words", "Check if a String Is an Acronym of Words", "Easy", [0, 1], true),
      p(2833, "furthest-point-from-origin", "Furthest Point From Origin", "Easy", [1], true),
      p(2843, "count-symmetric-integers", "Count Symmetric Integers", "Easy", [20], true),
      p(2848, "points-that-intersect-with-segments", "Points That Intersect With Segments", "Easy", [], false),
      p(2855, "minimum-right-shifts-to-sort-the-array", "Minimum Right Shifts to Sort the Array", "Easy", [0], true),
      p(2864, "maximum-odd-binary-number", "Maximum Odd Binary Number", "Easy", [1, 15, 20], true),
      p(2869, "minimum-operations-to-collect-elements", "Minimum Operations to Collect Elements", "Easy", [0, 2, 18], true),
      p(2873, "maximum-value-of-an-ordered-triplet-i", "Maximum Value of an Ordered Triplet I", "Easy", [0, 5], true),
      p(2877, "create-a-data-structure-from-a-matrix", "Create a Data Structure From a Matrix", "Medium", [], false),
      p(2879, "declare-the-result-of-a-statement", "Declare the Result of a Statement", "Easy", [], false),
      p(2883, "data-selection", "Data Selection", "Medium", [], false),
      p(2894, "divisible-and-non-divisible-sums-difference", "Divisible and Non-Divisible Sums Difference", "Easy", [20], true),
      p(2899, "last-visited-integers", "Last Visited Integers", "Easy", [0], true),
      p(2903, "find-indices-with-index-and-value-difference-i", "Find Indices With Index and Value Difference I", "Easy", [0, 3], true),
      p(2908, "minimum-sum-of-mountain-triplets-i", "Minimum Sum of Mountain Triplets I", "Easy", [0], true),
      p(2913, "subarrays-distinct-element-sum-of-squares-i", "Subarrays Distinct Element Sum of Squares I", "Easy", [0, 2, 22], true),
      p(2917, "find-the-integer-added-to-array-i", "Find the Integer Added to Array I", "Easy", [0], true),
      p(2923, "find-champion-i", "Find Champion I", "Easy", [0], true),
      p(2928, "distribute-candies-among-children-i", "Distribute Candies Among Children I", "Easy", [20, 23], true),
      p(2932, "maximum-strong-pair-xor-i", "Maximum Strong Pair XOR I", "Easy", [0, 2, 4, 17, 18], true),
      p(2937, "prefix-and-suffix-search-iii", "Prefix and Suffix Search III", "Medium", [], false),
      p(2942, "find-words-containing-character", "Find Words Containing Character", "Easy", [0, 1], true),
      p(2946, "matrix-similarity-after-cyclic-shifts", "Matrix Similarity After Cyclic Shifts", "Easy", [0, 20], true),
      p(2951, "find-the-peaks", "Find the Peaks", "Easy", [0], true),
      p(2956, "find-common-elements-between-two-arrays", "Find Common Elements Between Two Arrays", "Easy", [0, 2], true),
      p(2960, "count-tested-devices", "Count Tested Devices", "Easy", [], false),
      p(2965, "find-missing-and-repeated-values", "Find Missing and Repeated Values", "Easy", [0, 2, 20], true),
      p(2970, "count-the-number-of-incremovable-subarrays-i", "Count the Number of Incremovable Subarrays I", "Easy", [0, 3, 6], true),
      p(2974, "minimum-number-game", "Minimum Number Game", "Easy", [0, 19], true),
      p(2980, "check-if-bitwise-or-has-trailing-zeros", "Check if Bitwise OR Has Trailing Zeros", "Easy", [0, 18], true),
      p(2984, "find-peak-hours", "Find Peak Hours", "Medium", [], false),
      p(3005, "count-elements-with-maximum-frequency", "Count Elements With Maximum Frequency", "Easy", [0, 2], true),
      p(3010, "divide-an-array-into-subarrays-with-minimum-cost-i", "Divide an Array Into Subarrays With Minimum Cost I", "Easy", [0, 19], true),
      p(3014, "minimum-number-of-pushes-to-type-word-i", "Minimum Number of Pushes to Type Word I", "Easy", [1, 15, 20], true),
      p(3019, "number-of-changing-keys", "Number of Changing Keys", "Easy", [1], true),
      p(3024, "type-of-triangle", "Type of Triangle", "Easy", [0, 19, 20], true),
      p(3028, "ant-on-the-boundary", "Ant on the Boundary", "Easy", [0, 5], true),
      p(3032, "count-numbers-with-unique-digits-ii", "Count Numbers With Unique Digits II", "Easy", [2, 16, 20], false),
      p(3033, "modify-the-matrix", "Modify the Matrix", "Easy", [0], true),
      p(3038, "maximum-number-of-operations-with-the-same-score-i", "Maximum Number of Operations With the Same Score I", "Easy", [0], true),
      p(3042, "count-prefix-and-suffix-pairs-i", "Count Prefix and Suffix Pairs I", "Easy", [0, 1, 2, 17], true),
      p(3046, "split-the-array", "Split the Array", "Easy", [0, 2], true),
      p(3056, "snaps-in-a-grid", "Snaps in a Grid", "Medium", [], false),
      p(3057, "employees-project-allocation", "Employees Project Allocation", "Hard", [], false),
      p(3058, "friends-with-odd-sum-of-tags", "Friends With Odd Sum of Tags", "Medium", [], false),
      p(3062, "winner-of-the-linked-list-game", "Winner of the Linked List Game", "Easy", [7], false),
      p(3063, "linked-list-frequency", "Linked List Frequency", "Easy", [2, 7], false),
      p(3069, "distribute-elements-into-two-arrays-i", "Distribute Elements Into Two Arrays I", "Easy", [0, 3], true),
      p(3073, "maximum-triplets-sum-in-an-array", "Maximum Triplet Sum in an Array", "Medium", [], false),
      p(3079, "encrypt-the-string-i", "Encrypt the String I", "Medium", [], false),
      p(3084, "count-substrings-starting-and-ending-with-given-character", "Count Substrings Starting and Ending with Given Character", "Medium", [1, 20], true),
      p(3089, "find-employees-process-tasks-approach", "Find Employees Process Tasks", "Easy", [], false),
      p(3095, "shortest-subarray-with-or-at-least-k-i", "Shortest Subarray With OR at Least K I", "Easy", [0, 4, 18], true),
      p(3099, "harshad-number", "Harshad Number", "Easy", [20], true),
      p(3101, "count-alternating-subarrays", "Count Alternating Subarrays", "Medium", [0, 20], true),
      p(3105, "longest-strictly-increasing-or-strictly-decreasing-subarray", "Longest Strictly Increasing Or Strictly Decreasing Subarray", "Easy", [0], true),
      p(3110, "score-of-a-string", "Score of a String", "Easy", [1], true),
      p(3114, "latest-time-you-can-obtain-after-replacing-characters", "Latest Time You Can Obtain After Replacing Characters", "Easy", [1], true),
      p(3115, "maximum-prime-difference", "Maximum Prime Difference", "Medium", [0, 20, 21], true),
      p(3120, "count-the-number-of-special-characters-i", "Count the Number of Special Characters I", "Easy", [1, 2], true),
      p(3125, "maximum-number-that-makes-result-of-bitwise-and-zero", "Maximum Number That Makes Result of Bitwise AND Zero", "Medium", [1, 15, 19], false),
      p(3131, "find-the-integer-added-to-array-ii", "Find the Integer Added to Array II", "Medium", [0, 3, 19], true),
      p(3136, "valid-word", "Valid Word", "Easy", [1], true),
      p(3141, "maximum-string-happiness", "Maximum String Happiness", "Hard", [], false),
      p(3146, "permutation-difference-between-two-strings", "Permutation Difference Between Two Strings", "Easy", [1, 2], true),
      p(3151, "special-array-i", "Special Array I", "Easy", [0], true),
      p(3158, "find-the-xor-of-numbers-which-appear-twice", "Find the XOR of Numbers Which Appear Twice", "Easy", [0, 2, 18], true),
      p(3162, "find-the-number-of-good-pairs-i", "Find the Number of Good Pairs I", "Easy", [0, 2], true),
      p(3163, "string-compression-iii", "String Compression III", "Medium", [1], true),
      p(3168, "minimum-number-of-chairs-in-a-waiting-room", "Minimum Number of Chairs in a Waiting Room", "Easy", [1], true),
      p(3173, "bitwise-or-of-adjacent-elements", "Bitwise OR of Adjacent Elements", "Easy", [0, 18], false),
      p(3174, "clear-digits", "Clear Digits", "Easy", [1, 8], true),
      p(3178, "find-the-child-who-has-the-ball-after-k-seconds", "Find the Child Who Has the Ball After K Seconds", "Easy", [20], true),
      p(3180, "maximum-total-reward-using-operations-i", "Maximum Total Reward Using Operations I", "Medium", [0, 16, 18, 19], true),
      p(3184, "count-pairs-that-form-a-good-day-i", "Count Pairs That Form a Good Day I", "Easy", [], false),
      p(3189, "minimum-moves-to-get-a-peaceful-board", "Minimum Moves to Get a Peaceful Board", "Medium", [0, 15, 19], false),
      p(3190, "find-minimum-operations-to-make-all-elements-divisible-by-three", "Find Minimum Operations to Make All Elements Divisible by Three", "Easy", [0, 20], true),
      p(3194, "minimum-average-of-smallest-and-largest-values", "Minimum Average of Smallest and Largest Values", "Easy", [], false),
      p(3199, "count-triplets-with-even-xor-pairs-i", "Count Triplets With Even XOR Pairs I", "Medium", [], false),
      p(3200, "maximum-heights-of-a-triangle", "Maximum Heights of a Triangle", "Easy", [], false),
      p(3204, "bitwise-user-permissions-analysis", "Bitwise User Permissions Analysis", "Medium", [], false),
      p(3206, "alternating-groups-i", "Alternating Groups I", "Easy", [0, 4], true),
      p(3210, "find-the-encrypted-string", "Find the Encrypted String", "Easy", [1], true),
      p(3211, "generate-binary-strings-without-adjacent-zeros", "Generate Binary Strings Without Adjacent Zeros", "Medium", [1, 14, 18], true),
      p(3216, "lexicographically-smallest-string-after-swap", "Lexicographically Smallest String After Swap", "Easy", [], false),
      p(3222, "find-the-winning-player-in-coin-game", "Find the Winning Player in Coin Game", "Easy", [20], true),
      p(3226, "number-of-bit-changes-to-make-two-integers-equal", "Number of Bit Changes to Make Two Integers Equal", "Easy", [18], true),
      p(3232, "find-if-digit-game-can-be-won", "Find if Digit Game Can Be Won", "Easy", [0, 20], true),
      p(3237, "alt-and-tab-simulation", "Alt and Tab Simulation", "Medium", [0, 2], false),
      p(3242, "design-neighbor-sum-service", "Design Neighbor Sum Service", "Easy", [0, 2], true),
      p(3243, "shortest-distance-after-road-addition-queries-i", "Shortest Distance After Road Addition Queries I", "Medium", [0], true),
      p(3250, "find-the-encrypted-string-ii", "Find the Encrypted String II", "Medium", [], false),
      p(3254, "find-the-power-of-k-size-subarrays-i", "Find the Power of K-Size Subarrays I", "Medium", [0, 4], true),
      p(3258, "count-substrings-that-satisfy-k-constraint-i", "Count Substrings That Satisfy K-Constraint I", "Easy", [1, 4], true),
      p(3264, "final-array-state-after-k-multiplication-operations-i", "Final Array State After K Multiplication Operations I", "Easy", [0, 20], true),
      p(3269, "constructing-two-increasing-arrays", "Constructing Two Increasing Arrays", "Hard", [0, 16], false),
      p(3273, "maximum-amount-of-money-robot-can-earn-ii", "Maximum Amount of Money Robot Can Earn II", "Medium", [], false),
      p(3274, "check-if-two-chessboard-squares-have-the-same-color", "Check if Two Chessboard Squares Have the Same Color", "Easy", [1, 20], true),
      p(3280, "convert-date-to-binary", "Convert Date to Binary", "Easy", [1, 20], true),
      p(3284, "sum-of-consecutive-subsequences", "Sum of Consecutive Subsequences", "Hard", [0, 2, 16], false),
      p(3289, "the-two-sneaky-numbers-of-digitville", "The Two Sneaky Numbers of Digitville", "Easy", [0, 2, 20], true),
      p(3293, "final-product-id-weighted-sum", "Final Product Id Weighted Sum", "Medium", [], false),
      p(3297, "count-substrings-that-can-be-rearranged-to-contain-a-string-i", "Count Substrings That Can Be Rearranged to Contain a String I", "Medium", [1, 2, 4], true),
      p(3300, "minimum-element-after-replacement-with-digit-sum", "Minimum Element After Replacement With Digit Sum", "Easy", [0, 20], true),
      p(3304, "find-the-first-player-to-win-k-games-in-a-row", "Find the First Player to Win K Games in a Row", "Medium", [0], true),
      p(3309, "maximum-possible-number-by-binary-concatenation", "Maximum Possible Number by Binary Concatenation", "Medium", [0, 18], true),
      p(3314, "construct-the-minimum-bitwise-array-i", "Construct the Minimum Bitwise Array I", "Easy", [0, 18], true),
      p(3318, "find-x-sum-of-all-k-long-subarrays-i", "Find X-Sum of All K-Long Subarrays I", "Easy", [0, 2, 4], true),
      p(3324, "find-the-sequence-of-strings-appeared-on-the-screen", "Find the Sequence of Strings Appeared on the Screen", "Medium", [1], true),
      p(3329, "count-increasing-quadruplets", "Count Increasing Quadruplets", "Hard", [0, 5, 16], true),
      p(3330, "find-the-original-typed-string-i", "Find the Original Typed String I", "Easy", [1], true),
      p(3334, "find-the-maximum-factor-score-of-array", "Find the Maximum Factor Score of Array", "Medium", [0, 20, 21], true),
      p(3339, "find-the-number-of-k-even-arrays", "Find the Number of K-Even Arrays", "Medium", [16], false),
      p(3340, "check-balanced-string", "Check Balanced String", "Easy", [1], true),
      p(3345, "smallest-divisible-digit-product-i", "Smallest Divisible Digit Product I", "Easy", [20], true),
      p(3350, "adjacent-increasing-subarrays-detection-ii", "Adjacent Increasing Subarrays Detection II", "Medium", [0, 6], true),
      p(3355, "zero-array-transformation-i", "Zero Array Transformation I", "Medium", [0, 5], true),
      p(3360, "remove-removable-indices", "Remove Removable Indices", "Easy", [], false),
      p(3364, "minimum-positive-sum-subarray", "Minimum Positive Sum Subarray", "Easy", [0, 4, 5], true),
      p(3369, "count-vowel-strings-in-ranges", "Count Vowel Strings in Ranges", "Medium", [0, 1, 5], true),
      p(3373, "maximize-the-number-of-ideal-nodes", "Maximize the Number of Ideal Nodes", "Hard", [], false),
      p(3374, "first-letter-capitalization", "First Letter Capitalization", "Hard", [], false),
      p(3379, "transformed-array", "Transformed Array", "Easy", [0], true),
      p(3384, "beauty-of-a-matrix", "Beauty of a Matrix", "Medium", [], false),
      p(3389, "minimum-area-rectangle-in-2d-space", "Minimum Area Rectangle in 2D Space", "Medium", [], false),
      p(3394, "check-if-grid-can-be-cut-into-sections", "Check if Grid Can Be Cut Into Sections", "Medium", [0, 19], true),
      p(3396, "minimum-number-of-operations-to-make-elements-in-array-distinct", "Minimum Number of Operations to Make Elements in Array Distinct", "Easy", [0, 2], true),
      p(3400, "maximum-count-of-non-overlapping-palindromic-substrings", "Maximum Count of Non-Overlapping Palindromic Substrings", "Medium", [], false),
      p(3405, "count-the-number-of-inversions", "Count the Number of Inversions", "Hard", [0, 16], true),
      p(3410, "maximize-the-total-height-of-unique-towers", "Maximize the Total Height of Unique Towers", "Medium", [0, 15, 19], true),
      p(3415, "longest-common-prefix-of-k-strings-after-removal", "Longest Common Prefix of K Strings After Removal", "Hard", [0, 1, 17], true),
      p(3417, "zigzag-grid-traversal-with-skip", "Zigzag Grid Traversal With Skip", "Easy", [0], true),
      p(3422, "minimum-operations-to-make-array-equal-ii", "Minimum Operations to Make Array Equal II", "Medium", [0, 15, 20], true),
      p(3427, "sum-of-variable-length-subarrays", "Sum of Variable Length Subarrays", "Easy", [0, 5], true),
      p(3432, "count-partitions-with-even-sum-difference", "Count Partitions With Even Sum Difference", "Easy", [0, 5, 20], true),
      p(3437, "zigzag-grid-traversal-with-skip-ii", "Zigzag Grid Traversal With Skip II", "Medium", [], false),
      p(3442, "maximum-differences-between-node-and-ancestor", "Maximum Differences Between Node and Ancestor", "Medium", [], false),
      p(3447, "the-maze-runner", "The Maze Runner", "Medium", [], false),
      p(3452, "sum-of-good-numbers", "Sum of Good Numbers", "Easy", [0], true),
      p(3457, "eat-pizzas", "Eat Pizzas!", "Medium", [0, 15, 19], true),
      p(3462, "maximum-sum-with-at-most-k-elements", "Maximum Sum With At Most K Elements", "Medium", [0, 15, 19], true),
      p(3467, "transform-array-by-parity", "Transform Array by Parity", "Easy", [0, 19], true),
      p(3471, "find-the-largest-almost-missing-integer", "Find the Largest Almost Missing Integer", "Easy", [0, 2], true),
      p(3477, "fruits-into-baskets-ii", "Fruits Into Baskets II", "Easy", [0, 6, 22], true),
      p(3483, "unique-3-digit-even-numbers", "Unique 3-Digit Even Numbers", "Easy", [0, 2], true),
      p(3487, "maximum-unique-subarray-sum-after-deletion", "Maximum Unique Subarray Sum After Deletion", "Easy", [0, 2, 15], true),
      p(3492, "maximum-containers-on-a-ship", "Maximum Containers on a Ship", "Easy", [20], true),
      p(3497, "analyze-assignment-groups", "Analyze Assignment Groups", "Medium", [], false),
      p(3502, "minimum-cost-to-reach-every-position", "Minimum Cost to Reach Every Position", "Easy", [0], true),
      p(3507, "minimum-pair-removal-to-sort-array-i", "Minimum Pair Removal to Sort Array I", "Easy", [0, 2, 7], true),
      p(3512, "minimum-cost-to-reach-every-position-ii", "Minimum Cost to Reach Every Position II", "Medium", [], false),
      p(3516, "find-closest-person", "Find Closest Person", "Easy", [20], true),
      p(3521, "find-product-recommendation-pairs", "Find Product Recommendation Pairs", "Medium", [], true),
      p(3526, "range-xor-queries-with-sweeping", "Range XOR Queries With Sweeping", "Medium", [], false),
      p(3531, "count-covered-buildings", "Count Covered Buildings", "Medium", [0, 2, 19], true),
      p(3536, "maximum-product-of-two-digits", "Maximum Product of Two Digits", "Easy", [19, 20], true),
      p(3541, "find-most-frequent-vowel-and-consonant", "Find Most Frequent Vowel and Consonant", "Easy", [1, 2], true),
      p(3546, "equal-sum-grid-partition-i", "Equal Sum Grid Partition I", "Medium", [0, 5], true),
      p(3550, "ability-to-send-messages", "Ability to Send Messages", "Medium", [], false),
      p(3555, "smallest-subarray-to-sort-in-every-sliding-window", "Smallest Subarray to Sort in Every Sliding Window", "Medium", [0, 3, 8, 15, 19], false),
      p(3560, "find-number-of-ways-to-reach-the-k-th-stair", "Find Number of Ways to Reach the K-th Stair", "Hard", [16, 18, 20, 23], true),
      p(3565, "parallel-vertex-cover", "Parallel Vertex Cover", "Medium", [], false),
      p(3570, "object-approval-system", "Object Approval System", "Medium", [], false),
      p(3575, "maximum-good-subtree-score", "Maximum Good Subtree Score", "Hard", [0, 10, 16, 18], true),
      p(3580, "find-consistently-logging-employees", "Find Consistently Logging Employees", "Medium", [], false),
      p(3585, "event-merger", "Event Merger", "Medium", [], false),
      p(3591, "check-if-any-element-has-prime-frequency", "Check if Any Element Has Prime Frequency", "Easy", [0, 2, 20, 21], true),
      p(3596, "minimum-cost-path-with-alternating-directions-i", "Minimum Cost Path With Alternating Directions I", "Medium", [20], false),
      p(3601, "find-players-with-zero-or-one-losses-ii", "Find Players With Zero or One Losses II", "Medium", [], false),
      p(3606, "coupon-code-validator", "Coupon Code Validator", "Easy", [0, 1, 2, 19], true),
      p(3611, "find-the-maximum-length-of-a-good-subsequence-i", "Find the Maximum Length of a Good Subsequence I", "Medium", [0, 2, 16], true),
      p(3616, "number-of-student-replacements", "Number of Student Replacements", "Medium", [0], false),
      p(3620, "network-recovery-pathways", "Network Recovery Pathways", "Hard", [0, 6, 16], true),
      p(3625, "count-number-of-trapezoids-i", "Count Number of Trapezoids I", "Medium", [0, 2, 20], true),
      p(3630, "partition-array-for-maximum-xor-and-and", "Partition Array for Maximum XOR and AND", "Hard", [0, 15, 18, 20], true),
      p(3634, "best-room-allocation-method", "Best Room Allocation Method", "Medium", [], false),
      p(3639, "minimum-time-to-activate-string-fragments", "Minimum Time to Activate String Fragments", "Medium", [], false),
      p(3643, "landings-approach", "Landings Approach", "Easy", [], false),
      p(3648, "minimum-sensors-to-cover-grid", "Minimum Sensors to Cover Grid", "Medium", [20], true),
      p(3652, "best-visited-places-in-a-mall", "Best Visited Places in a Mall", "Medium", [], false),
      p(3657, "find-well-formed-paragraphs", "Find Well-Formed Paragraphs", "Medium", [], false),
      p(3662, "filter-characters-by-frequency", "Filter Characters by Frequency", "Easy", [1, 2], false),
      p(3667, "restore-finishing-order", "Restore Finishing Order", "Easy", [0, 2], true),
      p(3672, "sum-of-adjacent-primes", "Sum of Adjacent Primes", "Medium", [], false),
      p(3677, "count-binary-palindromic-numbers", "Count Binary Palindromic Numbers", "Hard", [18, 20], true),
      p(3681, "maximum-xor-of-subsequences", "Maximum XOR of Subsequences", "Hard", [0, 15, 18, 20], true),
      p(3686, "number-of-stable-subsequences", "Number of Stable Subsequences", "Hard", [0, 16], true),
      p(3691, "maximize-activity-selection-with-discount", "Maximize Activity Selection With Discount", "Medium", [], false),
      p(3696, "maximum-distance-between-unequal-words-in-array-i", "Maximum Distance Between Unequal Words in Array I", "Easy", [0, 1], false),
      p(3701, "compute-alternating-sum", "Compute Alternating Sum", "Easy", [0], true),
      p(3706, "car-fleet-ii-approach", "Car Fleet II Approach", "Hard", [], false),
      p(3711, "maximum-deletions-on-a-string", "Maximum Deletions on a String", "Hard", [1, 2, 16], true),
      p(3716, "maximize-sum-of-at-most-k-distinct-subarrays", "Maximize Sum of At Most K Distinct Subarrays", "Medium", [], false),
      p(3721, "longest-balanced-subarray-ii", "Longest Balanced Subarray II", "Hard", [0, 2, 5, 22], true),
      p(3726, "remove-zeros", "Remove Zeros", "Medium", [], false),
      p(3731, "subtract-abc", "Subtract ABC", "Medium", [], false),
      p(3736, "interleaved-adjacent-groups", "Interleaved Adjacent Groups", "Medium", [], false),
      p(3741, "minimum-difficulty-of-a-job-schedule-ii", "Minimum Difficulty of a Job Schedule II", "Hard", [], false),
      p(3746, "minimum-string-length-after-removing-substrings", "Minimum String Length After Removing Substrings", "Easy", [1, 8], true),
      p(3751, "total-waviness-of-numbers-i", "Total Waviness of Numbers I", "Medium", [], false),
      p(3756, "paint-the-grid", "Paint the Grid", "Medium", [], false),
      p(3761, "minimum-difference-in-indices-after-same-element-removals", "Minimum Difference in Indices After Same Element Removals", "Medium", [], false),
      p(3766, "minimum-moves-to-clean-the-classroom", "Minimum Moves to Clean the Classroom", "Medium", [0, 2, 18], true),
      p(3771, "total-sum-of-subarray-power", "Total Sum of Subarray Power", "Hard", [], false),
      p(3776, "vector-cross-product", "Vector Cross Product", "Medium", [], false),
      p(3781, "maximum-score-after-applying-operations", "Maximum Score After Applying Operations", "Medium", [], false),
      p(3786, "total-characters-in-string-after-transformations-ii", "Total Characters in String After Transformations II", "Hard", [1, 2, 16, 20], true),
      p(3791, "count-merged-overlapping-intervals", "Count Merged Overlapping Intervals", "Medium", [], false),
      p(3796, "find-maximum-area-of-a-triangle", "Find Maximum Area of a Triangle", "Medium", [0, 2, 15, 20], true),
      p(3801, "collect-elements-in-row-major-order", "Collect Elements in Row-Major Order", "Medium", [], false),
      p(3806, "swap-to-make-equal-strings", "Swap to Make Equal Strings", "Medium", [], false),
      p(3811, "gcd-of-sequential-prefix-xors", "GCD of Sequential Prefix XORs", "Hard", [], false),
      p(3816, "close-equal-character-pairs", "Close Equal Character Pairs", "Medium", [], false),
      p(3821, "reverse-yang-hui-triangle-ii", "Reverse Yang Hui Triangle II", "Medium", [], false),
      p(3826, "vowel-spellchecker-ii", "Vowel Spellchecker II", "Medium", [], false),
      p(3831, "find-the-lexicographically-largest-valid-sequence", "Find the Lexicographically Largest Valid Sequence", "Medium", [], false),
      p(3836, "choose-k-flips-to-maximize-xor", "Choose K Flips to Maximize XOR", "Hard", [], false),
      p(3841, "paint-special-elements-in-grid", "Paint Special Elements in Grid", "Medium", [], false),
      p(3846, "destroy-sequential-targets-ii", "Destroy Sequential Targets II", "Hard", [], false),
      p(0, "cf-1242b", "0-1 MST", "Medium", [8, 9, 10, 13, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1242/B"),
      p(0, "cf-1950f", "0, 1, 2, Tree!", "Medium", [0, 3, 8, 10, 11, 12, 14, 15, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1950/F"),
      p(0, "cf-2126f", "1-1-1, Free Tree!", "Hard", [0, 3, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2126/F"),
      p(0, "cf-1494c", "1D Sokoban", "Medium", [0, 3, 4, 6, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1494/C"),
      p(0, "cf-1692g", "2^Sort", "Easy", [0, 3, 4, 7, 12, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1692/G"),
      p(0, "cf-1715d", "2+ doors", "Medium", [9, 12, 13, 15, 18, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1715/D"),
      p(0, "cf-2127h", "23 Rises Again", "Hard", [0, 3, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 22, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2127/H"),
      p(0, "cf-1658d2", "388535 (Hard Version)", "Hard", [0, 3, 7, 8, 12, 14, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1658/D2"),
      p(0, "cf-452b", "4-point polyline", "Medium", [3, 8, 10, 11, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/452/B"),
      p(0, "cf-519e", "A and B and Lecture Rooms", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/519/E"),
      p(0, "cf-2241f", "A Bit Odd", "Medium", [0, 7, 12, 15, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2241/F"),
      p(0, "cf-1957d", "A BIT of an Inequality", "Medium", [3, 8, 14, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1957/D"),
      p(0, "cf-1469e", "A Bit Similar", "Hard", [1, 2, 3, 4, 8, 14, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1469/E"),
      p(0, "cf-1260d", "A Game with Traps", "Medium", [6, 11, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1260/D"),
      p(0, "cf-455b", "A Lot of Games", "Medium", [0, 1, 8, 10, 11, 13, 14, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/455/B"),
      p(0, "cf-2210f", "A Simple Problem", "Hard", [0, 6, 7, 10, 11, 12, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2210/F"),
      p(0, "cf-1805d", "A Wide, Wide Graph", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1805/D"),
      p(0, "cf-1238d", "AB-string", "Medium", [1, 6, 11, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1238/D"),
      p(0, "cf-1149d", "Abandoning Roads", "Hard", [3, 8, 9, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1149/D"),
      p(0, "cf-1428c", "ABBB", "Easy", [0, 1, 3, 7, 8, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1428/C"),
      p(0, "cf-2026c", "Action Figures", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2026/C"),
      p(0, "cf-601d", "Acyclic Organic Compounds", "Hard", [0, 1, 2, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/601/D"),
      p(0, "cf-1188a2", "Add on a Tree: Revolution", "Hard", [0, 8, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1188/A2"),
      p(0, "cf-2027c", "Add Zeros", "Medium", [0, 3, 7, 8, 9, 10, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2027/C"),
      p(0, "cf-2157e", "Adjusting Drones", "Medium", [0, 3, 6, 7, 8, 11, 12, 13, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2157/E"),
      p(0, "cf-2053i2", "Affectionate Arrays (Hard Version)", "Hard", [0, 3, 4, 7, 9, 12, 13, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2053/I2"),
      p(0, "cf-2194f1", "Again Trees... (Easy Version)", "Hard", [8, 10, 11, 13, 14, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2194/F1"),
      p(0, "cf-2194f2", "Again Trees... (hard version)", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2194/F2"),
      p(0, "cf-1648e", "Air Reform", "Hard", [0, 5, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1648/E"),
      p(0, "cf-2187f1", "Al Fine (Maximizing Version)", "Hard", [0, 5, 6, 7, 10, 11, 12, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2187/F1"),
      p(0, "cf-1767e", "Algebra Flash", "Hard", [3, 8, 9, 10, 11, 13, 14, 16, 17, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1767/E"),
      p(0, "cf-2028e", "Alice's Adventures in the Rabbit Hole", "Hard", [8, 10, 11, 12, 13, 14, 15, 16, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2028/E"),
      p(0, "cf-1759f", "All Possible Digits", "Medium", [0, 6, 7, 11, 12, 15, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1759/F"),
      p(0, "cf-1492e", "Almost Fault-Tolerant Database", "Hard", [0, 3, 8, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1492/E"),
      p(0, "cf-1608g", "Alphabetic Tree", "Hard", [0, 1, 2, 6, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1608/G"),
      p(0, "cf-786e", "ALT", "Hard", [0, 7, 9, 10, 11, 12, 13, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/786/E"),
      p(0, "cf-2005d", "Alter the GCD", "Hard", [0, 3, 5, 6, 7, 8, 11, 12, 14, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2005/D"),
      p(0, "cf-2204d", "Alternating Path", "Easy", [8, 9, 10, 13, 14, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2204/D"),
      p(0, "cf-2008e", "Alternating String", "Medium", [0, 1, 3, 7, 8, 12, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2008/E"),
      p(0, "cf-960e", "Alternating Tree", "Hard", [5, 8, 10, 11, 13, 14, 16, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/960/E"),
      p(0, "cf-739b", "Alyona and a tree", "Medium", [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/739/B"),
      p(0, "cf-777c", "Alyona and Spreadsheet", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/777/C"),
      p(0, "cf-1949j", "Amanda the Amoeba", "Hard", [0, 3, 4, 9, 10, 11, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1949/J"),
      p(0, "cf-1773a", "Amazing Trick", "Medium", [15, 20, 22, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1773/A"),
      p(0, "cf-558c", "Amr and Chemistry", "Medium", [3, 8, 9, 12, 13, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/558/C"),
      p(0, "cf-1610e", "AmShZ and G.O.A.T.", "Hard", [0, 3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1610/E"),
      p(0, "cf-1327f", "AND Segments", "Hard", [0, 3, 4, 7, 12, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1327/F"),
      p(0, "cf-1689e", "ANDfinity", "Hard", [3, 8, 9, 10, 13, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1689/E"),
      p(0, "cf-1859d", "Andrey and Escape from Capygrad", "Medium", [0, 6, 7, 11, 12, 13, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1859/D"),
      p(0, "cf-442b", "Andrey and Problem", "Medium", [12, 15, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/442/B"),
      p(0, "cf-1935f", "Andrey's Tree", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1935/F"),
      p(0, "cf-2092f", "Andryusha and CCB", "Hard", [1, 3, 8, 12, 14, 15, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2092/F"),
      p(0, "cf-780c", "Andryusha and Colored Balloons", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/780/C"),
      p(0, "cf-1900c", "Anji's Binary Tree", "Easy", [8, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1900/C"),
      p(0, "cf-557e", "Ann and Half-Palindrome", "Hard", [0, 1, 7, 9, 10, 11, 12, 13, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/557/E"),
      p(0, "cf-1949c", "Annual Ants' Gathering", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1949/C"),
      p(0, "cf-1641c", "Anonymity Is Important", "Hard", [0, 3, 6, 7, 8, 11, 12, 13, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1641/C"),
      p(0, "cf-1893a", "Anonymous Informant", "Easy", [0, 3, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1893/A"),
      p(0, "cf-2057e1", "Another Exercise on Graphs (Easy Version)", "Hard", [3, 6, 8, 9, 11, 13, 14, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2057/E1"),
      p(0, "cf-2057e2", "Another Exercise on Graphs (hard version)", "Hard", [6, 8, 9, 10, 11, 13, 14, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2057/E2"),
      p(0, "cf-1859c", "Another Permutation Problem", "Easy", [3, 8, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1859/C"),
      p(0, "cf-165c", "Another Problem on Strings", "Medium", [1, 3, 4, 6, 8, 11, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/165/C"),
      p(0, "cf-1743g", "Antifibonacci Cut", "Hard", [0, 2, 7, 12, 15, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1743/G"),
      p(0, "cf-1007d", "Ants", "Hard", [0, 7, 10, 11, 12, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1007/D"),
      p(0, "cf-2244f", "Anya Loves Trees!", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2244/F"),
      p(0, "cf-1466e", "Apollo versus Pan", "Medium", [3, 8, 14, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1466/E"),
      p(0, "cf-1843d", "Apple Tree", "Easy", [8, 10, 11, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1843/D"),
      p(0, "cf-1545c", "AquaMoon and Permutations", "Hard", [3, 8, 9, 13, 14, 15, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1545/C"),
      p(0, "cf-2131d", "Arboris Contractio", "Easy", [0, 7, 9, 10, 11, 12, 13, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2131/D"),
      p(0, "cf-1178e", "Archaeology", "Medium", [1, 3, 8, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1178/E"),
      p(0, "cf-1654e", "Arithmetic Operations", "Hard", [0, 3, 7, 8, 9, 12, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1654/E"),
      p(0, "cf-2132e", "Arithmetics Competition", "Medium", [0, 6, 7, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2132/E"),
      p(0, "cf-860e", "Arkady and a Nobody-men", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/860/E"),
      p(0, "cf-1525d", "Armchairs", "Medium", [12, 15, 16, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1525/D"),
      p(0, "cf-1299d", "Around the World", "Hard", [8, 9, 10, 11, 13, 14, 16, 17, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1299/D"),
      p(0, "cf-741d", "Arpa’s letter-marked tree and Mehrdad’s Dokhtar-kosh paths", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/741/D"),
      p(0, "cf-1474c", "Array Destruction", "Medium", [0, 3, 7, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1474/C"),
      p(0, "cf-1552d", "Array Differentiation", "Medium", [3, 8, 9, 10, 13, 14, 15, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1552/D"),
      p(0, "cf-1605e", "Array Equalizer", "Hard", [0, 3, 4, 6, 11, 12, 15, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1605/E"),
      p(0, "cf-1904c", "Array Game", "Easy", [0, 3, 4, 6, 7, 8, 11, 12, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1904/C"),
      p(0, "cf-1920d", "Array Repetition", "Medium", [0, 3, 6, 8, 11, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1920/D"),
      p(0, "cf-1579f", "Array Stabilization (AND version)", "Medium", [3, 8, 9, 13, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1579/F"),
      p(0, "cf-1547f", "Array Stabilization (GCD version)", "Medium", [0, 3, 4, 5, 6, 7, 8, 11, 12, 14, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1547/F"),
      p(0, "cf-1983f", "array-value", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1983/F"),
      p(0, "cf-1948c", "Arrow Path", "Easy", [3, 8, 9, 10, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1948/C"),
      p(0, "cf-557c", "Arthur and Table", "Medium", [0, 3, 7, 8, 12, 14, 15, 16, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/557/C"),
      p(0, "cf-2022d1", "Asesino (Easy Version)", "Medium", [0, 3, 6, 8, 11, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2022/D1"),
      p(0, "cf-1371e1", "Asterism (Easy Version)", "Medium", [3, 6, 8, 11, 14, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1371/E1"),
      p(0, "cf-2025d", "Attribute Checks", "Medium", [0, 3, 4, 7, 8, 12, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2025/D"),
      p(0, "cf-2041i", "Auto Complete", "Hard", [0, 1, 2, 6, 7, 10, 11, 12, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2041/I"),
      p(0, "cf-1312g", "Autocompletion", "Hard", [0, 7, 8, 10, 12, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1312/G"),
      p(0, "cf-1408e", "Avoid Rainbow Cycles", "Hard", [0, 7, 9, 10, 11, 12, 13, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1408/E"),
      p(0, "cf-1697c", "awoo's Favorite Problem", "Easy", [0, 1, 3, 4, 6, 7, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1697/C"),
      p(0, "cf-1620c", "BA-String", "Medium", [0, 3, 8, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1620/C"),
      p(0, "cf-1903f", "Babysitting", "Hard", [0, 6, 7, 9, 10, 11, 12, 13, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1903/F"),
      p(0, "cf-2097b", "Baggage Claim", "Hard", [0, 8, 9, 10, 11, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2097/B"),
      p(0, "cf-1592c", "Bakry and Partitioning", "Medium", [8, 9, 10, 11, 13, 14, 15, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1592/C"),
      p(0, "cf-317c", "Balance", "Hard", [8, 9, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/317/C"),
      p(0, "cf-1237c2", "Balanced Removals (Harder)", "Medium", [0, 5, 6, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1237/C2"),
      p(0, "cf-1814d", "Balancing Weapons", "Hard", [0, 3, 4, 6, 7, 8, 11, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1814/D"),
      p(0, "cf-1876e", "Ball-Stackable", "Hard", [0, 7, 10, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1876/E"),
      p(0, "cf-830c", "Bamboo Partition", "Hard", [0, 3, 4, 7, 8, 12, 14, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/830/C"),
      p(0, "cf-1436d", "Bandit in a City", "Medium", [6, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1436/D"),
      p(0, "cf-796c", "Bank Hacking", "Medium", [0, 7, 10, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/796/C"),
      p(0, "cf-2155d", "Batteries", "Medium", [3, 8, 9, 13, 14, 15, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2155/D"),
      p(0, "cf-2185h", "BattleCows 2", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2185/H"),
      p(0, "cf-2106g2", "Baudelaire (hard version)", "Hard", [0, 5, 6, 8, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2106/G2"),
      p(0, "cf-679d", "Bear and Chase", "Hard", [0, 3, 8, 9, 10, 13, 14, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/679/D"),
      p(0, "cf-639f", "Bear and Chemistry", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/639/F"),
      p(0, "cf-653b", "Bear and Compressing", "Easy", [1, 3, 8, 10, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/653/B"),
      p(0, "cf-385c", "Bear and Prime Numbers", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/385/C"),
      p(0, "cf-385b", "Bear and Strings", "Easy", [0, 1, 3, 8, 12, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/385/B"),
      p(0, "cf-574b", "Bear and Three Musketeers", "Medium", [2, 3, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/574/B"),
      p(0, "cf-1155d", "Beautiful Array", "Medium", [0, 3, 5, 7, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1155/D"),
      p(0, "cf-279e", "Beautiful Decomposition", "Medium", [12, 15, 16, 21, 23], false, "codeforces", "https://codeforces.com/problemset/problem/279/E"),
      p(0, "cf-87d", "Beautiful Road", "Hard", [0, 8, 9, 10, 11, 13, 14, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/87/D"),
      p(0, "cf-2075f", "Beautiful Sequence Returns", "Hard", [0, 3, 6, 7, 8, 11, 12, 14], false, "codeforces", "https://codeforces.com/problemset/problem/2075/F"),
      p(0, "cf-1904f", "Beautiful Tree", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1904/F"),
      p(0, "cf-1982d", "Beauty of the mountains", "Medium", [0, 3, 7, 8, 12, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1982/D"),
      p(0, "cf-79c", "Beaver", "Medium", [0, 1, 2, 3, 4, 7, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/79/C"),
      p(0, "cf-1494b", "Berland Crossword", "Easy", [0, 3, 8, 12, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1494/B"),
      p(0, "cf-1073d", "Berland Fair", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1073/D"),
      p(0, "cf-533a", "Berland Miners", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/533/A"),
      p(0, "cf-1519c", "Berland Regional", "Easy", [0, 3, 7, 8, 12, 14, 15, 19, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1519/C"),
      p(0, "cf-847l", "Berland SU Computer Network", "Hard", [2, 8, 9, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/847/L"),
      p(0, "cf-2026f", "Bermart Ice Cream", "Hard", [0, 5, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2026/F"),
      p(0, "cf-1922d", "Berserk Monsters", "Medium", [0, 3, 7, 8, 12, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1922/D"),
      p(0, "cf-489b", "BerSU Ball", "Easy", [3, 4, 8, 10, 12, 13, 14, 15, 16, 19, 22], false, "codeforces", "https://codeforces.com/problemset/problem/489/B"),
      p(0, "cf-827d", "Best Edge Weight", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/827/D"),
      p(0, "cf-2051e", "Best Price", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2051/E"),
      p(0, "cf-1495d", "BFS Trees", "Hard", [8, 9, 10, 11, 13, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1495/D"),
      p(0, "cf-424d", "Biathlon Track", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/424/D"),
      p(0, "cf-1915g", "Bicycles", "Medium", [0, 9, 12, 13, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1915/G"),
      p(0, "cf-418d", "Big Problems for Organizers", "Hard", [0, 7, 9, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/418/D"),
      p(0, "cf-2126g2", "Big Wins! (hard version)", "Hard", [0, 3, 4, 5, 6, 7, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2126/G2"),
      p(0, "cf-2022e1", "Billetes MX (Easy Version)", "Hard", [6, 8, 9, 10, 11, 13, 14, 15, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2022/E1"),
      p(0, "cf-2022e2", "Billetes MX (Hard Version)", "Hard", [0, 6, 7, 9, 11, 12, 13, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2022/E2"),
      p(0, "cf-2259f", "Binary Bubble Sort Inversions", "Medium", [0, 3, 4, 7, 12, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2259/F"),
      p(0, "cf-1508a", "Binary Literature", "Medium", [0, 1, 3, 4, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1508/A"),
      p(0, "cf-2203f", "Binary Search with One Swap", "Hard", [2, 3, 4, 5, 6, 11, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2203/F"),
      p(0, "cf-1625d", "Binary Spiders", "Hard", [0, 7, 10, 11, 12, 17, 18, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1625/D"),
      p(0, "cf-1849c", "Binary String Copying", "Medium", [0, 1, 2, 3, 6, 7, 8, 11, 12, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1849/C"),
      p(0, "cf-901c", "Bipartite Segments", "Hard", [0, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/901/C"),
      p(0, "cf-494d", "Birthday", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/494/D"),
      p(0, "cf-1946d", "Birthday Gift", "Medium", [0, 3, 8, 12, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1946/D"),
      p(0, "cf-1208f", "Bits And Pieces", "Hard", [8, 10, 12, 13, 14, 15, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1208/F"),
      p(0, "cf-2020c", "Bitwise Balancing", "Easy", [0, 2, 6, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2020/C"),
      p(0, "cf-778b", "Bitwise Formula", "Medium", [0, 1, 3, 8, 10, 13, 14, 18], false, "codeforces", "https://codeforces.com/problemset/problem/778/B"),
      p(0, "cf-1936d", "Bitwise Paradox", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1936/D"),
      p(0, "cf-1626e", "Black and White Tree", "Hard", [8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1626/E"),
      p(0, "cf-1821d", "Black Cells", "Medium", [3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1821/D"),
      p(0, "cf-1442e", "Black, White and Grey Tree", "Hard", [6, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1442/E"),
      p(0, "cf-1795f", "Blocking Chips", "Hard", [6, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1795/F"),
      p(0, "cf-1918d", "Blocking Elements", "Medium", [0, 3, 4, 6, 7, 11, 12, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1918/D"),
      p(0, "cf-246e", "Blood Cousins Return", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/246/E"),
      p(0, "cf-533c", "Board Game", "Medium", [0, 12, 15, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/533/C"),
      p(0, "cf-1394a", "Boboniu Chats with Du", "Medium", [3, 4, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1394/A"),
      p(0, "cf-1572a", "Book", "Medium", [0, 3, 6, 7, 8, 9, 11, 12, 13, 14, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1572/A"),
      p(0, "cf-279b", "Books", "Easy", [0, 3, 4, 6, 8, 11, 14], false, "codeforces", "https://codeforces.com/problemset/problem/279/B"),
      p(0, "cf-1982c", "Boring Day", "Easy", [0, 3, 4, 6, 7, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1982/C"),
      p(0, "cf-1779d", "Boris and His Amazing Haircut", "Medium", [0, 7, 12, 13, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1779/D"),
      p(0, "cf-442a", "Borya and Hanabi", "Medium", [0, 3, 8, 14, 18], false, "codeforces", "https://codeforces.com/problemset/problem/442/A"),
      p(0, "cf-1995b1", "Bouquet (Easy Version)", "Easy", [3, 4, 6, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1995/B1"),
      p(0, "cf-1995b2", "Bouquet (Hard Version)", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1995/B2"),
      p(0, "cf-1498b", "Box Fitting", "Easy", [0, 6, 7, 11, 12, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1498/B"),
      p(0, "cf-1750e", "Bracket Cost", "Hard", [0, 1, 5, 6, 7, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1750/E"),
      p(0, "cf-120h", "Brevity is Soul of Wit", "Medium", [22], false, "codeforces", "https://codeforces.com/problemset/problem/120/H"),
      p(0, "cf-2038l", "Bridge Renovation", "Easy", [3, 4, 8, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2038/L"),
      p(0, "cf-2049e", "Broken Queries", "Hard", [0, 3, 6, 8, 11, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2049/E"),
      p(0, "cf-758e", "Broken Tree", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/758/E"),
      p(0, "cf-1891e", "Brukhovich and Exams", "Hard", [0, 3, 8, 12, 14, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1891/E"),
      p(0, "cf-420c", "Bug in Code", "Medium", [0, 3, 4, 7, 9, 12, 13], false, "codeforces", "https://codeforces.com/problemset/problem/420/C"),
      p(0, "cf-1827e", "Bus Routes", "Hard", [6, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1827/E"),
      p(0, "cf-2023c", "C+K+S", "Hard", [0, 1, 2, 8, 9, 10, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2023/C"),
      p(0, "cf-231e", "Cactus", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/231/E"),
      p(0, "cf-571d", "Campus", "Hard", [0, 6, 7, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/571/D"),
      p(0, "cf-757g", "Can Bash Save the Day?", "Hard", [0, 5, 7, 9, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/757/G"),
      p(0, "cf-1868b1", "Candy Party (Easy Version)", "Medium", [0, 9, 12, 13, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1868/B1"),
      p(0, "cf-2089b1", "Canteen (Easy Version)", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2089/B1"),
      p(0, "cf-2089b2", "Canteen (Hard Version)", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 16, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2089/B2"),
      p(0, "cf-1388d", "Captain Flint and Treasure", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1388/D"),
      p(0, "cf-1345b", "Card Constructions", "Easy", [3, 6, 8, 11, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1345/B"),
      p(0, "cf-818e", "Card Game Again", "Medium", [0, 3, 4, 6, 7, 11, 12, 21], false, "codeforces", "https://codeforces.com/problemset/problem/818/E"),
      p(0, "cf-1328d", "Carousel", "Medium", [9, 12, 13, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1328/D"),
      p(0, "cf-1973b", "Cat, Fox and the Lonely Array", "Easy", [0, 3, 4, 6, 7, 11, 12, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1973/B"),
      p(0, "cf-1990e1", "Catch the Mole(Easy Version)", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1990/E1"),
      p(0, "cf-1990e2", "Catch the Mole(Hard Version)", "Hard", [0, 5, 6, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1990/E2"),
      p(0, "cf-51f", "Caterpillar", "Hard", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/51/F"),
      p(0, "cf-1918f", "Caterpillar on a Tree", "Hard", [0, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1918/F"),
      p(0, "cf-1625e1", "Cats on the Upgrade (easy version)", "Hard", [0, 3, 5, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1625/E1"),
      p(0, "cf-1625e2", "Cats on the Upgrade (hard version)", "Hard", [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1625/E2"),
      p(0, "cf-2154d", "Catshock", "Medium", [3, 4, 8, 9, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2154/D"),
      p(0, "cf-1469d", "Ceil Divisions", "Medium", [3, 8, 14, 15, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1469/D"),
      p(0, "cf-708c", "Centroids", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/708/C"),
      p(0, "cf-2164f1", "Chain Prefix Rank (Easy Version)", "Hard", [8, 10, 11, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2164/F1"),
      p(0, "cf-2164f2", "Chain Prefix Rank (Hard Version)", "Hard", [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2164/F2"),
      p(0, "cf-1511f", "Chainword", "Hard", [0, 1, 3, 7, 8, 12, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1511/F"),
      p(0, "cf-1975c", "Chamo and Mocha's Array", "Easy", [3, 6, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1975/C"),
      p(0, "cf-2111e", "Changing the String", "Medium", [0, 1, 6, 7, 11, 12, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2111/E"),
      p(0, "cf-1292d", "Chaotic V.", "Hard", [9, 10, 11, 12, 13, 15, 16, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1292/D"),
      p(0, "cf-637b", "Chat Order", "Easy", [0, 6, 7, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/637/B"),
      p(0, "cf-1487e", "Cheap Dinner", "Hard", [0, 3, 4, 7, 8, 9, 12, 13, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1487/E"),
      p(0, "cf-1453d", "Checkpoints", "Medium", [3, 8, 12, 14, 15, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1453/D"),
      p(0, "cf-427c", "Checkposts", "Medium", [3, 4, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/427/C"),
      p(0, "cf-1437c", "Chef Monocarp", "Medium", [12, 15, 16, 19, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1437/C"),
      p(0, "cf-846e", "Chemistry in Berland", "Hard", [8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/846/E"),
      p(0, "cf-2184f", "Cherry Tree", "Medium", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2184/F"),
      p(0, "cf-1519f", "Chests and Keys", "Hard", [3, 8, 10, 13, 14, 16, 18, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1519/F"),
      p(0, "cf-1511g", "Chips on a Board", "Hard", [0, 3, 4, 7, 8, 12, 14, 16, 18, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1511/G"),
      p(0, "cf-743d", "Chloe and pleasant prizes", "Medium", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/743/D"),
      p(0, "cf-490d", "Chocolate", "Medium", [3, 8, 10, 13, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/490/D"),
      p(0, "cf-2025f", "Choose Your Queries", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2025/F"),
      p(0, "cf-219d", "Choosing Capital for Treeland", "Medium", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/219/D"),
      p(0, "cf-1379c", "Choosing flowers", "Hard", [0, 3, 4, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1379/C"),
      p(0, "cf-372d", "Choosing Subtree is Fun", "Hard", [0, 3, 4, 6, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/372/D"),
      p(0, "cf-1073f", "Choosing Two Paths", "Hard", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1073/F"),
      p(0, "cf-1706d1", "Chopping Carrots (Easy Version)", "Medium", [3, 6, 8, 11, 12, 14, 15, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1706/D1"),
      p(0, "cf-1706d2", "Chopping Carrots (Hard Version)", "Hard", [0, 3, 4, 7, 8, 12, 14, 15, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1706/D2"),
      p(0, "cf-1617e", "Christmas Chocolates", "Hard", [0, 8, 9, 10, 11, 13, 14, 16, 17, 20, 21, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1617/E"),
      p(0, "cf-1498f", "Christmas Game", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17, 18, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1498/F"),
      p(0, "cf-2182f2", "Christmas Reindeer (hard version)", "Hard", [0, 3, 7, 8, 12, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2182/F2"),
      p(0, "cf-321b", "Ciel and Duel", "Medium", [12, 15, 16, 22], false, "codeforces", "https://codeforces.com/problemset/problem/321/B"),
      p(0, "cf-1971f", "Circle Perimeter", "Medium", [0, 3, 6, 8, 10, 11, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1971/F"),
      p(0, "cf-1138b", "Circus", "Medium", [1, 3, 8, 12, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1138/B"),
      p(0, "cf-2228c1", "Cirno and Number (Easy Version)", "Medium", [0, 3, 6, 8, 11, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2228/C1"),
      p(0, "cf-2228c2", "Cirno and Number (Hard Version)", "Medium", [0, 6, 8, 10, 11, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2228/C2"),
      p(0, "cf-1799e", "City Union", "Hard", [0, 8, 10, 12, 13, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1799/E"),
      p(0, "cf-1475d", "Cleaning the Phone", "Medium", [3, 4, 6, 11, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1475/D"),
      p(0, "cf-2097e", "Clearing the Snowdrift", "Hard", [0, 7, 8, 10, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2097/E"),
      p(0, "cf-527d", "Clique Problem", "Medium", [0, 7, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/527/D"),
      p(0, "cf-650e", "Clockwork Bomb", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/650/E"),
      p(0, "cf-1462e2", "Close Tuples (hard version)", "Medium", [0, 3, 4, 6, 11, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1462/E2"),
      p(0, "cf-777d", "Cloud of Hashtags", "Medium", [0, 1, 6, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/777/D"),
      p(0, "cf-1876g", "Clubstep", "Hard", [0, 3, 6, 7, 8, 10, 11, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1876/G"),
      p(0, "cf-1554b", "Cobb", "Medium", [3, 8, 12, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1554/B"),
      p(0, "cf-1902e", "Collapsing Strings", "Medium", [0, 1, 7, 10, 11, 12, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1902/E"),
      p(0, "cf-1904b", "Collecting Game", "Easy", [3, 4, 6, 11, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1904/B"),
      p(0, "cf-1714d", "Color with Occurrences", "Medium", [0, 1, 3, 7, 8, 12, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1714/D"),
      p(0, "cf-2004d", "Colored Portals", "Medium", [0, 3, 6, 7, 8, 9, 11, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2004/D"),
      p(0, "cf-1796e", "Colored Subgraphs", "Hard", [8, 10, 11, 12, 13, 14, 15, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1796/E"),
      p(0, "cf-1870c", "Colorful Table", "Easy", [0, 3, 4, 6, 7, 11, 12, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1870/C"),
      p(0, "cf-1787g", "Colorful Tree Again", "Hard", [0, 3, 7, 8, 10, 11, 12, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1787/G"),
      p(0, "cf-1697e", "Coloring", "Hard", [0, 3, 8, 9, 12, 13, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1697/E"),
      p(0, "cf-2219c", "Coloring a Red Black Tree", "Hard", [8, 10, 11, 12, 13, 14, 15, 16, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2219/C"),
      p(0, "cf-902b", "Coloring a Tree", "Easy", [8, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/902/B"),
      p(0, "cf-2112c", "Coloring Game", "Easy", [3, 4, 6, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2112/C"),
      p(0, "cf-1684c", "Column Swapping", "Easy", [0, 3, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1684/C"),
      p(0, "cf-2114d", "Come a Little Closer", "Easy", [0, 3, 8, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2114/D"),
      p(0, "cf-1777f", "Comfortably Numb", "Hard", [0, 1, 5, 7, 10, 11, 12, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1777/F"),
      p(0, "cf-747e", "Comments", "Medium", [0, 1, 8, 10, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/747/E"),
      p(0, "cf-1553g", "Common Divisor Graph", "Hard", [2, 3, 8, 9, 13, 14, 15, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1553/G"),
      p(0, "cf-182d", "Common Divisors", "Easy", [0, 1, 2, 3, 8, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/182/D"),
      p(0, "cf-1062e", "Company", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1062/E"),
      p(0, "cf-1182d", "Complete Mirror", "Hard", [0, 2, 8, 10, 11, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1182/D"),
      p(0, "cf-1508c", "Complete the MST", "Hard", [0, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1508/C"),
      p(0, "cf-1228d", "Complete Tripartite", "Medium", [0, 2, 3, 8, 9, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1228/D"),
      p(0, "cf-2018e1", "Complex Segments (Easy Version)", "Hard", [0, 5, 6, 7, 11, 12, 13, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2018/E1"),
      p(0, "cf-2018e2", "Complex Segments (Hard Version)", "Hard", [0, 5, 6, 7, 11, 12, 13, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2018/E2"),
      p(0, "cf-1901e", "Compressed Tree", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1901/E"),
      p(0, "cf-1523c", "Compression and Expansion", "Medium", [0, 3, 7, 8, 10, 11, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1523/C"),
      p(0, "cf-1598a", "Computer Game", "Easy", [0, 3, 8, 10, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1598/A"),
      p(0, "cf-1313e", "Concatenation with intersection", "Hard", [0, 1, 2, 3, 4, 7, 12, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1313/E"),
      p(0, "cf-2020d", "Connect the Dots", "Medium", [3, 8, 9, 10, 11, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2020/D"),
      p(0, "cf-292d", "Connected Components", "Medium", [0, 7, 8, 10, 12, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/292/D"),
      p(0, "cf-700b", "Connecting Universities", "Medium", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/700/B"),
      p(0, "cf-1098c", "Construct a tree", "Hard", [6, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1098/C"),
      p(0, "cf-2245d1", "Construct an Array (Easy Version)", "Medium", [0, 8, 10, 13, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2245/D1"),
      p(0, "cf-2040e", "Control of Randomness", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2040/E"),
      p(0, "cf-1398f", "Controversial Rounds", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1398/F"),
      p(0, "cf-1099f", "Cookies", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1099/F"),
      p(0, "cf-2029d", "Cool Graph", "Medium", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2029/D"),
      p(0, "cf-1830a", "Copil Copac Draws Trees", "Easy", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1830/A"),
      p(0, "cf-909e", "Coprocessor", "Medium", [8, 9, 10, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/909/E"),
      p(0, "cf-2164d", "Copy String", "Medium", [0, 1, 3, 4, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2164/D"),
      p(0, "cf-670e", "Correct Bracket Sequence Editor", "Medium", [0, 1, 7, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/670/E"),
      p(0, "cf-1472e", "Correct Placement", "Medium", [0, 3, 4, 6, 7, 11, 12, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1472/E"),
      p(0, "cf-533e", "Correcting Mistakes", "Medium", [1, 2, 3, 4, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/533/E"),
      p(0, "cf-2192d", "Cost of Tree", "Medium", [10, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2192/D"),
      p(0, "cf-1923e", "Count Paths", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1923/E"),
      p(0, "cf-1355c", "Count Triangles", "Medium", [0, 3, 4, 6, 11, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1355/C"),
      p(0, "cf-2063f1", "Counting Is Not Fun (Easy Version)", "Hard", [0, 2, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2063/F1"),
      p(0, "cf-2063f2", "Counting Is Not Fun (Hard Version)", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2063/F2"),
      p(0, "cf-2074d", "Counting Points", "Easy", [0, 3, 4, 7, 8, 12, 14], false, "codeforces", "https://codeforces.com/problemset/problem/2074/D"),
      p(0, "cf-372b", "Counting Rectangles is Fun", "Medium", [3, 5, 8, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/372/B"),
      p(0, "cf-1307d", "Cow and Fields", "Medium", [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1307/D"),
      p(0, "cf-1380c", "Create The Teams", "Easy", [0, 3, 8, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1380/C"),
      p(0, "cf-1111c", "Creative Snap", "Medium", [3, 5, 6, 8, 11, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1111/C"),
      p(0, "cf-2236g", "Criterion in Burlandia", "Hard", [0, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2236/G"),
      p(0, "cf-417d", "Cunning Gena", "Medium", [12, 15, 16, 18, 19], false, "codeforces", "https://codeforces.com/problemset/problem/417/D"),
      p(0, "cf-949d", "Curfew", "Hard", [3, 6, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/949/D"),
      p(0, "cf-982c", "Cut 'em all!", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/982/C"),
      p(0, "cf-1687d", "Cute number", "Hard", [0, 3, 6, 7, 8, 11, 12, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1687/D"),
      p(0, "cf-193a", "Cutting Figure", "Medium", [9, 10, 11, 13, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/193/A"),
      p(0, "cf-1974f", "Cutting Game", "Medium", [0, 3, 4, 6, 7, 8, 11, 12, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1974/F"),
      p(0, "cf-769c", "Cycle In Maze", "Medium", [8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/769/C"),
      p(0, "cf-1867d", "Cyclic Operations", "Medium", [0, 3, 8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1867/D"),
      p(0, "cf-2107f1", "Cycling (Easy Version)", "Hard", [3, 6, 8, 11, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2107/F1"),
      p(0, "cf-2107f2", "Cycling (Hard Version)", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2107/F2"),
      p(0, "cf-2208b", "Cyclists", "Easy", [0, 3, 8, 12, 14, 15, 19, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2208/B"),
      p(0, "cf-2109d", "D/D/D", "Medium", [8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2109/D"),
      p(0, "cf-1184e3", "Daleks' Invasion (hard)", "Hard", [0, 7, 9, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1184/E3"),
      p(0, "cf-1883g2", "Dances (Hard Version)", "Medium", [3, 4, 6, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1883/G2"),
      p(0, "cf-105b", "Dark Assembly", "Medium", [3, 8, 14, 23], false, "codeforces", "https://codeforces.com/problemset/problem/105/B"),
      p(0, "cf-754e", "Dasha and cyclic table", "Hard", [1, 3, 8, 10, 11, 14, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/754/E"),
      p(0, "cf-1800f", "Dasha and Nightmares", "Medium", [1, 2, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1800/F"),
      p(0, "cf-761d", "Dasha and Very Difficult Problem", "Medium", [3, 6, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/761/D"),
      p(0, "cf-852i", "Dating", "Hard", [3, 8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/852/I"),
      p(0, "cf-1369e", "DeadLee", "Hard", [0, 7, 8, 10, 12, 13, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1369/E"),
      p(0, "cf-1693d", "Decinc Dividing", "Hard", [0, 3, 5, 7, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1693/D"),
      p(0, "cf-1766e", "Decomposition", "Hard", [0, 3, 4, 5, 6, 7, 8, 11, 12, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1766/E"),
      p(0, "cf-1056d", "Decorate Apple Tree", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1056/D"),
      p(0, "cf-1285e", "Delete a Segment", "Hard", [0, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1285/E"),
      p(0, "cf-1494f", "Delete The Edges", "Hard", [0, 3, 8, 9, 10, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1494/F"),
      p(0, "cf-1598c", "Delete Two Elements", "Easy", [0, 3, 4, 7, 12, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1598/C"),
      p(0, "cf-724d", "Dense Subsequence", "Medium", [0, 1, 7, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/724/D"),
      p(0, "cf-472d", "Design Tutorial: Inverse the Problem", "Medium", [8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/472/D"),
      p(0, "cf-439c", "Devu and Partitioning of the Array", "Medium", [0, 3, 8, 14, 15, 21], false, "codeforces", "https://codeforces.com/problemset/problem/439/C"),
      p(0, "cf-2002d1", "DFS Checker (Easy Version)", "Medium", [0, 2, 3, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2002/D1"),
      p(0, "cf-2002d2", "DFS Checker (Hard Version)", "Hard", [0, 2, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2002/D2"),
      p(0, "cf-1707c", "DFS Trees", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1707/C"),
      p(0, "cf-1499f", "Diameter Cuts", "Hard", [8, 10, 11, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1499/F"),
      p(0, "cf-1707b", "Difference Array", "Medium", [0, 3, 7, 8, 12, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1707/B"),
      p(0, "cf-2050d", "Digital string maximization", "Easy", [1, 3, 8, 12, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2050/D"),
      p(0, "cf-2021e1", "Digital Village (Easy Version)", "Hard", [0, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2021/E1"),
      p(0, "cf-2021e3", "Digital Village (Extreme Version)", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2021/E3"),
      p(0, "cf-2021e2", "Digital Village (Hard Version)", "Hard", [0, 7, 9, 10, 11, 12, 13, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2021/E2"),
      p(0, "cf-366d", "Dima and Trap Graph", "Hard", [0, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/366/D"),
      p(0, "cf-711d", "Directed Roads", "Medium", [8, 9, 10, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/711/D"),
      p(0, "cf-1389g", "Directing Edges", "Hard", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1389/G"),
      p(0, "cf-2086c", "Disappearing Permutation", "Easy", [0, 8, 9, 10, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2086/C"),
      p(0, "cf-1949i", "Disks", "Medium", [8, 9, 10, 13, 14, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1949/I"),
      p(0, "cf-2246d", "diss_quack and Array Game", "Medium", [3, 8, 12, 14, 15, 18, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2246/D"),
      p(0, "cf-161d", "Distance in Tree", "Medium", [8, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/161/D"),
      p(0, "cf-1935e", "Distance Learning Courses in MAC", "Hard", [0, 3, 7, 8, 12, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1935/E"),
      p(0, "cf-1749f", "Distance to the Path", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1749/F"),
      p(0, "cf-1632e1", "Distance Tree (easy version)", "Hard", [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1632/E1"),
      p(0, "cf-1632e2", "Distance Tree (hard version)", "Hard", [6, 8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1632/E2"),
      p(0, "cf-1467e", "Distinctive Roots in a Tree", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1467/E"),
      p(0, "cf-1461d", "Divide and Summarize", "Medium", [0, 3, 5, 6, 7, 8, 11, 12, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1461/D"),
      p(0, "cf-977d", "Divide by three, multiply by two", "Easy", [8, 10, 13, 14, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/977/D"),
      p(0, "cf-260e", "Dividing Kingdom", "Hard", [0, 3, 6, 7, 8, 11, 12, 14], false, "codeforces", "https://codeforces.com/problemset/problem/260/E"),
      p(0, "cf-687d", "Dividing Kingdom II", "Hard", [0, 3, 7, 8, 9, 12, 13, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/687/D"),
      p(0, "cf-2120c", "Divine Tree", "Easy", [10, 11, 12, 15, 17, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2120/C"),
      p(0, "cf-2203d", "Divisibility Game", "Medium", [3, 8, 12, 14, 15, 21, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2203/D"),
      p(0, "cf-2111g", "Divisible Subarrays", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2111/G"),
      p(0, "cf-1968g1", "Division + LCP (easy version)", "Medium", [0, 1, 2, 6, 7, 11, 12, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1968/G1"),
      p(0, "cf-1968g2", "Division + LCP (hard version)", "Hard", [0, 1, 2, 3, 6, 7, 8, 11, 12, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1968/G2"),
      p(0, "cf-2152d", "Division Versus Addition", "Medium", [12, 15, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2152/D"),
      p(0, "cf-2072e", "Do You Love Your Hero and His Two-Hit Multi-Target Attacks?", "Medium", [3, 6, 8, 11, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2072/E"),
      p(0, "cf-1494d", "Dogeforces", "Hard", [0, 5, 7, 8, 10, 11, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1494/D"),
      p(0, "cf-1671c", "Dolce Vita", "Easy", [3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1671/C"),
      p(0, "cf-1605c", "Dominant Character", "Easy", [0, 1, 3, 8, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1605/C"),
      p(0, "cf-1257c", "Dominated Subarray", "Easy", [0, 1, 3, 4, 12, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1257/C"),
      p(0, "cf-1764f", "Doremy's Experimental Tree", "Hard", [3, 8, 10, 11, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1764/F"),
      p(0, "cf-2196d", "Double Bracket Sequence", "Hard", [0, 1, 7, 12, 15, 16, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2196/D"),
      p(0, "cf-2129a", "Double Perspective", "Easy", [9, 12, 13, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2129/A"),
      p(0, "cf-1703d", "Double Strings", "Easy", [0, 1, 3, 7, 8, 12, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1703/D"),
      p(0, "cf-1140g", "Double Tree", "Hard", [0, 5, 7, 9, 10, 11, 12, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1140/G"),
      p(0, "cf-1558e", "Down Below", "Hard", [6, 8, 9, 10, 11, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1558/E"),
      p(0, "cf-2264d", "Dr. Agos's Dark Mode", "Medium", [1, 3, 8, 14, 15, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2264/D"),
      p(0, "cf-1285d", "Dr. Evil Underscores", "Medium", [1, 3, 5, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1285/D"),
      p(0, "cf-516d", "Drazil and Morning Exercise", "Hard", [3, 4, 8, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/516/D"),
      p(0, "cf-161a", "Dress'em in Vests!", "Easy", [3, 4, 6, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/161/A"),
      p(0, "cf-2164c", "Dungeon", "Easy", [0, 3, 6, 7, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2164/C"),
      p(0, "cf-436c", "Dungeons and Candies", "Medium", [9, 10, 11, 12, 13, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/436/C"),
      p(0, "cf-445b", "DZY Loves Chemistry", "Easy", [8, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/445/B"),
      p(0, "cf-163e", "e-Government", "Hard", [0, 1, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/163/E"),
      p(0, "cf-2053f", "Earnest Matrix Complement", "Hard", [0, 3, 7, 8, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2053/F"),
      p(0, "cf-2044f", "Easy Demon Problem", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2044/F"),
      p(0, "cf-2064d", "Eating", "Medium", [0, 3, 4, 6, 7, 8, 10, 11, 12, 14, 15, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2064/D"),
      p(0, "cf-1669f", "Eating Candies", "Easy", [0, 3, 4, 6, 7, 11, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1669/F"),
      p(0, "cf-1263f", "Economic Difficulties", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1263/F"),
      p(0, "cf-1763f", "Edge Queries", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1763/F"),
      p(0, "cf-1338b", "Edge Weight Assignment", "Medium", [8, 10, 11, 12, 13, 14, 15, 17, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1338/B"),
      p(0, "cf-1512f", "Education", "Medium", [0, 3, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1512/F"),
      p(0, "cf-1998e2", "Eliminating Balls With Merging (Hard Version)", "Hard", [0, 3, 5, 6, 7, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1998/E2"),
      p(0, "cf-61e", "Enemy is weak", "Medium", [0, 7, 10, 11, 12, 17], false, "codeforces", "https://codeforces.com/problemset/problem/61/E"),
      p(0, "cf-1781c", "Equal Frequencies", "Medium", [0, 1, 3, 8, 12, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1781/C"),
      p(0, "cf-2211c1", "Equal Multisets (Easy Version)", "Easy", [3, 4, 6, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2211/C1"),
      p(0, "cf-1928b", "Equalize", "Easy", [3, 4, 6, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1928/B"),
      p(0, "cf-1702f", "Equate Multisets", "Medium", [0, 7, 12, 15, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1702/F"),
      p(0, "cf-559b", "Equivalent Strings", "Medium", [1, 2, 5, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/559/B"),
      p(0, "cf-1537e1", "Erase and Extend (Easy Version)", "Medium", [0, 1, 2, 3, 4, 6, 8, 11, 12, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1537/E1"),
      p(0, "cf-1537e2", "Erase and Extend (Hard Version)", "Hard", [0, 1, 2, 3, 4, 6, 7, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1537/E2"),
      p(0, "cf-1917b", "Erase First or Second Letter", "Easy", [0, 1, 3, 7, 8, 12, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1917/B"),
      p(0, "cf-1611e1", "Escape The Maze (easy version)", "Medium", [3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1611/E1"),
      p(0, "cf-1611e2", "Escape The Maze (hard version)", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1611/E2"),
      p(0, "cf-61d", "Eternal Victory", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/61/D"),
      p(0, "cf-2086d", "Even String", "Medium", [1, 3, 8, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2086/D"),
      p(0, "cf-1731c", "Even Subarrays", "Medium", [2, 3, 8, 14, 18, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1731/C"),
      p(0, "cf-1644e", "Expand the Path", "Medium", [0, 3, 7, 8, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1644/E"),
      p(0, "cf-804d", "Expected diameter of a tree", "Hard", [3, 6, 8, 10, 11, 13, 14, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/804/D"),
      p(0, "cf-6e", "Exposition", "Medium", [0, 3, 4, 6, 7, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/6/E"),
      p(0, "cf-2184e", "Exquisite Array", "Medium", [0, 7, 12, 13, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2184/E"),
      p(0, "cf-1634e", "Fair Share", "Hard", [0, 7, 8, 9, 10, 12, 13, 14, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1634/E"),
      p(0, "cf-1693b", "Fake Plastic Trees", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1693/B"),
      p(0, "cf-629e", "Famil Door and Roads", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/629/E"),
      p(0, "cf-1860b", "Fancy Coins", "Easy", [3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1860/B"),
      p(0, "cf-1402a", "Fancy Fence", "Medium", [0, 7, 12, 13, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1402/A"),
      p(0, "cf-118c", "Fancy Number", "Medium", [1, 3, 8, 12, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/118/C"),
      p(0, "cf-1942h", "Farmer John's Favorite Intern", "Hard", [0, 7, 10, 11, 12, 16, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1942/H"),
      p(0, "cf-2148g", "Farmer John's Last Wish", "Medium", [0, 6, 7, 11, 12, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2148/G"),
      p(0, "cf-467d", "Fedor and Essay", "Hard", [1, 2, 8, 9, 10, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/467/D"),
      p(0, "cf-757c", "Felicity is Coming!", "Medium", [0, 1, 2, 7, 12, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/757/C"),
      p(0, "cf-1967c", "Fenwick Tree", "Hard", [0, 3, 7, 8, 10, 11, 12, 14, 16, 17, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1967/C"),
      p(0, "cf-2110d", "Fewer Batteries", "Medium", [2, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2110/D"),
      p(0, "cf-2176d", "Fibonacci Paths", "Medium", [0, 7, 9, 12, 13, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2176/D"),
      p(0, "cf-1719c", "Fighting Tournament", "Easy", [0, 3, 4, 6, 7, 11, 12], false, "codeforces", "https://codeforces.com/problemset/problem/1719/C"),
      p(0, "cf-1517c", "Fillomino 2", "Easy", [0, 8, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1517/C"),
      p(0, "cf-1927d", "Find the Different Ones!", "Easy", [0, 3, 4, 6, 7, 8, 11, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1927/D"),
      p(0, "cf-2056b", "Find the Permutation", "Easy", [0, 3, 8, 9, 10, 13, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2056/B"),
      p(0, "cf-2009f", "Firefly's Queries", "Medium", [0, 7, 12, 18, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2009/F"),
      p(0, "cf-1817b", "Fish Graph", "Medium", [3, 8, 9, 10, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1817/B"),
      p(0, "cf-698b", "Fix a Tree", "Medium", [8, 9, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/698/B"),
      p(0, "cf-1792d", "Fixed Prefix Permutations", "Medium", [0, 2, 6, 7, 11, 12, 18, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1792/D"),
      p(0, "cf-1979d", "Fixing a Binary String", "Medium", [1, 2, 3, 8, 12, 14, 15, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1979/D"),
      p(0, "cf-1181c", "Flag", "Medium", [0, 3, 8, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1181/C"),
      p(0, "cf-1503d", "Flip the Cards", "Hard", [0, 3, 4, 7, 12, 15, 19, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1503/D"),
      p(0, "cf-1485c", "Floor and Mod", "Medium", [3, 6, 8, 11, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1485/C"),
      p(0, "cf-990f", "Flow Control", "Hard", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/990/F"),
      p(0, "cf-1367f2", "Flying Sort (Hard Version)", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1367/F2"),
      p(0, "cf-191c", "Fools and Roads", "Medium", [0, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/191/C"),
      p(0, "cf-1217f", "Forced Online Queries Problem", "Hard", [0, 5, 7, 9, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1217/F"),
      p(0, "cf-1829f", "Forever Winter", "Easy", [8, 9, 10, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1829/F"),
      p(0, "cf-2057f", "Formation", "Hard", [0, 3, 4, 6, 7, 11, 12, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2057/F"),
      p(0, "cf-1455e", "Four Points", "Hard", [0, 3, 6, 8, 12, 14, 15, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1455/E"),
      p(0, "cf-846c", "Four Segments", "Medium", [0, 3, 7, 8, 12, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/846/C"),
      p(0, "cf-510d", "Fox And Jumping", "Medium", [3, 8, 14, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/510/D"),
      p(0, "cf-388b", "Fox and Minimal path", "Medium", [0, 9, 13, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/388/B"),
      p(0, "cf-1957f1", "Frequency Mismatch (Easy Version)", "Hard", [0, 2, 5, 6, 7, 10, 11, 12, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1957/F1"),
      p(0, "cf-1957f2", "Frequency Mismatch (Hard Version)", "Hard", [0, 2, 6, 7, 8, 10, 11, 12, 13, 14, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1957/F2"),
      p(0, "cf-1585e", "Frequency Queries", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1585/E"),
      p(0, "cf-1775d", "Friendly Spiders", "Medium", [8, 9, 10, 13, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1775/D"),
      p(0, "cf-1324c", "Frog Jumps", "Easy", [0, 6, 7, 8, 10, 11, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1324/C"),
      p(0, "cf-1601b", "Frog Traveler", "Medium", [0, 3, 4, 7, 8, 9, 10, 12, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1601/B"),
      p(0, "cf-1428f", "Fruit Sequences", "Hard", [0, 3, 4, 5, 6, 7, 11, 12, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1428/F"),
      p(0, "cf-1062d", "Fun with Integers", "Medium", [0, 8, 9, 10, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1062/D"),
      p(0, "cf-1994d", "Funny Game", "Medium", [9, 10, 11, 12, 13, 15, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1994/D"),
      p(0, "cf-2196e1", "Fuzzy Concatenation (Easy Version)", "Hard", [0, 1, 3, 6, 7, 8, 11, 12, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2196/E1"),
      p(0, "cf-2196e2", "Fuzzy Concatenation (Hard version)", "Hard", [0, 1, 6, 7, 11, 12, 15, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2196/E2"),
      p(0, "cf-2013f1", "Game in Tree (Easy Version)", "Hard", [0, 3, 6, 7, 8, 10, 11, 12, 14, 15, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2013/F1"),
      p(0, "cf-1608c", "Game Master", "Medium", [0, 3, 4, 7, 8, 9, 10, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1608/C"),
      p(0, "cf-1889d", "Game of Stacks", "Hard", [0, 3, 8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1889/D"),
      p(0, "cf-1787d", "Game on Axis", "Medium", [0, 8, 9, 10, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1787/D"),
      p(0, "cf-2230f", "Game on Growing Tree", "Hard", [0, 5, 6, 8, 10, 11, 13, 14, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2230/F"),
      p(0, "cf-1623b", "Game on Ranges", "Easy", [0, 3, 8, 10, 13, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1623/B"),
      p(0, "cf-1452g", "Game On Tree", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1452/G"),
      p(0, "cf-1970c3", "Game on Tree (Hard)", "Medium", [8, 10, 11, 13, 14, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1970/C3"),
      p(0, "cf-1970c2", "Game on Tree (Medium)", "Medium", [8, 10, 11, 13, 14, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1970/C2"),
      p(0, "cf-1913c", "Game with Multiset", "Easy", [3, 6, 8, 11, 12, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1913/C"),
      p(0, "cf-2063d", "Game With Triangles", "Hard", [0, 3, 4, 6, 7, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2063/D"),
      p(0, "cf-1383b", "GameGame", "Medium", [12, 15, 16, 18, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1383/B"),
      p(0, "cf-2121g", "Gangsta", "Medium", [0, 5, 7, 12, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2121/G"),
      p(0, "cf-1593e", "Gardener and Tree", "Medium", [0, 3, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1593/E"),
      p(0, "cf-1822f", "Gardening Friends", "Medium", [3, 8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1822/F"),
      p(0, "cf-463c", "Gargari and Bishops", "Medium", [0, 2, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/463/C"),
      p(0, "cf-463d", "Gargari and Permutations", "Medium", [0, 8, 9, 10, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/463/D"),
      p(0, "cf-1801e", "Gasoline prices", "Hard", [0, 2, 5, 7, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1801/E"),
      p(0, "cf-1955g", "GCD on a grid", "Medium", [0, 3, 8, 10, 13, 14, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1955/G"),
      p(0, "cf-2115b", "Gellyfish and Camellia Japonica", "Hard", [3, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2115/B"),
      p(0, "cf-722d", "Generating Sets", "Medium", [0, 1, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/722/D"),
      p(0, "cf-2032d", "Genokraken", "Medium", [0, 3, 4, 7, 9, 10, 11, 12, 13, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2032/D"),
      p(0, "cf-1902b", "Getting Points", "Easy", [3, 6, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1902/B"),
      p(0, "cf-1661b", "Getting Zero", "Easy", [3, 8, 9, 10, 12, 13, 14, 15, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1661/B"),
      p(0, "cf-2091g", "Gleb and Boating", "Hard", [0, 3, 7, 8, 9, 12, 13, 14, 15, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2091/G"),
      p(0, "cf-2106f", "Goblin", "Medium", [8, 10, 12, 13, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2106/F"),
      p(0, "cf-1500a", "Going Home", "Medium", [0, 2, 3, 8, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1500/A"),
      p(0, "cf-1829d", "Gold Rush", "Easy", [0, 3, 8, 10, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1829/D"),
      p(0, "cf-1835f", "Good Graph", "Hard", [0, 8, 9, 10, 13, 14, 18, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1835/F"),
      p(0, "cf-1736c1", "Good Subarrays (Easy Version)", "Easy", [0, 3, 4, 6, 7, 11, 12], false, "codeforces", "https://codeforces.com/problemset/problem/1736/C1"),
      p(0, "cf-2241b", "Good times Good times", "Easy", [8, 10, 13, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2241/B"),
      p(0, "cf-2072f", "Goodbye, Banker Life", "Medium", [15, 18, 20, 21, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2072/F"),
      p(0, "cf-2233d", "Goods on the Shelf", "Medium", [0, 3, 4, 7, 8, 12, 14], false, "codeforces", "https://codeforces.com/problemset/problem/2233/D"),
      p(0, "cf-739e", "Gosha is hunting", "Hard", [0, 3, 7, 8, 12, 14, 16, 19, 20, 22, 23], false, "codeforces", "https://codeforces.com/problemset/problem/739/E"),
      p(0, "cf-1582c", "Grandma Capa Knits a Scarf", "Easy", [0, 1, 3, 4, 7, 8, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1582/C"),
      p(0, "cf-2069f", "Graph Inclusion", "Hard", [0, 5, 7, 8, 9, 10, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/2069/F"),
      p(0, "cf-1200f", "Graph Traveler", "Hard", [0, 3, 7, 8, 9, 10, 12, 13, 14, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1200/F"),
      p(0, "cf-1549b", "Gregor and the Pawn Game", "Easy", [0, 8, 9, 10, 12, 13, 14, 15, 16, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1549/B"),
      p(0, "cf-1990d", "Grid Puzzle", "Medium", [0, 3, 8, 12, 14, 15, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1990/D"),
      p(0, "cf-529b", "Group Photo 2 (online mirror version)", "Medium", [3, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/529/B"),
      p(0, "cf-2001c", "Guess The Tree", "Medium", [3, 5, 6, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2001/C"),
      p(0, "cf-2093f", "Hackers and Neural Networks", "Medium", [3, 8, 12, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2093/F"),
      p(0, "cf-490c", "Hacking Cypher", "Medium", [1, 3, 8, 14, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/490/C"),
      p(0, "cf-1799f", "Halve or Subtract", "Hard", [3, 6, 8, 11, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1799/F"),
      p(0, "cf-514b", "Han Solo and Lazer Gun", "Easy", [0, 3, 7, 8, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/514/B"),
      p(0, "cf-2207f", "Hanabi", "Hard", [0, 6, 7, 9, 11, 12, 13, 15, 16, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2207/F"),
      p(0, "cf-1740e", "Hanging Hearts", "Medium", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1740/E"),
      p(0, "cf-1916e", "Happy Life in University", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1916/E"),
      p(0, "cf-593d", "Happy Tree Party", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/593/D"),
      p(0, "cf-1983c", "Have Your Cake and Eat It Too", "Easy", [0, 3, 6, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1983/C"),
      p(0, "cf-1909c", "Heavy Intervals", "Easy", [0, 7, 12, 13, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1909/C"),
      p(0, "cf-1592d", "Hemose in ICPC ?", "Hard", [0, 6, 8, 10, 11, 13, 14, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1592/D"),
      p(0, "cf-1421d", "Hexagons", "Medium", [0, 3, 8, 9, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1421/D"),
      p(0, "cf-827b", "High Load", "Medium", [0, 10, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/827/B"),
      p(0, "cf-1315b", "Homecoming", "Easy", [1, 6, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1315/B"),
      p(0, "cf-1771d", "Hossam and (sub-)palindromic tree", "Hard", [0, 1, 3, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1771/D"),
      p(0, "cf-1771f", "Hossam and Range Minimum Query", "Hard", [0, 1, 2, 6, 7, 10, 11, 12, 17, 18, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1771/F"),
      p(0, "cf-126a", "Hot Bath", "Medium", [3, 6, 8, 11, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/126/A"),
      p(0, "cf-2255d", "How Long Until Nothing Remains?", "Hard", [0, 6, 7, 11, 12, 15, 18, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2255/D"),
      p(0, "cf-2184c", "Huge Pile", "Easy", [6, 8, 9, 10, 11, 13, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2184/C"),
      p(0, "cf-2253d", "Hypercarp and Interdimensional Jumps", "Medium", [0, 3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2253/D"),
      p(0, "cf-2133e", "I Yearned For The Mines", "Hard", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2133/E"),
      p(0, "cf-2121h", "Ice Baby", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2121/H"),
      p(0, "cf-217a", "Ice Skating", "Easy", [3, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/217/A"),
      p(0, "cf-2195g", "Idiot First Search and Queries", "Hard", [0, 6, 7, 9, 10, 11, 12, 13, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2195/G"),
      p(0, "cf-1728g", "Illumination", "Hard", [3, 4, 6, 8, 11, 14, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1728/G"),
      p(0, "cf-650b", "Image Preview", "Medium", [3, 4, 6, 8, 11, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/650/B"),
      p(0, "cf-817d", "Imbalanced Array", "Medium", [0, 5, 7, 12, 13, 19], false, "codeforces", "https://codeforces.com/problemset/problem/817/D"),
      p(0, "cf-1852b", "Imbalanced Arrays", "Medium", [3, 4, 9, 12, 13, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1852/B"),
      p(0, "cf-1763b", "Incinerate", "Easy", [0, 3, 6, 7, 8, 11, 12, 14, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1763/B"),
      p(0, "cf-1569d", "Inconvenient Pairs", "Medium", [0, 3, 4, 6, 7, 11, 12, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1569/D"),
      p(0, "cf-1644c", "Increase Subarray Sums", "Easy", [0, 3, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1644/C"),
      p(0, "cf-1922e", "Increasing Subsequences", "Medium", [5, 12, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1922/E"),
      p(0, "cf-2150a", "Incremental Path", "Easy", [0, 2, 7, 12], false, "codeforces", "https://codeforces.com/problemset/problem/2150/A"),
      p(0, "cf-2259g", "Index Removal", "Medium", [0, 6, 7, 11, 12, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2259/G"),
      p(0, "cf-1207g", "Indie Album", "Hard", [0, 1, 2, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1207/G"),
      p(0, "cf-1895e", "Infinite Card Game", "Hard", [0, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 19, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1895/E"),
      p(0, "cf-2071d1", "Infinite Sequence (Easy Version)", "Medium", [0, 3, 8, 14, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2071/D1"),
      p(0, "cf-2071d2", "Infinite Sequence (Hard Version)", "Hard", [0, 3, 7, 8, 12, 14, 15, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2071/D2"),
      p(0, "cf-1635d", "Infinite Set", "Medium", [1, 16, 17, 18, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1635/D"),
      p(0, "cf-1476b", "Inflation", "Easy", [3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1476/B"),
      p(0, "cf-374c", "Inna and Dima", "Medium", [0, 8, 9, 10, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/374/C"),
      p(0, "cf-780d", "Innokenty and a Football League", "Medium", [0, 1, 9, 12, 13, 15, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/780/D"),
      p(0, "cf-1548b", "Integers Have Friends", "Medium", [0, 3, 4, 5, 6, 7, 11, 12, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1548/B"),
      p(0, "cf-1648b", "Integral Array", "Medium", [0, 3, 7, 8, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1648/B"),
      p(0, "cf-2127g2", "Inter Active (Hard Version)", "Hard", [0, 6, 9, 11, 13, 15, 18, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2127/G2"),
      p(0, "cf-1879e", "Interactive Game with Coloring", "Hard", [0, 3, 8, 9, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1879/E"),
      p(0, "cf-2196c1", "Interactive Graph (Simple Version)", "Medium", [6, 8, 9, 10, 11, 13, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2196/C1"),
      p(0, "cf-482b", "Interesting Array", "Medium", [0, 7, 10, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/482/B"),
      p(0, "cf-1720b", "Interesting Sum", "Easy", [0, 3, 7, 8, 12, 14, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1720/B"),
      p(0, "cf-1044b", "Intersecting Subtrees", "Medium", [8, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1044/B"),
      p(0, "cf-2159d1", "Inverse Minimum Partition (Easy Version)", "Hard", [3, 4, 6, 8, 11, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2159/D1"),
      p(0, "cf-1638c", "Inversion Graph", "Easy", [0, 7, 9, 12, 13, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1638/C"),
      p(0, "cf-2143d1", "Inversion Graph Coloring (Easy Version)", "Medium", [0, 3, 4, 7, 12, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2143/D1"),
      p(0, "cf-936e", "Iqea", "Hard", [0, 5, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/936/E"),
      p(0, "cf-1833f", "Ira and Flamenco", "Medium", [0, 3, 4, 7, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1833/F"),
      p(0, "cf-2006a", "Iris and Game on the Tree", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2006/A"),
      p(0, "cf-2006b", "Iris and the Tree", "Medium", [0, 3, 7, 8, 10, 11, 12, 13, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2006/B"),
      p(0, "cf-2006e", "Iris's Full Binary Tree", "Hard", [0, 3, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2006/E"),
      p(0, "cf-1290b", "Irreducible Anagrams", "Medium", [0, 1, 3, 4, 6, 7, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1290/B"),
      p(0, "cf-2157g", "Isaac's Queries", "Hard", [3, 5, 8, 10, 12, 13, 14, 15, 16, 18, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2157/G"),
      p(0, "cf-2173f", "Isla's Memory Thresholds", "Hard", [0, 3, 5, 6, 7, 8, 11, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2173/F"),
      p(0, "cf-2227e", "It All Went Sideways", "Easy", [0, 6, 7, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2227/E"),
      p(0, "cf-2227f", "It Just Keeps Going Sideways", "Medium", [0, 6, 7, 11, 12, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2227/F"),
      p(0, "cf-1878e", "Iva & Pav", "Easy", [0, 6, 7, 11, 12, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1878/E"),
      p(0, "cf-1726c", "Jatayu's Balanced Bracket Sequence", "Easy", [0, 7, 9, 12, 13, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1726/C"),
      p(0, "cf-2187c", "Jerry and Tom", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2187/C"),
      p(0, "cf-626d", "Jerry's Protest", "Medium", [3, 8, 14, 16, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/626/D"),
      p(0, "cf-1361c", "Johnny and Megan's Necklace", "Hard", [6, 8, 9, 10, 11, 13, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1361/C"),
      p(0, "cf-768c", "Jon Snow and his Favourite Number", "Medium", [0, 3, 8, 14, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/768/C"),
      p(0, "cf-1780e", "Josuke and Complete Graph", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1780/E"),
      p(0, "cf-1320a", "Journey Planning", "Easy", [0, 7, 12, 15, 16, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1320/A"),
      p(0, "cf-2155f", "Juan's Colorful Tree", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2155/F"),
      p(0, "cf-1550f", "Jumping Around", "Hard", [0, 5, 6, 7, 9, 11, 12, 13, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1550/F"),
      p(0, "cf-2183f", "Jumping Man", "Hard", [3, 8, 10, 11, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2183/F"),
      p(0, "cf-1588f", "Jumping Through the Array", "Hard", [0, 3, 4, 6, 7, 9, 11, 12, 13], false, "codeforces", "https://codeforces.com/problemset/problem/1588/F"),
      p(0, "cf-1332c", "K-Complete Word", "Medium", [0, 1, 8, 10, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1332/C"),
      p(0, "cf-1328b", "K-th Beautiful String", "Easy", [0, 3, 6, 8, 11, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1328/B"),
      p(0, "cf-685b", "Kay and Snowflake", "Medium", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/685/B"),
      p(0, "cf-1866k", "Keen Tree Calculation", "Hard", [0, 6, 7, 9, 10, 11, 12, 13, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1866/K"),
      p(0, "cf-2048c", "Kevin and Binary Strings", "Easy", [0, 1, 3, 8, 12, 14, 15, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2048/C"),
      p(0, "cf-2048d", "Kevin and Competition Memories", "Medium", [0, 3, 4, 6, 7, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2048/D"),
      p(0, "cf-2048f", "Kevin and Math Class", "Hard", [0, 3, 5, 7, 8, 10, 11, 12, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2048/F"),
      p(0, "cf-2268c", "KiaKio and Energy Intervals", "Hard", [0, 3, 4, 5, 6, 7, 10, 11, 12, 13, 15, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2268/C"),
      p(0, "cf-242c", "King's Path", "Medium", [2, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/242/C"),
      p(0, "cf-1510k", "King's Task", "Easy", [0, 3, 8, 9, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1510/K"),
      p(0, "cf-613d", "Kingdom and its Cities", "Hard", [5, 8, 9, 10, 11, 13, 14, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/613/D"),
      p(0, "cf-2114e", "Kirei Attacks the Estate", "Easy", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2114/E"),
      p(0, "cf-1209f", "Koala and Notebook", "Hard", [0, 1, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1209/F"),
      p(0, "cf-1582f2", "Korney Korneevich and XOR (hard version)", "Hard", [3, 4, 6, 8, 11, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1582/F2"),
      p(0, "cf-2033d", "Kousuke's Assignment", "Easy", [0, 7, 12, 13, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2033/D"),
      p(0, "cf-1770e", "Koxia and Tree", "Hard", [8, 10, 11, 13, 14, 16, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1770/E"),
      p(0, "cf-1833g", "Ksyusha and Chinchilla", "Medium", [0, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1833/G"),
      p(0, "cf-979d", "Kuro and GCD and XOR and SUM", "Hard", [0, 1, 3, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/979/D"),
      p(0, "cf-1305d", "Kuroni and the Celebration", "Medium", [8, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1305/D"),
      p(0, "cf-553b", "Kyoya and Permutation", "Medium", [0, 6, 11, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/553/B"),
      p(0, "cf-2094h", "La Vaca Saturno Saturnita", "Medium", [3, 6, 8, 11, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2094/H"),
      p(0, "cf-1794e", "Labeling the Tree with Distances", "Hard", [0, 2, 7, 10, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1794/E"),
      p(0, "cf-1978f", "Large Graph", "Hard", [0, 3, 4, 7, 8, 9, 10, 12, 13, 14, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1978/F"),
      p(0, "cf-1045a", "Last chance", "Hard", [0, 7, 9, 10, 11, 12, 13, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1045/A"),
      p(0, "cf-1042f", "Leaf Sets", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1042/F"),
      p(0, "cf-1942d", "Learning to Paint", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1942/D"),
      p(0, "cf-995c", "Leaving the Bar", "Hard", [0, 3, 7, 8, 12, 14, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/995/C"),
      p(0, "cf-1277d", "Let's Play the Words?", "Medium", [0, 2, 7, 12, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1277/D"),
      p(0, "cf-1728d", "Letter Picking", "Medium", [3, 4, 15, 16, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1728/D"),
      p(0, "cf-1689a", "Lex String", "Easy", [0, 3, 4, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1689/A"),
      p(0, "cf-1930c", "Lexicographically Largest", "Medium", [0, 6, 7, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1930/C"),
      p(0, "cf-1797e", "Li Hua and Array", "Hard", [0, 3, 4, 7, 8, 12, 13, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1797/E"),
      p(0, "cf-1797f", "Li Hua and Path", "Hard", [0, 5, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1797/F"),
      p(0, "cf-1797d", "Li Hua and Tree", "Medium", [0, 3, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1797/D"),
      p(0, "cf-1914g2", "Light Bulbs (Hard Version)", "Hard", [0, 2, 7, 8, 9, 10, 12, 13, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1914/G2"),
      p(0, "cf-1659c", "Line Empire", "Medium", [0, 3, 6, 8, 11, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1659/C"),
      p(0, "cf-1336a", "Linova and Kingdom", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1336/A"),
      p(0, "cf-1851f", "Lisa and the Martians", "Medium", [1, 10, 11, 12, 15, 17, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1851/F"),
      p(0, "cf-258e", "Little Elephant and Tree", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/258/E"),
      p(0, "cf-276d", "Little Girl and Maximum XOR", "Medium", [0, 12, 15, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/276/D"),
      p(0, "cf-202a", "LLPS", "Easy", [0, 1, 3, 6, 8, 11, 12, 14, 15, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/202/A"),
      p(0, "cf-600e", "Lomsat gelral", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/600/E"),
      p(0, "cf-1928d", "Lonely Mountain Dungeons", "Medium", [0, 3, 6, 7, 8, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1928/D"),
      p(0, "cf-1955e", "Long Inversions", "Medium", [0, 3, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1955/E"),
      p(0, "cf-2145f", "Long Journey", "Hard", [5, 8, 9, 10, 12, 13, 14, 15, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2145/F"),
      p(0, "cf-1967d", "Long Way to be Non-decreasing", "Hard", [0, 3, 4, 6, 8, 9, 10, 11, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1967/D"),
      p(0, "cf-2001d", "Longest Max Min Subsequence", "Medium", [0, 3, 7, 8, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2001/D"),
      p(0, "cf-5c", "Longest Regular Bracket Sequence", "Medium", [0, 1, 7, 12, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/5/C"),
      p(0, "cf-1676f", "Longest Strike", "Easy", [0, 3, 4, 7, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1676/F"),
      p(0, "cf-696a", "Lorenzo Von Matterhorn", "Medium", [0, 3, 7, 8, 10, 11, 12, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/696/A"),
      p(0, "cf-1167b", "Lost Numbers", "Easy", [3, 5, 8, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1167/B"),
      p(0, "cf-1835b", "Lottery", "Hard", [3, 4, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1835/B"),
      p(0, "cf-939d", "Love Rescue", "Medium", [1, 8, 9, 10, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/939/D"),
      p(0, "cf-1932c", "LR-remainders", "Easy", [0, 3, 4, 7, 8, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1932/C"),
      p(0, "cf-1768d", "Lucky Permutation", "Medium", [8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1768/D"),
      p(0, "cf-109b", "Lucky Probability", "Medium", [3, 8, 14, 23], false, "codeforces", "https://codeforces.com/problemset/problem/109/B"),
      p(0, "cf-1106d", "Lunar New Year and a Wander", "Medium", [0, 7, 8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1106/D"),
      p(0, "cf-1824b1", "LuoTianyi and the Floating Islands (Easy Version)", "Medium", [10, 11, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1824/B1"),
      p(0, "cf-1824c", "LuoTianyi and XOR-Tree", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1824/C"),
      p(0, "cf-1142b", "Lynyrd Skynyrd", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1142/B"),
      p(0, "cf-1873h", "Mad City", "Medium", [8, 9, 10, 11, 13, 14, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1873/H"),
      p(0, "cf-917b", "MADMAX", "Medium", [8, 9, 10, 13, 14, 16, 23], false, "codeforces", "https://codeforces.com/problemset/problem/917/B"),
      p(0, "cf-1647b", "Madoka and the Elegant Gift", "Easy", [0, 3, 8, 9, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1647/B"),
      p(0, "cf-632f", "Magic Matrix", "Hard", [3, 5, 8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/632/F"),
      p(0, "cf-1822g1", "Magic Triples (Easy Version)", "Medium", [0, 3, 7, 8, 12, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1822/G1"),
      p(0, "cf-1862f", "Magic Will Save the World", "Medium", [3, 6, 8, 11, 14, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1862/F"),
      p(0, "cf-1704d", "Magical Array", "Medium", [0, 2, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1704/D"),
      p(0, "cf-1163e", "Magical Permutation", "Hard", [0, 3, 7, 8, 9, 12, 13, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1163/E"),
      p(0, "cf-766c", "Mahmoud and a Message", "Medium", [1, 3, 8, 12, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/766/C"),
      p(0, "cf-766e", "Mahmoud and a xor trip", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/766/E"),
      p(0, "cf-862b", "Mahmoud and Ehab and the bipartiteness", "Easy", [8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/862/B"),
      p(0, "cf-959e", "Mahmoud and Ehab and the xor-MST", "Medium", [0, 9, 13, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/959/E"),
      p(0, "cf-29c", "Mail Stamps", "Medium", [0, 7, 8, 9, 10, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/29/C"),
      p(0, "cf-2004f", "Make a Palindrome", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2004/F"),
      p(0, "cf-1761e", "Make It Connected", "Hard", [3, 4, 6, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1761/E"),
      p(0, "cf-1593b", "Make it Divisible by 25", "Easy", [8, 10, 12, 13, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1593/B"),
      p(0, "cf-1594c", "Make Them Equal", "Easy", [1, 3, 8, 12, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1594/C"),
      p(0, "cf-2138c1", "Maple and Tree Beauty (Easy Version)", "Medium", [3, 8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2138/C1"),
      p(0, "cf-1705e", "Mark and Professor Koro", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1705/E"),
      p(0, "cf-2068f", "Mascot Naming", "Medium", [0, 1, 3, 8, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2068/F"),
      p(0, "cf-1741d", "Masha and a Beautiful Tree", "Easy", [5, 8, 9, 10, 11, 13, 14, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1741/D"),
      p(0, "cf-2244e", "Masha and the Garland", "Easy", [0, 1, 7, 12, 15, 16, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2244/E"),
      p(0, "cf-414d", "Mashmokh and Water Tanks", "Hard", [0, 3, 4, 6, 7, 10, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/414/D"),
      p(0, "cf-1721f", "Matching Reduction", "Hard", [3, 8, 9, 10, 13, 14, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1721/F"),
      p(0, "cf-2081a", "Math Division", "Medium", [16, 18, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2081/A"),
      p(0, "cf-1986d", "Mathematical Problem", "Easy", [0, 3, 4, 8, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1986/D"),
      p(0, "cf-1864d", "Matrix Cascade", "Medium", [0, 3, 7, 8, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1864/D"),
      p(0, "cf-1986b", "Matrix Stabilization", "Easy", [0, 3, 7, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1986/B"),
      p(0, "cf-2043e", "Matrix Transformation", "Hard", [0, 3, 7, 8, 9, 10, 12, 13, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2043/E"),
      p(0, "cf-1691d", "Max GEQ Sum", "Medium", [0, 3, 4, 5, 6, 7, 11, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1691/D"),
      p(0, "cf-1849e", "Max to the Right of Min", "Hard", [0, 3, 4, 5, 6, 7, 11, 12, 13, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1849/E"),
      p(0, "cf-2143c", "Max Tree", "Easy", [8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2143/C"),
      p(0, "cf-1985h1", "Maximize the Largest Component (Easy Version)", "Medium", [0, 3, 7, 8, 9, 10, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1985/H1"),
      p(0, "cf-1997d", "Maximize the Root", "Medium", [6, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1997/D"),
      p(0, "cf-1778f", "Maximizing Root", "Hard", [8, 9, 10, 11, 13, 14, 16, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1778/F"),
      p(0, "cf-1721d", "Maximum AND", "Medium", [5, 8, 10, 12, 13, 14, 15, 18, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1721/D"),
      p(0, "cf-1903d1", "Maximum And Queries (easy version)", "Medium", [3, 6, 8, 11, 12, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1903/D1"),
      p(0, "cf-1401d", "Maximum Distributed Tree", "Medium", [0, 8, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1401/D"),
      p(0, "cf-2050f", "Maximum modulo equality", "Medium", [0, 5, 7, 12, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2050/F"),
      p(0, "cf-2170a", "Maximum Neighborhood", "Easy", [0, 3, 8, 12, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2170/A"),
      p(0, "cf-2147e", "Maximum OR Popcount", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2147/E"),
      p(0, "cf-1406b", "Maximum Product", "Easy", [0, 3, 8, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1406/B"),
      p(0, "cf-1324f", "Maximum White Subtree", "Medium", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1324/F"),
      p(0, "cf-1492c", "Maximum width", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1492/C"),
      p(0, "cf-1682f", "MCMF?", "Hard", [0, 3, 4, 7, 9, 12, 13, 15, 19, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1682/F"),
      p(0, "cf-2044g1", "Medium Demon Problem (easy version)", "Medium", [0, 8, 9, 10, 11, 13, 14, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2044/G1"),
      p(0, "cf-2044g2", "Medium Demon Problem (hard version)", "Medium", [0, 8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2044/G2"),
      p(0, "cf-1884c", "Medium Design", "Medium", [0, 3, 7, 8, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1884/C"),
      p(0, "cf-309c", "Memory for Arrays", "Medium", [6, 11, 12, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/309/C"),
      p(0, "cf-2010c2", "Message Transmission Error (hard version)", "Medium", [1, 2, 3, 4, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2010/C2"),
      p(0, "cf-1935c", "Messenger in MAC", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1935/C"),
      p(0, "cf-1735d", "Meta-set", "Medium", [0, 2, 3, 7, 8, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1735/D"),
      p(0, "cf-1619e", "MEX and Increments", "Medium", [0, 7, 12, 15, 16, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1619/E"),
      p(0, "cf-2123e", "MEX Count", "Easy", [0, 3, 4, 6, 7, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2123/E"),
      p(0, "cf-1497a", "Meximization", "Easy", [0, 3, 7, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1497/A"),
      p(0, "cf-1628a", "Meximum Array", "Easy", [0, 3, 4, 6, 11, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1628/A"),
      p(0, "cf-1927f", "Microcycle", "Medium", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1927/F"),
      p(0, "cf-1623e", "Middle Duplication", "Hard", [0, 1, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1623/E"),
      p(0, "cf-1554c", "Mikasa", "Medium", [0, 6, 11, 12, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1554/C"),
      p(0, "cf-547b", "Mike and Feet", "Medium", [0, 6, 7, 11, 12, 13, 16], false, "codeforces", "https://codeforces.com/problemset/problem/547/B"),
      p(0, "cf-548b", "Mike and Fun", "Easy", [0, 3, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/548/B"),
      p(0, "cf-1511d", "Min Cost String", "Medium", [1, 3, 8, 9, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1511/D"),
      p(0, "cf-1792c", "Min Max Sort", "Medium", [3, 4, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1792/C"),
      p(0, "cf-1970g1", "Min-Fund Prison (Easy)", "Medium", [8, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1970/G1"),
      p(0, "cf-1970g3", "Min-Fund Prison (Hard)", "Hard", [8, 9, 10, 11, 13, 14, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1970/G3"),
      p(0, "cf-825e", "Minimal Labels", "Hard", [0, 7, 8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/825/E"),
      p(0, "cf-1175e", "Minimal Segment Cover", "Hard", [0, 5, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1175/E"),
      p(0, "cf-797c", "Minimal string", "Medium", [0, 1, 7, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/797/C"),
      p(0, "cf-1654f", "Minimal String Xoration", "Hard", [0, 1, 2, 5, 7, 12, 15, 17, 18, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1654/F"),
      p(0, "cf-1665e", "MinimizOR", "Hard", [0, 3, 4, 5, 7, 8, 12, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1665/E"),
      p(0, "cf-1887c", "Minimum Array", "Hard", [0, 2, 3, 4, 6, 7, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1887/C"),
      p(0, "cf-1881f", "Minimum Maximum Distance", "Medium", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1881/F"),
      p(0, "cf-2211e", "Minimum Path Cover", "Hard", [3, 8, 10, 11, 12, 14, 15, 16, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2211/E"),
      p(0, "cf-1487c", "Minimum Ties", "Medium", [0, 3, 8, 9, 10, 12, 13, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1487/C"),
      p(0, "cf-1624g", "MinOr Tree", "Medium", [8, 9, 10, 12, 13, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1624/G"),
      p(0, "cf-2045m", "Mirror Maze", "Medium", [0, 3, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/2045/M"),
      p(0, "cf-501b", "Misha and Changing Handles", "Easy", [0, 1, 7, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/501/B"),
      p(0, "cf-504e", "Misha and LCP on Tree", "Hard", [1, 2, 6, 8, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/504/E"),
      p(0, "cf-832d", "Misha, Grisha and Underground", "Medium", [8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/832/D"),
      p(0, "cf-2092d", "Mishkin Energizer", "Medium", [0, 1, 3, 8, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2092/D"),
      p(0, "cf-144d", "Missile Silos", "Medium", [0, 7, 8, 9, 10, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/144/D"),
      p(0, "cf-1081e", "Missing Numbers", "Medium", [6, 11, 12, 15, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1081/E"),
      p(0, "cf-1559d1", "Mocha and Diana (Easy Version)", "Easy", [3, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1559/D1"),
      p(0, "cf-1559d2", "Mocha and Diana (Hard Version)", "Hard", [3, 4, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1559/D2"),
      p(0, "cf-1928e", "Modular Sequence", "Hard", [3, 8, 9, 12, 13, 14, 15, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1928/E"),
      p(0, "cf-2104g", "Modulo 3", "Hard", [0, 5, 7, 9, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2104/G"),
      p(0, "cf-577b", "Modulo Sum", "Medium", [0, 3, 4, 7, 12, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/577/B"),
      p(0, "cf-776c", "Molly's Chemicals", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/776/C"),
      p(0, "cf-2228f", "Momoyo and the Network", "Hard", [5, 6, 8, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2228/F"),
      p(0, "cf-1873f", "Money Trees", "Easy", [3, 4, 6, 11, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1873/F"),
      p(0, "cf-2035e", "Monster", "Hard", [0, 3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2035/E"),
      p(0, "cf-1626c", "Monsters And Spells", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1626/C"),
      p(0, "cf-2200f", "Mooclear Reactor 2", "Medium", [0, 3, 7, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2200/F"),
      p(0, "cf-603b", "Moodular Arithmetic", "Medium", [8, 10, 13, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/603/B"),
      p(0, "cf-1129c", "Morse Code", "Hard", [0, 1, 2, 6, 7, 11, 12, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1129/C"),
      p(0, "cf-1793d", "Moscow Gorillas", "Medium", [0, 3, 4, 6, 11, 12, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1793/D"),
      p(0, "cf-1676c", "Most Similar Words", "Easy", [0, 1, 3, 8, 12, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1676/C"),
      p(0, "cf-1485e", "Move and Swap", "Hard", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1485/E"),
      p(0, "cf-2104b", "Move to the End", "Easy", [0, 3, 7, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2104/B"),
      p(0, "cf-1311f", "Moving Points", "Medium", [0, 5, 7, 12, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1311/F"),
      p(0, "cf-505c", "Mr. Kitayuta, the Treasure Hunter", "Medium", [3, 4, 8, 10, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/505/C"),
      p(0, "cf-505b", "Mr. Kitayuta's Colorful Graph", "Easy", [8, 9, 10, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/505/B"),
      p(0, "cf-2081d", "MST in Modulo Graph", "Hard", [9, 10, 11, 12, 13, 15, 17, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2081/D"),
      p(0, "cf-1948g", "MST with Matching", "Hard", [3, 8, 10, 11, 13, 14, 17, 18, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1948/G"),
      p(0, "cf-471c", "MUH and House of Cards", "Medium", [3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/471/C"),
      p(0, "cf-1342d", "Multiple Testcases", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1342/D"),
      p(0, "cf-1709f", "Multiset of Strings", "Hard", [3, 8, 9, 10, 11, 13, 14, 16, 17, 18, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1709/F"),
      p(0, "cf-1801c", "Music Festival", "Medium", [0, 6, 7, 11, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1801/C"),
      p(0, "cf-822d", "My pretty girl Noora", "Medium", [3, 8, 12, 14, 15, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/822/D"),
      p(0, "cf-2053g", "Naive String Splits", "Hard", [1, 2, 3, 6, 8, 11, 12, 14, 15, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2053/G"),
      p(0, "cf-794c", "Naming Company", "Medium", [12, 15, 19, 23], false, "codeforces", "https://codeforces.com/problemset/problem/794/C"),
      p(0, "cf-1661e", "Narrow Components", "Hard", [0, 3, 7, 8, 10, 11, 12, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1661/E"),
      p(0, "cf-1521d", "Nastia Plays with a Tree", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1521/D"),
      p(0, "cf-1172b", "Nauuo and Circle", "Medium", [8, 10, 11, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1172/B"),
      p(0, "cf-1560f1", "Nearest Beautiful Number (easy version)", "Medium", [3, 6, 8, 10, 11, 12, 13, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1560/F1"),
      p(0, "cf-1651d", "Nearest Excluded Points", "Medium", [0, 6, 7, 8, 9, 10, 11, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1651/D"),
      p(0, "cf-1367e", "Necklace Assembly", "Medium", [3, 8, 9, 10, 12, 13, 14, 15, 16, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1367/E"),
      p(0, "cf-1543c", "Need for Pink Slips", "Medium", [0, 3, 8, 10, 13, 14, 18, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1543/C"),
      p(0, "cf-1152b", "Neko Performs Cat Furrier Transform", "Easy", [8, 10, 13, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1152/B"),
      p(0, "cf-1956a", "Nene's Game", "Easy", [0, 3, 6, 7, 8, 11, 12, 14, 15, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1956/A"),
      p(0, "cf-2108c", "Neo's Escape", "Medium", [0, 3, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2108/C"),
      p(0, "cf-1338d", "Nested Rubber Bands", "Hard", [8, 10, 11, 13, 14, 15, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1338/D"),
      p(0, "cf-2025c", "New Game", "Easy", [0, 3, 4, 6, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2025/C"),
      p(0, "cf-2029c", "New Rating", "Medium", [0, 6, 7, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2029/C"),
      p(0, "cf-659e", "New Reform", "Medium", [0, 7, 8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/659/E"),
      p(0, "cf-1359b", "New Theatre Square", "Easy", [0, 3, 4, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1359/B"),
      p(0, "cf-1284b", "New Year and Ascent Sequence", "Easy", [0, 6, 7, 11, 12, 16, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1284/B"),
      p(0, "cf-750d", "New Year and Fireworks", "Medium", [0, 3, 7, 8, 10, 12, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/750/D"),
      p(0, "cf-1284f", "New Year and Social Network", "Hard", [0, 7, 9, 10, 11, 12, 13, 17, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1284/F"),
      p(0, "cf-1091e", "New Year and the Acquaintance Estimation", "Hard", [0, 6, 7, 9, 11, 12, 13, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1091/E"),
      p(0, "cf-500b", "New Year Permutation", "Medium", [8, 9, 10, 12, 13, 14, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/500/B"),
      p(0, "cf-500d", "New Year Santa Network", "Medium", [8, 9, 10, 11, 13, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/500/D"),
      p(0, "cf-2182e", "New Year's Gifts", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2182/E"),
      p(0, "cf-2254g", "Nightcrawler", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2254/G"),
      p(0, "cf-842e", "Nikita and game", "Hard", [5, 6, 8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/842/E"),
      p(0, "cf-1977c", "Nikita and LCM", "Medium", [0, 3, 7, 8, 12, 14, 15, 16, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1977/C"),
      p(0, "cf-2043f", "Nim", "Hard", [0, 3, 8, 9, 12, 14, 15, 16, 18, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2043/F"),
      p(0, "cf-1951e", "No Palindromes", "Hard", [0, 1, 2, 3, 5, 8, 12, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1951/E"),
      p(0, "cf-1946f", "Nobody is needed", "Hard", [0, 7, 8, 10, 12, 13, 14, 16, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1946/F"),
      p(0, "cf-847i", "Noise Level", "Medium", [0, 8, 10, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/847/I"),
      p(0, "cf-2040d", "Non Prime Tree", "Medium", [3, 4, 8, 10, 11, 12, 13, 14, 15, 17, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2040/D"),
      p(0, "cf-1986f", "Non-academic Problem", "Medium", [8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1986/F"),
      p(0, "cf-1627d", "Not Adding", "Medium", [3, 8, 14, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1627/D"),
      p(0, "cf-1627c", "Not Assigning", "Easy", [8, 10, 11, 13, 14, 15, 17, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1627/C"),
      p(0, "cf-1992e", "Novice's Mistake", "Medium", [0, 1, 3, 8, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1992/E"),
      p(0, "cf-1691e", "Number of Groups", "Hard", [0, 7, 8, 9, 10, 12, 13, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1691/E"),
      p(0, "cf-1538c", "Number of Pairs", "Easy", [0, 3, 4, 6, 7, 11, 12, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1538/C"),
      p(0, "cf-466c", "Number of Ways", "Medium", [0, 3, 4, 6, 7, 8, 11, 12, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/466/C"),
      p(0, "cf-2104f", "Numbers and Strings", "Hard", [0, 3, 6, 8, 10, 11, 13, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2104/F"),
      p(0, "cf-1286b", "Numbers on Tree", "Medium", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1286/B"),
      p(0, "cf-1216e1", "Numerical Sequence (easy version)", "Medium", [3, 6, 8, 11, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1216/E1"),
      p(0, "cf-1479d", "Odd Mineral Resource", "Hard", [0, 3, 6, 7, 8, 10, 11, 12, 14, 17, 18, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1479/D"),
      p(0, "cf-2153f", "Odd Queries on Odd Array", "Hard", [0, 3, 7, 8, 10, 11, 12, 14, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2153/F"),
      p(0, "cf-1519e", "Off by One", "Hard", [8, 9, 10, 11, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1519/E"),
      p(0, "cf-830a", "Office Keys", "Medium", [3, 6, 8, 11, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/830/A"),
      p(0, "cf-554b", "Ohana Cleans Up", "Easy", [1, 3, 8, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/554/B"),
      p(0, "cf-37c", "Old Berland Language", "Medium", [0, 7, 10, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/37/C"),
      p(0, "cf-1490g", "Old Floppy Drive", "Medium", [0, 6, 7, 11, 12, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1490/G"),
      p(0, "cf-222d", "Olympiad", "Medium", [3, 4, 6, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/222/D"),
      p(0, "cf-1746g", "Olympiad Training", "Hard", [0, 6, 7, 11, 12, 16, 19, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1746/G"),
      p(0, "cf-526b", "Om Nom and Dark Park", "Easy", [0, 8, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/526/B"),
      p(0, "cf-2117g", "Omg Graph", "Medium", [3, 8, 9, 12, 13, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2117/G"),
      p(0, "cf-1843f2", "Omsk Metro (hard version)", "Hard", [0, 5, 7, 8, 10, 11, 12, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1843/F2"),
      p(0, "cf-1843f1", "Omsk Metro (simple version)", "Medium", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1843/F1"),
      p(0, "cf-440c", "One-Based Arithmetic", "Medium", [3, 5, 8, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/440/C"),
      p(0, "cf-567d", "One-Dimensional Battle Ships", "Medium", [0, 6, 7, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/567/D"),
      p(0, "cf-1567f", "One-Four Overload", "Hard", [0, 8, 9, 10, 13, 14, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1567/F"),
      p(0, "cf-1896d", "Ones and Twos", "Medium", [0, 3, 4, 5, 6, 7, 11, 12, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1896/D"),
      p(0, "cf-486b", "OR in Matrix", "Easy", [0, 2, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/486/B"),
      p(0, "cf-2030f", "Orangutan Approved Subarrays", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2030/F"),
      p(0, "cf-2053b", "Outstanding Impressionist", "Easy", [0, 3, 6, 7, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2053/B"),
      p(0, "cf-1244d", "Paint the Tree", "Medium", [0, 3, 8, 9, 10, 11, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1244/D"),
      p(0, "cf-448c", "Painting Fence", "Medium", [5, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/448/C"),
      p(0, "cf-1324d", "Pair of Topics", "Easy", [0, 3, 4, 6, 7, 11, 12, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1324/D"),
      p(0, "cf-81e", "Pairs", "Hard", [0, 8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/81/E"),
      p(0, "cf-134b", "Pairs of Numbers", "Medium", [3, 8, 10, 13, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/134/B"),
      p(0, "cf-1391e", "Pairs of Pairs", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1391/E"),
      p(0, "cf-1486f", "Pairs of Paths", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1486/F"),
      p(0, "cf-1827c", "Palindrome Partition", "Hard", [0, 1, 2, 3, 6, 7, 8, 11, 12, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1827/C"),
      p(0, "cf-2069d", "Palindrome Shuffle", "Medium", [1, 2, 3, 4, 6, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2069/D"),
      p(0, "cf-1624d", "Palindromes Coloring", "Easy", [1, 6, 11, 12, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1624/D"),
      p(0, "cf-2227d", "Palindromex", "Easy", [0, 3, 4, 6, 7, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2227/D"),
      p(0, "cf-835d", "Palindromic characteristics", "Medium", [1, 2, 3, 8, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/835/D"),
      p(0, "cf-883h", "Palindromic Cut", "Medium", [0, 1, 3, 8, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/883/H"),
      p(0, "cf-1528a", "Parsa's Humongous Tree", "Medium", [5, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1528/A"),
      p(0, "cf-115a", "Party", "Easy", [8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/115/A"),
      p(0, "cf-459d", "Pashmak and Parmida's problem", "Medium", [0, 5, 7, 12, 19], false, "codeforces", "https://codeforces.com/problemset/problem/459/D"),
      p(0, "cf-1702g1", "Passable Paths (easy version)", "Medium", [8, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1702/G1"),
      p(0, "cf-603e", "Pastoral Oddities", "Hard", [0, 5, 7, 10, 11, 12, 13, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/603/E"),
      p(0, "cf-1714g", "Path Prefixes", "Medium", [0, 6, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1714/G"),
      p(0, "cf-1213g", "Path Queries", "Medium", [5, 9, 10, 11, 13, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1213/G"),
      p(0, "cf-1746d", "Paths on the Tree", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1746/D"),
      p(0, "cf-1476e", "Pattern Matching", "Hard", [0, 1, 2, 7, 8, 9, 10, 12, 13, 14, 17, 18, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1476/E"),
      p(0, "cf-1119e", "Pavel and Triangles", "Medium", [3, 6, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1119/E"),
      p(0, "cf-1491c", "Pekora and Trampoline", "Medium", [0, 3, 7, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1491/C"),
      p(0, "cf-1553c", "Penalty", "Easy", [3, 8, 12, 14, 15, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1553/C"),
      p(0, "cf-2031e", "Penchick and Chloe's Trees", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2031/E"),
      p(0, "cf-2031d", "Penchick and Desert Rabbit", "Medium", [0, 3, 4, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2031/D"),
      p(0, "cf-2109f", "Penguin Steps", "Hard", [6, 8, 9, 10, 11, 13, 14, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2109/F"),
      p(0, "cf-923c", "Perfect Security", "Medium", [0, 1, 7, 10, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/923/C"),
      p(0, "cf-1413c", "Perform Easily", "Medium", [0, 3, 4, 6, 8, 11, 14, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1413/C"),
      p(0, "cf-1998c", "Perform Operations to Maximize Score", "Medium", [0, 3, 6, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1998/C"),
      p(0, "cf-1738d", "Permutation Addicts", "Medium", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1738/D"),
      p(0, "cf-1967a", "Permutation Counting", "Easy", [0, 6, 11, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1967/A"),
      p(0, "cf-1718d", "Permutation for Burenka", "Hard", [0, 7, 10, 11, 12, 15, 17, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1718/D"),
      p(0, "cf-1968d", "Permutation Game", "Easy", [3, 8, 9, 10, 12, 13, 14, 15, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1968/D"),
      p(0, "cf-1696d", "Permutation Graph", "Medium", [0, 5, 6, 7, 9, 11, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1696/D"),
      p(0, "cf-1980e", "Permutation of Rows and Columns", "Medium", [0, 2, 7, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1980/E"),
      p(0, "cf-1701d", "Permutation Restoration", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1701/D"),
      p(0, "cf-1490d", "Permutation Transformation", "Easy", [0, 5, 8, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1490/D"),
      p(0, "cf-1698e", "PermutationForces II", "Hard", [3, 4, 8, 10, 11, 12, 14, 15, 17, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1698/E"),
      p(0, "cf-1856e1", "PermuTree (easy version)", "Medium", [8, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1856/E1"),
      p(0, "cf-1856e2", "PermuTree (hard version)", "Hard", [0, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1856/E2"),
      p(0, "cf-830e", "Perpetual Motion Machine", "Hard", [0, 9, 10, 11, 13, 15, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/830/E"),
      p(0, "cf-778c", "Peterson Polyglot", "Hard", [1, 2, 3, 8, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/778/C"),
      p(0, "cf-1042d", "Petya and Array", "Medium", [0, 3, 4, 5, 7, 12], false, "codeforces", "https://codeforces.com/problemset/problem/1042/D"),
      p(0, "cf-886c", "Petya and Catacombs", "Easy", [0, 10, 11, 12, 13, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/886/C"),
      p(0, "cf-111b", "Petya and Divisors", "Medium", [0, 6, 7, 11, 12, 21], false, "codeforces", "https://codeforces.com/problemset/problem/111/B"),
      p(0, "cf-1735c", "Phase Shift", "Easy", [0, 1, 8, 9, 10, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1735/C"),
      p(0, "cf-1515f", "Phoenix and Earthquake", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1515/F"),
      p(0, "cf-1348f", "Phoenix and Memory", "Hard", [0, 7, 8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1348/F"),
      p(0, "cf-1348d", "Phoenix and Science", "Medium", [0, 6, 11, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1348/D"),
      p(0, "cf-1463e", "Plan of Lectures", "Hard", [0, 8, 9, 10, 11, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1463/E"),
      p(0, "cf-1535d", "Playoff Tournament", "Medium", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1535/D"),
      p(0, "cf-1182b", "Plus from Picture", "Easy", [0, 1, 8, 10, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1182/B"),
      p(0, "cf-2258f", "Plus Minus Tree", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2258/F"),
      p(0, "cf-755c", "PolandBall and Forest", "Easy", [8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/755/C"),
      p(0, "cf-755b", "PolandBall and Game", "Easy", [0, 1, 6, 7, 11, 12, 15, 17, 19, 23], false, "codeforces", "https://codeforces.com/problemset/problem/755/B"),
      p(0, "cf-1560e", "Polycarp and String Transformation", "Medium", [0, 1, 6, 11, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1560/E"),
      p(0, "cf-1990f", "Polygonal Segments", "Hard", [0, 3, 4, 5, 7, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1990/F"),
      p(0, "cf-1580a", "Portal", "Medium", [0, 3, 7, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1580/A"),
      p(0, "cf-1120d", "Power Tree", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1120/D"),
      p(0, "cf-2137f", "Prefix Maximum Invariance", "Medium", [0, 6, 7, 11, 12, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2137/F"),
      p(0, "cf-1326d2", "Prefix-Suffix Palindrome (Hard version)", "Medium", [1, 2, 6, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1326/D2"),
      p(0, "cf-627d", "Preorder Test", "Hard", [6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/627/D"),
      p(0, "cf-377b", "Preparing for the Contest", "Medium", [0, 6, 7, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/377/B"),
      p(0, "cf-912e", "Prime Gift", "Hard", [3, 4, 6, 8, 10, 11, 13, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/912/E"),
      p(0, "cf-1991d", "Prime XOR Coloring", "Medium", [9, 12, 13, 15, 18, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1991/D"),
      p(0, "cf-986e", "Prince's Problem", "Hard", [0, 3, 7, 8, 10, 11, 12, 14, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/986/E"),
      p(0, "cf-1327b", "Princesses and Princes", "Easy", [3, 8, 9, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1327/B"),
      p(0, "cf-1141g", "Privatization of Roads in Treeland", "Medium", [6, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1141/G"),
      p(0, "cf-2043d", "Problem about GCD", "Medium", [3, 8, 14, 20, 21, 22], false, "codeforces", "https://codeforces.com/problemset/problem/2043/D"),
      p(0, "cf-1743d", "Problem with Random Tests", "Medium", [3, 8, 12, 14, 15, 16, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1743/D"),
      p(0, "cf-1847d", "Professor Higashikata", "Medium", [0, 1, 7, 12, 13, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1847/D"),
      p(0, "cf-1914f", "Programming Competition", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1914/F"),
      p(0, "cf-200d", "Programming Language", "Medium", [0, 1, 3, 6, 8, 11, 14], false, "codeforces", "https://codeforces.com/problemset/problem/200/D"),
      p(0, "cf-1660f1", "Promising String (easy version)", "Medium", [0, 1, 3, 8, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1660/F1"),
      p(0, "cf-948a", "Protect Sheep", "Easy", [0, 3, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/948/A"),
      p(0, "cf-343e", "Pumping Stations", "Hard", [3, 5, 8, 9, 10, 11, 12, 13, 14, 15, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/343/E"),
      p(0, "cf-1615e", "Purple Crayon", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1615/E"),
      p(0, "cf-1530c", "Pursuit", "Easy", [3, 6, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1530/C"),
      p(0, "cf-696b", "Puzzles", "Medium", [8, 10, 11, 13, 14, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/696/B"),
      p(0, "cf-1706e", "Qpwoeirut and Vertices", "Hard", [0, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1706/E"),
      p(0, "cf-2101b", "Quartet Swapping", "Medium", [0, 3, 5, 7, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2101/B"),
      p(0, "cf-1143c", "Queen", "Easy", [8, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1143/C"),
      p(0, "cf-600b", "Queries about less or equal elements", "Easy", [0, 3, 4, 6, 7, 11, 12, 19], false, "codeforces", "https://codeforces.com/problemset/problem/600/B"),
      p(0, "cf-245h", "Queries for Number of Palindromes", "Medium", [1, 2, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/245/H"),
      p(0, "cf-1861c", "Queries for the Array", "Medium", [0, 1, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1861/C"),
      p(0, "cf-1777c", "Quiz Master", "Medium", [3, 4, 6, 11, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1777/C"),
      p(0, "cf-2171d", "Rae Taylor and Trees (easy version)", "Easy", [0, 6, 7, 10, 11, 12, 13, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2171/D"),
      p(0, "cf-2171f", "Rae Taylor and Trees (hard version)", "Medium", [0, 6, 7, 10, 11, 12, 13, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2171/F"),
      p(0, "cf-1580e", "Railway Construction", "Hard", [0, 3, 7, 8, 9, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1580/E"),
      p(0, "cf-1419f", "Rain of Fire", "Hard", [0, 6, 7, 8, 9, 10, 11, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1419/F"),
      p(0, "cf-846f", "Random Query", "Medium", [0, 3, 4, 7, 12, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/846/F"),
      p(0, "cf-1758d", "Range = √Sum", "Medium", [3, 4, 6, 8, 11, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1758/D"),
      p(0, "cf-1630b", "Range and Partition", "Medium", [0, 3, 4, 6, 7, 11, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1630/B"),
      p(0, "cf-1988e", "Range Minimum Sum", "Hard", [0, 3, 5, 6, 7, 8, 11, 12, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1988/E"),
      p(0, "cf-1841c", "Ranom Numbers", "Medium", [1, 3, 8, 12, 14, 15, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1841/C"),
      p(0, "cf-786d", "Rap God", "Hard", [0, 1, 2, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/786/D"),
      p(0, "cf-1450d", "Rating Compression", "Medium", [0, 3, 4, 6, 7, 11, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1450/D"),
      p(0, "cf-1845d", "Rating System", "Medium", [0, 3, 4, 6, 7, 8, 11, 12, 13, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1845/D"),
      p(0, "cf-724c", "Ray Tracing", "Medium", [0, 2, 12, 15, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/724/C"),
      p(0, "cf-1598f", "RBS", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1598/F"),
      p(0, "cf-1359f", "RC Kaboom Show", "Hard", [0, 3, 6, 7, 8, 11, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1359/F"),
      p(0, "cf-2112d", "Reachability and Tree", "Medium", [8, 9, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2112/D"),
      p(0, "cf-2042d", "Recommendations", "Medium", [0, 3, 4, 7, 12, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2042/D"),
      p(0, "cf-1176d", "Recover it!", "Medium", [8, 9, 10, 12, 13, 14, 15, 19, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1176/D"),
      p(0, "cf-1781e", "Rectangle Shrinking", "Hard", [0, 3, 4, 6, 7, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1781/E"),
      p(0, "cf-932b", "Recursive Queries", "Easy", [0, 6, 7, 8, 10, 11, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/932/B"),
      p(0, "cf-2118d1", "Red Light, Green Light (Easy version)", "Medium", [0, 3, 8, 9, 10, 13, 14, 16, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2118/D1"),
      p(0, "cf-2118d2", "Red Light, Green Light (Hard version)", "Hard", [0, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2118/D2"),
      p(0, "cf-2053d", "Refined Product Optimality", "Medium", [0, 6, 7, 11, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2053/D"),
      p(0, "cf-4c", "Registration System", "Easy", [0, 2, 7, 12], false, "codeforces", "https://codeforces.com/problemset/problem/4/C"),
      p(0, "cf-1615h", "Reindeer Games", "Hard", [0, 5, 6, 7, 9, 11, 12, 13, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1615/H"),
      p(0, "cf-2176e", "Remove at the lowest cost", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2176/E"),
      p(0, "cf-1976f", "Remove Bridges", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1976/F"),
      p(0, "cf-2063c", "Remove Exactly Two", "Medium", [0, 3, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2063/C"),
      p(0, "cf-900c", "Remove Extra One", "Medium", [0, 3, 7, 8, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/900/C"),
      p(0, "cf-2193h", "Remove the Grail Tree", "Hard", [0, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2193/H"),
      p(0, "cf-1800d", "Remove Two Letters", "Easy", [0, 1, 2, 7, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1800/D"),
      p(0, "cf-1007a", "Reorder the Array", "Easy", [0, 3, 4, 7, 12, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1007/A"),
      p(0, "cf-2047b", "Replace Character", "Easy", [1, 3, 8, 12, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2047/B"),
      p(0, "cf-522a", "Reposts", "Easy", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/522/A"),
      p(0, "cf-1681d", "Required Length", "Medium", [2, 3, 8, 9, 10, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1681/D"),
      p(0, "cf-1650e", "Rescheduling the Exam", "Medium", [0, 6, 7, 11, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1650/E"),
      p(0, "cf-1739d", "Reset K Edges", "Medium", [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1739/D"),
      p(0, "cf-2053e", "Resourceful Caterpillar Sequence", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2053/E"),
      p(0, "cf-404c", "Restore Graph", "Medium", [8, 9, 10, 13, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/404/C"),
      p(0, "cf-1759g", "Restore the Permutation", "Medium", [0, 6, 7, 11, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1759/G"),
      p(0, "cf-1659d", "Reverse Sort Sum", "Medium", [0, 3, 4, 7, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1659/D"),
      p(0, "cf-2252c", "Risky Tower", "Easy", [0, 3, 6, 7, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2252/C"),
      p(0, "cf-1700d", "River Locks", "Medium", [6, 11, 12, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1700/D"),
      p(0, "cf-638c", "Road Improvement", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/638/C"),
      p(0, "cf-2229g", "Roadworks", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2229/G"),
      p(0, "cf-2014d", "Robert Hood and Mrs Hood", "Easy", [0, 3, 7, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2014/D"),
      p(0, "cf-2014h", "Robin Hood Archery", "Medium", [0, 2, 5, 7, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2014/H"),
      p(0, "cf-1426e", "Rock, Paper, Scissors", "Medium", [3, 8, 12, 14, 15, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1426/E"),
      p(0, "cf-1858e1", "Rollbacks (Easy Version)", "Hard", [0, 3, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1858/E1"),
      p(0, "cf-2127d", "Root was Built by Love, Broken by Destiny", "Medium", [8, 9, 10, 11, 13, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2127/D"),
      p(0, "cf-848b", "Rooter's Song", "Medium", [0, 3, 4, 7, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/848/B"),
      p(0, "cf-1709d", "Rorororobot", "Medium", [0, 6, 7, 11, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1709/D"),
      p(0, "cf-1594e2", "Rubik's Cube Coloring (hard version)", "Hard", [0, 3, 8, 10, 11, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1594/E2"),
      p(0, "cf-1846g", "Rudolf and CodeVid-23", "Medium", [9, 12, 13, 15, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1846/G"),
      p(0, "cf-1941f", "Rudolf and Imbalance", "Medium", [3, 4, 6, 11, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1941/F"),
      p(0, "cf-1846e2", "Rudolf and Snowflakes (hard version)", "Medium", [0, 3, 6, 8, 11, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1846/E2"),
      p(0, "cf-1941d", "Rudolf and the Ball Game", "Easy", [0, 8, 10, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1941/D"),
      p(0, "cf-893c", "Rumor", "Easy", [8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/893/C"),
      p(0, "cf-1419d2", "Sage's Birthday (hard version)", "Medium", [3, 4, 6, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1419/D2"),
      p(0, "cf-2033e", "Sakurako, Kosuke, and the Permutation", "Easy", [0, 3, 7, 8, 9, 10, 12, 13, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2033/E"),
      p(0, "cf-2008g", "Sakurako's Task", "Medium", [6, 11, 12, 15, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2008/G"),
      p(0, "cf-1520d", "Same Differences", "Easy", [0, 2, 7, 12, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1520/D"),
      p(0, "cf-1687c", "Sanae and Giant Robot", "Hard", [0, 3, 6, 7, 8, 11, 12, 13, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1687/C"),
      p(0, "cf-1109b", "Sasha and One More Name", "Medium", [1, 2, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1109/B"),
      p(0, "cf-1929c", "Sasha and the Casino", "Easy", [3, 6, 8, 11, 12, 14, 15, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1929/C"),
      p(0, "cf-1929e", "Sasha and the Happy Tree Cutting", "Hard", [3, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1929/E"),
      p(0, "cf-1929f", "Sasha and the Wedding Binary Search Tree", "Hard", [0, 3, 7, 8, 10, 11, 12, 13, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1929/F"),
      p(0, "cf-1701c", "Schedule Management", "Easy", [0, 3, 4, 6, 11, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1701/C"),
      p(0, "cf-1777d", "Score of a Tree", "Medium", [8, 10, 11, 13, 14, 16, 17, 18, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1777/D"),
      p(0, "cf-1794c", "Scoring Subsequences", "Easy", [3, 4, 6, 11, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1794/C"),
      p(0, "cf-2232c1", "Seating Arrangement (Easy Version)", "Easy", [3, 4, 6, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2232/C1"),
      p(0, "cf-1774g", "Segment Covering", "Hard", [0, 3, 7, 8, 10, 11, 12, 14, 15, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1774/G"),
      p(0, "cf-1872f", "Selling a Menagerie", "Medium", [0, 8, 9, 10, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1872/F"),
      p(0, "cf-1254b1", "Send Boxes to Alice (Easy Version)", "Medium", [3, 4, 6, 12, 15, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1254/B1"),
      p(0, "cf-802j1", "Send the Fool Further! (easy)", "Easy", [8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/802/J1"),
      p(0, "cf-1789f", "Serval and Brain Power", "Hard", [0, 1, 3, 8, 12, 14, 15, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1789/F"),
      p(0, "cf-1153d", "Serval and Rooted Tree", "Medium", [6, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1153/D"),
      p(0, "cf-1027f", "Session in BSU", "Hard", [6, 8, 9, 10, 11, 13, 14, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1027/F"),
      p(0, "cf-1975f", "Set", "Hard", [3, 5, 8, 10, 13, 14, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1975/F"),
      p(0, "cf-1761c", "Set Construction", "Easy", [8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1761/C"),
      p(0, "cf-1904d2", "Set To Max (Hard Version)", "Medium", [0, 5, 7, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1904/D2"),
      p(0, "cf-982d", "Shark", "Medium", [0, 3, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/982/D"),
      p(0, "cf-1732c1", "Sheikh (Easy version)", "Medium", [3, 4, 6, 11, 12, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1732/C1"),
      p(0, "cf-776f", "Sherlock's bet to Moriarty", "Hard", [0, 5, 7, 9, 10, 11, 12, 13, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/776/F"),
      p(0, "cf-1245d", "Shichikuji and Power Grid", "Medium", [9, 10, 11, 12, 13, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1245/D"),
      p(0, "cf-1690f", "Shifting String", "Medium", [1, 9, 13, 17, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1690/F"),
      p(0, "cf-2118f", "Shifts and Swaps", "Hard", [0, 2, 7, 9, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2118/F"),
      p(0, "cf-2039c2", "Shohag Loves XOR (Hard Version)", "Medium", [3, 8, 14, 18, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2039/C2"),
      p(0, "cf-1969d", "Shop Game", "Medium", [0, 7, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1969/D"),
      p(0, "cf-2182g", "Short Garland", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2182/G"),
      p(0, "cf-1512g", "Short Task", "Medium", [3, 8, 14, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1512/G"),
      p(0, "cf-2093g", "Shorten the Array", "Medium", [0, 1, 3, 4, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/2093/G"),
      p(0, "cf-1205b", "Shortest Cycle", "Medium", [3, 8, 9, 13, 14, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1205/B"),
      p(0, "cf-1923f", "Shrink-Reverse", "Hard", [0, 1, 2, 3, 6, 8, 11, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1923/F"),
      p(0, "cf-1950g", "Shuffling Songs", "Medium", [0, 1, 2, 8, 9, 10, 13, 14, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1950/G"),
      p(0, "cf-2260d", "Signs of Prefix Sums", "Medium", [0, 3, 8, 10, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2260/D"),
      p(0, "cf-2205d", "Simons and Beating Peaks", "Medium", [0, 5, 7, 10, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2205/D"),
      p(0, "cf-344b", "Simple Molecules", "Easy", [3, 8, 9, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/344/B"),
      p(0, "cf-965d", "Single-use Stones", "Medium", [3, 4, 6, 11, 12, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/965/D"),
      p(0, "cf-2065a", "Skibidus and Amog'u", "Easy", [0, 1, 3, 8, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2065/A"),
      p(0, "cf-2065f", "Skibidus and Slay", "Medium", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2065/F"),
      p(0, "cf-613b", "Skills", "Medium", [3, 4, 6, 8, 11, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/613/B"),
      p(0, "cf-1760g", "SlavicG's Favorite Problem", "Medium", [8, 9, 10, 13, 14, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1760/G"),
      p(0, "cf-2134d", "Sliding Tree", "Hard", [0, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2134/D"),
      p(0, "cf-1734d", "Slime Escape", "Medium", [0, 3, 4, 7, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1734/D"),
      p(0, "cf-1923d", "Slimes", "Medium", [0, 3, 4, 6, 7, 11, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1923/D"),
      p(0, "cf-891d", "Sloth", "Hard", [8, 10, 11, 13, 14, 16, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/891/D"),
      p(0, "cf-1989d", "Smithing Skill", "Medium", [0, 3, 4, 7, 8, 12, 14, 15, 16, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1989/D"),
      p(0, "cf-1920f1", "Smooth Sailing (Easy Version)", "Hard", [0, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1920/F1"),
      p(0, "cf-1920f2", "Smooth Sailing (Hard Version)", "Hard", [0, 6, 7, 9, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1920/F2"),
      p(0, "cf-1654g", "Snowy Mountain", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1654/G"),
      p(0, "cf-546b", "Soldier and Badges", "Easy", [0, 3, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/546/B"),
      p(0, "cf-1004e", "Sonya and Ice Cream", "Hard", [0, 6, 7, 9, 10, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1004/E"),
      p(0, "cf-843a", "Sorting by Subsequences", "Easy", [0, 8, 10, 13, 14, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/843/A"),
      p(0, "cf-1633e", "Spanning Tree Queries", "Hard", [0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1633/E"),
      p(0, "cf-1133f2", "Spanning Tree with One Fixed Degree", "Medium", [8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1133/F2"),
      p(0, "cf-2252f", "Spectral Components", "Hard", [8, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2252/F"),
      p(0, "cf-2018b", "Speedbreaker", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2018/B"),
      p(0, "cf-1863e", "Speedrun", "Hard", [3, 4, 8, 9, 10, 12, 13, 14, 15, 16, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1863/E"),
      p(0, "cf-1887d", "Split", "Hard", [0, 3, 4, 5, 6, 7, 10, 11, 12, 13, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1887/D"),
      p(0, "cf-1059e", "Split the Tree", "Hard", [0, 6, 7, 10, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1059/E"),
      p(0, "cf-1976e", "Splittable Permutations", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1976/E"),
      p(0, "cf-2108e", "Spruce Dispute", "Hard", [0, 8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2108/E"),
      p(0, "cf-633c", "Spy Syndrome 2", "Medium", [0, 1, 2, 7, 12, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/633/C"),
      p(0, "cf-1360f", "Spy-string", "Medium", [1, 2, 3, 8, 14, 15, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1360/F"),
      p(0, "cf-2257c", "Spying on the Beaver", "Easy", [8, 9, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2257/C"),
      p(0, "cf-57a", "Square Earth?", "Easy", [0, 8, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/57/A"),
      p(0, "cf-1497e1", "Square-Free Division (easy version)", "Medium", [0, 3, 4, 7, 12, 15, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1497/E1"),
      p(0, "cf-1495f", "Squares", "Hard", [0, 7, 9, 10, 11, 12, 13, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1495/F"),
      p(0, "cf-1995c", "Squaring", "Medium", [0, 3, 8, 12, 14, 15, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1995/C"),
      p(0, "cf-1610h", "Squid Game", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1610/H"),
      p(0, "cf-1419b", "Stairs", "Easy", [0, 3, 8, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1419/B"),
      p(0, "cf-1870h", "Standard Graph Problem", "Hard", [0, 7, 9, 10, 11, 12, 13, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1870/H"),
      p(0, "cf-1402c", "Star Trek", "Hard", [8, 9, 10, 11, 13, 14, 16, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1402/C"),
      p(0, "cf-633e", "Startup Funding", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 23], false, "codeforces", "https://codeforces.com/problemset/problem/633/E"),
      p(0, "cf-2222g", "Statistics on Tree", "Hard", [3, 5, 6, 8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2222/G"),
      p(0, "cf-2129b", "Stay or Mirror", "Medium", [0, 3, 7, 8, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2129/B"),
      p(0, "cf-2244c", "Stepan and Permutation", "Easy", [8, 10, 12, 13, 14, 15, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/2244/C"),
      p(0, "cf-1396b", "Stoned Game", "Medium", [3, 8, 12, 14, 15, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1396/B"),
      p(0, "cf-2059e2", "Stop Gaming (Hard Version)", "Hard", [0, 1, 2, 3, 7, 8, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2059/E2"),
      p(0, "cf-1470a", "Strange Birthday Party", "Easy", [3, 4, 6, 11, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1470/A"),
      p(0, "cf-1470b", "Strange Definition", "Medium", [2, 9, 13, 18, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1470/B"),
      p(0, "cf-2156b", "Strange Machine", "Easy", [0, 3, 6, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2156/B"),
      p(0, "cf-1470e", "Strange Permutation", "Hard", [0, 3, 4, 6, 7, 9, 11, 12, 13, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1470/E"),
      p(0, "cf-1296e1", "String Coloring (easy version)", "Medium", [9, 12, 13, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1296/E1"),
      p(0, "cf-2225f", "String Cutting", "Hard", [1, 2, 3, 6, 8, 11, 12, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2225/F"),
      p(0, "cf-1430d", "String Deletion", "Medium", [0, 3, 4, 6, 7, 11, 12, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1430/D"),
      p(0, "cf-1535f", "String Distance", "Hard", [0, 1, 2, 3, 6, 7, 8, 11, 12, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1535/F"),
      p(0, "cf-1451c", "String Equality", "Easy", [0, 1, 2, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1451/C"),
      p(0, "cf-159c", "String Manipulation 1.0", "Easy", [0, 1, 3, 6, 7, 8, 11, 12, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/159/C"),
      p(0, "cf-1316b", "String Modification", "Easy", [0, 1, 3, 8, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1316/B"),
      p(0, "cf-827a", "String Reconstruction", "Medium", [0, 1, 7, 12, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/827/A"),
      p(0, "cf-1430e", "String Reversal", "Medium", [0, 1, 7, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1430/E"),
      p(0, "cf-710f", "String Set Queries", "Hard", [0, 1, 2, 3, 7, 8, 12, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/710/F"),
      p(0, "cf-1383a", "String Transformation 1", "Medium", [1, 3, 4, 9, 10, 11, 12, 13, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1383/A"),
      p(0, "cf-1550e", "Stringforces", "Hard", [1, 3, 4, 6, 8, 11, 14, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1550/E"),
      p(0, "cf-1845c", "Strong Password", "Easy", [1, 6, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1845/C"),
      p(0, "cf-475b", "Strongly Connected City", "Easy", [0, 3, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/475/B"),
      p(0, "cf-129b", "Students and Shoelaces", "Easy", [0, 3, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/129/B"),
      p(0, "cf-2190b1", "Sub-RBS (Easy Version)", "Easy", [1, 3, 4, 12, 15, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2190/B1"),
      p(0, "cf-2190b2", "Sub-RBS (Hard Version)", "Medium", [0, 1, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2190/B2"),
      p(0, "cf-2148a", "Sublime Sequence", "Easy", [2, 3, 8, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2148/A"),
      p(0, "cf-2128e1", "Submedians (Easy Version)", "Medium", [0, 6, 7, 11, 12, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2128/E1"),
      p(0, "cf-2128e2", "Submedians (Hard Version)", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2128/E2"),
      p(0, "cf-729e", "Subordinates", "Medium", [0, 7, 9, 12, 13, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/729/E"),
      p(0, "cf-1580d", "Subsequence", "Hard", [3, 5, 8, 10, 11, 12, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1580/D"),
      p(0, "cf-1807g1", "Subsequence Addition (Easy Version)", "Easy", [0, 3, 7, 8, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1807/G1"),
      p(0, "cf-914f", "Substrings in a String", "Hard", [0, 1, 3, 7, 8, 12, 14, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/914/F"),
      p(0, "cf-1651e", "Sum of Matchings", "Hard", [3, 8, 10, 12, 13, 14, 15, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1651/E"),
      p(0, "cf-1921f", "Sum of Progression", "Medium", [0, 3, 7, 8, 12, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1921/F"),
      p(0, "cf-1691c", "Sum of Substrings", "Easy", [1, 3, 8, 12, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1691/C"),
      p(0, "cf-1930d1", "Sum over all Substrings (Easy Version)", "Medium", [1, 3, 8, 12, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1930/D1"),
      p(0, "cf-538h", "Summer Dichotomy", "Hard", [0, 7, 8, 10, 12, 13, 14, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/538/H"),
      p(0, "cf-2026d", "Sums of Segments", "Medium", [0, 6, 7, 11, 12, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2026/D"),
      p(0, "cf-2043c", "Sums on Segments", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2043/C"),
      p(0, "cf-1834d", "Survey in Class", "Medium", [0, 3, 7, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1834/D"),
      p(0, "cf-1891d", "Suspicious logarithms", "Medium", [3, 6, 8, 11, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1891/D"),
      p(0, "cf-920c", "Swap Adjacent Elements", "Easy", [3, 4, 8, 10, 12, 13, 14, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/920/C"),
      p(0, "cf-1716e", "Swap and Maximum Block", "Hard", [0, 5, 7, 8, 10, 12, 13, 14, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1716/E"),
      p(0, "cf-1983d", "Swap Dilemma", "Medium", [0, 5, 7, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1983/D"),
      p(0, "cf-727d", "T-shirts Distribution", "Medium", [12, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/727/D"),
      p(0, "cf-2173d", "Taiga's Carry Chains", "Medium", [3, 8, 12, 14, 15, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2173/D"),
      p(0, "cf-535d", "Tavas and Malekas", "Medium", [1, 2, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/535/D"),
      p(0, "cf-1369d", "TediousLee", "Medium", [9, 10, 11, 12, 13, 15, 16, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1369/D"),
      p(0, "cf-1859f", "Teleportation in Byteland", "Hard", [0, 5, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1859/F"),
      p(0, "cf-1842f", "Tenzing and Tree", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1842/F"),
      p(0, "cf-253c", "Text Editor", "Medium", [0, 7, 8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/253/C"),
      p(0, "cf-1358d", "The Best Vacation", "Medium", [0, 3, 4, 6, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1358/D"),
      p(0, "cf-1847f", "The Boss's Identity", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 15, 18, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1847/F"),
      p(0, "cf-1819b", "The Butcher", "Medium", [0, 3, 4, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1819/B"),
      p(0, "cf-1282e", "The Cake Is a Lie", "Hard", [0, 7, 8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1282/E"),
      p(0, "cf-2027d1", "The Endspeaker (Easy Version)", "Medium", [0, 3, 4, 6, 9, 11, 12, 13, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2027/D1"),
      p(0, "cf-1083a", "The Fair Nut and the Best Path", "Medium", [0, 7, 10, 11, 12, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1083/A"),
      p(0, "cf-2062e2", "The Game (Hard Version)", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2062/E2"),
      p(0, "cf-1829e", "The Lakes", "Easy", [0, 8, 9, 10, 13, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1829/E"),
      p(0, "cf-1381d", "The Majestic Brown Tree Snake", "Hard", [3, 4, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1381/D"),
      p(0, "cf-1955h", "The Most Reckless Defense", "Hard", [3, 8, 9, 14, 15, 16, 18, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1955/H"),
      p(0, "cf-1594d", "The Number of Imposters", "Medium", [8, 9, 10, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1594/D"),
      p(0, "cf-1175f", "The Number of Subpermutations", "Hard", [0, 2, 3, 5, 7, 8, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1175/F"),
      p(0, "cf-1403a", "The Potion of Great Power", "Hard", [0, 3, 4, 6, 7, 9, 11, 12, 13, 19, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1403/A"),
      p(0, "cf-228e", "The Road to Berland is Paved With Good Intentions", "Medium", [8, 9, 10, 13, 14, 22], false, "codeforces", "https://codeforces.com/problemset/problem/228/E"),
      p(0, "cf-1574d", "The Strongest Build", "Hard", [0, 2, 3, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1574/D"),
      p(0, "cf-1850h", "The Third Letter", "Medium", [0, 8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1850/H"),
      p(0, "cf-2055c", "The Trail", "Easy", [3, 4, 8, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2055/C"),
      p(0, "cf-910a", "The Way to Home", "Easy", [0, 8, 10, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/910/A"),
      p(0, "cf-1017d", "The Wu", "Medium", [0, 3, 7, 8, 12, 14, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1017/D"),
      p(0, "cf-1805e", "There Should Be a Lot of Maximums", "Hard", [0, 3, 4, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1805/E"),
      p(0, "cf-1914d", "Three Activities", "Easy", [0, 3, 8, 12, 14, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1914/D"),
      p(0, "cf-1335e1", "Three Blocks Palindrome (easy version)", "Medium", [0, 3, 4, 6, 7, 8, 11, 12, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1335/E1"),
      p(0, "cf-1335e2", "Three Blocks Palindrome (hard version)", "Medium", [0, 3, 4, 7, 8, 12, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1335/E2"),
      p(0, "cf-1780f", "Three Chairs", "Hard", [0, 3, 7, 8, 12, 14, 16, 18, 19, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1780/F"),
      p(0, "cf-581d", "Three Logos", "Medium", [0, 3, 8, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/581/D"),
      p(0, "cf-1006c", "Three Parts of the Array", "Easy", [0, 3, 4, 6, 7, 11, 12], false, "codeforces", "https://codeforces.com/problemset/problem/1006/C"),
      p(0, "cf-3c", "Tic-tac-toe", "Medium", [0, 3, 8, 14, 23], false, "codeforces", "https://codeforces.com/problemset/problem/3/C"),
      p(0, "cf-763d", "Timofey and a flat tree", "Hard", [0, 2, 7, 9, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/763/D"),
      p(0, "cf-763a", "Timofey and a tree", "Medium", [0, 8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/763/A"),
      p(0, "cf-1790f", "Timofey and Black-White Tree", "Hard", [3, 5, 8, 9, 10, 11, 12, 13, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1790/F"),
      p(0, "cf-1856c", "To Become Max", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1856/C"),
      p(0, "cf-1677c", "Tokitsukaze and Two Colorful Tapes", "Medium", [8, 9, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1677/C"),
      p(0, "cf-913d", "Too Easy Problems", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/913/D"),
      p(0, "cf-1895c", "Torn Lucky Ticket", "Easy", [0, 2, 3, 8, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1895/C"),
      p(0, "cf-1679d", "Toss a Coin to Your Graph...", "Medium", [6, 8, 9, 10, 11, 13, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1679/D"),
      p(0, "cf-538c", "Tourist's Notes", "Medium", [0, 3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/538/C"),
      p(0, "cf-487e", "Tourists", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/487/E"),
      p(0, "cf-27b", "Tournament", "Easy", [3, 8, 10, 12, 13, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/27/B"),
      p(0, "cf-479b", "Towers", "Easy", [0, 3, 8, 12, 14, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/479/B"),
      p(0, "cf-1843e", "Tracking Segments", "Medium", [0, 3, 4, 6, 7, 8, 11, 12, 14], false, "codeforces", "https://codeforces.com/problemset/problem/1843/E"),
      p(0, "cf-2122d", "Traffic Lights", "Hard", [0, 3, 5, 7, 8, 9, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/2122/D"),
      p(0, "cf-2071c", "Trapmigiano Reggiano", "Medium", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2071/C"),
      p(0, "cf-2034c", "Trapped in the Witch's Labyrinth", "Easy", [0, 8, 9, 10, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2034/C"),
      p(0, "cf-1214d", "Treasure Island", "Medium", [2, 8, 10, 13, 14, 16, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1214/D"),
      p(0, "cf-1111e", "Tree", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1111/E"),
      p(0, "cf-375d", "Tree and Queries", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/375/D"),
      p(0, "cf-1540b", "Tree Array", "Hard", [3, 8, 9, 10, 11, 13, 14, 16, 17, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1540/B"),
      p(0, "cf-1508e", "Tree Calendar", "Hard", [0, 3, 7, 8, 10, 11, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1508/E"),
      p(0, "cf-675d", "Tree Construction", "Medium", [0, 7, 10, 11, 12, 17], false, "codeforces", "https://codeforces.com/problemset/problem/675/D"),
      p(0, "cf-1118f1", "Tree Cutting (Easy Version)", "Medium", [8, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1118/F1"),
      p(0, "cf-2050g", "Tree Destruction", "Medium", [8, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2050/G"),
      p(0, "cf-1375g", "Tree Modification", "Hard", [3, 8, 9, 10, 11, 13, 14, 15, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1375/G"),
      p(0, "cf-2035f", "Tree Operations", "Hard", [3, 6, 8, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2035/F"),
      p(0, "cf-117e", "Tree or not Tree", "Hard", [0, 5, 7, 9, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/117/E"),
      p(0, "cf-2208d1", "Tree Orientation (Easy Version)", "Medium", [8, 9, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2208/D1"),
      p(0, "cf-2018c", "Tree Pruning", "Medium", [3, 8, 10, 11, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2018/C"),
      p(0, "cf-1328e", "Tree Queries", "Medium", [8, 9, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1328/E"),
      p(0, "cf-1695d2", "Tree Queries (Hard Version)", "Hard", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1695/D2"),
      p(0, "cf-1696f", "Tree Recovery", "Hard", [3, 8, 9, 10, 11, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1696/F"),
      p(0, "cf-1404b", "Tree Tag", "Medium", [8, 10, 11, 13, 14, 16, 17, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1404/B"),
      p(0, "cf-1844g", "Tree Weights", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1844/G"),
      p(0, "cf-1092f", "Tree with Maximum Cost", "Medium", [8, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1092/F"),
      p(0, "cf-1882d", "Tree XOR", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1882/D"),
      p(0, "cf-1320e", "Treeland and Viruses", "Hard", [0, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1320/E"),
      p(0, "cf-1902f", "Trees and XOR Queries Again", "Hard", [0, 5, 7, 8, 9, 10, 11, 12, 13, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1902/F"),
      p(0, "cf-1528c", "Trees of Tranquillity", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1528/C"),
      p(0, "cf-1712f", "Triameter", "Hard", [0, 6, 7, 8, 10, 11, 12, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1712/F"),
      p(0, "cf-2063e", "Triangle Tree", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2063/E"),
      p(0, "cf-30e", "Tricky and Clever Password", "Hard", [0, 1, 2, 6, 7, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/30/E"),
      p(0, "cf-1981c", "Turtle and an Incomplete Sequence", "Medium", [0, 3, 8, 12, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1981/C"),
      p(0, "cf-2003e2", "Turtle and Inversions (Hard Version)", "Hard", [0, 3, 4, 5, 7, 8, 12, 14, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2003/E2"),
      p(0, "cf-2003f", "Turtle and Three Sequences", "Hard", [0, 3, 4, 7, 8, 12, 14, 15, 16, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/2003/F"),
      p(0, "cf-1641d", "Two Arrays", "Hard", [2, 3, 4, 8, 12, 14, 15, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1641/D"),
      p(0, "cf-520b", "Two Buttons", "Easy", [0, 8, 9, 10, 12, 13, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/520/B"),
      p(0, "cf-1827d", "Two Centroids", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1827/D"),
      p(0, "cf-1895g", "Two Characters, Two Colors", "Hard", [0, 6, 7, 11, 12, 15, 16, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1895/G"),
      p(0, "cf-1774e", "Two Chess Pieces", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1774/E"),
      p(0, "cf-1276b", "Two Fairs", "Medium", [8, 9, 10, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1276/B"),
      p(0, "cf-14d", "Two Paths", "Medium", [3, 4, 8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/14/D"),
      p(0, "cf-1409e", "Two Platforms", "Medium", [3, 4, 6, 11, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1409/E"),
      p(0, "cf-1488c", "Two Policemen", "Medium", [3, 6, 8, 11, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1488/C"),
      p(0, "cf-2025a", "Two Screens", "Easy", [1, 3, 4, 6, 11, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2025/A"),
      p(0, "cf-223b", "Two Strings", "Medium", [0, 1, 7, 12, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/223/B"),
      p(0, "cf-550a", "Two Substrings", "Medium", [0, 1, 3, 8, 12, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/550/A"),
      p(0, "cf-1156b", "Ugly Pairs", "Medium", [0, 1, 8, 10, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1156/B"),
      p(0, "cf-489d", "Unbearable Controversy of Being", "Medium", [3, 8, 9, 10, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/489/D"),
      p(0, "cf-1388c", "Uncle Bogdan and Country Happiness", "Medium", [8, 10, 11, 12, 13, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1388/C"),
      p(0, "cf-1955f", "Unfair Game", "Medium", [12, 15, 16, 20, 23], false, "codeforces", "https://codeforces.com/problemset/problem/1955/F"),
      p(0, "cf-1800e1", "Unforgivable Curse (easy version)", "Easy", [1, 3, 8, 9, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1800/E1"),
      p(0, "cf-1800e2", "Unforgivable Curse (hard version)", "Medium", [1, 3, 8, 9, 10, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1800/E2"),
      p(0, "cf-2056d", "Unique Median", "Hard", [0, 3, 5, 6, 7, 8, 11, 12, 14, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2056/D"),
      p(0, "cf-1681f", "Unique Occurrences", "Hard", [0, 5, 7, 8, 10, 11, 12, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1681/F"),
      p(0, "cf-2219b1", "Unique Values (Easy version)", "Medium", [5, 6, 11, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2219/B1"),
      p(0, "cf-2131f", "Unjust Binary Life", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2131/F"),
      p(0, "cf-1808c", "Unlucky Numbers", "Medium", [0, 3, 8, 12, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1808/C"),
      p(0, "cf-1682e", "Unordered Swaps", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 17, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1682/E"),
      p(0, "cf-2104e", "Unpleasant Strings", "Medium", [1, 6, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2104/E"),
      p(0, "cf-2242c", "Unstable Elements", "Easy", [0, 3, 4, 7, 8, 12, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2242/C"),
      p(0, "cf-1535c", "Unstable String", "Easy", [0, 1, 3, 4, 6, 11, 12, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1535/C"),
      p(0, "cf-1899g", "Unusual Entertainment", "Medium", [0, 3, 4, 7, 8, 9, 10, 11, 12, 13, 14, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1899/G"),
      p(0, "cf-1475f", "Unusual Matrix", "Medium", [3, 8, 14, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1475/F"),
      p(0, "cf-1558b", "Up the Strip", "Medium", [3, 4, 8, 14, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1558/B"),
      p(0, "cf-1561d1", "Up the Strip (simplified version)", "Medium", [0, 3, 7, 8, 12, 14, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1561/D1"),
      p(0, "cf-843c", "Upgrading Tree", "Hard", [8, 9, 10, 11, 13, 14, 15, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/843/C"),
      p(0, "cf-1731d", "Valiant's New Map", "Medium", [0, 3, 4, 6, 7, 8, 11, 12, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1731/D"),
      p(0, "cf-1992f", "Valuable Cards", "Medium", [3, 4, 8, 12, 14, 15, 16, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1992/F"),
      p(0, "cf-1423b", "Valuable Paper", "Medium", [6, 9, 11, 13, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1423/B"),
      p(0, "cf-1847c", "Vampiric Powers, anyone?", "Easy", [3, 8, 12, 14, 15, 16, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1847/C"),
      p(0, "cf-552c", "Vanya and Scales", "Medium", [3, 8, 12, 14, 15, 16, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/552/C"),
      p(0, "cf-552d", "Vanya and Triangles", "Medium", [0, 3, 7, 8, 12, 14, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/552/D"),
      p(0, "cf-706d", "Vasiliy's Multiset", "Medium", [0, 6, 7, 10, 11, 12, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/706/D"),
      p(0, "cf-336c", "Vasily the Bear and Sequence", "Medium", [0, 3, 8, 12, 14, 15, 21], false, "codeforces", "https://codeforces.com/problemset/problem/336/C"),
      p(0, "cf-1076e", "Vasya and a Tree", "Medium", [0, 7, 10, 11, 12, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1076/E"),
      p(0, "cf-493c", "Vasya and Basketball", "Medium", [0, 3, 4, 6, 7, 8, 11, 12, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/493/C"),
      p(0, "cf-1051e", "Vasya and Big Integers", "Hard", [0, 1, 2, 6, 7, 11, 12, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1051/E"),
      p(0, "cf-1016d", "Vasya And The Matrix", "Medium", [15, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1016/D"),
      p(0, "cf-1793e", "Velepin and Marketing", "Hard", [0, 3, 4, 6, 7, 11, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1793/E"),
      p(0, "cf-2042e", "Vertex Pairs", "Hard", [0, 3, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2042/E"),
      p(0, "cf-1675d", "Vertical Paths", "Easy", [0, 9, 10, 11, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1675/D"),
      p(0, "cf-1670d", "Very Suspicious", "Medium", [0, 3, 6, 8, 11, 12, 14, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1670/D"),
      p(0, "cf-371d", "Vessels", "Medium", [0, 7, 10, 11, 12, 13, 17], false, "codeforces", "https://codeforces.com/problemset/problem/371/D"),
      p(0, "cf-2234c", "Vessels, Heights and Two Versions (Easy Version)", "Easy", [0, 3, 4, 8, 10, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2234/C"),
      p(0, "cf-731f", "Video Cards", "Medium", [0, 3, 7, 8, 12, 14, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/731/F"),
      p(0, "cf-1848b", "Vika and the Bridge", "Easy", [0, 6, 7, 11, 12, 15, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1848/B"),
      p(0, "cf-2238c", "Village Guilds", "Easy", [8, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2238/C"),
      p(0, "cf-525a", "Vitaliy and Pie", "Easy", [1, 2, 12, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/525/A"),
      p(0, "cf-1851g", "Vlad and the Mountains", "Hard", [0, 3, 4, 6, 7, 9, 10, 11, 12, 13, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1851/G"),
      p(0, "cf-1926g", "Vlad and Trouble at MIT", "Medium", [0, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1926/G"),
      p(0, "cf-1675f", "Vlad and Unfinished Business", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1675/F"),
      p(0, "cf-2119f", "Volcanic Eruptions", "Hard", [8, 9, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/2119/F"),
      p(0, "cf-1826e", "Walk the Runway", "Hard", [0, 3, 7, 8, 9, 12, 13, 14, 16, 18, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1826/E"),
      p(0, "cf-1548a", "Web of Lies", "Easy", [3, 8, 9, 12, 13, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/1548/A"),
      p(0, "cf-1650c", "Weight of the System of Nested Segments", "Easy", [0, 2, 12, 15, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1650/C"),
      p(0, "cf-1399e2", "Weights Division (hard version)", "Hard", [3, 4, 6, 8, 10, 11, 12, 13, 14, 15, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1399/E2"),
      p(0, "cf-1198b", "Welfare State", "Medium", [0, 3, 6, 7, 8, 11, 12, 14, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1198/B"),
      p(0, "cf-1670c", "Where is the Pizza?", "Easy", [0, 7, 8, 9, 10, 12, 13, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1670/C"),
      p(0, "cf-1200d", "White Lines", "Medium", [0, 3, 4, 7, 8, 12, 14, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1200/D"),
      p(0, "cf-1676g", "White-Black Balanced Subtrees", "Easy", [8, 9, 10, 11, 13, 14, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1676/G"),
      p(0, "cf-2117f", "Wildflower", "Medium", [8, 10, 11, 13, 14, 17, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2117/F"),
      p(0, "cf-167d", "Wizards and Roads", "Hard", [0, 5, 7, 9, 12, 13, 15, 22], false, "codeforces", "https://codeforces.com/problemset/problem/167/D"),
      p(0, "cf-1657f", "Words on Tree", "Hard", [8, 9, 10, 11, 13, 14, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1657/F"),
      p(0, "cf-290c", "WTF?", "Medium", [0, 10, 11, 17, 22], false, "codeforces", "https://codeforces.com/problemset/problem/290/C"),
      p(0, "cf-1878g", "wxhtzdy ORO Tree", "Hard", [0, 3, 6, 7, 8, 10, 11, 12, 13, 14, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1878/G"),
      p(0, "cf-339c", "Xenia and Weights", "Medium", [8, 9, 10, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/339/C"),
      p(0, "cf-895b", "XK Segments", "Medium", [3, 4, 6, 11, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/895/B"),
      p(0, "cf-1895d", "XOR Construction", "Medium", [0, 1, 7, 10, 11, 12, 15, 17, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1895/D"),
      p(0, "cf-1416c", "XOR Inverse", "Hard", [0, 1, 5, 7, 10, 11, 12, 15, 16, 17, 18, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1416/C"),
      p(0, "cf-1849f", "XOR Partition", "Hard", [0, 5, 6, 7, 10, 11, 12, 15, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1849/F"),
      p(0, "cf-2267f1", "XOR Transformations (Easy Version)", "Medium", [0, 3, 8, 14, 18, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2267/F1"),
      p(0, "cf-2267f2", "XOR Transformations (Hard Version)", "Hard", [0, 1, 3, 7, 8, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2267/F2"),
      p(0, "cf-1720d1", "Xor-Subsequence (easy version)", "Medium", [1, 3, 4, 8, 10, 11, 14, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1720/D1"),
      p(0, "cf-1720d2", "Xor-Subsequence (hard version)", "Hard", [0, 1, 7, 10, 11, 12, 16, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1720/D2"),
      p(0, "cf-429a", "Xor-tree", "Easy", [8, 10, 11, 13, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/429/A"),
      p(0, "cf-1788f", "XOR, Tree, and Queries", "Hard", [0, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1788/F"),
      p(0, "cf-2121f", "Yamakasi", "Medium", [0, 3, 4, 6, 7, 8, 11, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2121/F"),
      p(0, "cf-1899d", "Yarik and Musical Notes", "Easy", [2, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/1899/D"),
      p(0, "cf-633g", "Yash And Trees", "Hard", [0, 7, 8, 10, 12, 13, 14, 18, 20, 21], false, "codeforces", "https://codeforces.com/problemset/problem/633/G"),
      p(0, "cf-1980g", "Yasya and the Mysterious Tree", "Hard", [0, 1, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1980/G"),
      p(0, "cf-1748e", "Yet Another Array Counting Problem", "Hard", [0, 5, 6, 7, 10, 11, 12, 16, 17, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1748/E"),
      p(0, "cf-1511c", "Yet Another Card Deck", "Easy", [0, 3, 7, 8, 10, 11, 12, 14, 17], false, "codeforces", "https://codeforces.com/problemset/problem/1511/C"),
      p(0, "cf-1430g", "Yet Another DAG Problem", "Hard", [8, 9, 10, 13, 14, 16, 18, 20, 22], false, "codeforces", "https://codeforces.com/problemset/problem/1430/G"),
      p(0, "cf-2146e", "Yet Another MEX Problem", "Hard", [0, 2, 3, 5, 7, 8, 12, 14, 15], false, "codeforces", "https://codeforces.com/problemset/problem/2146/E"),
      p(0, "cf-1901d", "Yet Another Monster Fight", "Medium", [0, 6, 11, 12, 15, 16, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1901/D"),
      p(0, "cf-1257d", "Yet Another Monster Killing Problem", "Medium", [0, 3, 4, 6, 7, 11, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1257/D"),
      p(0, "cf-1747d", "Yet Another Problem", "Medium", [0, 6, 7, 11, 12, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1747/D"),
      p(0, "cf-1703f", "Yet Another Problem About Pairs Satisfying an Inequality", "Easy", [0, 6, 7, 11, 12, 15, 16, 19], false, "codeforces", "https://codeforces.com/problemset/problem/1703/F"),
      p(0, "cf-2035d", "Yet Another Real Number Problem", "Medium", [0, 5, 6, 7, 11, 12, 15, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2035/D"),
      p(0, "cf-1438e", "Yurii Can Do Everything", "Hard", [3, 4, 5, 6, 8, 11, 14, 15, 18], false, "codeforces", "https://codeforces.com/problemset/problem/1438/E"),
      p(0, "cf-2086e", "Zebra-like Numbers", "Hard", [3, 8, 10, 12, 13, 14, 15, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2086/E"),
      p(0, "cf-1695c", "Zero Path", "Medium", [0, 3, 7, 8, 9, 12, 13, 14, 15, 16], false, "codeforces", "https://codeforces.com/problemset/problem/1695/C"),
      p(0, "cf-274b", "Zero Tree", "Medium", [8, 10, 11, 12, 13, 14, 15, 16, 17], false, "codeforces", "https://codeforces.com/problemset/problem/274/B"),
      p(0, "cf-551b", "ZgukistringZ", "Medium", [0, 1, 3, 8, 14, 15, 17], false, "codeforces", "https://codeforces.com/problemset/problem/551/B"),
      p(0, "cf-2223b", "Zhily and Barknights", "Medium", [0, 3, 4, 6, 7, 11, 12, 16, 19, 20], false, "codeforces", "https://codeforces.com/problemset/problem/2223/B"),
      p(0, "cf-2189f", "Zhora the Vacuum Cleaner", "Hard", [0, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 19], false, "codeforces", "https://codeforces.com/problemset/problem/2189/F"),
      p(0, "cf-1400d", "Zigzags", "Medium", [0, 3, 4, 7, 8, 12, 14, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1400/D"),
      p(0, "cf-1491d", "Zookeeper and The Infinite Zoo", "Medium", [12, 15, 16, 18, 20], false, "codeforces", "https://codeforces.com/problemset/problem/1491/D"),
    ];
  };

  const normalizeLcProblems = (raw) => {
    const seen = new Set();
    const list = [];
    (Array.isArray(raw) ? raw : []).forEach((item) => {
      if (!item || typeof item !== "object") return;
      const url = typeof item.url === "string" ? item.url.trim() : "";
      if (!url || seen.has(url)) return;
      seen.add(url);
      /* A problem from another platform has no LeetCode number. Number(null)
         and Number(undefined) are both 0, which would make every one of them
         look like "problem 0", so the absence of a number is kept as null and
         the row shows its platform's own id instead. */
      const rawNum = item.num;
      const num = rawNum === null || rawNum === undefined || rawNum === "" ? null : Number(rawNum);
      if (num !== null && !Number.isFinite(num)) return;
      const platform = typeof item.platform === "string" && item.platform ? item.platform : "leetcode";
      const slug = String(item.slug || "").trim();
      list.push({
        id: String(item.id || `p-${slug || url.slice(-12)}`),
        /* slug is the key the API, revision, notes and solutions all use to
           address a problem, so it is carried through rather than re-derived
           from the URL. */
        slug,
        num,
        platform,
        name: String(item.name || (num === null ? slug : `Problem ${num}`)).trim() || slug,
        url,
        rating: Number.isFinite(Number(item.rating)) && item.rating !== null && item.rating !== undefined
          ? Number(item.rating)
          : null,
        topics: Array.isArray(item.topics) ? item.topics.filter((t) => typeof t === "string" && t) : [],
        /* Whether the server holds this problem's full statement. The API sends
           it and this rebuild used to drop it, so anything on the client asking
           "can this problem's worked examples be read?" was told no for every
           problem including the ones that have one. */
        hasDescription: item.hasDescription === true,
        difficulty: ["Easy", "Medium", "Hard"].includes(item.difficulty) ? item.difficulty : "Medium",
        solved: Boolean(item.solved),
        added: Boolean(item.added),
        /* When the user marked it solved, and when they last ran code on it.
           Both are stamped from real events (tapping Solved, pressing Run) and
           are what "recently solved" and "recently attempted" sort by - no
           timestamp is guessed. */
        solvedAt: Number(item.solvedAt) || 0,
        lastRunAt: Number(item.lastRunAt) || 0,
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

  /* ------------------------------- the catalog ----------------------------- */
  /* Search and filtering for the problem list the user actually browses.
     Kept client-side on purpose: this list is the problems added on this
     device (tens of rows), so filtering it locally is instant and keeps
     working offline. The full online catalog is filtered server-side through
     GET /api/problems - see db/problems.js - and is not this list. */

  const LC_STATUS_FILTERS = ["all", "solved", "unsolved", "starred"];
  const LC_REVISION_FILTERS = ["all", "scheduled", "due", "overdue"];
  /* Every sort ends in the problem number so equal rows never jump around
     between two renders of the same data. */
  const LC_SORTS = [
    { value: "catalog", label: "Catalog order" },
    { value: "title", label: "Title A-Z" },
    { value: "difficulty", label: "Difficulty" },
    { value: "solved", label: "Recently solved" },
    { value: "attempted", label: "Recently attempted" },
    { value: "revision", label: "Revision date" }
  ];
  const LC_DIFFICULTY_RANK = { Easy: 0, Medium: 1, Hard: 2 };

  const lcFilter = { query: "", difficulty: "all", status: "all", revision: "all", sort: "catalog" };

  const lcFilterIsDefault = () =>
    !lcFilter.query.trim() &&
    lcFilter.difficulty === "all" &&
    lcFilter.status === "all" &&
    lcFilter.revision === "all";

  const revisionEntryFor = (problem) => {
    const slug = lcSlugOf(problem);
    if (!slug || !revisionView.items.length) return null;
    return revisionView.items.find((entry) => entry.slug === slug) || null;
  };

  /* The external-link button carries the same words for every problem.

     The catalog holds LeetCode rows and Codeforces rows, so a button reading
     "Open on LeetCode" is simply wrong on the Codeforces ones - the name of the
     site is the one thing about a link that cannot be true for all of them. Only
     the wording is generic; each problem's own URL is used exactly as stored and
     is never rewritten or guessed.

     The rule itself, and the test for a usable URL, live in search.js so they
     can be checked without a browser. These two names point at that module's
     copies rather than re-implementing it. */
  const EXTERNAL_LINK_LABEL = window.EXTERNAL_LINK_LABEL || "Open in Website";
  const externalUrlOf = (problem) => (window.externalUrlOf ? window.externalUrlOf(problem) : "");

  /* Matching lives in search.js: case-insensitive, partial, across title, slug,
     topics, note headings and platform, with every typed word required to match
     somewhere. */
  /* Everything below delegates to search.js, which is where the matching rules
     are written and where they are tested. This function only adds the panel's
     own filters - difficulty, solved, starred, revision - on top of the text
     match, and then re-sorts by whatever the reader chose.

     The search ranking and the chosen sort deliberately coexist: matching narrows
     the set, sortLcProblems orders it, and searchProblems only puts a
     title-and-topic hit ahead of a weaker one within equal sort keys. */
  const visibleLcProblems = () => {
    const query = lcFilter.query;
    const filtered = lcState.problems.filter((problem) => {
      if (lcFilter.difficulty !== "all" && problem.difficulty !== lcFilter.difficulty) return false;
      if (lcFilter.status === "solved" && !problemIsSolved(problem)) return false;
      if (lcFilter.status === "unsolved" && problemIsSolved(problem)) return false;
      if (lcFilter.status === "starred" && problem.bookmarked !== true) return false;
      if (lcFilter.revision !== "all") {
        const entry = revisionEntryFor(problem);
        if (lcFilter.revision === "scheduled") {
          if (!entry) return false;
        } else {
          /* "due" and "overdue" only ever mean problems still on the schedule;
             a finished problem is not due however old its date is. */
          if (!entry || entry.status !== "active") return false;
          if (lcFilter.revision === "due" && entry.bucket !== "today") return false;
          if (lcFilter.revision === "overdue" && entry.bucket !== "overdue") return false;
        }
      }
      return !window.quantaSearch || window.quantaSearch.matchesQuery(problem, query);
    });
    return window.quantaSearch ? window.quantaSearch.searchProblems(filtered, query) : filtered;
  };
  const sortLcProblems = (problems) => {
    const byNumber = (a, b) =>
      a.num === b.num ? a.name.localeCompare(b.name) : Number(a.num) - Number(b.num);
    const copy = [...problems];
    switch (lcFilter.sort) {
      case "title":
        return copy.sort((a, b) => a.name.localeCompare(b.name) || byNumber(a, b));
      case "difficulty":
        return copy.sort(
          (a, b) =>
            (LC_DIFFICULTY_RANK[a.difficulty] ?? 1) - (LC_DIFFICULTY_RANK[b.difficulty] ?? 1) || byNumber(a, b)
        );
      case "solved":
        return copy.sort((a, b) => (Number(b.solvedAt) || 0) - (Number(a.solvedAt) || 0) || byNumber(a, b));
      case "attempted":
        return copy.sort((a, b) => (Number(b.lastRunAt) || 0) - (Number(a.lastRunAt) || 0) || byNumber(a, b));
      case "revision": {
        const dueOf = (problem) => {
          const entry = revisionEntryFor(problem);
          return entry && entry.status === "active" ? entry.dueDate : "";
        };
        return copy.sort((a, b) => {
          const da = dueOf(a);
          const db = dueOf(b);
          /* Problems with no active date go last rather than being treated as
             due in 1970. */
          if (!da && !db) return byNumber(a, b);
          if (!da) return 1;
          if (!db) return -1;
          return da < db ? -1 : da > db ? 1 : byNumber(a, b);
        });
      }
      default:
        return copy.sort(byNumber);
    }
  };

  /* The slug a revision record is keyed by. */
  const lcSlugOf = (problem) => {
    const url = String(problem?.url || "");
    const match = url.match(/leetcode\.com\/problems\/([a-z0-9-]+)/i);
    return match ? match[1].toLowerCase() : "";
  };

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
    /* The problem-level flag also carries progress synced from the database
       (marked solved on another device), where no language is known. */
    if (problem.solved === true) return true;
    if (problem.langSolved && typeof problem.langSolved === "object") {
      return Object.values(problem.langSolved).some(Boolean);
    }
    return false;
  };

  const currentLangLabel = () => {
    try {
      return getLanguageDef(qlActiveLanguage).label;
    } catch {
      return qlActiveLanguage;
    }
  };

  /* Puts the filter controls back to their defaults and syncs the widgets, so the
   UI and the filter state can never drift apart. */
const syncLcFilterControls = () => {
    if (lcSearchInput && lcSearchInput.value !== lcFilter.query) lcSearchInput.value = lcFilter.query;
    if (lcSearchClear) lcSearchClear.hidden = !lcFilter.query;
    lcDifficultyChips?.querySelectorAll(".lc-chip").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.difficulty === lcFilter.difficulty);
    });
    if (lcStatusFilter && lcStatusFilter.value !== lcFilter.status) lcStatusFilter.value = lcFilter.status;
    if (lcRevisionFilter && lcRevisionFilter.value !== lcFilter.revision) lcRevisionFilter.value = lcFilter.revision;
    if (lcSortSelect && lcSortSelect.value !== lcFilter.sort) lcSortSelect.value = lcFilter.sort;
  };

  const resetLcFilters = () => {
    lcFilter.query = "";
    lcFilter.difficulty = "all";
    lcFilter.status = "all";
    lcFilter.revision = "all";
    lcFilter.sort = "catalog";
    window.clearTimeout(lcSearchDebounce);
    syncLcFilterControls();
  };

  /* What the user is filtering by, as removable chips. Each one removes only
     itself, so nobody has to undo everything to change one thing. */
  const renderLcActiveFilters = () => {
    if (!lcActiveFilters) return;
    lcActiveFilters.innerHTML = "";

    const chips = [];
    if (lcFilter.query.trim()) chips.push({ key: "query", label: `“${lcFilter.query.trim()}”` });
    if (lcFilter.difficulty !== "all") chips.push({ key: "difficulty", label: lcFilter.difficulty });
    if (lcFilter.status !== "all")
      chips.push({ key: "status", label: { solved: "Solved", unsolved: "Unsolved", starred: "Starred" }[lcFilter.status] });
    if (lcFilter.revision !== "all")
      chips.push({
        key: "revision",
        label: { scheduled: "In revision list", due: "Due today", overdue: "Overdue" }[lcFilter.revision]
      });

    if (lcFiltersCount) {
      lcFiltersCount.textContent = String(chips.length);
      lcFiltersCount.hidden = chips.length === 0;
    }
    if (lcFiltersClear) lcFiltersClear.disabled = chips.length === 0 && lcFilter.sort === "catalog";

    chips.forEach((chip) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "lc-active-chip";
      button.textContent = chip.label;
      button.setAttribute("aria-label", `Remove filter ${chip.label}`);
      button.addEventListener("click", () => {
        if (chip.key === "query") {
          lcFilter.query = "";
        } else if (chip.key === "status") {
          lcFilter.status = "all";
        } else {
          lcFilter[chip.key] = "all";
        }
        syncLcFilterControls();
        resetLcVisibleLimit();
        renderLcProblemList();
      });
      lcActiveFilters.append(button);
    });
  };

  /* A small marker saying where this problem sits in the revision schedule, so
   the list answers "do I need to revise this?" without opening it. */
  const appendRevisionMarker = (metaRow, problem) => {
    const entry = revisionEntryFor(problem);
    if (!entry) return;
    const badge = document.createElement("span");
    const label =
      entry.status === "completed"
        ? "Revised"
        : entry.bucket === "overdue"
          ? "Overdue"
          : entry.bucket === "today"
            ? "Due today"
            : revisionDueLabel(entry);
    badge.className = `lc-rev-marker lc-rev-marker--${entry.status === "completed" ? "done" : entry.bucket}`;
    badge.textContent = label;
    badge.title = entry.dueDate ? `Next review ${revisionFormatDate(entry.dueDate)}` : label;
    metaRow.append(badge);
  };

  /* The catalog list shows revision state, so the schedule is fetched quietly in
   the background the first time the list is drawn. It is never required to
   render: without it the list simply has no revision markers, and once it
   arrives the list is drawn again so the markers appear. */
const ensureRevisionStateForCatalog = () => {
    if (revisionView.loaded || revisionView.loading) return;
    void loadRevisionDashboard().then(() => {
      if (currentPage === "quantalab" && revisionView.loaded) renderLcProblemList();
    });
  };

  /* Says plainly that this list is only what is on this device, so a filtered
     count is never mistaken for the whole catalog. */
  const updateLcOfflineNote = () => {
    if (!lcOfflineNote) return;
    if (navigator.onLine) {
      lcOfflineNote.hidden = true;
      lcOfflineNote.textContent = "";
      return;
    }
    lcOfflineNote.hidden = false;
    lcOfflineNote.textContent = navigator.onLine
      ? ""
      : `Offline: searching the ${lcState.problems.length} problems saved on this device, not the full online catalog.`;
  };

  window.addEventListener("online", updateLcOfflineNote);
  window.addEventListener("offline", updateLcOfflineNote);

  const initLcFilters = () => {
    if (lcSortSelect && !lcSortSelect.options.length) {
      LC_SORTS.forEach((sort) => {
        const option = document.createElement("option");
        option.value = sort.value;
        option.textContent = sort.label;
        lcSortSelect.append(option);
      });
    }
    syncLcFilterControls();
    updateLcOfflineNote();
    ensureRevisionStateForCatalog();
  };

  /* The catalog is large (hundreds of problems), so the list is drawn in slices
     rather than all at once: the first page immediately, the rest on demand.
     Filtering still runs over everything, so the count is always the true one. */
  const LC_PAGE_SIZE = 60;
  let lcVisibleLimit = LC_PAGE_SIZE;

  const resetLcVisibleLimit = () => {
    lcVisibleLimit = LC_PAGE_SIZE;
  };

  const renderLcProblemList = () => {
    const filtered = sortLcProblems(visibleLcProblems());
    /* A search shows everything it found.

       The limit used to apply to searches as well as to browsing, so "Arrays"
       reported 915 matches and drew 60 of them with a button to page through.
       That is the behaviour the complaint was about: you ask a question, you
       get a slice and have to keep clicking. Only browsing the whole catalog is
       paged, because drawing 2,000 rows when nobody filtered anything is slow
       on a phone for no reason. */
    const SEARCH_ALL_CEILING = Number.MAX_SAFE_INTEGER;
    const searching = lcFilter.query.trim().length > 0;
    if (searching && filtered.length <= SEARCH_ALL_CEILING) {
      lcVisibleLimit = Math.max(lcVisibleLimit, filtered.length);
    }
    const problems = filtered.slice(0, lcVisibleLimit);
    const solvedCount = lcState.problems.filter((problem) => problemIsSolved(problem)).length;
    const filtering = !lcFilterIsDefault();

    if (lcProgressChip) {
      lcProgressChip.textContent = `${solvedCount} / ${lcState.problems.length} solved`;
    }

    /* The count always describes the filtered set, so it can never quietly
       disagree with what is on screen. */
    if (lcResultCount) {
      lcResultCount.textContent = filtering
        ? `${filtered.length} of ${lcState.problems.length} problems`
        : `${lcState.problems.length} problems on this device`;
    }
    renderLcActiveFilters();

    if (!problems.length) {
      /* The old rows must go: leaving them behind would show results that the
         current filters do not actually match. */
      lcProblemList.replaceChildren();
      lcEmpty.hidden = false;
      /* The text is rewritten every time rather than only when the mode changes.
         It used to be cached against `dataset.mode`, so deleting one word and
         typing another left the message naming the word that was already gone -
         "No problems match “arra”" while the box said something else entirely. */
      const wanted = filtering
        ? lcFilter.query.trim()
          ? `No problems match “${lcFilter.query.trim()}”.`
          : "No problems match these filters."
        : "No problems here yet. Use Add problem to start your list.";
      if (lcEmpty.textContent !== wanted) lcEmpty.textContent = wanted;
      lcEmpty.dataset.mode = filtering ? "filtered" : "empty";
      return;
    }
    lcEmpty.hidden = true;
    lcEmpty.dataset.mode = "";

    const fragment = document.createDocumentFragment();
    problems.forEach((problem) => {
      const row = document.createElement("div");
      const rowSolved = problemIsSolved(problem);
      row.className = `lc-problem-row${problem.id === lcState.activeProblemId ? " is-active" : ""}${rowSolved ? " is-solved" : ""}`;
      row.dataset.problemId = problem.id;
      row.setAttribute("role", "listitem");

      const numEl = document.createElement("span");
      numEl.className = "lc-problem-num";
      /* A LeetCode problem shows its LeetCode number. A problem from another
         platform has no such number, so it shows that platform's own id -
         "1984D" from the slug "cf-1984d" - rather than a dash, because a dash
         tells the reader nothing they can act on. */
      if (problem.num !== null && problem.num !== undefined && problem.num !== 0) {
        numEl.textContent = String(problem.num);
      } else {
        const match = /^cf-(\d+)([a-z]\d*)$/.exec(problem.slug || "");
        numEl.textContent = match ? `${match[1]}${match[2].toUpperCase()}` : "—";
        numEl.dataset.platform = problem.platform || "leetcode";
      }

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

      /* Where this problem sits in the revision schedule. */
      appendRevisionMarker(metaRow, problem);

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

      /* The external link, labelled the same way for every problem. A problem
         with no usable URL does not get a link at all: an anchor with no
         destination re-opens this page and reads as a broken button. */
      const externalUrl = externalUrlOf(problem);
      if (externalUrl) {
        const openLink = document.createElement("a");
        openLink.className = "lc-problem-link";
        openLink.href = externalUrl;
        openLink.target = "_blank";
        openLink.rel = "noopener noreferrer";
        openLink.setAttribute("aria-label", `${EXTERNAL_LINK_LABEL}: ${problem.name}`);
        openLink.setAttribute("title", EXTERNAL_LINK_LABEL);
        openLink.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.9 12a3.1 3.1 0 0 1 3.1-3.1h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12ZM8 13h8v-2H8v2Zm9-6h-4v1.9h4a3.1 3.1 0 1 1 0 6.2h-4V17h4a5 5 0 0 0 0-10Z"/></svg>';
        metaRow.append(openLink);
      }

      main.append(nameBtn, metaRow);
      row.append(numEl, main);
      fragment.appendChild(row);
    });

    /* A search should show what it found, not the first sixty of it.
       Browsing the whole catalog is still paged, because drawing 2,000 rows when
       nobody asked for a filter is slow on a phone. The two cases are separated
       here rather than hidden behind one limit. */
    if (searching && filtered.length > problems.length) {
      const showAll = document.createElement("button");
      showAll.type = "button";
      showAll.className = "lc-more-btn";
      showAll.textContent = `Show all ${filtered.length} matching problems`;
      showAll.addEventListener("click", () => {
        lcVisibleLimit = filtered.length;
        renderLcProblemList();
      });
      fragment.appendChild(showAll);
    } else if (filtered.length > problems.length) {
      /* When the list is cut short, say so and offer the rest, rather than
         silently showing a slice that looks like the whole catalog. */
      const more = document.createElement("button");
      more.type = "button";
      more.className = "lc-more-btn";
      const remaining = filtered.length - problems.length;
      more.textContent = `Show ${Math.min(LC_PAGE_SIZE, remaining)} more of ${remaining} still matching`;
      more.addEventListener("click", () => {
        lcVisibleLimit += LC_PAGE_SIZE;
        renderLcProblemList();
      });
      fragment.appendChild(more);
    }

    lcProblemList.replaceChildren(fragment);
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
    /* Same wording as the list, and the same treatment of a missing URL: the
       button is hidden rather than left pointing nowhere. */
    const detailExternalUrl = externalUrlOf(problem);
    const detailLinks = [lcDetailLink, byId("lc-detail-link-desc")].filter(Boolean);
    detailLinks.forEach((link) => {
      if (detailExternalUrl) {
        link.href = detailExternalUrl;
        link.hidden = false;
        link.title = `${EXTERNAL_LINK_LABEL}: ${problem.name}`;
        link.setAttribute("aria-label", `${EXTERNAL_LINK_LABEL}: ${problem.name}`);
      } else {
        link.removeAttribute("href");
        link.hidden = true;
        link.removeAttribute("title");
        link.removeAttribute("aria-label");
      }
    });
    const langSolvedNow = Boolean(problem.langSolved?.[qlActiveLanguage]);
    lcDetailSolvedBtn.textContent = langSolvedNow ? `Unsolved (${currentLangLabel()})` : `Solved (${currentLangLabel()})`;
    lcDetailSolvedBtn.classList.toggle("is-solved", langSolvedNow);
    const starredNow = problem.bookmarked === true;
    if (lcDetailStarBtn) {
      setStarBtnLabel(lcDetailStarBtn, starredNow ? "Starred" : "Star");
      lcDetailStarBtn.classList.toggle("is-active", starredNow);
      lcDetailStarBtn.setAttribute("aria-pressed", String(starredNow));
      lcDetailStarBtn.title = starredNow ? "Remove star" : "Star for revision";
    }
    const savedBadge = byId("lc-detail-saved");
    if (savedBadge) savedBadge.hidden = !getProblemCode(problem, qlActiveLanguage).trim();
    renderNotesSections();
    renderQlCodeView();
    /* Study notes and saved solutions belong to this problem, so they are
       reloaded whenever a different problem is opened. */
    if (typeof refreshStudyForActiveProblem === "function") refreshStudyForActiveProblem();
    /* The "Revise" button shows whether this problem is already scheduled. */
    if (typeof refreshRevisionButton === "function") void refreshRevisionButton(problem);
  };

  const renderLcAll = () => {
    ensureRevisionStateForCatalog();
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
      showLcAddError("Paste a problem link first.");
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
    /* Stamp the moment, so "recently solved" sorts by when it really happened.
       Un-marking clears it rather than leaving a stale date behind. */
    problem.solvedAt = problem.solved ? Date.now() : 0;
    persistLcState();
    renderLcProblemList();
    renderLcDetail();
    /* Mirror the decision into the database so the Progress page and the other
       device see it. Never blocks the UI. */
    void pushProgressForProblem(problem);
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

  /* Where a statement actually came from, and how it is being shown right now.
     These are two separate facts, and conflating them is what made the app say
     "saved on this device" for a copy it had fetched from the database minutes
     earlier. */
  const DESC_SOURCE_LABEL = {
    api: "from the database",
    leetcode: "from LeetCode",
    bundle: "from the offline bundle"
  };

  /* One vocabulary for every source, wherever it was recorded. "database" and
     "offline-pack" were the two names in use; they become "api" and "bundle". */
  const canonicalDescSource = (source) => {
    const raw = String(source || "");
    if (raw === "database" || raw === "api") return "api";
    if (raw === "offline-pack" || raw === "bundle" || raw === "cache") return "bundle";
    if (raw === "leetcode") return "leetcode";
    return "";
  };

  /* The label always answers two questions: where did this text come from, and
     is what I am looking at that copy or a fresh one? A copy the API served is
     never labelled as offline content. The origin and serving mode are returned
     as well as the wording, so they can be recorded on the element rather than
     being thrown away with the text. */
  const describeStatementSource = ({ origin, serving, state }) => {
    const from = origin ? DESC_SOURCE_LABEL[canonicalDescSource(origin)] : "";
    const base = { origin: canonicalDescSource(origin), serving };
    if (serving === "network") return { ...base, text: `Online · ${from || "from the API"}`, kind: "synced" };
    if (serving === "device") {
      if (state === "refreshing") return { ...base, text: `Saved on this device · ${from} · checking for updates…`, kind: "cached" };
      if (state === "refresh-failed") return { ...base, text: `Saved on this device · ${from} · could not check for updates`, kind: "cached" };
      return { ...base, text: `Saved on this device · ${from}`, kind: "cached" };
    }
    if (serving === "unavailable") return { ...base, text: "Statement not available", kind: "error" };
    return { text: "", kind: "" };
  };

  /* The status line under the problem statement. It also records the truth on
     the element itself, so the Diagnostics panel and the tests can read what is
     actually being shown instead of parsing the wording. */
  const setDescStatus = (info) => {
    const node = byId("ql-desc-sync");
    if (!node) return;
    const { text = "", kind = "", origin = "", serving = "" } = typeof info === "string" ? { text: info } : info || {};
    node.textContent = text;
    node.className = `ql-desc-sync${kind ? ` ql-desc-sync--${kind}` : ""}`;
    node.hidden = !text;
    node.dataset.origin = canonicalDescSource(origin);
    node.dataset.serving = serving;
    if (serving === "network") node.dataset.source = "online";
    else if (serving === "device") node.dataset.source = "cached";
    else if (serving === "unavailable") node.dataset.source = "missing";
    else delete node.dataset.source;
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

  /* Set by the diagnostics section further down. Statements load long before
     Settings is ever opened, so the recorder is declared here and filled in
     later rather than being called from nowhere. */
  let noteStatementServed = () => {};

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
      : '<p class="ql-desc-empty">Description unavailable right now. Check your connection, or open it on the problem’s website for the full statement.</p>';

  /* Sanitises a statement's HTML and puts it in `target`.

     The target is a parameter because the same statement is shown in two
     places: the problem detail pane, and inside the mock interview. Writing
     both through one function means the mock page gets exactly the same
     sanitising - scripts stripped, event handlers and non-https hrefs removed -
     rather than a second, weaker copy of that work. */
  const renderDescHtml = (html, target = qlDescBody) => {
    if (!target) return;
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
    target.innerHTML = "";
    while (holder.firstChild) target.appendChild(holder.firstChild);
  };

  const loadQlDescription = (problem) => {
    if (!qlDescBody || !problem) return;
    if (qlDescDiff) qlDescDiff.textContent = `${problem.num ? `#${problem.num} · ` : ""}${problem.difficulty}`;
    if (qlDescLink) qlDescLink.href = problem.url;
    const slug = slugKey(problem.url);
    if (!slug) {
      setDescStatus("");
      qlDescBody.innerHTML = '<p class="ql-desc-empty">No description available for custom problems. Open it on the problem’s website for the full statement.</p>';
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
        setDescStatus(describeStatementSource({ origin: cached.source, serving: "device", state: "refreshing" }));
        refreshDescription(slug, token);
      } else {
        /* The copy on screen is the device's, but it says where that copy came
           from, so "saved on this device" is never mistaken for offline data. */
        setDescStatus(describeStatementSource({ origin: cached.source, serving: "device" }));
      }
      return;
    }

    setDescStatus({ text: "Loading statement…", kind: "syncing" });
    qlDescBody.innerHTML = '<p class="ql-desc-loading">Loading problem description…</p>';
    requestDescription(slug).then((result) => {
      if (token !== qlDescToken) return; /* stale — another problem took over */
      if (result && result.html) {
        rememberDescription(slug, result.html, result.source);
        renderDescHtml(result.html);
        const fromNetwork = result.source !== "offline-pack";
        setDescStatus(
          describeStatementSource({ origin: result.source, serving: fromNetwork ? "network" : "device" })
        );
        noteStatementServed(fromNetwork);
      } else {
        setDescStatus({ text: "Statement not available", kind: "error", serving: "unavailable" });
        qlDescBody.innerHTML = describeUnavailable(offline);
      }
    });
  };

  /* Background refresh for an old cached statement. It never blocks the view
     and never replaces text with an error — the saved copy stays readable. A
     failed refresh leaves the copy alone and says only that the check failed,
     because an outage must never destroy good cached data. */
  const refreshDescription = (slug, token) => {
    requestDescription(slug).then((result) => {
      if (token !== qlDescToken) return;
      if (result && result.html) {
        const changed = rememberDescription(slug, result.html, result.source);
        if (changed) renderDescHtml(result.html);
        const cached = readDescCache().get(slug);
        noteStatementServed(result.source !== "offline-pack");
        setDescStatus(
          describeStatementSource({ origin: (cached && cached.source) || result.source, serving: "device" })
        );
      } else {
        setDescStatus(
          describeStatementSource({ origin: readDescCache().get(slug)?.source, serving: "device", state: "refresh-failed" })
        );
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
      /* An attempt is an attempt: it is recorded whether it passed, failed or
         timed out, which is exactly what "recently attempted" means. */
      problem.lastRunAt = Date.now();
      persistLcState(true);
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
    const isSolutions = tab === "solutions";
    const isCode = !isNotes && !isSolutions;
    qlTabNotes.classList.toggle("is-active", isNotes);
    qlTabCode.classList.toggle("is-active", isCode);
    qlTabSolutions?.classList.toggle("is-active", isSolutions);
    qlTabNotes.setAttribute("aria-selected", String(isNotes));
    qlTabCode.setAttribute("aria-selected", String(isCode));
    qlTabSolutions?.setAttribute("aria-selected", String(isSolutions));
    qlViewNotes.hidden = !isNotes;
    qlViewCode.hidden = !isCode;
    if (qlViewSolutions) qlViewSolutions.hidden = !isSolutions;
    if (isCode) void renderQlCodeView();
    relayoutMonacoEditors();
    if (isCode) queueDescDividerSync();
  };

  qlTabNotes?.addEventListener("click", () => selectQlTab("notes"));
  qlTabCode?.addEventListener("click", () => selectQlTab("code"));
  qlTabSolutions?.addEventListener("click", () => {
    selectQlTab("solutions");
    void renderSolutionList(studySlug(getActiveLcProblem()));
  });

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
    /* Typing re-filters a list of tens of rows, but the list also re-renders the
       whole pane. Waiting for a short pause keeps a fast typist from paying for
       every intermediate state, and keeps a real search box responsive. */
    window.clearTimeout(lcSearchDebounce);
    const applySearch = () => {
      if (lcSearchClear) lcSearchClear.hidden = !lcFilter.query;
      resetLcVisibleLimit();
      renderLcProblemList();
    };
    if (event.target.value) {
      lcSearchDebounce = window.setTimeout(applySearch, 120);
      /* The clear button must appear immediately or it looks broken while the
         user is still typing. */
      if (lcSearchClear) lcSearchClear.hidden = false;
    } else {
      applySearch();
    }
  });

  lcSearchClear?.addEventListener("click", () => {
    window.clearTimeout(lcSearchDebounce);
    lcFilter.query = "";
    if (lcSearchInput) lcSearchInput.value = "";
    lcSearchClear.hidden = true;
    resetLcVisibleLimit();
    renderLcProblemList();
    lcSearchInput?.focus();
  });

  lcDifficultyChips?.addEventListener("click", (event) => {
    const chip = event.target.closest(".lc-chip");
    if (!chip) return;
    lcFilter.difficulty = chip.dataset.difficulty || "all";
    lcDifficultyChips.querySelectorAll(".lc-chip").forEach((el) => {
      el.classList.toggle("is-active", el.dataset.difficulty === lcFilter.difficulty);
    });
    resetLcVisibleLimit();
    renderLcProblemList();
  });

  lcStatusFilter?.addEventListener("change", (event) => {
    lcFilter.status = event.target.value;
    resetLcVisibleLimit();
    renderLcProblemList();
  });

  lcRevisionFilter?.addEventListener("change", (event) => {
    lcFilter.revision = event.target.value;
    resetLcVisibleLimit();
    renderLcProblemList();
  });

  lcSortSelect?.addEventListener("change", (event) => {
    lcFilter.sort = event.target.value;
    resetLcVisibleLimit();
    renderLcProblemList();
  });

  /* The panel is a plain details region on wide screens and a sheet on a phone,
     so it is the same control in both cases - just placed differently. */
  lcFiltersToggle?.addEventListener("click", () => {
    const open = lcFiltersToggle.getAttribute("aria-expanded") === "true";
    lcFiltersToggle.setAttribute("aria-expanded", String(!open));
    if (lcFiltersPanel) lcFiltersPanel.hidden = open;
  });

  lcFiltersClear?.addEventListener("click", () => {
    resetLcFilters();
    resetLcVisibleLimit();
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
       every element — including the Open in Website button — sits correctly
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

  /* The theme slider is driven entirely by script.js, which owns the theme.
     This element is only moved between the top bar and the mobile drawer
     here, never re-implemented: a second set of pointer handlers on it is
     what let the knob and the theme drift apart. */
  const themeSymbolGroup = byId("theme-symbols");

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

  /* Theme switching.
     script.js owns the theme: it applies the change, moves the knob, keeps the
     stored value and runs the cross-fade. Everything here goes through that one
     path, so a chip press and a slider drag cannot disagree about where the
     knob is or which theme is active - the bug that let the knob jump to the
     left while a different theme was showing.

     This block only reacts to the change, to keep the Settings chips and the
     code editor in step. */
  const THEME_ORDER = ["dark", "beige", "ember"];

  const selectThemeFromSettings = (theme) => {
    const next = THEME_ORDER.includes(theme) ? theme : "dark";
    if (window.QuantaTheme) {
      window.QuantaTheme.set(next);
      return;
    }
    /* script.js did not load: fall back to a plain switch rather than leaving
       the app unable to change theme at all. */
    document.body.setAttribute("data-theme", next);
    try {
      localStorage.setItem("leetcodeDashboardTheme", next);
    } catch {
      /* private mode */
    }
    handleThemeChanged(next);
  };

  /* Everything that has to follow a theme change, whoever caused it. */
  const handleThemeChanged = () => {
    syncSettingsUi();
    if (labState.languageThemes !== false && (currentPage === "lab" || currentPage === "quantalab")) {
      if (currentPage === "lab" && getActiveSession()) applyLanguageTheme(getActiveSession().language);
      else void renderQlCodeView();
    } else {
      syncMonacoTheme();
    }
  };

  window.addEventListener("quanta:themechange", handleThemeChanged);

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
      },
      /* Mock interview: editor | output width, and the same pair stacked on a
         narrow screen. The same resizer drives these as the Lab's, so the
         divider is styled and dragged identically and remembers its position;
         the keys are separate so the two panels never overwrite each other's
         sizes. */
      {
        el: byId("mock-col-resizer"),
        mode: "x",
        key: "mockColW",
        layout: () => mockWorkspace,
        start: () => mockWorkspace?.querySelector(".mock-editor-pane"),
        minStart: 240,
        minEnd: 240,
        trackExtra: 34
      },
      {
        el: byId("mock-row-resizer"),
        mode: "y",
        key: "mockRowH",
        layout: () => mockWorkspace,
        start: () => mockWorkspace?.querySelector(".mock-editor-pane"),
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
  /* ---------------------------------------------------------- scrollbars
   *
   * Scrollbars hide themselves and appear only while something is being
   * scrolled. The CSS needs to know which moments those are, and it cannot:
   * there is no "scrolling" state in CSS. So this marks them.
   *
   * A scroll event does not bubble, so the listener is registered in the
   * capture phase - that is what catches every scroller on the page, including
   * ones added later, without each having to announce itself.
   *
   * One class, one timer, for the whole document. Anything more would be a
   * scroll handler per panel, which is how scrolling ends up feeling heavy.
   *
   * Mouse wheel, touchpad, touch and keyboard all arrive here as the same
   * event, because the browser reports them the same way once they have moved
   * the scroll position. Nothing about scrolling itself is touched: no
   * overflow is removed, no pointer-events are disabled, and the bar is still
   * there to be dragged.
   */
  const SCROLLING_CLASS = "quanta-scrolling";
  const SCROLL_IDLE_MS = 900;
  let scrollIdleTimer = null;

  const endScrollingSoon = () => {
    if (scrollIdleTimer) window.clearTimeout(scrollIdleTimer);
    scrollIdleTimer = window.setTimeout(() => {
      scrollIdleTimer = null;
      document.documentElement.classList.remove(SCROLLING_CLASS);
    }, SCROLL_IDLE_MS);
  };

  document.addEventListener(
    "scroll",
    () => {
      const root = document.documentElement;
      if (!root.classList.contains(SCROLLING_CLASS)) root.classList.add(SCROLLING_CLASS);
      endScrollingSoon();
    },
    { capture: true, passive: true }
  );

  /* Hidden again when the pointer leaves the window, rather than waiting out
     the timer for a bar nobody can see. */
  window.addEventListener("blur", () => {
    if (scrollIdleTimer) window.clearTimeout(scrollIdleTimer);
    document.documentElement.classList.remove(SCROLLING_CLASS);
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

/* ======================= coding progress dashboard ===================== */
  /* Everything on this page comes from the database through /api/progress/*.
     Two facts are kept visibly apart, because this app cannot tell whether a
     solution is algorithmically correct:

       - "Solved" means the user pressed "Mark solved" on some device.
       - "Runs" are real executions the server performed (Judge0). A successful
         run only means the program compiled and finished.

     Nothing here is invented: no number comes from a seed, and no day is ever
     filled in when there was no activity. */

  const PROGRESS_PAGE_SIZE = 20;

  const progressView = {
    summary: null,
    activity: [],
    activityTotal: 0,
    loading: false,
    loaded: false,
    error: ""
  };

  const progressSetText = (id, value) => {
    const node = byId(id);
    if (node) node.textContent = String(value);
  };

  const progressNumber = (value) => new Intl.NumberFormat().format(Number(value) || 0);

  /* Minutes east of UTC, so the server buckets days in the viewer's timezone. */
  const progressTzOffset = () => -new Date().getTimezoneOffset();

  const progressFetch = async (path, options = {}) => {
    const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
    const response = await fetch(`${getApiBase()}${path}`, {
      cache: "no-store",
      ...options,
      signal: hasTimeout ? AbortSignal.timeout(15000) : undefined
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status}).`);
    return payload;
  };

  const progressDayDate = (dayKey) => new Date(`${dayKey}T00:00:00Z`);

  const formatDayKey = (dayKey, options = {}) =>
    new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options }).format(progressDayDate(dayKey));

  /* The stored timestamp is UTC without a zone marker, so it is parsed as UTC
     explicitly instead of being shifted into the device timezone. */
  const parseSolvedAt = (value) => {
    if (!value) return null;
    const parsed = new Date(`${String(value).replace(" ", "T")}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };

  /* Slug of a local problem, reused from the existing URL parser. */
  const progressSlugOf = (problem) => {
    const info = extractLcProblemInfo(problem?.url || "");
    return info ? info.slug : "";
  };

  /* Sends the user's own "Mark solved" decision to the database so the phone,
     the browser and the dashboard always agree. Best effort: a failed sync must
     never break the editor, and the local list stays authoritative offline. */
  const pushProgressForProblem = async (problem) => {
    const slug = progressSlugOf(problem);
    if (!slug) return;
    const info = extractLcProblemInfo(problem.url);
    try {
      await progressFetch("/api/progress/solved", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          num: info?.num > 0 ? info.num : problem.num > 0 ? problem.num : null,
          title: problem.name || "",
          difficulty: problem.difficulty || "Medium",
          solved: problemIsSolved(problem)
        })
      });
    } catch {
      /* Offline or server unavailable: keep the local state, retry next time. */
    }
  };

  /* Brings problems marked solved on another device (for example the phone)
     into this device's list. The database stores progress per problem while the
     local list tracks it per language, so a synced problem is marked at the
     problem level instead of guessing which language it was solved in. */
  const syncSolvedFromServer = async () => {
    let payload = null;
    try {
      payload = await progressFetch("/api/progress");
    } catch {
      return;
    }
    const items = Array.isArray(payload?.items) ? payload.items : [];
    if (!items.length) return;

    let changed = false;
    const bySlug = new Map(lcState.problems.map((problem) => [progressSlugOf(problem), problem]));
    items.forEach((item) => {
      const problem = bySlug.get(String(item.slug || "").toLowerCase());
      if (!problem || problem.solved === true) return;
      problem.solved = true;
      changed = true;
    });
    if (!changed) return;
    persistLcState();
    renderLcAll();
  };

  const renderProgressTiles = (summary) => {
    progressSetText("stat-total", progressNumber(summary.catalog.total));
    progressSetText("stat-solved", progressNumber(summary.solved.total));
    progressSetText("stat-unsolved", progressNumber(summary.catalog.unsolved));
    progressSetText("stat-completion", `${summary.catalog.completionPercent}%`);
    progressSetText("stat-streak-current", progressNumber(summary.streaks.current));
    progressSetText("stat-streak-longest", progressNumber(summary.streaks.longest));
    progressSetText("stat-today", progressNumber(summary.solved.today));
    progressSetText("stat-week", progressNumber(summary.solved.thisWeek));
    progressSetText("stat-runs-total", progressNumber(summary.runs.total));
    progressSetText("stat-runs-ok", progressNumber(summary.runs.successful));
    progressSetText("stat-runs-failed", progressNumber(summary.runs.failed));

    const solvedHint = byId("stat-solved-hint");
    if (solvedHint) {
      solvedHint.textContent =
        summary.solved.outsideCatalog > 0
          ? `${summary.solved.outsideCatalog} outside the catalog`
          : "marked solved";
    }

    /* Problems solved outside the catalog would make the percentage look wrong,
       so they are stated separately instead of being folded in silently. */
    const note = byId("progress-solved-note");
    if (note) {
      note.hidden = summary.solved.outsideCatalog <= 0;
      note.textContent =
        summary.solved.outsideCatalog > 0
          ? `${progressNumber(summary.solved.outsideCatalog)} solved ${
              summary.solved.outsideCatalog === 1 ? "problem is" : "problems are"
            } not in the catalog, so ${
              summary.solved.outsideCatalog === 1 ? "it is" : "they are"
            } not counted in the completion percentage.`
          : "";
    }
  };

  const renderProgressDifficulty = (rows) => {
    const host = byId("progress-difficulty");
    if (!host) return;
    host.innerHTML = "";
    rows.forEach((row) => {
      const item = document.createElement("div");
      item.className = "diff-row";

      const label = document.createElement("span");
      label.className = "diff-row__label";
      label.textContent = row.difficulty;

      const bar = document.createElement("div");
      bar.className = "diff-row__bar";
      bar.setAttribute("role", "img");
      bar.setAttribute("aria-label", `${row.difficulty}: ${row.solved} of ${row.total} solved`);
      const fill = document.createElement("div");
      fill.className = "diff-row__fill";
      fill.style.width = `${Math.max(0, Math.min(100, row.percent))}%`;
      bar.append(fill);

      const count = document.createElement("span");
      count.className = "diff-row__count";
      count.textContent = `${progressNumber(row.solved)} / ${progressNumber(row.total)}`;

      item.append(label, bar, count);
      host.append(item);
    });
  };

  const progressLevel = (count, max) => {
    if (count <= 0) return 0;
    if (max <= 1) return 4;
    const ratio = count / max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };

  const renderProgressHeatmap = (summary) => {
    const host = byId("progress-heatmap");
    const detail = byId("progress-heatmap-detail");
    if (!host) return;

    const daily = Array.isArray(summary.activity?.daily) ? summary.activity.daily : [];
    const max = daily.reduce((peak, entry) => Math.max(peak, Number(entry.count) || 0), 0);
    host.innerHTML = "";

    /* Week columns, Monday first. A series that starts mid-week is padded with
       empty cells instead of shifting every day into the wrong weekday. */
    const slots = [];
    if (daily.length) {
      const firstWeekday = (progressDayDate(daily[0].day).getUTCDay() + 6) % 7;
      for (let i = 0; i < firstWeekday; i += 1) slots.push(null);
      daily.forEach((entry) => slots.push(entry));
      while (slots.length % 7 !== 0) slots.push(null);
    }

    const describe = (entry) => {
      const when = formatDayKey(entry.day, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
      return entry.count > 0
        ? `${progressNumber(entry.count)} ${entry.count === 1 ? "problem" : "problems"} solved on ${when}`
        : `No problems solved on ${when}`;
    };

    for (let i = 0; i < slots.length; i += 7) {
      slots.slice(i, i + 7).forEach((entry) => {
        if (!entry) {
          const spacer = document.createElement("span");
          spacer.className = "hm-cell";
          spacer.style.visibility = "hidden";
          host.append(spacer);
          return;
        }
        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = `hm-cell hm-cell--l${progressLevel(entry.count, max)}`;
        if (entry.day === summary.today) cell.classList.add("hm-cell--today");
        cell.setAttribute("aria-label", describe(entry));
        const show = () => {
          if (detail) detail.textContent = describe(entry);
        };
        cell.addEventListener("mouseenter", show);
        cell.addEventListener("focus", show);
        cell.addEventListener("click", show);
        host.append(cell);
      });
    }

    if (detail) {
      detail.textContent =
        max > 0 ? "Hover or tap a day to see what you solved." : "No activity in this period yet.";
    }

    const range = byId("progress-activity-range");
    if (range) range.textContent = `last ${summary.activity.days} days`;
  };

  const renderProgressBars = (hostId, series, labelOf) => {
    const host = byId(hostId);
    if (!host) return;
    host.innerHTML = "";
    const max = series.reduce((peak, entry) => Math.max(peak, Number(entry.count) || 0), 0);
    series.forEach((entry) => {
      const column = document.createElement("div");
      column.className = "bar-col";

      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.height = `${max > 0 ? Math.round((entry.count / max) * 100) : 0}%`;
      fill.title = `${labelOf(entry)}: ${progressNumber(entry.count)}`;

      const label = document.createElement("span");
      label.className = "bar-label";
      label.textContent = labelOf(entry);

      column.append(fill, label);
      host.append(column);
    });
  };

  const renderProgressComparison = (comparison) => {
    const node = byId("progress-comparison");
    if (!node) return;
    const describe = (value) => {
      const parts = [`${progressNumber(value.current)} solved`, `previous ${progressNumber(value.previous)}`];
      if (value.previous > 0) {
        const sign = value.delta > 0 ? "+" : "";
        parts.push(`${sign}${progressNumber(value.delta)} (${sign}${value.percent}%)`);
      } else if (value.current > 0) {
        parts.push("no data for the previous period");
      }
      return parts.join(" · ");
    };
    node.textContent = `This week — ${describe(comparison.week)}. This month — ${describe(comparison.month)}.`;
  };

  const renderProgressActivity = () => {
    const host = byId("progress-activity-list");
    const more = byId("progress-activity-more");
    if (!host) return;
    host.innerHTML = "";

    if (!progressView.activity.length) {
      const empty = document.createElement("p");
      empty.className = "progress-note";
      empty.textContent = "Nothing solved yet.";
      host.append(empty);
      if (more) more.hidden = true;
      return;
    }

    progressView.activity.forEach((item) => {
      const row = document.createElement("div");
      row.className = "activity-row";

      const title = document.createElement("span");
      title.className = "activity-row__title";
      title.textContent = `${item.num ? `#${item.num} ` : ""}${item.title || item.slug}`;

      const difficulty = document.createElement("span");
      difficulty.className = "activity-row__diff";
      difficulty.textContent = item.difficulty || "Medium";

      const date = document.createElement("span");
      date.className = "activity-row__date";
      const parsed = parseSolvedAt(item.solvedAt);
      date.textContent = parsed
        ? new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(parsed)
        : "";

      row.append(title, difficulty, date);
      host.append(row);
    });

    if (more) more.hidden = progressView.activity.length >= progressView.activityTotal;
  };

  /* Paginated so a long history is never loaded in one request. */
  const loadProgressActivity = async (append = false) => {
    const offset = append ? progressView.activity.length : 0;
    const page = await progressFetch(`/api/progress/activity?limit=${PROGRESS_PAGE_SIZE}&offset=${offset}`);
    const items = Array.isArray(page?.items) ? page.items : [];
    progressView.activity = append ? [...progressView.activity, ...items] : items;
    progressView.activityTotal = Number(page?.total) || progressView.activity.length;
    renderProgressActivity();
  };

  /* Loads everything the page shows. Loading and error states are explicit; a
     failed refresh keeps the last numbers on screen with the error shown, and
     the "updated" line always states when the data was really fetched. */
  const renderProgressPage = async () => {
    if (progressView.loading) return;
    progressView.loading = true;
    progressView.error = "";

    const statusNode = byId("progress-status");
    const errorNode = byId("progress-error");
    const contentNode = byId("progress-content");
    const emptyNode = byId("progress-empty");
    const refresh = byId("progress-refresh");

    if (refresh) refresh.disabled = true;
    if (statusNode) statusNode.textContent = progressView.loaded ? "Refreshing…" : "Loading your progress…";
    if (!progressView.loaded) {
      if (errorNode) errorNode.hidden = true;
      if (contentNode) contentNode.hidden = true;
    }

    try {
      const summary = await progressFetch(
        `/api/progress/summary?tzOffset=${progressTzOffset()}&days=365&weeks=12&months=6`
      );
      progressView.summary = summary;
      progressView.loaded = true;

      renderProgressTiles(summary);
      renderProgressDifficulty(summary.solved.byDifficulty);
      renderProgressHeatmap(summary);
      renderProgressBars("progress-weekly", summary.activity.weekly, (entry) =>
        formatDayKey(entry.start, { day: "numeric", month: "short" })
      );
      renderProgressBars("progress-monthly", summary.activity.monthly, (entry) =>
        formatDayKey(entry.start, { month: "short" })
      );
      renderProgressComparison(summary.comparison);
      await loadProgressActivity(false);

      /* The prompt is about solved problems, so runs alone never hide it. */
      const hasSolved = summary.solved.total > 0;
      if (contentNode) contentNode.hidden = false;
      if (emptyNode) emptyNode.hidden = hasSolved;
      if (errorNode) errorNode.hidden = true;
      if (statusNode) {
        const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date());
        statusNode.textContent =
          `Updated ${time} · ${progressNumber(summary.solved.total)} solved of ` +
          `${progressNumber(summary.catalog.total)} catalog problems`;
      }
    } catch (error) {
      progressView.error = error?.message || "Progress could not be loaded.";
      if (statusNode) statusNode.textContent = "Progress is unavailable right now.";
      const errorText = byId("progress-error-text");
      if (errorText) errorText.textContent = progressView.error;
      if (errorNode) errorNode.hidden = false;
      if (!progressView.loaded && contentNode) contentNode.hidden = true;
    } finally {
      progressView.loading = false;
      if (refresh) refresh.disabled = false;
    }
  };

  byId("progress-refresh")?.addEventListener("click", () => {
    void renderProgressPage();
  });

  byId("progress-error-retry")?.addEventListener("click", () => {
    void renderProgressPage();
  });

  byId("progress-activity-more")?.addEventListener("click", async () => {
    const button = byId("progress-activity-more");
    if (button) {
      button.disabled = true;
      button.textContent = "Loading…";
    }
    try {
      await loadProgressActivity(true);
    } catch {
      /* the list keeps whatever it already has */
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = "Show more";
      }
    }
  });

/* ================== study notes and saved solutions (client) ============== */
/* Personal notes and saved solutions for each problem, stored on the device
   first and pushed to the database when a server is reachable.

   How saving behaves:
     - The working code in the editor is never touched. "Save current editor as a
       solution" copies it into a new saved solution and leaves the editor alone.
     - A saved solution is only ever called a saved solution. The runner executes
       code with free-form stdin and cannot check a problem's hidden tests, so
       nothing here is ever described as correct or accepted.

   Sync states shown in the UI:
     local   - written on this device, not sent yet (no server when written)
     pending - saved locally, waiting for the server to confirm
     synced  - the server confirmed this exact revision
     conflict- the server has a newer revision; the user must choose

   Conflicts are never resolved silently: a stale write is refused by the server,
   its current copy is shown, and "Use mine" re-sends deliberately. */

const STUDY_KEY = "quantaStudyStoreV1";

const SYNC_LABELS = {
  local: "On this device",
  pending: "Waiting to sync",
  synced: "Synced",
  conflict: "Conflict"
};

const emptyStudyStore = () => ({ notes: {}, solutions: [], pending: 0 });

const readStudyStore = () => {
  const raw = readJson(STUDY_KEY, emptyStudyStore);
  return {
    notes: raw && typeof raw.notes === "object" && raw.notes ? raw.notes : {},
    solutions: Array.isArray(raw.solutions) ? raw.solutions : [],
    pending: 0
  };
};

let studyStore = readStudyStore();

const writeStudyStore = () => writeJson(STUDY_KEY, studyStore);

const studySlug = (problem) => {
  const info = extractLcProblemInfo(problem?.url || "");
  return info ? info.slug : "";
};

/* ------------------------------ transport ------------------------------- */

const studyRequest = async (path, options = {}) => {
  const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
  const response = await fetch(`${getApiBase()}${path}`, {
    cache: "no-store",
    ...options,
    signal: hasTimeout ? AbortSignal.timeout(15000) : undefined
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, ok: response.ok, payload };
};

const studyJson = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body)
});

/* ------------------------------- notes ---------------------------------- */

const emptyNote = (slug) => ({
  slug,
  title: "",
  approach: "",
  observations: "",
  edgeCases: "",
  timeComplexity: "",
  spaceComplexity: "",
  tags: [],
  sections: null,
  revision: 0,
  syncState: "local",
  serverCopy: null,
  updatedAt: null
});

const getStoredNote = (slug) => studyStore.notes[slug] || emptyNote(slug);

const setStoredNote = (slug, patch) => {
  const next = { ...getStoredNote(slug), ...patch, slug };
  next.updatedAt = new Date().toISOString();
  studyStore.notes[slug] = next;
  writeStudyStore();
  return next;
};

const noteHasContent = (note) =>
  Boolean(
    (note.title || "").trim() ||
      (note.approach || "").trim() ||
      (note.observations || "").trim() ||
      (note.edgeCases || "").trim() ||
      (note.timeComplexity || "").trim() ||
      (note.spaceComplexity || "").trim() ||
      (note.tags || []).length
  );

/* Pulls the note for this problem: device copy first, then the server copy when
   it is newer. A local edit that has not been sent is never overwritten. */
const loadNoteFor = async (slug) => {
  const local = getStoredNote(slug);
  const result = await studyRequest(`/api/study/note?slug=${encodeURIComponent(slug)}`);
  if (result.status === 0 || !result.ok) return local;
  const server = result.payload?.note || null;

  if (!server) {
    /* The server has no note: keep a local one, but a copy that was previously
       synced and deleted elsewhere should not reappear as if it were new. */
    if (!local.revision) return local;
    return setStoredNote(slug, { syncState: "local" });
  }

  if (local.syncState === "pending" || local.syncState === "conflict") {
    /* Local work wins until the server has confirmed it; compare revisions so a
       clearly older server copy cannot roll the user back by surprise. */
    if (local.revision && local.revision > server.revision) return local;
    if (local.syncState === "pending") return local;
    return setStoredNote(slug, { syncState: "conflict", serverCopy: server });
  }

  const merged = {
    ...local,
    ...server,
    tags: Array.isArray(server.tags) ? server.tags : [],
    sections: Array.isArray(server.sections) ? server.sections : local.sections,
    syncState: "synced",
    serverCopy: null
  };
  studyStore.notes[slug] = merged;
  writeStudyStore();
  return merged;
};

/* Saves the note: the device copy is updated first, so the work is never lost,
   and the server is asked to confirm it afterwards. */
const saveNoteFor = async (slug) => {
  const current = getStoredNote(slug);
  const local = setStoredNote(slug, { syncState: "pending" });
  const body = {
    slug,
    title: current.title || "",
    approach: current.approach || "",
    observations: current.observations || "",
    edgeCases: current.edgeCases || "",
    timeComplexity: current.timeComplexity || "",
    spaceComplexity: current.spaceComplexity || "",
    tags: current.tags || [],
    sections: current.sections || undefined,
    baseRevision: current.revision || 0
  };

  const result = await studyRequest("/api/study/note", studyJson("PUT", body));

  if (result.ok && result.payload?.note) {
    return setStoredNote(slug, { ...result.payload.note, syncState: "synced", serverCopy: null });
  }

  if (result.status === 409) {
    setStoredNote(slug, { syncState: "conflict", serverCopy: result.payload?.note || null });
    return getStoredNote(slug);
  }

  /* No server: the note stays on this device and is marked as such. */
  setStoredNote(slug, { syncState: "local" });
  return getStoredNote(slug);
};

/* Re-sends the local copy on purpose, accepting the server's newer revision. */
const forceSaveNoteFor = async (slug) => {
  const current = getStoredNote(slug);
  const base = current.serverCopy?.revision ?? current.revision ?? 0;
  return saveNoteFor(slug, base);
};

const deleteNoteFor = async (slug) => {
  delete studyStore.notes[slug];
  writeStudyStore();
  await studyRequest(`/api/study/note?slug=${encodeURIComponent(slug)}`, { method: "DELETE" });
};

/* ----------------------------- solutions -------------------------------- */

const solutionsFor = (slug) =>
  studyStore.solutions.filter((solution) => solution.slug === slug);

const upsertStoredSolution = (solution) => {
  const index = studyStore.solutions.findIndex(
    (entry) =>
      (solution.id && entry.id === solution.id) ||
      (solution.clientId && entry.clientId === solution.clientId)
  );
  const next = { ...solution, updatedAt: solution.updatedAt || new Date().toISOString() };
  if (index >= 0) studyStore.solutions[index] = { ...studyStore.solutions[index], ...next };
  else studyStore.solutions.unshift(next);
  writeStudyStore();
  return next;
};

const listSolutionsFor = async (slug) => {
  const localOnly = solutionsFor(slug).some((entry) => entry.syncState !== "synced");
  const result = await studyRequest(`/api/study/solutions?slug=${encodeURIComponent(slug)}&limit=100`);
  if (!result.ok) return solutionsFor(slug);

  (result.payload?.items || []).forEach((server) => {
    const local = studyStore.solutions.find((entry) => entry.id === server.id);
    if (!local) {
      studyStore.solutions.unshift({ ...server, syncState: "synced" });
      return;
    }
    if (local.syncState === "pending" || local.syncState === "conflict") {
      if (server.revision > (local.revision || 0)) {
        studyStore.solutions[studyStore.solutions.indexOf(local)] = {
          ...local,
          syncState: "conflict",
          serverCopy: server
        };
      }
      return;
    }
    Object.assign(local, server, { syncState: "synced", serverCopy: null });
  });

  /* Server rows that were deleted elsewhere must not linger as "synced". */
  const serverIds = new Set((result.payload?.items || []).map((item) => item.id));
  studyStore.solutions = studyStore.solutions.filter(
    (entry) => entry.slug !== slug || entry.syncState !== "synced" || serverIds.has(entry.id)
  );
  writeStudyStore();
  return localOnly ? solutionsFor(slug) : solutionsFor(slug);
};

const createSolutionLocal = async (input) => {
  const clientId = randomId("sol");
  const draft = {
    id: null,
    clientId,
    slug: input.slug,
    title: input.title || "Solution",
    language: input.language || "java",
    code: input.code || "",
    explanation: input.explanation || "",
    timeComplexity: input.timeComplexity || "",
    spaceComplexity: input.spaceComplexity || "",
    revision: 0,
    syncState: "pending",
    createdAt: new Date().toISOString()
  };
  upsertStoredSolution(draft);

  const result = await studyRequest("/api/study/solutions", studyJson("POST", draft));
  if (result.ok && result.payload?.solution) {
    const stored = upsertStoredSolution({ ...result.payload.solution, syncState: "synced", serverCopy: null });
    /* Drop the offline draft now that the server has its own copy. */
    studyStore.solutions = studyStore.solutions.filter(
      (entry) => !(entry.clientId === clientId && entry.id !== stored.id)
    );
    writeStudyStore();
    return stored;
  }
  setSolutionSync(stored0(draft), "local");
  return getStoredSolution(draft.clientId);
};

const stored0 = (draft) => studyStore.solutions.find((entry) => entry.clientId === draft.clientId) || draft;

const getStoredSolution = (key) =>
  studyStore.solutions.find((entry) => entry.id === key || entry.clientId === key) || null;

const setSolutionSync = (solution, syncState) => {
  const index = studyStore.solutions.findIndex((entry) => entry === solution);
  if (index < 0) return solution;
  studyStore.solutions[index] = { ...solution, syncState };
  writeStudyStore();
  return studyStore.solutions[index];
};

const updateSolutionLocal = async (key, patch) => {
  const current = getStoredSolution(key);
  if (!current) return null;
  const next = { ...current, ...patch, syncState: "pending", serverCopy: null };
  upsertStoredSolution(next);

  if (!next.id) {
    /* Created offline and never reached the server: send it now. */
    return createSolutionLocal(next);
  }

  const result = await studyRequest(`/api/study/solutions/${next.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: next.title,
      language: next.language,
      code: next.code,
      explanation: next.explanation,
      timeComplexity: next.timeComplexity,
      spaceComplexity: next.spaceComplexity,
      baseRevision: next.revision || 0
    })
  });

  if (result.ok && result.payload?.solution) {
    return upsertStoredSolution({ ...result.payload.solution, syncState: "synced", serverCopy: null });
  }
  if (result.status === 409) {
    upsertStoredSolution({ ...next, syncState: "conflict", serverCopy: result.payload?.solution || null });
    return getStoredSolution(key);
  }
  upsertStoredSolution({ ...next, syncState: "local" });
  return getStoredSolution(key);
};

const deleteSolutionLocal = async (key) => {
  const current = getStoredSolution(key);
  if (!current) return;
  studyStore.solutions = studyStore.solutions.filter((entry) => entry !== current);
  writeStudyStore();
  if (current.id) await studyRequest(`/api/study/solutions/${current.id}`, { method: "DELETE" });
};

/* ------------------------------- rendering ------------------------------ */

const studySetValue = (id, value) => {
  const node = byId(id);
  if (!node) return;
  if (document.activeElement !== node) node.value = value ?? "";
};

const renderStudyNote = async (slug) => {
  const note = slug ? await loadNoteFor(slug) : emptyNote("");
  studySetValue("study-note-title", note.title);
  studySetValue("study-note-approach", note.approach);
  studySetValue("study-note-observations", note.observations);
  studySetValue("study-note-edge", note.edgeCases);
  studySetValue("study-note-time", note.timeComplexity);
  studySetValue("study-note-space", note.spaceComplexity);
  studySetValue("study-note-tags", (note.tags || []).join(", "));

  const status = byId("study-note-status");
  if (status) {
    status.textContent = SYNC_LABELS[note.syncState] || SYNC_LABELS.local;
    status.className = `study-badge study-badge--${note.syncState}`;
  }

  const conflict = byId("study-note-conflict");
  if (conflict) {
    const hasConflict = note.syncState === "conflict" && note.serverCopy;
    conflict.hidden = !hasConflict;
    if (hasConflict) {
      conflict.innerHTML = "";
      const text = document.createElement("p");
      text.textContent = "This note also changed on another device. Nothing was overwritten.";
      const mine = document.createElement("button");
      mine.type = "button";
      mine.className = "prog-btn";
      mine.textContent = "Keep my version";
      mine.addEventListener("click", async () => {
        await forceSaveNoteFor(slug);
        await renderStudyNote(slug);
        showLabToast("Your note was saved over the other copy");
      });
      const theirs = document.createElement("button");
      theirs.type = "button";
      theirs.className = "prog-btn";
      theirs.textContent = "Use the other device's version";
      theirs.addEventListener("click", async () => {
        if (!note.serverCopy) return;
        setStoredNote(slug, { ...note.serverCopy, syncState: "synced", serverCopy: null });
        await renderStudyNote(slug);
        showLabToast("Loaded the other device's note");
      });
      conflict.append(text, mine, theirs);
    }
  }
  return note;
};

const collectNoteFromForm = (slug) => {
  const current = getStoredNote(slug);
  return setStoredNote(slug, {
    title: byId("study-note-title")?.value || "",
    approach: byId("study-note-approach")?.value || "",
    observations: byId("study-note-observations")?.value || "",
    edgeCases: byId("study-note-edge")?.value || "",
    timeComplexity: byId("study-note-time")?.value || "",
    spaceComplexity: byId("study-note-space")?.value || "",
    tags: (byId("study-note-tags")?.value || "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean),
    /* The rich-text sections belong to the problem, so they travel with the
       note and end up on the other device too. */
    sections: getActiveLcProblem()?.notes || current.sections || undefined,
    syncState: "local"
  });
};

const solutionSyncBadge = (solution) => {
  const badge = document.createElement("span");
  badge.className = `study-badge study-badge--${solution.syncState}`;
  badge.textContent = SYNC_LABELS[solution.syncState] || SYNC_LABELS.local;
  return badge;
};

const renderSolutionList = async (slug) => {
  const list = byId("solution-list");
  const empty = byId("solution-empty");
  if (!list) return;
  const items = slug ? await listSolutionsFor(slug) : [];
  list.innerHTML = "";
  if (empty) empty.hidden = items.length > 0;

  /* The comparison is drawn from the same `items` this list renders, so it can
     never describe a different set of solutions than the one on screen. */
  await renderSolutionComparison(slug, items);

  items.forEach((solution) => {
    const card = document.createElement("article");
    card.className = "solution-card";

    const head = document.createElement("div");
    head.className = "solution-card__head";

    const title = document.createElement("strong");
    title.className = "solution-card__title";
    title.textContent = solution.title || "Solution";

    const language = document.createElement("span");
    language.className = "solution-card__lang";
    language.textContent = (getLanguageDef(solution.language) || {}).label || solution.language;

    head.append(title, language, solutionSyncBadge(solution));

    const meta = document.createElement("p");
    meta.className = "solution-card__meta";
    const parts = [];
    if (solution.timeComplexity) parts.push(`time ${solution.timeComplexity}`);
    if (solution.spaceComplexity) parts.push(`space ${solution.spaceComplexity}`);
    if (solution.updatedAt) {
      parts.push(`updated ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(new Date(solution.updatedAt))}`);
    }
    meta.textContent = parts.join(" · ");

    const preview = document.createElement("pre");
    preview.className = "solution-card__code";
    preview.textContent = (solution.code || "").slice(0, 600);

    const actions = document.createElement("div");
    actions.className = "solution-card__actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "prog-btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openSolutionForm(solution));

    const load = document.createElement("button");
    load.type = "button";
    load.className = "prog-btn";
    load.textContent = "Open in editor";
    load.title = "Copies this solution into the editor for this language";
    load.addEventListener("click", async () => {
      if (!window.confirm("Replace what is open in the editor with this saved solution?")) return;
      if (qlActiveLanguage !== solution.language) qlActiveLanguage = normalizeLanguage(solution.language);
      await ensureQlEditor();
      const problem = getActiveLcProblem();
      if (problem) setProblemCode(problem, qlActiveLanguage, solution.code || "");
      if (qlEditor) qlEditor.setValue(solution.code || "");
      selectQlTab("code");
      renderLcDetail();
      showLabToast("Loaded into the editor");
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "prog-btn prog-btn--danger";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      if (!window.confirm(`Delete the saved solution "${solution.title}"? This cannot be undone.`)) return;
      await deleteSolutionLocal(solution.id || solution.clientId);
      await renderSolutionList(slug);
      showLabToast("Saved solution deleted");
    });

    actions.append(edit, load, remove);
    card.append(head, meta, preview, actions);

    if (solution.syncState === "conflict" && solution.serverCopy) {
      const banner = document.createElement("div");
      banner.className = "study-conflict";
      const text = document.createElement("p");
      text.textContent = "This solution also changed on another device. Nothing was overwritten.";
      const mine = document.createElement("button");
      mine.type = "button";
      mine.className = "prog-btn";
      mine.textContent = "Keep my version";
      mine.addEventListener("click", async () => {
        await updateSolutionLocal(solution.id || solution.clientId, {
          title: solution.title,
          language: solution.language,
          code: solution.code,
          explanation: solution.explanation,
          timeComplexity: solution.timeComplexity,
          spaceComplexity: solution.spaceComplexity
        });
        await renderSolutionList(slug);
      });
      const theirs = document.createElement("button");
      theirs.type = "button";
      theirs.className = "prog-btn";
      theirs.textContent = "Use the other device's version";
      theirs.addEventListener("click", async () => {
        upsertStoredSolution({ ...solution.serverCopy, syncState: "synced", serverCopy: null });
        await renderSolutionList(slug);
      });
      banner.append(text, mine, theirs);
      card.append(banner);
    }

    list.append(card);
  });
};

/* ----------------------------- form handling ---------------------------- */

let solutionFormKey = null;

const openSolutionForm = (solution) => {
  const form = byId("solution-form");
  if (!form) return;
  solutionFormKey = solution ? solution.id || solution.clientId : null;
  byId("solution-form-title").textContent = solution ? "Edit saved solution" : "New saved solution";
  byId("solution-title").value = solution?.title || "";
  byId("solution-language").value = normalizeLanguage(solution?.language || qlActiveLanguage);
  byId("solution-time").value = solution?.timeComplexity || "";
  byId("solution-space").value = solution?.spaceComplexity || "";
  byId("solution-explanation").value = solution?.explanation || "";
  byId("solution-code").value = solution?.code || "";
  const conflict = byId("solution-conflict");
  if (conflict) conflict.hidden = true;
  form.hidden = false;
  form.scrollIntoView({ block: "nearest", behavior: "smooth" });
};

const closeSolutionForm = () => {
  const form = byId("solution-form");
  if (form) form.hidden = true;
  solutionFormKey = null;
};

const readSolutionForm = () => ({
  title: byId("solution-title")?.value.trim() || "Solution",
  language: normalizeLanguage(byId("solution-language")?.value || qlActiveLanguage),
  code: byId("solution-code")?.value || "",
  explanation: byId("solution-explanation")?.value || "",
  timeComplexity: byId("solution-time")?.value.trim() || "",
  spaceComplexity: byId("solution-space")?.value.trim() || ""
});

/* Renders both study panels for whichever problem is open. */
const renderStudyPanels = async () => {
  const problem = getActiveLcProblem();
  const slug = studySlug(problem);
  if (!slug) return;
  await renderStudyNote(slug);
  await renderSolutionList(slug);
};

/* ------------------------------- events --------------------------------- */

byId("study-note-save")?.addEventListener("click", async () => {
  const slug = studySlug(getActiveLcProblem());
  if (!slug) {
    showLabToast("Open a problem first.");
    return;
  }
  collectNoteFromForm(slug);
  const note = await saveNoteFor(slug);
  await renderStudyNote(slug);
  showLabToast(
    note.syncState === "synced"
      ? "Note saved and synced"
      : note.syncState === "conflict"
        ? "Saved on this device - see the conflict below"
        : "Note saved on this device"
  );
});

byId("study-note-delete")?.addEventListener("click", async () => {
  const slug = studySlug(getActiveLcProblem());
  if (!slug) return;
  if (!window.confirm("Delete this study note from this device and the server? This cannot be undone.")) return;
  await deleteNoteFor(slug);
  await renderStudyNote(slug);
  showLabToast("Study note deleted");
});

byId("solution-save-current")?.addEventListener("click", async () => {
  const problem = getActiveLcProblem();
  const slug = studySlug(problem);
  if (!slug) {
    showLabToast("Open a problem first.");
    return;
  }
  if (!qlEditor) await ensureQlEditor();
  const code = qlEditor ? qlEditor.getValue() : getProblemCode(problem, qlActiveLanguage);
  if (!code.trim()) {
    showLabToast("The editor is empty - nothing to save.");
    return;
  }
  const existing = solutionsFor(slug).filter((entry) => entry.language === qlActiveLanguage).length;
  openSolutionForm({
    title: `${(getLanguageDef(qlActiveLanguage) || {}).label || qlActiveLanguage} idea ${existing + 1}`,
    language: qlActiveLanguage,
    code
  });
});

byId("solution-save")?.addEventListener("click", async () => {
  const slug = studySlug(getActiveLcProblem());
  if (!slug) return;
  const values = readSolutionForm();
  if (!values.code.trim()) {
    showLabToast("A solution needs some code.");
    return;
  }
  const saved = solutionFormKey
    ? await updateSolutionLocal(solutionFormKey, values)
    : await createSolutionLocal({ ...values, slug });
  closeSolutionForm();
  await renderSolutionList(slug);
  showLabToast(
    saved?.syncState === "synced"
      ? "Solution saved and synced"
      : saved?.syncState === "conflict"
        ? "Saved on this device - resolve the conflict below"
        : "Solution saved on this device"
  );
});

byId("solution-cancel")?.addEventListener("click", () => {
  if (byId("solution-code")?.value.trim()) {
    if (!window.confirm("Discard the solution you have not saved?")) return;
  }
  closeSolutionForm();
});

/* Warn before a reload or a tab close throws away typing that was never saved. */
const studyHasUnsavedTyping = () => {
  const codeField = byId("solution-code");
  if (codeField && !byId("solution-form")?.hidden && codeField.value.trim()) return true;
  const noteDirty = studySlug(getActiveLcProblem());
  if (!noteDirty) return false;
  const note = getStoredNote(noteDirty);
  const form = {
    title: byId("study-note-title")?.value || "",
    approach: byId("study-note-approach")?.value || "",
    observations: byId("study-note-observations")?.value || "",
    edgeCases: byId("study-note-edge")?.value || "",
    timeComplexity: byId("study-note-time")?.value || "",
    spaceComplexity: byId("study-note-space")?.value || ""
  };
  return (
    form.title !== (note.title || "") ||
    form.approach !== (note.approach || "") ||
    form.observations !== (note.observations || "") ||
    form.edgeCases !== (note.edgeCases || "") ||
    form.timeComplexity !== (note.timeComplexity || "") ||
    form.spaceComplexity !== (note.spaceComplexity || "")
  );
};

window.addEventListener("beforeunload", (event) => {
  if (!studyHasUnsavedTyping()) return;
  event.preventDefault();
  event.returnValue = "";
});

/* Used by the Android wrapper: the hardware Back button asks first, so typing
   that was never saved is not thrown away silently. In a browser this is a
   no-op and Back behaves as it always has. */
window.quantaHasUnsavedWork = () => studyHasUnsavedTyping();

window.quantaHandleBack = () => {
  if (!studyHasUnsavedTyping()) return false;
  const codeField = byId("solution-code");
  if (codeField && !byId("solution-form")?.hidden && codeField.value.trim()) {
    if (!window.confirm("Discard the solution you have not saved?")) return true;
    closeSolutionForm();
    return true;
  }
  const slug = studySlug(getActiveLcProblem());
  if (slug) {
    collectNoteFromForm(slug);
    void saveNoteFor(slug).then(() => {
      showLabToast("Note saved before leaving");
      renderStudyNote(slug);
    });
    return true;
  }
  return true;
};

/* Changing problem or language must not leave another problem's fields behind. */
const refreshStudyForActiveProblem = () => {
  void renderStudyPanels();
};

  /* ================== smart DSA revision system (client) ================== */
  /* Shows when each problem should be revisited next and lets the user say how
     it went, which moves it along the ladder.
  
     The scheduling rule itself lives in db/revision.js (nextSchedule) and is
     unit-tested there; this file only sends the user's answer and renders the
     result, so the phone and the browser behave identically.
  
     Honesty rules kept on purpose:
       - "Again / Difficult / Good / Easy" describe how the review felt. Nothing
         here claims a solution was accepted: this app cannot judge correctness.
       - "Reviewed today" counts reviews actually recorded today, not items whose
         due date is today.
       - Offline, the list is served from the device copy and clearly labelled,
         and the actions are disabled rather than silently dropped. */
  
  const REVISION_CACHE_KEY = "quantaRevisionCacheV1";
  
  const REVISION_CONFIDENCE = ["again", "difficult", "good", "easy"];
  const CONFIDENCE_LABELS = { again: "Again", difficult: "Difficult", good: "Good", easy: "Easy" };
  
  const revisionView = {
    items: [],
    counts: null,
    today: "",
    loaded: false,
    loading: false,
    fromCache: false
  };
  
  const revisionTzOffset = () => -new Date().getTimezoneOffset();
  
  const revisionRequest = async (path, options = {}) => {
    const hasTimeout = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function";
    const response = await fetch(`${getApiBase()}${path}`, {
      cache: "no-store",
      ...options,
      signal: hasTimeout ? AbortSignal.timeout(15000) : undefined
    });
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    return { status: response.status, ok: response.ok, payload };
  };
  
  const revisionJson = (method, body) => ({
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...body, tzOffsetMinutes: revisionTzOffset() })
  });
  
  const readRevisionCache = () => {
    const cached = readJson(REVISION_CACHE_KEY, () => null);
    if (!cached || !Array.isArray(cached.items)) return null;
    return cached;
  };
  
  const writeRevisionCache = (payload) => {
    try {
      writeJson(REVISION_CACHE_KEY, { items: payload.items, counts: payload.counts, today: payload.today });
    } catch {
      /* quota or private mode - the list still works while the page is open */
    }
  };
  
  /* The day as this device sees it, used when the dashboard has not loaded yet
     (for example straight after a problem was added from Quanta Lab). */
  const revisionLocalToday = () => {
    const now = new Date(Date.now() + revisionTzOffset() * 60000);
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-${String(now.getUTCDate()).padStart(2, "0")}`;
  };

  /* Human wording for the next review, relative to the user's today. The day is
     compared as text: both sides are YYYY-MM-DD, so ordering is correct and no
     Date object can shift it into the wrong day. */
  const revisionDueLabel = (item) => {
    if (item.status === "completed") return "Finished";
    const today = revisionView.today || revisionLocalToday();
    if (!item.dueDate) return "";
    if (item.dueDate < today) return "Overdue";
    if (item.dueDate === today) return "Due today";
    const diff = Math.round((new Date(`${item.dueDate}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000);
    if (diff === 1) return "Tomorrow";
    if (diff > 30) return `On ${revisionFormatDate(item.dueDate)}`;
    return `In ${diff} days`;
  };
  
  const revisionFormatDate = (dayKey) => {
    if (!dayKey) return "";
    try {
      return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", timeZone: "UTC" }).format(
        new Date(`${dayKey}T00:00:00Z`)
      );
    } catch {
      return dayKey;
    }
  };
  
  const revisionSlugOf = (problem) => {
    const info = extractLcProblemInfo(problem?.url || "");
    return info ? info.slug : "";
  };
  
  /* ------------------------------ rendering ------------------------------- */
  
  const revisionSetText = (id, value) => {
    const node = byId(id);
    if (node) node.textContent = String(value);
  };
  
  const revisionVisibleItems = () => {
    const when = byId("revision-filter-when")?.value || "all";
    const status = byId("revision-filter-status")?.value || "all";
    const difficulty = byId("revision-filter-difficulty")?.value || "all";

    return revisionView.items.filter((item) => {
      if (status !== "all" && item.status !== status) return false;
      if (difficulty !== "all" && item.difficulty !== difficulty) return false;
      if (when === "all") return true;
      /* The due-date filters only ever speak about problems that are still on
         the schedule - a finished one is not "due" in any sense. */
      if (item.status !== "active") return false;
      if (when === "due") return item.bucket === "today" || item.bucket === "overdue";
      return item.bucket === when;
    });
  };
  
  const renderRevisionList = () => {
    const list = byId("revision-list");
    if (!list) return;
    list.innerHTML = "";
    const items = revisionVisibleItems();
  
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "progress-note";
      empty.textContent = revisionView.items.length
        ? "Nothing matches this filter."
        : "Nothing in this view yet.";
      list.append(empty);
      return;
    }
  
    items.forEach((item) => {
      const card = document.createElement("article");
      card.className = `revision-card revision-card--${item.bucket}`;
      card.dataset.slug = item.slug;
  
      const head = document.createElement("div");
      head.className = "revision-card__head";
      const difficulty = document.createElement("span");
      difficulty.className = "revision-card__diff";
      difficulty.textContent = item.difficulty;
      const title = document.createElement("strong");
      title.className = "revision-card__title";
      title.textContent = `${item.num ? `#${item.num} ` : ""}${item.title || item.slug}`;
      const due = document.createElement("span");
      due.className = "study-badge";
      due.textContent = revisionDueLabel(item);
      head.append(difficulty, title, due);
  
      const meta = document.createElement("p");
      meta.className = "revision-card__meta";
      const parts = [];
      /* Title, number, difficulty and the next date are always shown; the topic
         appears only when the catalog actually has one for this problem. */
      if (item.topic) {
      /* Never present the user's own note tags as if they came from the
         catalog - they are shown as what they are. */
      parts.push(item.topicSource === "notes" ? `your tag: ${item.noteTags.slice(0, 2).join(", ")}` : item.topic);
    }
      parts.push(`next review ${revisionFormatDate(item.dueDate)}`);
      if (item.reviewCount > 0) parts.push(`${item.reviewCount} review${item.reviewCount === 1 ? "" : "s"}`);
      if (item.confidence) parts.push(`last: ${CONFIDENCE_LABELS[item.confidence] || item.confidence}`);
      if (item.stage > 0) parts.push(`step ${item.stage}`);
      meta.textContent = parts.join(" · ");
  
      card.append(head, meta);
  
      if (item.status !== "completed") {
        const ratings = document.createElement("div");
        ratings.className = "revision-card__ratings";
        REVISION_CONFIDENCE.forEach((confidence) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `rev-rating rev-rating--${confidence}`;
          button.textContent = CONFIDENCE_LABELS[confidence];
          button.title = {
            again: "I could not solve or remember this",
            difficult: "I needed significant help",
            good: "I solved it with some effort",
            easy: "I can solve it confidently"
          }[confidence];
          button.disabled = revisionView.fromCache;
          button.addEventListener("click", () => void reviewRevisionItem(item.slug, confidence));
          ratings.append(button);
        });
        card.append(ratings);
  
        const actions = document.createElement("div");
        actions.className = "revision-card__actions";
  
        const snooze = document.createElement("button");
        snooze.type = "button";
        snooze.className = "prog-btn";
        snooze.textContent = "Snooze 3 days";
        snooze.disabled = revisionView.fromCache;
        snooze.addEventListener("click", () => void rescheduleRevisionItem(item.slug, { snoozeDays: 3 }));
        actions.append(snooze);
  
        const date = document.createElement("input");
        date.type = "date";
        date.className = "revision-card__date";
        date.value = item.dueDate || "";
        date.setAttribute("aria-label", `Next review date for ${item.title || item.slug}`);
        date.addEventListener("change", () => {
          if (!date.value) return;
          void rescheduleRevisionItem(item.slug, { dueDate: date.value });
        });
        actions.append(date);
  
        const finish = document.createElement("button");
        finish.type = "button";
        finish.className = "prog-btn";
        finish.textContent = "Finished it";
        finish.disabled = revisionView.fromCache;
        finish.addEventListener("click", () => void completeRevisionItem(item.slug));
        actions.append(finish);
  
        card.append(actions);
      }
  
      const footer = document.createElement("div");
      footer.className = "revision-card__actions";
  
      const open = document.createElement("button");
      open.type = "button";
      open.className = "prog-btn";
      open.textContent = "Open problem";
      open.addEventListener("click", () => openRevisionProblem(item.slug));
      footer.append(open);
  
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "prog-btn prog-btn--danger";
      remove.textContent = item.status === "completed" ? "Remove" : "Stop revising";
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Remove "${item.title || item.slug}" from your revision list? Your past reviews are kept.`)) return;
        await removeRevisionItem(item.slug);
      });
      footer.append(remove);
      card.append(footer);
  
      list.append(card);
    });
  };
  
  const renderRevisionSummary = () => {
    const counts = revisionView.counts;
    if (!counts) return;
    revisionSetText("rev-due-today", counts.dueToday);
    revisionSetText("rev-overdue", counts.overdue);
    revisionSetText("rev-reviewed", counts.reviewedToday);
    revisionSetText("rev-progress", `${counts.progressPercent}%`);
    const fill = byId("rev-progress-fill");
    if (fill) fill.style.width = `${counts.progressPercent}%`;
  };
  
  /* One plain sentence about the day, so the tiles are never the only story. */
  const revisionStatusText = (counts) => {
    if (!counts) return "";
    const scheduled = Math.max(0, (counts.upcoming || 0) + (counts.completed || 0));
    const dueBits = [];
    if (counts.overdue) dueBits.push(`${counts.overdue} overdue`);
    if (counts.dueToday) dueBits.push(`${counts.dueToday} due today`);
    if (!dueBits.length) {
      return scheduled
        ? `Nothing due today · ${counts.upcoming} still scheduled`
        : "Nothing scheduled yet - add a problem to start revising.";
    }
    const tail = counts.upcoming ? ` · ${counts.upcoming} coming up` : "";
    return `${dueBits.join(" · ")}${tail}`;
  };
  
  /* ------------------------------ actions --------------------------------- */
  
  const applyRevisionPayload = (payload, { fromCache = false } = {}) => {
    revisionView.items = Array.isArray(payload.items) ? payload.items : [];
    revisionView.counts = payload.counts || null;
    revisionView.today = payload.today || "";
    revisionView.fromCache = fromCache;
    revisionView.loaded = true;
    if (!fromCache) writeRevisionCache(payload);
  };
  
  const loadRevisionDashboard = async () => {
    if (revisionView.loading) return;
    revisionView.loading = true;
  
    const statusNode = byId("revision-status");
    const errorNode = byId("revision-error");
    const contentNode = byId("revision-content");
    const emptyNode = byId("revision-empty");
    const refresh = byId("revision-refresh");
    if (refresh) refresh.disabled = true;
  
    if (!revisionView.loaded && statusNode) statusNode.textContent = "Loading your revision list...";
    if (!revisionView.loaded && contentNode) contentNode.hidden = true;
  
    try {
      const result = await revisionRequest(`/api/revision?tzOffset=${revisionTzOffset()}`);
      if (!result.ok) throw new Error(result.payload?.error || `Request failed (${result.status}).`);
      applyRevisionPayload(result.payload);
      renderRevisionSummary();
      renderRevisionList();
      if (contentNode) contentNode.hidden = false;
      if (emptyNode) emptyNode.hidden = revisionView.items.length > 0;
      if (errorNode) errorNode.hidden = true;
      const offline = byId("revision-offline");
      if (offline) offline.hidden = true;
      if (statusNode) {
        statusNode.textContent = revisionStatusText(revisionView.counts || {});
      }
      maybeNotifyRevision();
    } catch (error) {
      const cached = readRevisionCache();
      if (cached) {
        /* Offline is not a failure: show the device copy and say so plainly. */
        applyRevisionPayload(cached, { fromCache: true });
        renderRevisionSummary();
        renderRevisionList();
        if (contentNode) contentNode.hidden = false;
        if (emptyNode) emptyNode.hidden = revisionView.items.length > 0;
        const offline = byId("revision-offline");
        if (offline) offline.hidden = false;
        if (statusNode) statusNode.textContent = "Showing the copy saved on this device.";
      } else {
        const errorText = byId("revision-error-text");
        if (errorText) errorText.textContent = error?.message || "Your revision list could not be loaded.";
        if (errorNode) errorNode.hidden = false;
        if (statusNode) statusNode.textContent = "Revision is unavailable right now.";
        if (!revisionView.loaded && contentNode) contentNode.hidden = true;
      }
    } finally {
      revisionView.loading = false;
      if (refresh) refresh.disabled = false;
    }
  };
  
  const reviewRevisionItem = async (slug, confidence) => {
    if (revisionView.fromCache) {
      showLabToast("Reconnect to change a review - changes are not sent offline.");
      return;
    }
    const result = await revisionRequest(`/api/revision/${encodeURIComponent(slug)}/review`, revisionJson("POST", { confidence }));
    if (!result.ok) {
      showLabToast(result.payload?.error || "Could not save that review.");
      return;
    }
    await loadRevisionDashboard();
    const next = result.payload?.item?.dueDate;
    showLabToast(next ? `Next review on ${revisionFormatDate(next)}` : "Review saved");
  };
  
  const rescheduleRevisionItem = async (slug, patch) => {
    if (revisionView.fromCache) {
      showLabToast("Reconnect to change a date - changes are not sent offline.");
      return;
    }
    const result = await revisionRequest(`/api/revision/${encodeURIComponent(slug)}/reschedule`, revisionJson("POST", patch));
    if (!result.ok) {
      showLabToast(result.payload?.error || "Could not change that date.");
      return;
    }
    await loadRevisionDashboard();
    showLabToast(`Next review on ${revisionFormatDate(result.payload?.item?.dueDate)}`);
  };
  
  const completeRevisionItem = async (slug) => {
    if (revisionView.fromCache) {
      showLabToast("Reconnect to finish a problem - changes are not sent offline.");
      return;
    }
    const result = await revisionRequest(`/api/revision/${encodeURIComponent(slug)}/complete`, revisionJson("POST", {}));
    if (!result.ok) {
      showLabToast(result.payload?.error || "Could not finish this problem.");
      return;
    }
    await loadRevisionDashboard();
    showLabToast(
      result.payload?.alreadyCompleted
        ? "Already finished - the original date was kept."
        : "Finished - it left your revision list."
    );
  };
  
  const removeRevisionItem = async (slug) => {
    if (revisionView.fromCache) {
      showLabToast("Reconnect to remove a problem - changes are not sent offline.");
      return;
    }
    const result = await revisionRequest(`/api/revision/${encodeURIComponent(slug)}`, { method: "DELETE" });
    if (!result.ok) {
      showLabToast(result.payload?.error || "Could not remove this problem.");
      return;
    }
    await loadRevisionDashboard();
    showLabToast("Removed from your revision list");
  };
  
  /* Opens the problem in Quanta Lab so notes, code and Run stay one tap away. */
  const openRevisionProblem = (slug) => {
    const problem = lcState.problems.find((entry) => revisionSlugOf(entry) === slug);
    if (!problem) {
      showLabToast("That problem is not in your Quanta Lab list.");
      return;
    }
    lcState.activeProblemId = problem.id;
    persistLcState();
    showPage("quantalab");
    renderLcAll();
  };
  
  /* Adds the problem that is open in the detail pane. */
  const addActiveProblemToRevision = async () => {
    const problem = getActiveLcProblem();
    const slug = revisionSlugOf(problem);
    if (!slug) {
      showLabToast("Open a problem first.");
      return;
    }
    const info = extractLcProblemInfo(problem.url);
    const result = await revisionRequest(
      "/api/revision",
      revisionJson("POST", {
        slug,
        num: info?.num ?? problem.num ?? null,
        title: problem.name || "",
        difficulty: problem.difficulty || "Medium"
      })
    );
    if (!result.ok) {
      showLabToast(result.payload?.error || "Could not add this problem.");
      return;
    }

    /* Keep the button honest straight away - the detail pane is not re-rendered,
       so nothing the user typed in the notes or the editor is disturbed. */
    const added = result.payload?.item;
    if (added) {
      const index = revisionView.items.findIndex((entry) => entry.slug === added.slug);
      if (index >= 0) revisionView.items[index] = added;
      else revisionView.items.push(added);
      revisionView.loaded = true;
      refreshRevisionButton(problem);
    }
    showLabToast(
      added?.dueDate
        ? `Added - first review on ${revisionFormatDate(added.dueDate)}`
        : "Added to your revision list"
    );
    /* Refresh the tiles in the background; the list is already correct. */
    void loadRevisionDashboard();
  };
  
  /* Keeps the "Revise" button in the problem detail honest: it shows whether this
     problem is already scheduled, and how soon. */
  /* Sets a .lc-star-btn's visible label without touching the rest of its
     contents. Writing `button.textContent = "..."` replaces everything inside
     the button, which was harmless while it held only text and silently deletes
     the icon the moment the label changes. */
  const setStarBtnLabel = (button, label) => {
    if (!button) return;
    const span = button.querySelector(".lc-star-btn__label");
    if (span) span.textContent = label;
    else button.textContent = label;
  };

  const refreshRevisionButton = async (problem) => {
    const button = byId("lc-detail-revision");
    if (!button) return;
    const slug = revisionSlugOf(problem);
    if (!slug) {
      button.hidden = true;
      return;
    }
    button.hidden = false;
  
    if (!revisionView.loaded) {
      setStarBtnLabel(button, "Revise");
      button.setAttribute("aria-pressed", "false");
      return;
    }
    const item = revisionView.items.find((entry) => entry.slug === slug);
    if (!item) {
      setStarBtnLabel(button, "Revise");
      button.setAttribute("aria-pressed", "false");
      button.title = "Add to revision";
      return;
    }
    const when = item.status === "completed" ? "finished" : revisionDueLabel(item).toLowerCase();
    setStarBtnLabel(button, item.status === "completed" ? "Revised" : when);
    button.setAttribute("aria-pressed", "true");
    button.title = `Next review ${revisionFormatDate(item.dueDate)}`;
  };
  
  /* ---------------------------- optional reminder ------------------------- */
  /* What exists in this app today: no push service, no background worker and no
     server-side scheduler. The only reminder that can honestly be offered is a
     local one: when the app is open and something is due, ask this device to show
     a single notification, at most once a day.
  
     Nothing is switched on silently. Permission is requested only when the user
     turns the setting on, and if the device or the browser refuses, the setting
     stays off and says why. No external notification service is introduced. */
  
  const REVISION_REMINDER_KEY = "quantaRevisionReminderV1";
  const REVISION_REMINDER_DAY_KEY = "quantaRevisionReminderDayV1";
  
  /* readJson only returns objects, so the small flags below are stored as
     { on: true } / { day: "2026-10-11" } rather than as bare values. */
  const removeRevisionStorageKey = (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* privacy mode - the reminder simply stays as it was */
    }
  };
  
  const revisionNotificationsSupported = () =>
    typeof window !== "undefined" && "Notification" in window && typeof window.Notification === "function";
  
  const revisionReminderEnabled = () => readJson(REVISION_REMINDER_KEY, () => ({})).on === true;
  
  const setRevisionReminderState = (enabled) => {
    if (enabled) writeJson(REVISION_REMINDER_KEY, { on: true });
    else removeRevisionStorageKey(REVISION_REMINDER_KEY);
  };
  
  const revisionReminderHint = (text) => {
    const hint = byId("settings-reminder-hint");
    if (hint) hint.textContent = text;
  };
  
  /* Asks for permission only when the user switches the reminder on. Returns
     true when reminders really are active. */
  const enableRevisionReminder = async () => {
    if (!revisionNotificationsSupported()) {
      revisionReminderHint("This device cannot show notifications, so nothing was turned on. The revision list still works.");
      return false;
    }
    let permission = window.Notification.permission;
    if (permission === "default") {
      try {
        permission = await window.Notification.requestPermission();
      } catch {
        permission = "denied";
      }
    }
    if (permission !== "granted") {
      revisionReminderHint("Permission was not granted, so no reminder is set. You can allow notifications later in the browser or device settings.");
      return false;
    }
    setRevisionReminderState(true);
    revisionReminderHint("On. You will get one reminder when you open the app with problems due.");
    return true;
  };
  
  const disableRevisionReminder = () => {
    setRevisionReminderState(false);
    revisionReminderHint("Ask this device for permission once, then a single reminder when you open the app with problems due. Off by default.");
  };
  
  /* Called after each successful dashboard load. At most one notification per
     calendar day, and only when something is genuinely due. */
  const maybeNotifyRevision = () => {
    if (!revisionReminderEnabled() || revisionView.fromCache || !revisionView.counts) return;
    if (!revisionNotificationsSupported() || window.Notification.permission !== "granted") return;
    const counts = revisionView.counts;
    const due = (counts.overdue || 0) + (counts.dueToday || 0);
    if (!due) return;
  
    const today = revisionView.today || "";
    if (readJson(REVISION_REMINDER_DAY_KEY, () => ({})).day === today) return;
    try {
      new window.Notification("Time to revise", {
        body: due === 1 ? "1 problem is due today." : `${due} problems are due today or waiting.`,
        tag: "quanta-revision-daily"
      });
      writeJson(REVISION_REMINDER_DAY_KEY, { day: today });
    } catch {
      /* A device that refuses to show one is not a reason to fail the page. */
    }
  };
  
  const initRevisionReminderSettings = () => {
    const toggle = byId("settings-revision-reminder");
    if (toggle) {
      toggle.checked = revisionReminderEnabled();
      revisionReminderHint(
        revisionReminderEnabled()
          ? "On. You will get one reminder when you open the app with problems due."
          : "Ask this device for permission once, then a single reminder when you open the app with problems due. Off by default."
      );
      toggle.addEventListener("change", async (event) => {
        const wanted = event.target.checked;
        const active = wanted ? await enableRevisionReminder() : (disableRevisionReminder(), false);
        event.target.checked = active;
        showLabToast(
          active
            ? "Reminder on - one a day, while the app is open"
            : wanted
              ? "Notifications are not available here"
              : "Reminder off"
        );
      });
    }
  
    byId("settings-revision-open")?.addEventListener("click", () => {
      showPage("revision");
    });
  };
  
  /* ------------------------------- events -------------------------------- */
  
  byId("revision-refresh")?.addEventListener("click", () => {
    void loadRevisionDashboard();
  });
  
  byId("revision-error-retry")?.addEventListener("click", () => {
    void loadRevisionDashboard();
  });
  
  byId("revision-filter-when")?.addEventListener("change", renderRevisionList);
  byId("revision-filter-status")?.addEventListener("change", renderRevisionList);
  byId("revision-filter-difficulty")?.addEventListener("change", renderRevisionList);
  
  byId("lc-detail-revision")?.addEventListener("click", () => {
    const problem = getActiveLcProblem();
    const slug = revisionSlugOf(problem);
    const existing = revisionView.items.find((entry) => entry.slug === slug);
    if (existing) {
      showPage("revision");
      void loadRevisionDashboard();
      return;
    }
    void addActiveProblemToRevision();
  });
  
  /* When the device comes back, quietly refresh so an offline list catches up. */
  window.addEventListener("online", () => {
    if (revisionView.fromCache) void loadRevisionDashboard();
  });
  
  /* ================= connection and data-source diagnostics ==================
     What this section is for
     ------------------------
     The app can show a problem statement while the internet is down, and it can
     show one straight from the database while other things fail. Saying "online"
     or "offline" without saying which, is what makes the app confusing.

     So every line here is checked against the thing it claims to describe, and
     the three facts that used to be mixed together are reported separately:

       internet  - does this device think it has a network
       api       - did the hosted API answer a real request
       database  - did the API's own health check find the database

     An API that answers while its database is down is reported as exactly that:
     API connected, database unhealthy.

     Rules this file keeps to
     -----------------------
     - Nothing is ever shown as connected because something else worked.
     - A Wi-Fi icon is not proof of an internet connection, so the device's own
       answer is shown as a hint and the API check is what decides the rest.
     - No address, host name, user or password is written into the panel.
     - No status is reported as successful unless a request actually succeeded.
     - There is no polling loop: one check at start-up, one when the network
       changes, one when the panel is opened, and one on demand. */

  const DIAG_STATE_KEY = "quantaDiagnosticsV1";
  const DIAG_API_TIMEOUT_MS = 8000;
  const DIAG_RUNNER_TIMEOUT_MS = 6000;

  const diagState = {
    checking: false,
    lastCheckAt: 0,
    lastApiOkAt: 0,
    lastDatabaseOkAt: 0,
    lastStatementOkAt: 0,
    runToken: 0
  };

  /* Only ever stores timestamps and the place a service lives as "hosted" or
     "local network" - never the address itself. */
  const readDiagHistory = () => {
    const stored = readJson(DIAG_STATE_KEY, () => ({}));
    return {
      lastApiOkAt: Number(stored.lastApiOkAt) || 0,
      lastDatabaseOkAt: Number(stored.lastDatabaseOkAt) || 0,
      lastStatementOkAt: Number(stored.lastStatementOkAt) || 0
    };
  };

  const writeDiagHistory = (patch) => {
    try {
      localStorage.setItem(DIAG_STATE_KEY, JSON.stringify({ ...readDiagHistory(), ...patch }));
    } catch {
      /* private mode - the panel still shows this session's results */
    }
  };

  /* Statements arriving from the network are the truest proof that the API works,
     so they update the "last successful connection" time. Called from the
     statement loader, which runs long before this section exists. */
  noteStatementServed = (fromNetwork) => {
    if (!fromNetwork) return;
    diagState.lastStatementOkAt = Date.now();
    diagState.lastApiOkAt = diagState.lastStatementOkAt;
    writeDiagHistory({ lastApiOkAt: diagState.lastApiOkAt, lastStatementOkAt: diagState.lastStatementOkAt });
  };

  const diagTimeout = (ms) =>
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;

  /* A service is only ever called "local network" or "hosted" - the address
     itself stays out of the panel. */
  const diagServiceKind = (base) => {
    const value = String(base || "");
    if (!value) return "same server as this page";
    try {
      const url = new URL(value, window.location.href);
      const host = url.hostname;
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") return "this computer";
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || host.endsWith(".local")) return "a local network address";
      return "a hosted service";
    } catch {
      return "a configured address";
    }
  };

  const DIAG_STATES = {
    ok: { label: "Connected", dot: "ok" },
    local: { label: "On this device", dot: "ok" },
    checking: { label: "Checking", dot: "checking" },
    bad: { label: "Unavailable", dot: "bad" },
    warn: { label: "Degraded", dot: "warn" },
    unset: { label: "Not configured", dot: "muted" },
    unknown: { label: "Unknown", dot: "muted" }
  };

  const setDiagRow = (key, stateKey, detail) => {
    const row = byId("diag-panel")?.querySelector(`[data-diag="${key}"]`);
    if (!row) return;
    const state = DIAG_STATES[stateKey] || DIAG_STATES.unknown;
    const stateNode = row.querySelector("[data-diag-state]");
    const detailNode = row.querySelector("[data-diag-detail]");
    if (stateNode) {
      stateNode.textContent = state.label;
      stateNode.dataset.state = stateKey;
    }
    row.querySelector("[data-diag-dot]")?.setAttribute("data-dot", state.dot);
    row.dataset.state = stateKey;
    if (detailNode) detailNode.textContent = detail;
  };

  const setDiagFact = (name, value) => {
    const node = document.querySelector(`[data-diag-fact="${name}"]`);
    if (node) node.textContent = value;
  };

  /* "3 minutes ago" is friendlier than a timestamp, but the exact time stays
     available in the tooltip so nothing is hidden. */
  const diagAgo = (timestamp) => {
    if (!timestamp) return "Never";
    const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
    if (seconds < 45) return "Just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    const days = Math.round(hours / 24);
    return `${days} day${days === 1 ? "" : "s"} ago`;
  };

  const diagExactTime = (timestamp) => {
    if (!timestamp) return "";
    try {
      return new Date(timestamp).toLocaleString();
    } catch {
      return "";
    }
  };

  const countOfflinePack = async () => {
    const pack = await loadOfflinePack();
    return pack ? Object.keys(pack).length : 0;
  };

  const renderDiagPanel = () => {
    const history = readDiagHistory();
    setDiagFact("lastApiOk", diagAgo(Math.max(history.lastApiOkAt, diagState.lastApiOkAt)));
    const apiNode = document.querySelector('[data-diag-fact="lastApiOk"]');
    if (apiNode) apiNode.title = diagExactTime(Math.max(history.lastApiOkAt, diagState.lastApiOkAt));
    setDiagFact("lastCheck", diagAgo(diagState.lastCheckAt));
    setDiagFact("cached", String(readDescCache().size));
    setDiagFact("pending", "Not supported");
    setDiagFact("bundled", diagState.bundledCount === undefined ? "Unknown" : String(diagState.bundledCount));
  };

  /* One request per service, each with its own timeout, all of them optional:
     a slow service must not hold up the others or the page. */
  const runConnectionDiagnostics = async ({ manual = false } = {}) => {
    if (diagState.checking) return diagState;
    diagState.checking = true;
    const token = (diagState.runToken += 1);
    const stale = () => token !== diagState.runToken;

    const history = readDiagHistory();
    diagState.lastCheckAt = Date.now();
    renderDiagPanel();

    setDiagRow("internet", "checking", "Asking this device…");
    setDiagRow("api", "checking", "Contacting the API…");
    setDiagRow("database", "checking", "Waiting for the API health check…");
    setDiagRow("runner", "checking", "Checking the code runner…");
    setDiagRow("statements", "checking", "Counting what is stored on this device…");
    if (manual) showLabToast("Checking connections…");

    /* --- internet: the device's own answer, labelled as a hint --- */
    const deviceOnline = navigator.onLine !== false;
    setDiagRow(
      "internet",
      deviceOnline ? "ok" : "bad",
      deviceOnline ? "This device reports a network connection" : "This device reports no network"
    );

    /* --- the API, and the database as the API itself sees it --- */
    const apiBase = getApiBase();
    const apiStartedAt = performance.now();
    try {
      const response = await fetch(`${apiBase}/health`, { cache: "no-store", signal: diagTimeout(DIAG_API_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const payload = await response.json();
      if (payload?.ok !== true) throw new Error("unhealthy response");
      if (stale()) return diagState;

      /* Only this request's own duration, so a slow service is never blamed on
         something else that happened during the same check. */
      const apiMs = Math.round(performance.now() - apiStartedAt);
      diagState.lastApiOkAt = Date.now();
      writeDiagHistory({ lastApiOkAt: diagState.lastApiOkAt });
      setDiagRow("api", "ok", `${diagServiceKind(apiBase)} · answered in ${apiMs}ms`);

      /* The API answered but that says nothing about its database. The health
         payload carries the database's own check, and the two are reported
         separately so a broken database is never hidden behind a reachable API. */
      const db = payload.database;
      if (!db || db.configured === false) {
        setDiagRow("database", "unset", "The API is not configured with a database");
      } else if (db.ok === true) {
        diagState.lastDatabaseOkAt = Date.now();
        writeDiagHistory({ lastDatabaseOkAt: diagState.lastDatabaseOkAt });
        setDiagRow("database", "ok", typeof db.latencyMs === "number" ? `Answered in ${db.latencyMs}ms` : "Answered");
      } else {
        setDiagRow("database", "bad", "The API could not reach its database — statements and progress will not load");
      }
    } catch {
      if (stale()) return diagState;
      /* No address is shown here on purpose: a failed request to a private
         address should not put that address on screen. */
      setDiagRow("api", deviceOnline ? "bad" : "bad", deviceOnline ? "The API did not answer" : "No answer, and this device reports no network");
      /* The database cannot be judged when the API never answered. Saying
         "unhealthy" here would be a guess. */
      setDiagRow("database", "unknown", "Not checked — the API did not answer");
    }

    /* --- the code runner, only when one is configured --- */
    const runBase = getRunServerBase();
    try {
      const response = await fetch(`${runBase}/api/run/capabilities`, { cache: "no-store", signal: diagTimeout(DIAG_RUNNER_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const caps = await response.json();
      if (stale()) return diagState;
      const usable = Object.entries(caps || {})
        .filter(([, value]) => value && value !== false && value !== "unavailable")
        .map(([key]) => key);
      const languages = usable.length ? usable.join(", ") : "no languages reported";
      setDiagRow("runner", usable.length ? "ok" : "warn", `${diagServiceKind(runBase)} · ${languages}`);
    } catch {
      if (stale()) return diagState;
      /* JavaScript runs in the browser without any server, so say what still
         works rather than reporting a blanket failure. */
      setDiagRow("runner", "warn", "The compiler server did not answer — JavaScript still runs in this browser");
    }

    /* --- what is stored on this device --- */
    try {
      const cached = readDescCache().size;
      const bundled = await countOfflinePack();
      if (stale()) return diagState;
      diagState.bundledCount = bundled;
      const node = byId("diag-panel")?.querySelector('[data-diag="statements"]');
      const statementSource = byId("ql-desc-sync")?.dataset.source;
      setDiagRow(
        "statements",
        "local",
        `${cached} saved here${bundled ? `, ${bundled} bundled with the app` : ""}${
          statementSource ? ` · the open statement is currently ${statementSource === "online" ? "online" : statementSource === "cached" ? "from this device" : "unavailable"}` : ""
        }`
      );
    } catch {
      if (stale()) return diagState;
      setDiagRow("statements", "unknown", "Could not read what is stored on this device");
    }

    diagState.checking = false;
    renderDiagPanel();
    if (manual) showLabToast("Connection check finished");
    return diagState;
  };

  /* Runs once at start-up and whenever the network changes, never on a timer. */
  const initConnectionDiagnostics = () => {
    byId("diag-check")?.addEventListener("click", () => {
      void runConnectionDiagnostics({ manual: true });
    });

    byId("diag-retry-statement")?.addEventListener("click", () => {
      const problem = getActiveLcProblem();
      const slug = slugKey(problem?.url || "");
      const node = byId("diag-note");
      if (!slug) {
        if (node) node.textContent = "Open a problem first — there is no statement to retry.";
        showLabToast("Open a problem first");
        return;
      }
      /* Only the statement is dropped, and only for this problem. Notes, saved
         solutions and code are untouched. */
      try {
        const cache = readDescCache();
        if (cache.has(slug)) {
          cache.delete(slug);
          writeDescCache();
        }
        readDescCache;
      } catch {
        /* private mode */
      }
      if (node) node.textContent = "Asking the API for this statement again…";
      void requestDescription(slug).then((result) => {
        if (result && result.html) {
          rememberDescription(slug, result.html, result.source);
          /* Saying "fetched again" when the answer actually came from the
             bundled copy would be a claim the user cannot check. */
          const fromBundle = result.source === "offline-pack";
          if (node) {
            node.textContent = fromBundle
              ? "The API could not provide it just now - showing the copy bundled with the app."
              : "The statement was fetched from the API again.";
          }
          showLabToast(fromBundle ? "Showing the bundled copy" : "Statement fetched from the API");
        } else {
          if (node) node.textContent = "The API could not provide that statement, and no copy is stored on this device.";
          showLabToast("Still not available");
        }
        void runConnectionDiagnostics();
      });
    });

    byId("diag-clear-cache")?.addEventListener("click", () => {
      /* The confirmation says exactly what is lost and what is not, because
         losing someone's notes would be unacceptable. */
      const confirmed = window.confirm(
        "Clear the statements saved on this device?\n\n" +
          "This only removes cached problem statements (about 1 MB). " +
          "Your notes, saved solutions, stars and code are NOT touched, and statements are fetched again as you open problems.\n\n" +
          "Continue?"
      );
      const node = byId("diag-note");
      if (!confirmed) {
        if (node) node.textContent = "Nothing was cleared.";
        return;
      }
      try {
        localStorage.removeItem(DESC_CACHE_KEY);
        descCache = new Map();
      } catch {
        if (node) node.textContent = "This browser will not let the app clear its storage.";
        showLabToast("Could not clear the cache");
        return;
      }
      if (node) node.textContent = "Cached statements cleared. Notes and solutions were not touched.";
      showLabToast("Cached statements cleared");
      void runConnectionDiagnostics();
    });

    /* Network changes are the moment a status is most likely to be wrong. */
    window.addEventListener("online", () => {
      void runConnectionDiagnostics();
    });
    window.addEventListener("offline", () => {
      setDiagRow("internet", "bad", "This device reports no network");
      /* A network that just went away does not prove the services are broken,
         so the other rows are left as they were, marked stale. */
      setDiagRow("api", "unknown", "Not re-checked since the network went away");
      setDiagRow("database", "unknown", "Not re-checked since the network went away");
      renderDiagPanel();
    });

    /* Render what is known immediately, then check for real in the background
       so opening Settings is never blocked by a network round trip. */
    const history = readDiagHistory();
    diagState.lastCheckAt = 0;
    renderDiagPanel();
    void countOfflinePack()
      .then((bundled) => {
        diagState.bundledCount = bundled;
        renderDiagPanel();
      })
      .catch(() => {});
    void runConnectionDiagnostics();
    return history;
  };

  /* --------------------- algorithm visualizer page --------------------- */
  /* Registered from visualizer.js, which holds the engines and is tested by
     scripts/test-visualizer.js. This half is only the player: it turns the
     engine's frame list into something you can step through. */

  /* ====================== algorithm visualizer UI =========================
     The player for visualizer.js.

     Everything on screen is derived from one value: `viz.index`, an index into
     the frame list the engine produced. Playing is just incrementing it, stepping
     is setting it, and the scrubber is an <input type="range"> bound to it. There
     is no separate "animating" code path that could disagree with what stepping
     shows, which is what keeps the narration and the drawing honest.

     What this file deliberately does not do: guess. If an algorithm produces no
     frames, the stage says so. If an input is invalid, the field says what is
     wrong rather than silently falling back to the default. */

  const VIZ_KEY = "quantaVisualizerV1";

  const vizState = {
    group: "sort",
    algorithm: "bubble",
    frames: [],
    index: 0,
    playing: false,
    timer: null,
    speed: 450,
    inputs: {},
    error: ""
  };

  /* Short source listings. These are shown as reference next to the animation;
     they are the same algorithm as the engine, kept deliberately small, and the
     engine is the authority on behaviour (it is what the tests check). */
  const VIZ_CODE = {
    bubble: `for i in 0..n-1:
    swapped = false
    for j in 0..n-1-i-1:
      if a[j] > a[j+1]:
        swap(a[j], a[j+1])
        swapped = true
    if not swapped:
      break            # already sorted`,
    selection: `for i in 0..n-1:
    smallest = i
    for j in i+1..n-1:
      if a[j] < a[smallest]:
        smallest = j
    swap(a[i], a[smallest])`,
    insertion: `for i in 1..n-1:
    key = a[i]
    j = i - 1
    while j >= 0 and a[j] > key:
      a[j+1] = a[j]     # shift right
      j -= 1
    a[j+1] = key`,
    merge: `sort(lo, hi):
    if hi - lo <= 1: return
    mid = (lo + hi) / 2
    sort(lo, mid)
    sort(mid, hi)
    merge the two sorted halves`,
    quick: `sort(lo, hi):
    if lo > hi: return
    pivot = a[hi]
    i = lo
    for j in lo..hi-1:
      if a[j] < pivot:
        swap(a[i], a[j])
        i += 1
    swap(a[i], a[hi])     # pivot is now final
    sort(lo, i-1)
    sort(i+1, hi)`,
    heap: `build a max heap over the whole array
  for end in n-1 down to 1:
    swap(a[0], a[end])  # biggest value is final
    sift_down(0, end)`,
    linear: `for i in 0..n-1:
    if a[i] == target:
      return i
  return -1`,
    binary: `lo = 0, hi = n - 1
  while lo <= hi:
    mid = (lo + hi) / 2
    if a[mid] == target: return mid
    if a[mid] < target:  lo = mid + 1
    else:                hi = mid - 1
  return -1`,
    exponential: `bound = 1
  while a[bound] <= target:
    bound *= 2               # find a range that contains it
  binary search inside [bound/2, bound]`,
    lowerBound: `lo = 0, hi = n
  while lo < hi:
    mid = (lo + hi) / 2
    if a[mid] < target: lo = mid + 1
    else:               hi = mid
  return lo               # where the value would be inserted`,
    factorial: `fact(n):
    if n <= 1: return 1
    return n * fact(n - 1)`,
    fibonacci: `fib(n):
    if n < 2: return n
    return fib(n - 1) + fib(n - 2)
  # fib(1) is recomputed many times - this is why it is slow`,
    hanoi: `hanoi(n, from, to, spare):
    if n == 0: return
    hanoi(n - 1, from, spare, to)
    move disc n: from -> to
    hanoi(n - 1, spare, to, from)`,
    gcd: `gcd(a, b):
    if b == 0: return a
    return gcd(b, a mod b)`,
    bstInsert: `insert(node, value):
    if node is empty:
      return new node(value)
    if value < node.value:
      node.left  = insert(node.left,  value)
    else:
      node.right = insert(node.right, value)
    return node`,
    traversals: `pre-order : node, left,  right
  in-order  : left,  node,  right
  post-order: left,  right, node`,
    bfs: `queue = [start]
  while queue is not empty:
    node = queue.pop_front()
    for each neighbour:
      if not seen:
        seen.add(neighbour)
        queue.push_back(neighbour)`,
    dfs: `stack = [start]
  while stack is not empty:
    node = stack.pop()
    if seen: continue
    seen.add(node)
    for each unvisited neighbour:
      stack.push(neighbour)`,
    dijkstra: `dist[start] = 0, everything else unknown
  while unvisited nodes remain:
    settle the unvisited node with the smallest dist
    for each edge from it:
      if dist[here] + weight < dist[there]:
        dist[there] = dist[here] + weight   # relax`,
    slidingWindow: `sum = 0
  for i in 0..n-1:
    sum += a[i]
    if i >= k:
      sum -= a[i - k]    # drop what left the window
    if i >= k - 1:
      record(sum)`,
    twoPointers: `lo = 0, hi = n - 1
  while lo <= hi:
    if a[lo] + a[hi] == target: found
    if a[lo] + a[hi] <  target: lo += 1
    else:                      hi -= 1`,
    prefixSum: `prefix[0] = 0
  for i in 0..n-1:
    prefix[i+1] = prefix[i] + a[i]

  # any range sum is now one subtraction:
  #   sum(a[i..j]) = prefix[j+1] - prefix[i]`,
    kadane: `best = current = a[0]
  for i in 1..n-1:
    if current + a[i] < a[i]:
      current = a[i]        # a negative tail: start again
    else:
      current += a[i]
    best = max(best, current)`,
    dpFibonacci: `fib[0] = 0, fib[1] = 1
  for i in 2..n:
    fib[i] = fib[i-1] + fib[i-2]   # each value computed once`,
    climbStairs: `ways[0] = 1, ways[1] = 1
  for i in 2..n:
    ways[i] = ways[i-1] + ways[i-2]`,
    knapsack: `best[i][c] = best value using items 0..i with capacity c
  best[i][c] = max(
    best[i-1][c],                          # skip item i
    value[i] + best[i-1][c - weight[i]]    # take item i
  )`,
    lcs: `dp[i][j] = longest common subsequence of a[0..i) and b[0..j)
  if a[i-1] == b[j-1]: dp[i][j] = dp[i-1][j-1] + 1
  else:                 dp[i][j] = max(dp[i-1][j], dp[i][j-1])`
  };

  const vizDpCodeKey = {
    fibonacci: "dpFibonacci",
    climbStairs: "climbStairs",
    knapsack: "knapsack",
    lcs: "lcs"
  };

  /* ---------------------------- input parsing ---------------------------- */

  /* Only the shapes the engine can actually draw are accepted. A value like
     "3.5" or "1,2,abc" is reported rather than silently coerced, because a
     visualizer that quietly changes your data teaches the wrong thing. */
  const vizParseList = (raw) => {
    const text = String(raw || "").trim();
    if (!text) return { values: [], error: "Enter some numbers." };
    const parts = text.split(/[\s,]+/).filter(Boolean);
    const values = [];
    for (const part of parts) {
      if (!/^-?\d+$/.test(part)) return { values: [], error: `"${part}" is not a whole number.` };
      values.push(Number(part));
    }
    if (values.length < 2) return { values, error: "Use at least two values." };
    if (values.length > 24) return { values: [], error: "Keep it to 24 values so the bars stay readable." };
    return { values, error: "" };
  };

  /* Accepts a leading minus, because the lists it parses genuinely can contain
     negative numbers. The scalar parser is the one that rejects negatives by
     default; a list and a single value must not disagree about what a number
     looks like. */
  const vizParseInt = (raw, label, { min = 0, max = 99 } = {}) => {
    const text = String(raw || "").trim();
    if (!/^-?\d+$/.test(text)) return { value: null, error: `${label} must be a whole number.` };
    const value = Number(text);
    if (value < min || value > max) return { value: null, error: `${label} must be between ${min} and ${max}.` };
    return { value, error: "" };
  };

  /* ------------------------------ rendering ------------------------------ */

  const vizEl = (id) => document.getElementById(id);

  const vizRenderPicker = () => {
    const host = vizEl("viz-picker");
    if (!host) return;
    host.innerHTML = "";
    for (const [key, group] of Object.entries(window.VISUALIZERS || {})) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `viz-chip${vizState.group === key ? " is-active" : ""}`;
      button.textContent = group.label;
      button.dataset.group = key;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", vizState.group === key ? "true" : "false");
      button.addEventListener("click", () => {
        if (vizState.group === key) return;
        vizState.group = key;
        vizState.algorithm = Object.keys(group.items)[0];
        vizStop();
        vizRenderPicker();
        vizRenderAlgorithms();
        vizRenderInputs();
        vizRun();
      });
      host.appendChild(button);
    }
  };

  const vizRenderAlgorithms = () => {
    const host = vizEl("viz-algorithms");
    if (!host) return;
    host.innerHTML = "";
    const group = (window.VISUALIZERS || {})[vizState.group];
    if (!group) return;
    for (const [key, algo] of Object.entries(group.items)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `viz-alg${vizState.algorithm === key ? " is-active" : ""}`;
      button.dataset.algorithm = key;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", vizState.algorithm === key ? "true" : "false");
      const name = document.createElement("span");
      name.className = "viz-alg__name";
      name.textContent = algo.label;
      const cost = document.createElement("span");
      cost.className = "viz-alg__cost";
      cost.textContent = algo.complexity;
      button.append(name, cost);
      button.addEventListener("click", () => {
        if (vizState.algorithm === key) return;
        vizState.algorithm = key;
        vizStop();
        vizRenderAlgorithms();
        vizRenderInputs();
        vizRun();
      });
      host.appendChild(button);
    }
    const about = vizEl("viz-about");
    const current = group.items[vizState.algorithm];
    if (about && current) about.textContent = current.note;
  };

    /* Inputs are stored per group AND per algorithm.
     A single shared object let the sorting group's array leak into the
     searching group, which then complained that its own default was unsorted -
     an error the user could not see the cause of, and could not fix without
     guessing. Keying by group/algorithm means every algorithm keeps its own
     last-used values, which is also what someone comparing two algorithms
     actually wants. */
  const vizInputKey = () => `${vizState.group}.${vizState.algorithm}`;
  const vizInputs = () => {
    const key = vizInputKey();
    if (!vizState.inputs[key] || typeof vizState.inputs[key] !== "object") vizState.inputs[key] = {};
    return vizState.inputs[key];
  };

  const vizInputField = (id, label, value, hint) => {
    const wrap = document.createElement("label");
    wrap.className = "viz-field";
    const caption = document.createElement("span");
    caption.textContent = label;
    const input = document.createElement("input");
    input.className = "settings-input";
    input.type = "text";
    input.id = id;
    input.value = value;
    input.autocomplete = "off";
    input.spellcheck = false;
    wrap.append(caption, input);
    if (hint) {
      const small = document.createElement("small");
      small.textContent = hint;
      wrap.appendChild(small);
    }
    return { wrap, input };
  };

  const vizRenderInputs = () => {
    const host = vizEl("viz-inputs");
    if (!host) return;
    host.innerHTML = "";
    const example = (window.VIZ_EXAMPLES || {})[vizState.group] || {};
    const algo = vizState.algorithm;
    const state = vizInputs();

    /* Each field writes its value back into the stored state before the run is
       rebuilt. Without that the state kept its old value, so typing "3,
       banana, 7" into the array box re-ran the previous array and the invalid
       input was never reported - the run looked like it had worked. */
    const addField = (field, storeKey) => {
      const apply = () => {
        if (storeKey) vizInputs()[storeKey] = field.input.value;
        vizRun();
      };
      field.input.addEventListener("change", apply);
      field.input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          apply();
        }
      });
      host.appendChild(field.wrap);
      return field.input;
    };

    const shuffle = vizEl("viz-shuffle");

    if (vizState.group === "sort") {
      if (state.array === undefined) state.array = (example.array || [5, 2, 9, 1, 5, 6, 3]).join(", ");
      addField(vizInputField("viz-in-array", "Values", state.array, "Whole numbers, separated by commas."), "array");
      if (shuffle) shuffle.hidden = false;
    } else if (vizState.group === "search") {
      if (state.array === undefined) state.array = (example.array || []).join(", ");
      if (state.target === undefined) state.target = String(example.target ?? 11);
      addField(vizInputField("viz-in-array", "Sorted values", state.array, "Searching needs a sorted array."), "array");
      addField(vizInputField("viz-in-target", "Looking for", state.target), "target");
      if (shuffle) shuffle.hidden = false;
    } else if (vizState.group === "recursion") {
      if (algo === "gcd") {
        if (state.a === undefined) state.a = String(example.gcdA ?? 48);
        if (state.b === undefined) state.b = String(example.gcdB ?? 18);
        addField(vizInputField("viz-in-a", "First number", state.a), "a");
        addField(vizInputField("viz-in-b", "Second number", state.b), "b");
      } else {
        const label = algo === "factorial" ? "n" : algo === "fibonacci" ? "n (max 12)" : "discs (max 5)";
        const fallback = algo === "factorial" ? example.factorial ?? 5 : algo === "fibonacci" ? example.fibonacci ?? 8 : example.hanoi ?? 3;
        if (state.n === undefined) state.n = String(fallback);
        addField(vizInputField("viz-in-n", label, state.n), "n");
      }
      if (shuffle) shuffle.hidden = true;
    } else if (vizState.group === "tree") {
      if (state.values === undefined) state.values = (example.values || [50, 30, 70, 20, 40, 60, 80]).join(", ");
      addField(vizInputField("viz-in-values", "Values to insert", state.values, "Inserted in this order, in a binary search tree."), "values");
      if (shuffle) shuffle.hidden = false;
    } else if (vizState.group === "graph") {
      if (state.note === undefined) state.note = "";
      const caption = document.createElement("p");
      caption.className = "viz-note viz-note--plain";
      caption.textContent =
        "This one uses a fixed graph so the paths stay readable: 0 → 1 (4), 0 → 2 (1), 2 → 1 (2), 1 → 3 (1), 2 → 3 (5), 3 → 4 (3). The number on each edge is its weight.";
      host.appendChild(caption);
      if (shuffle) shuffle.hidden = true;
    } else if (vizState.group === "pattern") {
      if (algo === "slidingWindow") {
        if (state.array === undefined) state.array = (example.array || []).join(", ");
        if (state.k === undefined) state.k = String(example.k ?? 3);
        addField(vizInputField("viz-in-array", "Values", state.array), "array");
        addField(vizInputField("viz-in-k", "Window size", state.k), "k");
      } else if (algo === "twoPointers") {
        if (state.array === undefined) state.array = (example.sorted || []).join(", ");
        if (state.target === undefined) state.target = String(example.target ?? 9);
        addField(vizInputField("viz-in-array", "Sorted values", state.array), "array");
        addField(vizInputField("viz-in-target", "Looking for", state.target), "target");
      } else {
        if (state.array === undefined) state.array = (example.array || [2, 1, 5, 1, 3, 2, 8, 1]).join(", ");
        addField(vizInputField("viz-in-array", "Values", state.array), "array");
      }
      if (shuffle) shuffle.hidden = algo !== "slidingWindow" && algo !== "prefixSum" && algo !== "kadane";
    } else if (vizState.group === "dp") {
      if (algo === "knapsack") {
        const items = example.items || [];
        const caption = document.createElement("p");
        caption.className = "viz-note viz-note--plain";
        caption.textContent = `Fixed items so the table stays small: ${items
          .map((item) => `weight ${item.weight} / value ${item.value}`)
          .join(", ")}.`;
        host.appendChild(caption);
        if (state.capacity === undefined) state.capacity = String(example.capacity ?? 8);
        addField(vizInputField("viz-in-capacity", "Bag capacity (max 12)", state.capacity), "capacity");
      } else if (algo === "lcs") {
        const caption = document.createElement("p");
        caption.className = "viz-note viz-note--plain";
        caption.textContent = `Fixed strings so the table stays readable: "${example.strA}" and "${example.strB}".`;
        host.appendChild(caption);
      } else {
        const fallback = example.n ?? 8;
        if (state.n === undefined) state.n = String(fallback);
        addField(vizInputField("viz-in-n", "n (max 20)", state.n), "n");
      }
      if (shuffle) shuffle.hidden = true;
    }
  };

  /* Builds the frame list for the current selection, or reports why it cannot. */
  const vizBuild = () => {
    const V = window;
    const algo = (V.VISUALIZERS?.[vizState.group]?.items || {})[vizState.algorithm];
    if (!algo) return { error: "That algorithm is not available." };
    const example = (V.VIZ_EXAMPLES || {})[vizState.group] || {};
    const state = vizInputs();
    /* Reads the array field the current algorithm actually uses. The tree
       group names its field "values" while the others name it "array";
       reading one fixed name meant the tree group always saw an empty field
       and reported "Enter some numbers" while a perfectly good list sat in
       the box. */
    const readArray = () => vizParseList(vizState.group === "tree" ? state.values : state.array);

    try {
      if (vizState.group === "sort") {
        const { values, error } = readArray();
        if (error) return { error };
        return algo.run(values);
      }
      if (vizState.group === "search") {
        const { values, error } = readArray();
        if (error) return { error };
        const sortedCopy = values.slice().sort((a, b) => a - b);
        if (values.some((v, i) => v !== sortedCopy[i])) {
          return { error: "Searching needs the values in ascending order." };
        }
        /* Widened to accept negatives, matching what the array itself accepts.
           vizParseInt's default is 0..99 and its test rejects a minus sign, so a
           reader who typed "-5" into the values was then told "The value must be
           a whole number" about a field they had not touched. The sibling
           two-pointers group already allows -9999..9999 for the same reason. */
        const target = vizParseInt(state.target, "The value", { min: -999999, max: 999999 });
        if (target.error) return { error: target.error };
        return algo.run(values, target.value);
      }
      if (vizState.group === "recursion") {
        if (vizState.algorithm === "gcd") {
          const a = vizParseInt(state.a, "The first number", { min: 0, max: 99999 });
          const b = vizParseInt(state.b, "The second number", { min: 0, max: 99999 });
          if (a.error) return { error: a.error };
          if (b.error) return { error: b.error };
          if (a.value === 0 && b.value === 0) return { error: "Both numbers cannot be zero." };
          return algo.build(a.value, b.value);
        }
        const cap = vizState.algorithm === "hanoi" ? 5 : vizState.algorithm === "fibonacci" ? 12 : 12;
        const parsed = vizParseInt(state.n, "That value", { min: 0, max: cap });
        if (parsed.error) return { error: parsed.error };
        return algo.build(parsed.value);
      }
      if (vizState.group === "tree") {
        const { values, error } = readArray();
        if (error) return { error };
        if (values.length > 15) return { error: "Keep it to 15 values so the tree stays readable." };
        if (algo === "traversals" && values.length < 2) return { error: "A traversal needs at least two values." };
        return algo.run(values);
      }
      if (vizState.group === "graph") {
        return algo.run(example.edges || []);
      }
      if (vizState.group === "pattern") {
        if (vizState.algorithm === "slidingWindow") {
          const { values, error } = readArray();
          if (error) return { error };
          const k = vizParseInt(state.k, "The window size", { min: 1, max: values.length });
          if (k.error) return { error: k.error };
          return algo.run(values, k.value);
        }
        if (vizState.algorithm === "twoPointers") {
          const { values, error } = readArray();
          if (error) return { error };
          const sortedCopy = values.slice().sort((a, b) => a - b);
          if (values.some((v, i) => v !== sortedCopy[i])) {
            return { error: "Two pointers needs the values in ascending order." };
          }
          const target = vizParseInt(state.target, "The value", { min: -9999, max: 9999 });
          if (target.error) return { error: target.error };
          return algo.run(values, target.value);
        }
        const { values, error } = readArray();
        if (error) return { error };
        return algo.run(values);
      }
      if (vizState.group === "dp") {
        if (vizState.algorithm === "knapsack") {
          const items = example.items || [];
          const capacity = vizParseInt(state.capacity, "The capacity", { min: 0, max: 12 });
          if (capacity.error) return { error: capacity.error };
          return algo.run(items.map((i) => i.weight), items.map((i) => i.value), capacity.value);
        }
        if (vizState.algorithm === "lcs") {
          return algo.run(example.strA || "ABCBDAB", example.strB || "BDCABA");
        }
        const parsed = vizParseInt(state.n, "That value", { min: 0, max: 20 });
        if (parsed.error) return { error: parsed.error };
        return algo.run(parsed.value);
      }
      return { error: "That algorithm is not available." };
    } catch (error) {
      /* An algorithm that throws is a bug in the engine, not the user's input.
         It is reported as such rather than being shown as bad input. */
      return { error: `The visualizer hit an error while preparing this run: ${error?.message || error}` };
    }
  };

  const vizRun = () => {
    const built = vizBuild();
    const note = vizEl("viz-note");
    if (built.error) {
      vizState.frames = [];
      vizState.index = 0;
      vizState.error = built.error;
      if (note) {
        note.textContent = built.error;
        note.classList.add("viz-note--error");
      }
      const canvas = vizEl("viz-canvas");
      if (canvas) canvas.innerHTML = "";
      vizSyncControls();
      return;
    }
    vizState.error = "";
    vizState.frames = built.frames || [];
    vizState.index = 0;
    if (note) {
      note.classList.remove("viz-note--error");
    }
    vizPersist();
    vizSyncControls();
    vizRenderFrame();
  };

  const vizPersist = () => {
    writeJson(VIZ_KEY, {
      group: vizState.group,
      algorithm: vizState.algorithm,
      speed: vizState.speed,
      inputs: vizState.inputs
    });
  };

  /* ------------------------------- drawing ------------------------------- */

  const vizBars = (host, frame, { highlight = [] } = {}) => {
    const values = frame.array || [];
    if (!values.length) return;
    const max = Math.max(...values.map((v) => Math.abs(v)), 1);
    const row = document.createElement("div");
    row.className = "viz-bars";

    values.forEach((value, index) => {
      const cell = document.createElement("div");
      cell.className = "viz-bar-cell";
      const bar = document.createElement("div");
      bar.className = "viz-bar";
      const height = Math.max(6, Math.round((Math.abs(value) / max) * 100));
      bar.style.height = `${height}%`;
      if (highlight.includes(index)) bar.classList.add("is-active");
      if (typeof frame.sorted === "number" && index >= values.length - frame.sorted) bar.classList.add("is-done");
      if (Array.isArray(frame.range) && index >= frame.range[0] && index <= frame.range[1]) bar.classList.add("is-window");
      if (frame.found === index) bar.classList.add("is-found");
      const label = document.createElement("span");
      label.className = "viz-bar__label";
      label.textContent = String(value);
      cell.append(bar, label);
      row.appendChild(cell);
    });

    host.appendChild(row);

    /* The index rail, so it is obvious *which* bars the step refers to. */
    const rail = document.createElement("div");
    rail.className = "viz-indexes";
    values.forEach((_, index) => {
      const tick = document.createElement("span");
      tick.className = "viz-index";
      tick.textContent = String(index);
      if (highlight.includes(index)) tick.classList.add("is-active");
      rail.appendChild(tick);
    });
    host.appendChild(rail);
  };

  const vizStack = (host, frame) => {
    const calls = frame.calls || [];
    if (!calls.length) return;
    const box = document.createElement("div");
    box.className = "viz-stack";
    const maxDepth = Math.max(...calls.map((c) => c.depth));
    const latest = calls.length - 1;

    calls.forEach((call, i) => {
      const row = document.createElement("div");
      row.className = `viz-stack__row is-${call.state}`;
      if (i === latest) row.classList.add("is-current");
      const indent = document.createElement("span");
      indent.className = "viz-stack__indent";
      indent.textContent = "│ ".repeat(call.depth);
      const label = document.createElement("span");
      label.className = "viz-stack__label";
      label.textContent = call.label;
      row.append(indent, label);
      box.appendChild(row);
    });
    host.appendChild(box);
    void maxDepth;
  };

  const vizTree = (host, frame) => {
    const root = frame.nodes;
    /* The first frame of an insert has no tree yet. Saying so beats drawing an
       empty box, because "nothing here" is exactly what is true at that step. */
    if (!root) {
      const empty = document.createElement("p");
      empty.className = "viz-note--plain";
      empty.textContent = "The tree is empty so far — this step is about deciding where the first value goes.";
      host.appendChild(empty);
      return;
    }
    const layout = window.layoutTree(root);
    if (!layout.nodes.length) return;

    const box = document.createElement("div");
    box.className = "viz-tree";
    const depthCount = Math.max(...layout.nodes.map((n) => n.depth)) + 1;

    layout.nodes.forEach((node) => {
      const el = document.createElement("div");
      el.className = "viz-node";
      if (frame.highlight === node.id) el.classList.add("is-active");
      el.textContent = String(node.value);
      el.style.left = `${node.x * 100}%`;
      el.style.top = `${(node.depth / Math.max(1, depthCount)) * 100}%`;
      box.appendChild(el);
    });

    const edgeLayer = document.createElement("svg");
    /* `className` is a read-only accessor on SVGElement, so assigning it throws
       and aborts the whole render. setAttribute is the only correct way. */
    edgeLayer.setAttribute("class", "viz-tree__edges");
    edgeLayer.setAttribute("viewBox", "0 0 100 100");
    edgeLayer.setAttribute("preserveAspectRatio", "none");
    const byId = new Map(layout.nodes.map((n) => [n.id, n]));
    for (const [fromId, toId] of layout.edges) {
      const from = byId.get(fromId);
      const to = byId.get(toId);
      if (!from || !to) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      const y = (d) => ((d + 0.5) / Math.max(1, depthCount)) * 100;
      line.setAttribute("x1", String(from.x * 100));
      line.setAttribute("y1", String(y(from.depth)));
      line.setAttribute("x2", String(to.x * 100));
      line.setAttribute("y2", String(y(to.depth)));
      edgeLayer.appendChild(line);
    }
    box.appendChild(edgeLayer);
    box.style.setProperty("--viz-depth", String(depthCount));
    host.appendChild(box);
  };

  const vizGraph = (host, frame) => {
    const nodes = frame.nodes || [];
    if (!nodes.length) return;
    const edges = frame.edges || [];
    const box = document.createElement("div");
    box.className = "viz-graph";

    const edgeLayer = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    edgeLayer.setAttribute("class", "viz-graph__edges");
    edgeLayer.setAttribute("viewBox", "0 0 100 100");
    edgeLayer.setAttribute("preserveAspectRatio", "none");

    const radius = 34;
    const angleFor = (index, total) => (Math.PI * 2 * index) / total - Math.PI / 2;
    const posFor = (node) => {
      const index = nodes.indexOf(node);
      return { x: 50 + Math.cos(angleFor(index, nodes.length)) * radius, y: 50 + Math.sin(angleFor(index, nodes.length)) * radius };
    };

    for (const [from, to, weight] of edges) {
      const a = posFor(from);
      const b = posFor(to);
      if (!a || !b) continue;
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(a.x));
      line.setAttribute("y1", String(a.y));
      line.setAttribute("x2", String(b.x));
      line.setAttribute("y2", String(b.y));
      const active =
        (Array.isArray(frame.visited) && frame.visited.includes(from) && frame.visited.includes(to)) ||
        frame.current === from;
      if (active) line.classList.add("is-active");
      edgeLayer.appendChild(line);

      const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
      text.setAttribute("x", String((a.x + b.x) / 2));
      text.setAttribute("y", String((a.y + b.y) / 2 - 1));
      text.setAttribute("text-anchor", "middle");
      /* className is read-only on an SVGElement, so it must be set as an
         attribute. Assigning `.className` throws and kills the whole render. */
      text.setAttribute("class", "viz-graph__weight");
      text.textContent = String(weight === undefined ? 1 : weight);
      edgeLayer.appendChild(text);
    }
    box.appendChild(edgeLayer);

    for (const node of nodes) {
      const p = posFor(node);
      const el = document.createElement("div");
      el.className = "viz-node";
      el.textContent = String(node);
      el.style.left = `${p.x}%`;
      el.style.top = `${p.y}%`;
      if (Array.isArray(frame.visited) && frame.visited.includes(node)) el.classList.add("is-done");
      if (frame.current === node) el.classList.add("is-active");
      if (Array.isArray(frame.dist) && frame.dist[node] !== undefined && Number.isFinite(frame.dist[node])) {
        el.dataset.distance = String(frame.dist[node]);
      }
      box.appendChild(el);
    }

    if (Array.isArray(frame.queue) && frame.queue.length) {
      const q = document.createElement("div");
      q.className = "viz-graph__queue";
      q.textContent = `Queue: ${frame.queue.join(" → ")}`;
      box.appendChild(q);
    }
    if (Array.isArray(frame.stack) && frame.stack.length) {
      const q = document.createElement("div");
      q.className = "viz-graph__queue";
      q.textContent = `Stack: ${frame.stack.join(", ")}`;
      box.appendChild(q);
    }
    host.appendChild(box);
  };

  const vizTable = (host, frame) => {
    if (Array.isArray(frame.table)) {
      const list = document.createElement("div");
      list.className = "viz-table viz-table--row";
      for (const cell of frame.table) {
        const el = document.createElement("div");
        el.className = "viz-table__cell";
        if (frame.highlight === cell.index) el.classList.add("is-active");
        const key = document.createElement("span");
        key.className = "viz-table__key";
        key.textContent = String(cell.index);
        const value = document.createElement("span");
        value.className = "viz-table__value";
        value.textContent = String(cell.value);
        el.append(key, value);
        list.appendChild(el);
      }
      host.appendChild(list);
      return;
    }
    if (!Array.isArray(frame.table2d)) return;

    const table = document.createElement("div");
    table.className = "viz-table viz-table--grid";
    const header = frame.headers || null;
    const rows = frame.rowLabels || null;
    const size = frame.table2d.length;
    const cols = frame.table2d[0]?.length || 0;

    if (header) {
      const head = document.createElement("div");
      head.className = "viz-table__row viz-table__row--head";
      head.appendChild(Object.assign(document.createElement("div"), { className: "viz-table__cell viz-table__cell--head", textContent: "" }));
      for (const label of header.slice(0, cols)) {
        const cell = document.createElement("div");
        cell.className = "viz-table__cell viz-table__cell--head";
        cell.textContent = String(label);
        head.appendChild(cell);
      }
      table.appendChild(head);
    }

    for (let r = 0; r < size; r += 1) {
      const row = document.createElement("div");
      row.className = "viz-table__row";
      if (rows) {
        const label = document.createElement("div");
        label.className = "viz-table__cell viz-table__cell--head";
        label.textContent = String(rows[r] ?? "");
        row.appendChild(label);
      }
      for (let c = 0; c < cols; c += 1) {
        const cell = document.createElement("div");
        cell.className = "viz-table__cell";
        if (frame.highlight && frame.highlight.row === r && frame.highlight.col === c) cell.classList.add("is-active");
        cell.textContent = String(frame.table2d[r][c]);
        row.appendChild(cell);
      }
      table.appendChild(row);
    }
    host.appendChild(table);
  };

  const vizRenderFrame = () => {
    const canvas = vizEl("viz-canvas");
    const note = vizEl("viz-note");
    if (!canvas) return;
    canvas.innerHTML = "";

    const frame = vizState.frames[vizState.index];
    if (!frame) {
      if (!vizState.error && note) note.textContent = "Press Run it to build the steps.";
      return;
    }

    if (note) {
      note.classList.remove("viz-note--error");
      /* Replaced, not appended to. Appending left every previous frame's text
         on screen, so the note grew into a wall of text mixing several steps
         together - the worst possible outcome for a feature whose whole job is
         to explain one step at a time. */
      note.textContent = "";
      const title = document.createElement("strong");
      title.className = "viz-note__title";
      title.textContent = frame.title;
      note.append(title, document.createTextNode(` ${frame.note || ""}`));
    }

    /* Which renderer a frame uses is decided by the shape of the frame, and
       the order matters. Graph frames carry `nodes` as an ARRAY of node ids
       while tree frames carry `nodes` as a TREE OBJECT, and an earlier version
       tested `if (frame.nodes)` for the tree - which is truthy for the array
       too, so every graph was drawn as a tree and the graph renderer below it
       was unreachable. The type is now checked explicitly. */
    if (Array.isArray(frame.array)) vizBars(canvas, frame, { highlight: frame.pointers || [] });
    else if (Array.isArray(frame.calls)) vizStack(canvas, frame);
    /* Tree frames carry `nodes` as a tree OBJECT, graph frames as an ARRAY of
       ids. The test is on the object, not on truthiness: the very first frame
       of an insert starts with an empty tree, so `nodes` is null there, and a
       truthiness check sent that frame to the graph branch and drew nothing at
       all - the page looked broken until you pressed next. */
    else if (frame.nodes && typeof frame.nodes === "object" && !Array.isArray(frame.nodes)) vizTree(canvas, frame);
    else if (Array.isArray(frame.nodes)) vizGraph(canvas, frame);
    else if (frame.table || frame.table2d) vizTable(canvas, frame);

    const code = vizEl("viz-code");
    if (code) {
      const key = vizDpCodeKey[vizState.algorithm] || vizState.algorithm;
      code.textContent = VIZ_CODE[key] || "The code for this algorithm is not listed.";
    }

    vizSyncControls();
  };

  /* ------------------------------- playback ------------------------------ */

  const vizSyncControls = () => {
    const total = vizState.frames.length;
    const scrub = vizEl("viz-scrub");
    if (scrub) {
      scrub.max = String(Math.max(0, total - 1));
      /* Only written when it disagrees with the state. Writing it on every
         render fought the user's drag: the browser moved the thumb, the render
         put it straight back, and dragging appeared to do nothing at all. */
      if (Number(scrub.value) !== vizState.index) scrub.value = String(vizState.index);
      scrub.disabled = total === 0;
    }
    const step = vizEl("viz-step");
    if (step) step.textContent = total ? `Step ${vizState.index + 1}` : "No steps";
    const totalEl = vizEl("viz-total");
    if (totalEl) totalEl.textContent = total ? `of ${total}` : "";
    const play = vizEl("viz-play");
    if (play) {
      play.setAttribute("aria-label", vizState.playing ? "Pause" : "Play");
      play.title = vizState.playing ? "Pause" : "Play";
      const icons = play.querySelectorAll("svg");
      icons.forEach((icon) => {
        const isPlay = icon.dataset.icon === "play";
        icon.hidden = isPlay === vizState.playing;
      });
    }
    for (const id of ["viz-first", "viz-prev", "viz-next", "viz-last"]) {
      const node = vizEl(id);
      if (node) node.disabled = total === 0;
    }
  };

  const vizGoTo = (index) => {
    const total = vizState.frames.length;
    if (!total) return;
    const next = Number(index);
    if (!Number.isFinite(next)) return;
    vizState.index = Math.max(0, Math.min(total - 1, next));
    vizRenderFrame();
  };

  const vizStop = () => {
    vizState.playing = false;
    if (vizState.timer) {
      window.clearInterval(vizState.timer);
      vizState.timer = null;
    }
    vizSyncControls();
  };

  const vizPlay = () => {
    const total = vizState.frames.length;
    if (total < 2) return;
    /* Restarting from the end is what people expect from a play button. */
    if (vizState.index >= total - 1) vizState.index = 0;
    vizState.playing = true;
    vizState.timer = window.setInterval(() => {
      if (vizState.index >= vizState.frames.length - 1) {
        vizStop();
        return;
      }
      vizGoTo(vizState.index + 1);
    }, vizState.speed);
    vizSyncControls();
  };

  /* Builds a shuffled but readable example, so the "Different values" button
     actually changes the picture instead of reshuffling the same numbers. */
  const vizShuffle = () => {
    const state = vizInputs();
    const example = (window.VIZ_EXAMPLES || {})[vizState.group] || {};
    const randomArray = (count, min, max) =>
      Array.from({ length: count }, () => min + Math.floor(Math.random() * (max - min + 1)));
    const sortNumbers = (a) => a.slice().sort((x, y) => x - y);

    if (vizState.group === "sort") {
      state.array = randomArray(9, 1, 99).join(", ");
    } else if (vizState.group === "search") {
      const size = 9 + Math.floor(Math.random() * 4);
      const sorted = sortNumbers(Array.from(new Set(randomArray(size, 1, 99))));
      state.array = sorted.join(", ");
      state.target = String(sorted[Math.floor(Math.random() * sorted.length)]);
    } else if (vizState.group === "tree") {
      state.values = randomArray(7 + Math.floor(Math.random() * 4), 10, 99).join(", ");
    } else if (vizState.group === "pattern") {
      if (vizState.algorithm === "twoPointers") {
        const sorted = sortNumbers(Array.from(new Set(randomArray(10, 1, 60))));
        state.array = sorted.join(", ");
        state.target = String(sorted[Math.floor(Math.random() * sorted.length)] + sorted[Math.floor(Math.random() * sorted.length)]);
      } else if (vizState.algorithm === "slidingWindow") {
        state.array = randomArray(10, 1, 20).join(", ");
        state.k = String(2 + Math.floor(Math.random() * 3));
      } else {
        state.array = randomArray(11, -9, 20).join(", ");
      }
    }
    void example;
    vizRenderInputs();
    vizRun();
  };

  /* -------------------------------- wiring ------------------------------- */

  const initVisualizer = () => {
    const stored = readJson(VIZ_KEY, () => ({}));
    if (stored && typeof stored === "object") {
      if (stored.group && window.VISUALIZERS?.[stored.group]) vizState.group = stored.group;
      if (stored.algorithm && window.VISUALIZERS?.[vizState.group]?.items?.[stored.algorithm]) {
        vizState.algorithm = stored.algorithm;
      }
      if (stored.inputs && typeof stored.inputs === "object") vizState.inputs = { ...stored.inputs };
      if ([80, 200, 450, 900].includes(Number(stored.speed))) vizState.speed = Number(stored.speed);
    }

    const speed = vizEl("viz-speed");
    if (speed) {
      speed.value = String(vizState.speed);
      speed.addEventListener("change", () => {
        vizState.speed = Number(speed.value) || 450;
        vizPersist();
        if (vizState.playing) {
          vizStop();
          vizPlay();
        }
      });
    }

    const scrub = vizEl("viz-scrub");
    if (scrub) {
      scrub.addEventListener("input", () => {
        /* The target is read BEFORE stopping playback. vizStop() re-syncs the
           controls, which writes the slider from the current step, so reading
           it afterwards returned the old position and the drag appeared to do
           nothing. */
        const target = Number(scrub.value);
        vizStop();
        vizGoTo(target);
      });
    }

    vizEl("viz-run")?.addEventListener("click", () => {
      vizStop();
      vizRun();
    });
    vizEl("viz-shuffle")?.addEventListener("click", () => {
      vizStop();
      vizShuffle();
    });
    vizEl("viz-first")?.addEventListener("click", () => { vizStop(); vizGoTo(0); });
    vizEl("viz-prev")?.addEventListener("click", () => { vizStop(); vizGoTo(vizState.index - 1); });
    vizEl("viz-next")?.addEventListener("click", () => { vizStop(); vizGoTo(vizState.index + 1); });
    vizEl("viz-last")?.addEventListener("click", () => { vizStop(); vizGoTo(vizState.frames.length - 1); });
    vizEl("viz-play")?.addEventListener("click", () => (vizState.playing ? vizStop() : vizPlay()));

    /* Keyboard stepping, but only while this page is on screen, so the arrow
       keys keep working normally everywhere else in the app. */
    document.addEventListener("keydown", (event) => {
      if (currentPage !== "visualizer") return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" && document.activeElement !== scrub) return;
      if (tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.key === "ArrowRight") { event.preventDefault(); vizStop(); vizGoTo(vizState.index + 1); }
      else if (event.key === "ArrowLeft") { event.preventDefault(); vizStop(); vizGoTo(vizState.index - 1); }
      else if (event.key === " ") { event.preventDefault(); vizState.playing ? vizStop() : vizPlay(); }
    });

    vizRenderPicker();
    vizRenderAlgorithms();
    vizRenderInputs();
    vizRun();

    /* Pause when the page is hidden: a timer that keeps stepping frames nobody
       is looking at is wasted work, and it would jump to a random frame when the
       page came back. */
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) vizStop();
    });
  };


  /* ---------------------- smart problem discovery ----------------------- */
  /* Registered from discovery.js, which holds the recommendation logic and is
     tested by scripts/test-discovery.js. This half renders it and wires each
     suggestion to the existing problem opener and revision schedule. */

  /* ====================== smart discovery UI ===========================
     Renders the recommendations from discovery.js onto a page, and wires them to
     the existing problem opener so a suggestion is one click from becoming work.

     Everything shown comes from the catalog and the user's own history. There is
     no popularity score anywhere on this page, because nothing permitted
     publishes one. */

  const DISCOVERY_KEY = "quantaDiscoveryV1";

  const discoveryState = {
    strategy: "all",
    limit: 12,
    recs: [],
    coverage: []
  };

  const discoveryEl = (id) => document.getElementById(id);

  /* The catalog the recommendations are built from. This reads the same list the
     Lab page renders, so a suggestion always refers to a problem that exists in
     the app rather than to a second, possibly different, copy of the catalog. */
  const discoveryProblems = () => {
    const list = Array.isArray(lcState?.problems) ? lcState.problems : [];
    if (list.length) return list;
    /* Before the Lab has built its list the catalog may not exist yet. Seeding
       here keeps the page usable straight after a reload. */
    return normalizeLcProblems(seedProblems());
  };

  /* Opens a problem in the Lab by slug. Goes through the same path the Revision
     page uses, so a suggestion lands in exactly the same view as every other
     place a problem can be opened from. */
  const discoveryOpenProblem = (slug) => {
    if (!slug) return;
    const problem = (lcState?.problems || []).find((p) => p.slug === slug || revisionSlugOf(p) === slug);
    if (problem) {
      /* selectLcProblem is the same entry point the Lab list rows use, so a
         suggestion opens in exactly the view every other problem opens in. */
      showPage("quantalab");
      selectLcProblem(problem.id);
      return;
    }
    /* Not in the local list (for example a problem added since the page loaded):
       fall back to the slug, which is what the API and revision both key on. */
    openRevisionProblem(slug);
  };

  /* Adds a problem straight to the revision schedule, without opening it first.
     The Revision page only ever added the problem that happened to be open, so
     this is the piece that makes "Add to revision" work from a suggestion. */
  const discoveryAddToRevision = async (problem) => {
    const slug = problem?.slug || revisionSlugOf(problem);
    if (!slug) return { ok: false, message: "That problem has no id yet." };
    const info = extractLcProblemInfo(problem.url);
    const result = await revisionRequest(
      "/api/revision",
      revisionJson("POST", {
        slug,
        num: info?.num ?? problem.num ?? null,
        title: problem.name || problem.title || "",
        difficulty: problem.difficulty || "Medium"
      })
    );
    if (!result.ok) return { ok: false, message: result.payload?.error || "Could not add that problem." };
    return { ok: true };
  };

  /* Problems currently on the revision schedule, so "due" recommendations match
     what the Revision page would show. Read from the cached dashboard rather than
     re-fetching, so opening this page never adds a request. */
  const discoveryDueSlugs = () => {
    const cache = readRevisionCache();
    const slugs = new Set();
    for (const bucket of ["due", "overdue", "upcoming", "completed"]) {
      const items = cache?.items?.[bucket];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (bucket === "completed") continue;
        if (item?.slug) slugs.add(item.slug);
      }
    }
    /* If the cached dashboard has not loaded, the Revision page still knows. */
    return slugs;
  };

  const discoveryRenderFilters = () => {
    const host = discoveryEl("discovery-filters");
    if (!host) return;
    host.innerHTML = "";
    const options = [{ key: "all", label: "Everything" }];
    for (const [key, def] of Object.entries(window.DISCOVERY_STRATEGIES || {})) {
      options.push({ key, label: def.label });
    }
    /* The module can also emit a strategy that has no chip of its own - "explore"
       is one. Without a chip those suggestions are reachable only under
       "Everything" and disappear under every specific filter, with nothing on
       screen to explain why. A chip is added for any strategy actually present
       in the current results, so every kind of suggestion can be selected. */
    for (const key of new Set(discoveryState.recs.map((r) => r.strategy).filter(Boolean))) {
      if (options.some((option) => option.key === key)) continue;
      const fromList = discoveryState.recs.find((r) => r.strategy === key);
      options.push({ key, label: fromList?.strategyLabel || key });
    }
    options.sort((a, b) => (a.key === "all" ? -1 : b.key === "all" ? 1 : a.label.localeCompare(b.label)));

    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `viz-chip${discoveryState.strategy === option.key ? " is-active" : ""}`;
      button.textContent = option.label;
      button.dataset.strategy = option.key;
      button.setAttribute("aria-pressed", discoveryState.strategy === option.key ? "true" : "false");
      button.addEventListener("click", () => {
        discoveryState.strategy = option.key;
        /* Saved here as well as in the "Show more" handler. Choosing a filter
           used to be forgotten on every reload unless the reader happened to
           press a button that did nothing else. */
        writeJson(DISCOVERY_KEY, { strategy: discoveryState.strategy, limit: discoveryState.limit });
        discoveryRenderFilters();
        discoveryRenderList();
      });
      host.appendChild(button);
    }
  };

  const discoveryRenderList = () => {
    const host = discoveryEl("discovery-list");
    const empty = discoveryEl("discovery-empty");
    const count = discoveryEl("discovery-count");
    if (!host) return;
    host.innerHTML = "";

    let recs = discoveryState.recs;
    if (discoveryState.strategy !== "all") {
      recs = recs.filter((r) => r.strategy === discoveryState.strategy);
    }

    if (count) {
      count.textContent = recs.length
        ? `${recs.length} suggestion${recs.length === 1 ? "" : "s"}`
        : "";
    }

    /* The button is hidden rather than left on screen when there is nothing
       more to ask for. */
    const moreBtn = discoveryEl("discovery-more");
    if (moreBtn) moreBtn.hidden = recs.length < discoveryState.limit;

    if (!recs.length) {
      if (empty) {
        empty.hidden = false;
        /* Distinguishes "you have genuinely done everything" from "the module
           that makes suggestions did not load". Both produced an empty list, so
           a broken page used to congratulate the reader on having solved
           everything. */
        empty.textContent = !window.discoveryRecommend
          ? "The suggestions module did not load on this device, so there is nothing to suggest. Everything else in Quanta still works."
          : discoveryState.strategy === "all"
            ? "Nothing to suggest right now — everything unsolved has already been attempted. Solve something new and this will fill up again."
            : "Nothing under this heading. Try another filter.";
      }
      return;
    }
    if (empty) empty.hidden = true;

    const fragment = document.createDocumentFragment();
    for (const rec of recs) {
      const card = document.createElement("article");
      card.className = "discovery-card";
      card.dataset.strategy = rec.strategy;

      const head = document.createElement("div");
      head.className = "discovery-card__head";

      const badge = document.createElement("span");
      badge.className = "discovery-card__badge";
      badge.textContent = rec.strategyLabel;

      const difficulty = document.createElement("span");
      difficulty.className = `discovery-card__difficulty is-${(rec.problem.difficulty || "").toLowerCase()}`;
      difficulty.textContent = rec.problem.difficulty || "Unknown";

      head.append(badge, difficulty);

      const title = document.createElement("h3");
      title.className = "discovery-card__title";
      title.textContent = rec.problem.name || rec.problem.title || rec.problem.slug;

      const meta = document.createElement("div");
      meta.className = "discovery-card__meta";
      const bits = [];
      if (rec.problem.num !== null && rec.problem.num !== undefined && rec.problem.num !== 0) {
        bits.push(`#${rec.problem.num}`);
      }
      if (rec.problem.platform && rec.problem.platform !== "leetcode") {
        bits.push(rec.problem.platform === "codeforces" ? "Codeforces" : rec.problem.platform);
      }
      if (Number.isFinite(rec.problem.rating)) bits.push(`rated ${rec.problem.rating}`);
      if (rec.topic) bits.push(rec.topic);
      meta.textContent = bits.join(" · ");

      const reason = document.createElement("p");
      reason.className = "discovery-card__reason";
      reason.textContent = rec.reason;

      const actions = document.createElement("div");
      actions.className = "discovery-card__actions";
      const open = document.createElement("button");
      open.type = "button";
      open.className = "prog-btn";
      open.textContent = "Open";
      open.addEventListener("click", () => discoveryOpenProblem(rec.problem.slug));
      const add = document.createElement("button");
      add.type = "button";
      add.className = "prog-btn prog-btn--ghost";
      add.textContent = "Add to revision";
      add.addEventListener("click", async () => {
        add.disabled = true;
        add.textContent = "Adding…";
        const result = await discoveryAddToRevision(rec.problem);
        add.textContent = result.ok ? "Added" : result.message || "Could not add";
        if (result.ok) {
          showLabToast("Added to your revision list");
          void loadRevisionDashboard();
        } else {
          showLabToast(result.message || "Could not add that problem");
        }
        add.disabled = false;
      });
      actions.append(open, add);

      card.append(head, title, meta, reason, actions);
      fragment.appendChild(card);
    }
    host.appendChild(fragment);
  };

  const discoveryRenderCoverage = () => {
    const host = discoveryEl("discovery-coverage");
    if (!host) return;
    host.innerHTML = "";
    const entries = discoveryState.coverage;
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "viz-note--plain";
      empty.textContent = "No topic data yet.";
      host.appendChild(empty);
      return;
    }

    const legend = document.createElement("p");
    legend.className = "discovery-legend";
    legend.textContent = "How far into each topic you are. The bar is solved problems as a share of that topic in the catalog.";
    host.appendChild(legend);

    const grid = document.createElement("div");
    grid.className = "discovery-grid";
    for (const entry of entries) {
      const cell = document.createElement("div");
      cell.className = `discovery-tile is-${entry.status}`;

      const name = document.createElement("span");
      name.className = "discovery-tile__name";
      name.textContent = entry.topic;

      const bar = document.createElement("div");
      bar.className = "discovery-tile__bar";
      const fill = document.createElement("div");
      fill.className = "discovery-tile__fill";
      fill.style.width = `${Math.round(entry.share * 100)}%`;
      bar.appendChild(fill);

      const counts = document.createElement("span");
      counts.className = "discovery-tile__counts";
      /* The real numbers, so the bar can be checked against them. */
      counts.textContent = entry.solved === 0 && entry.attempted === 0
        ? `${entry.total} problems · not started`
        : `${entry.solved} of ${entry.total} solved${entry.attempted > entry.solved ? ` · ${entry.attempted} tried` : ""}`;

      cell.append(name, bar, counts);
      cell.title = entry.status;
      grid.appendChild(cell);
    }
    host.appendChild(grid);
  };

  const discoveryRefresh = () => {
    const problems = discoveryProblems();
    const solvedSlugs = new Set(problems.filter((p) => p.solved).map((p) => p.slug));
    const attemptedSlugs = new Set(problems.filter((p) => p.lastRunAt).map((p) => p.slug));

    /* `limit` was hard-coded to 60 here while the "Show more" button raised
       discoveryState.limit and re-called this function. The button therefore
       asked for the same 60 rows again and the list drew all of them anyway, so
       it could never change anything: a permanently visible button that did
       nothing. Both the fetch and the draw now honour the same number. */
    discoveryState.recs = window.discoveryRecommend
      ? window.discoveryRecommend(problems, {
          solvedSlugs,
          attemptedSlugs,
          dueSlugs: discoveryDueSlugs(),
          limit: discoveryState.limit
        })
      : [];
    discoveryState.coverage = window.discoveryCoverage ? window.discoveryCoverage(problems) : [];

    const shown = discoveryEl("discovery-summary");
    if (shown) {
      const total = problems.length;
      const solved = problems.filter((p) => p.solved).length;
      const topics = discoveryState.coverage.length;
      shown.textContent = `${solved} of ${total} problems solved across ${topics} topics.`;
    }

    discoveryRenderList();
    discoveryRenderCoverage();
  };

  const initDiscovery = () => {
    const stored = readJson(DISCOVERY_KEY, () => ({}));
    if (stored && stored.strategy) discoveryState.strategy = stored.strategy;
    /* Guarded: a hand-edited or half-written value must not become a fetch
       limit of -1 or 1e9. */
    if (Number.isFinite(stored?.limit) && stored.limit >= 12 && stored.limit <= 600) {
      discoveryState.limit = stored.limit;
    }

    const more = discoveryEl("discovery-more");
    more?.addEventListener("click", () => {
      discoveryState.limit += 12;
      writeJson(DISCOVERY_KEY, { strategy: discoveryState.strategy, limit: discoveryState.limit });
      void loadRevisionDashboard().catch(() => {});
      discoveryRefresh();
    });
    const refreshBtn = discoveryEl("discovery-refresh");
    refreshBtn?.addEventListener("click", () => {
      renderLcAll();
      discoveryRefresh();
      showLabToast("Suggestions updated");
    });

    discoveryRenderFilters();
    discoveryRefresh();
  };


  /* --------------------- technical interview academy --------------------- */
  /* Content comes from academy.js, checked by scripts/test-academy.js. This
     half renders it, tracks which points the reader marked, and runs the quiz
     so that an explanation is always shown once an answer is chosen. */

  /* ========================= technical interview academy ====================
     The player for academy.js: topic navigation, per-point checkboxes, a progress
     bar, and a quiz that explains itself whether the answer is right or wrong.

     Progress is stored per point, keyed by `topic.sectionIndex.pointIndex`, so
     editing one section never invalidates the rest. */
  (() => {
    /* Every use of ACADEMY_TOPICS and ACADEMY_QUIZ below assumes they are
       arrays. They are set by academy.js, and a module that did not load - a
       blocked file, a cache miss, a syntax error in an edit - left them
       undefined, so the first of those reads threw. Because this whole block
       runs from the start-up sequence, that one throw used to take every
       initialiser after it down as well and leave a blank page.

       Checked once, here, and reported on the Academy page by the caller. The
       rest of the function can then keep its simpler assumptions. */
    if (!Array.isArray(window.ACADEMY_TOPICS) || window.ACADEMY_TOPICS.length === 0) {
      throw new Error("The Academy module (academy.js) did not load.");
    }
    if (!Array.isArray(window.ACADEMY_QUIZ)) window.ACADEMY_QUIZ = [];

    const ACADEMY_KEY = `quantaAcademyV${window.ACADEMY_VERSION || 1}`;
    const academyState = { topic: null, progress: null, quizAnswers: {} };

    const el = (id) => document.getElementById(id);

    const pointId = (topicKey, sectionIndex, pointIndex) => `${topicKey}.${sectionIndex}.${pointIndex}`;

    const loadProgress = () => {
      const raw = readJson(ACADEMY_KEY, () => ({}));
      const saved = raw && typeof raw === "object" ? raw : {};
      academyState.progress = new Set(Array.isArray(saved.done) ? saved.done : []);
      academyState.quizAnswers = saved.answers && typeof saved.answers === "object" ? saved.answers : {};
    };

    /* `topic` is written here as well as `done` and `answers`. It used to be
       read back on start-up but never written by anything, so a reader who had
       worked through four topics came back to the first one every time. */
    const saveProgress = () => {
      writeJson(ACADEMY_KEY, {
        done: [...academyState.progress],
        answers: academyState.quizAnswers,
        topic: academyState.topic
      });
    };

    const totalPoints = () =>
      window.ACADEMY_TOPICS.reduce((sum, t) => sum + t.sections.reduce((s, sec) => s + sec.points.length, 0), 0);

    const donePoints = () => academyState.progress.size;

    const renderNav = () => {
      const host = el("academy-nav");
      if (!host) return;
      host.innerHTML = "";
      for (const topic of window.ACADEMY_TOPICS) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `viz-chip${academyState.topic === topic.key ? " is-active" : ""}`;
        button.dataset.topic = topic.key;
        button.textContent = topic.label;
        button.setAttribute("aria-pressed", academyState.topic === topic.key ? "true" : "false");

        const topicDone = topic.sections.reduce((sum, sec, si) => sum + sec.points.filter((_, pi) => academyState.progress.has(pointId(topic.key, si, pi))).length, 0);
        const topicTotal = topic.sections.reduce((sum, sec) => sum + sec.points.length, 0);
        const done = topicDone === topicTotal && topicTotal > 0;

        button.addEventListener("click", () => {
          academyState.topic = topic.key;
          /* Persisted, so the topic a reader is actually working on is the one
             they return to. */
          saveProgress();
          renderNav();
          renderTopic();
        });
        host.appendChild(button);
        if (done) button.classList.add("is-complete");
      }
    };

    const renderProgress = () => {
      const text = el("academy-progress-text");
      if (text) {
        const total = totalPoints();
        text.textContent = `${donePoints()} of ${total} points marked as understood.`;
      }
      const bar = el("academy-progress-fill");
      if (bar) {
        const total = totalPoints();
        bar.style.width = `${total ? Math.round((donePoints() / total) * 100) : 0}%`;
      }
    };

    const renderTopic = () => {
      const host = el("academy-body");
      if (!host) return;
      host.innerHTML = "";
      const topic = window.ACADEMY_TOPICS.find((t) => t.key === academyState.topic) || window.ACADEMY_TOPICS[0];
      academyState.topic = topic.key;

      const intro = document.createElement("p");
      intro.className = "viz-about";
      intro.textContent = topic.blurb;
      host.appendChild(intro);

      topic.sections.forEach((section, si) => {
        const card = document.createElement("section");
        card.className = "settings-group academy-section";

        const title = document.createElement("h3");
        title.textContent = section.title;
        card.appendChild(title);

        const list = document.createElement("ul");
        list.className = "academy-points";

        section.points.forEach((point, pi) => {
          const id = pointId(topic.key, si, pi);
          const checked = academyState.progress.has(id);

          const li = document.createElement("li");
          li.className = `academy-point${checked ? " is-done" : ""}`;

          const label = document.createElement("label");
          label.className = "academy-point__label";

          const box = document.createElement("input");
          box.type = "checkbox";
          box.checked = checked;
          box.className = "academy-point__box";
          box.addEventListener("change", () => {
            if (box.checked) academyState.progress.add(id);
            else academyState.progress.delete(id);
            li.classList.toggle("is-done", box.checked);
            saveProgress();
            renderProgress();
          });

          const text = document.createElement("span");
          text.className = "academy-point__text";
          text.textContent = point;

          label.append(box, text);
          li.appendChild(label);
          list.appendChild(li);
        });

        card.appendChild(list);
        host.appendChild(card);
      });
    };

    const renderQuiz = () => {
      const host = el("academy-quiz");
      if (!host) return;
      host.innerHTML = "";
      /* This used to set `.checked = false` on #academy-quiz-toggle. That element
         is a <details>, which has no `checked` property, so the line assigned a
         meaningless expando, ran on every render, and did nothing. Removed
         rather than replaced: a <details> is already in the state it should be
         in unless something deliberately opened it. */

      window.ACADEMY_QUIZ.forEach((item, index) => {
        const card = document.createElement("div");
        card.className = "academy-quiz__item";

        const topic = window.ACADEMY_TOPICS.find((t) => t.key === item.topic);
        const label = document.createElement("span");
        label.className = "academy-quiz__topic";
        label.textContent = topic ? topic.label : item.topic;

        const question = document.createElement("p");
        question.className = "academy-quiz__question";
        question.textContent = item.question;

        card.append(label, question);

        if (item.code) {
          const pre = document.createElement("pre");
          pre.className = "viz-code";
          pre.textContent = item.code;
          card.appendChild(pre);
        }

        const options = document.createElement("div");
        options.className = "academy-quiz__options";
        const chosen = academyState.quizAnswers[index];

        item.options.forEach((option, oi) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "viz-alg";
          if (chosen !== undefined && chosen === oi) button.classList.add("is-selected");
          button.textContent = option;

          button.addEventListener("click", () => {
            academyState.quizAnswers[index] = oi;
            saveProgress();
            renderQuiz();
          });
          options.appendChild(button);
        });
        card.appendChild(options);

        /* The explanation appears as soon as anything is chosen, right or wrong.
           There is no state where the reader is told they are wrong and given
           nothing to read. */
        if (chosen !== undefined) {
          const correct = chosen === item.answer;
          const explain = document.createElement("p");
          explain.className = `academy-quiz__why${correct ? " is-right" : " is-wrong"}`;
          explain.textContent = `${correct ? "Correct." : "Not quite."} ${item.why}`;
          card.appendChild(explain);
        }

        host.appendChild(card);
      });

      const score = el("academy-quiz-score");
      if (score) {
        const answered = Object.keys(academyState.quizAnswers).length;
        const right = window.ACADEMY_QUIZ.filter((item, i) => academyState.quizAnswers[i] === item.answer).length;
        score.textContent = answered ? `${right} of ${answered} answered correctly. ${window.ACADEMY_QUIZ.length - answered} still to try.` : `${window.ACADEMY_QUIZ.length} questions. Pick an answer to see why.`;
      }
    };

    const initAcademy = () => {
      loadProgress();
      const stored = readJson(ACADEMY_KEY, () => ({}));
      academyState.topic = (window.ACADEMY_TOPICS || []).some((t) => t.key === stored.topic)
        ? stored.topic
        : (window.ACADEMY_TOPICS || [])[0]?.key || null;

      el("academy-reset")?.addEventListener("click", () => {
        const confirmed = window.confirm(
          "Clear your progress on this page?\n\nThis only forgets which points you marked and your quiz answers. Your problems, notes, code and revision schedule are not affected."
        );
        if (!confirmed) return;
        academyState.progress = new Set();
        academyState.quizAnswers = {};
        saveProgress();
        renderNav();
        renderTopic();
        renderQuiz();
        renderProgress();
        showLabToast("Academy progress cleared");
      });

      renderNav();
      renderTopic();
      renderQuiz();
      renderProgress();
    };

    /* The module is wrapped in an IIFE so its helpers stay out of the app's
       shared scope, but init still has to be called from the app's init block.
       Publishing just this one function is the seam between the two. */
    window.initAcademy = initAcademy;
  })();


  /* ------------------------ DSA pattern trainer ------------------------- */
  /* Content and the topic-tag matching come from patterns.js, checked by
     scripts/test-patterns.js. Practice lists are built from the live catalog
     rather than hardcoded, so they cannot list a problem that is not there. */

  /* =========================== DSA pattern trainer UI =====================
     Renders patterns.js: pick a pattern, read when to use it and what shape it
     has, copy the skeleton, work through the mistakes, then practise on real
     problems pulled from the catalog by topic tag. */

  const PATTERN_KEY = "quantaPatternsV1";
  const patternState = { key: null, visited: new Set() };

  const patternEl = (id) => document.getElementById(id);

  const patternCatalog = () => {
    const list = Array.isArray(lcState?.problems) ? lcState.problems : [];
    return list.length ? list : normalizeLcProblems(seedProblems());
  };

  const patternLoad = () => {
    const raw = readJson(PATTERN_KEY, () => ({}));
    const saved = raw && typeof raw === "object" ? raw : {};
    patternState.key = (window.PATTERNS || []).some((p) => p.key === saved.key) ? saved.key : (window.PATTERNS || [])[0]?.key || null;
    patternState.visited = new Set(Array.isArray(saved.visited) ? saved.visited : []);
  };

  const patternSave = () => {
    writeJson(PATTERN_KEY, { key: patternState.key, visited: [...patternState.visited] });
  };

  const patternRenderNav = () => {
    const host = patternEl("pattern-nav");
    if (!host) return;
    host.innerHTML = "";
    for (const pattern of window.PATTERNS || []) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `viz-chip${patternState.key === pattern.key ? " is-active" : ""}`;
      button.dataset.pattern = pattern.key;
      button.textContent = pattern.title;
      button.setAttribute("aria-pressed", patternState.key === pattern.key ? "true" : "false");
      if (patternState.visited.has(pattern.key)) button.classList.add("is-complete");
      button.addEventListener("click", () => {
        patternState.key = pattern.key;
        patternState.visited.add(pattern.key);
        patternSave();
        patternRenderNav();
        patternRenderBody();
      });
      host.appendChild(button);
    }
  };

  const patternRenderBody = () => {
    const host = patternEl("pattern-body");
    if (!host) return;
    host.innerHTML = "";
    const pattern = (window.PATTERNS || []).find((p) => p.key === patternState.key);
    if (!pattern) {
      /* The host is emptied on entry, so returning here used to leave the
         panel blank - no pattern, and nothing saying why. Either patterns.js
         did not load, or the stored key names a pattern that no longer exists;
         the two are told apart. */
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = window.PATTERNS && window.PATTERNS.length
        ? "That pattern is not in the list any more. Pick another from the tabs above."
        : "The pattern module did not load on this device, so there is nothing to show here. Everything else in Quanta still works.";
      host.appendChild(p);
      return;
    }

    const when = document.createElement("p");
    when.className = "viz-about";
    when.textContent = pattern.when;
    host.appendChild(when);

    const shapeCard = document.createElement("section");
    shapeCard.className = "settings-group pattern-block";
    const shapeTitle = document.createElement("h3");
    shapeTitle.textContent = "The shape";
    const shapeText = document.createElement("p");
    shapeText.className = "pattern-shape";
    shapeText.textContent = pattern.shape;
    shapeCard.append(shapeTitle, shapeText);

    const codePre = document.createElement("pre");
    codePre.className = "viz-code";
    codePre.textContent = pattern.skeleton;
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "prog-btn prog-btn--ghost pattern-copy";
    copy.textContent = "Copy the skeleton";
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pattern.skeleton);
        copy.textContent = "Copied";
      } catch {
        /* Clipboard access can be refused. Say so rather than pretending. */
        copy.textContent = "Select the code and copy it";
      }
      window.setTimeout(() => { copy.textContent = "Copy the skeleton"; }, 2200);
    });
    shapeCard.append(codePre, copy);
    host.appendChild(shapeCard);

    const checkCard = document.createElement("section");
    checkCard.className = "settings-group pattern-block";
    const checkTitle = document.createElement("h3");
    checkTitle.textContent = "Where it goes wrong";
    const list = document.createElement("ul");
    list.className = "pattern-mistakes";
    for (const item of pattern.checklist) {
      const li = document.createElement("li");
      li.textContent = item;
      list.appendChild(li);
    }
    checkCard.append(checkTitle, list);
    host.appendChild(checkCard);

    /* Practice, built from the catalog by topic tag. */
    const problems = window.patternProblems
      ? window.patternProblems(window.PATTERNS, pattern.key, patternCatalog(), 8)
      : [];
    const practice = document.createElement("section");
    practice.className = "settings-group pattern-block";

    const practiceTitle = document.createElement("h3");
    practiceTitle.textContent = "Practise it";
    practice.appendChild(practiceTitle);

    if (!problems.length) {
      const empty = document.createElement("p");
      empty.className = "viz-note--plain";
      empty.textContent = `No problems in your catalog are tagged ${pattern.topics.join(" or ")} yet. Run the catalog sync to pick up more.`;
      practice.appendChild(empty);
    } else {
      const intro = document.createElement("p");
      intro.className = "pattern-intro";
      intro.textContent = `Easiest first. These are the ${problems.length} easiest catalog problems tagged ${pattern.topics.join(" or ")}.`;
      practice.appendChild(intro);

      const list2 = document.createElement("div");
      list2.className = "pattern-problems";
      for (const problem of problems) {
        const row = document.createElement("div");
        row.className = "pattern-problem";

        const meta = document.createElement("span");
        meta.className = `discovery-card__difficulty is-${String(problem.difficulty || "").toLowerCase()}`;
        meta.textContent = problem.difficulty || "";

        const name = document.createElement("span");
        name.className = "pattern-problem__name";
        name.textContent = problem.name || problem.title || problem.slug;

        const platform = document.createElement("span");
        platform.className = "pattern-problem__platform";
        platform.textContent = problem.platform && problem.platform !== "leetcode" ? problem.platform : "";

        const open = document.createElement("button");
        open.type = "button";
        open.className = "prog-btn";
        open.textContent = "Open";
        open.addEventListener("click", () => {
          showPage("quantalab");
          selectLcProblem(problem.id);
        });

        row.append(meta, name, platform, open);
        list2.appendChild(row);
      }
      practice.appendChild(list2);
    }
    host.appendChild(practice);
  };

  const patternRenderGaps = () => {
    const host = patternEl("pattern-gaps");
    if (!host) return;
    host.innerHTML = "";
    if (!window.patternGaps) {
      /* Same shape as the practice list: the host has already been emptied, so
         returning silently rendered an empty section rather than no section. */
      const missing = document.createElement("p");
      missing.className = "viz-note--plain";
      missing.textContent = "Coverage could not be worked out because the pattern module did not load on this device.";
      host.appendChild(missing);
      return;
    }
    const gaps = window.patternGaps(window.PATTERNS, patternCatalog());
    if (!gaps.length) {
      const none = document.createElement("p");
      none.className = "viz-note--plain";
      none.textContent = "Every topic in your catalog is covered by a pattern here.";
      host.appendChild(none);
      return;
    }
    /* Reported, not hidden. A topic with problems but no teaching page should
       look like a known gap rather than like a bug. */
    const note = document.createElement("p");
    note.className = "pattern-intro";
    note.textContent = `Topics in your catalog with no pattern page yet: ${gaps.map((g) => `${g.topic} (${g.count})`).join(", ")}.`;
    host.appendChild(note);
  };

  const initPatterns = () => {
    patternLoad();
    patternEl("pattern-reset")?.addEventListener("click", () => {
      const confirmed = window.confirm(
        "Clear the patterns you have visited?\n\nThis only forgets which pattern pages you opened. Your problems, notes and revision schedule are not affected."
      );
      if (!confirmed) return;
      patternState.visited = new Set();
      patternSave();
      patternRenderNav();
      showLabToast("Pattern history cleared");
    });
    patternRenderNav();
    patternRenderBody();
    patternRenderGaps();
  };


/* ============================ mock test =============================
     A three-question test: press Start, then one question at a time. Coding
     problems are timed at ten minutes each and answered with code; multiple
     choice questions have no clock and are answered by choosing.

     The rules live in mocktest.js, which is pure and is checked by
     scripts/test-mock-test.js - picking the questions, the timing, the marking,
     the worked-example check, the tally. This half is the screen.

     Three things this screen will not do:

       - show any part of an answer before the question is submitted or its clock
         runs out. The result region is emptied when a question opens and only
         filled afterwards, so there is nothing to scroll back to.

       - carry one question's code into another. Each question owns its own draft,
         and a fresh test throws all of them away.

       - call a coding answer correct unless something was actually checked. A
         program that runs cleanly is not a pass, because Quanta has no hidden
         tests and a green tick it cannot justify would be worse than an honest
         "this could not be evaluated". */

  const mockEl = (id) => document.getElementById(id);
  const MOCK_TEST_ENGINE = () => window.mockTestEngine;

  const mockState = {
    /* The three chosen for this test, each carrying its own kind. */
    questions: [],
    index: 0,
    /* One entry per question: { question, mark, code, expired }. */
    results: [],
    /* question id -> language -> the code typed for THAT question.
       The reason this is keyed per question rather than per language alone is
       that the editor is shared. A single per-language buffer means question
       two opens showing question one's answer, and an objective question in
       between does not break that chain - it just sits there. */
    drafts: {},
    remaining: null,
    timer: null,
    submitted: false,
    /* The question is closed: accepted, expired, or moved on from. A closed
       question takes no further submissions, which is also what stops a clock
       that fires more than once producing two results. */
    final: false,
    chosenOption: null,
    submitting: false,
    history: [],
    /* Whether the current catalog has any problem the app could mark. */
    poolIsEvaluable: false,
    /* The results screen has been built and the test recorded, so neither can
       happen twice for one sitting. */
    finished: false
  };

  const mockStopTimer = () => {
    if (mockState.timer) {
      window.clearInterval(mockState.timer);
      mockState.timer = null;
    }
  };

  const currentQuestion = () => mockState.questions[mockState.index] || null;

  const mockShow = (id, on) => {
    const el = mockEl(id);
    if (!el) return;
    if (on) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "");
  };

  /* --------------------------------- drafts -------------------------------
   *
   * One answer per question, and a fresh test starts with none of them.
   *
   * Both halves matter. Sharing a buffer between questions means question two
   * opens pre-filled with question one's code, which in a mock interview is not
   * a cosmetic problem - it is the whole answer written for you. And a buffer
   * that survives a retake means the "fresh" test is not fresh at all.
   */
  const mockDraftGet = (question, language) => {
    const perQuestion = mockState.drafts[question?.id];
    return perQuestion && typeof perQuestion[language] === "string" ? perQuestion[language] : "";
  };

  const mockDraftSet = (question, language, code) => {
    if (!question?.id) return;
    if (!mockState.drafts[question.id]) mockState.drafts[question.id] = {};
    mockState.drafts[question.id][language] = String(code ?? "");
  };

  const mockDraftsClear = () => {
    mockState.drafts = {};
  };

  /* Puts a question's own draft on screen. Called when a coding question opens
     and when the reader switches language, so both routes show the same thing
     and neither leaves the previous question's code visible. */
  const mockEditorShowCode = (language) => {
    const question = currentQuestion();
    if (!mockEditor || !question) return;
    const code = mockDraftGet(question, language);
    mockEditor.setValue(code);
    mockRefreshSubmit();
  };

  /* ---------------------------------------------------------------- start */

  /* Questions come from the app's own material: coding problems out of the
     catalog, multiple choice out of the Academy quiz and the pattern trainer.
     Nothing is written by hand to pad either pool. */
  const mockQuestionPools = () => {
    const engine = MOCK_TEST_ENGINE();
    const patterns = window.PATTERNS || [];
    const bank = engine ? engine.buildObjectiveBank({ quiz: window.ACADEMY_QUIZ, patterns }) : [];

    const all = (Array.isArray(lcState?.problems) ? lcState.problems : [])
      .filter((p) => p && p.slug && p.name)
      .map((p) => ({
        id: `code-${p.slug}`,
        kind: engine?.KIND?.CODING || "coding",
        slug: p.slug,
        prompt: p.name,
        difficulty: p.difficulty,
        platform: p.platform,
        url: p.url,
        num: p.num,
        topics: Array.isArray(p.topics) ? p.topics : [],
        /* Whether this device holds the full statement, and therefore whether
           the worked examples that decide a right answer can be read from it. */
        evaluable: p.hasDescription === true,
        source: "catalog"
      }));

    /* Preferred over the whole catalog, because a question that cannot be
       marked is not much of a question. The fallback keeps the test working on a
       catalog where nothing has a statement. */
    const evaluable = all.filter((p) => p.evaluable);
    const coding = evaluable.length ? evaluable : all;
    mockState.poolIsEvaluable = evaluable.length > 0;

    return { coding, objective: bank };
  };

  /* Everything a test owns, thrown away and rebuilt. Called by Start and by
     Retake, so neither can inherit anything from the last attempt - including a
     clock still counting, an editor still holding an answer, and a half-built
     result that would be counted twice. */
  const mockResetTest = () => {
    mockStopTimer();
    mockState.questions = [];
    mockState.results = [];
    mockState.index = 0;
    mockState.remaining = null;
    mockState.submitted = false;
    mockState.final = false;
    mockState.finished = false;
    mockState.chosenOption = null;
    mockState.submitting = false;
    mockDraftsClear();
    if (mockEditor) mockLockEditor(false);
    /* The editor is emptied here as well as in mockOpenQuestion, so a retake
       cannot leave the previous attempt's code on screen even for the moment
       before the first question renders. */
    if (mockEditor) mockEditor.setValue("");
    mockSetOutput("");
    mockShow("mock-q-validation", false);
    const body = mockEl("mock-q-body");
    if (body) body.replaceChildren();
    const result = mockEl("mock-q-result");
    if (result) result.replaceChildren();
  };

  /* Why coding questions come from where they do.

     Written when the panel is set up rather than when a test starts, because the
     start screen is hidden the moment a test begins - a note rendered inside
     mockStartTest lands on a panel nobody will ever see again. */
  const mockRenderPoolNote = () => {
    /* Reads the pools once so the answer is known before anything is clicked. */
    mockQuestionPools();
    const note = mockEl("mock-start-pool");
    if (!note) return;
    note.textContent = mockState.poolIsEvaluable
      ? "Coding questions come from the problems Quanta holds the full statement for. Those are the ones whose worked examples can be run against your answer, so it can actually be marked right or wrong."
      : "This catalog has no stored statements, so coding answers cannot be marked right or wrong here. They will still be run, and told apart from a compile or runtime error.";
  };

  const mockStartTest = () => {
    const engine = MOCK_TEST_ENGINE();
    const note = mockEl("mock-start-note");
    if (!engine) {
      if (note) note.textContent = "The mock test module did not load, so a test cannot be started.";
      return;
    }
    const pools = mockQuestionPools();
    if (!pools.coding.length) {
      if (note) note.textContent = "There are no problems in this catalog yet, so there is nothing to ask. Add a problem first.";
      return;
    }
    const questions = engine.buildTest({ ...pools, seed: Date.now() });
    if (!questions.length) {
      if (note) note.textContent = "There was nothing to build a test from.";
      return;
    }

    /* Said before the test starts, because a reader who sees the same platform
       three times running would otherwise be left to work out why. */
    mockRenderPoolNote();

    /* Before anything new is shown, so the previous attempt cannot bleed into
       this one through the editor, the clock or the result region. */
    mockResetTest();

    mockState.questions = questions;
    if (note) note.textContent = "";
    mockShow("mock-start", false);
    mockShow("mock-summary", false);
    mockShow("mock-run", true);
    mockSyncHistoryPanel();
    void mockOpenQuestion();
  };

  /* ------------------------------------------------------------- question */

  const mockRenderClock = () => {
    const engine = MOCK_TEST_ENGINE();
    const clock = mockEl("mock-clock");
    const seconds = mockState.remaining;
    /* An objective question has no clock. It is hidden outright rather than
       shown at zero, so nothing on screen suggests a timer is running. */
    if (seconds === null || seconds === undefined) {
      if (clock) clock.hidden = true;
    } else if (clock) {
      clock.hidden = false;
      clock.textContent = engine ? engine.clockText(seconds) : String(seconds);
      clock.classList.toggle("is-urgent", seconds <= 60);
    }
    const bar = mockEl("mock-stage-bar");
    const total = engine ? engine.CODING_SECONDS : 600;
    if (bar) {
      const used = seconds === null || seconds === undefined ? 0 : 1 - seconds / total;
      bar.style.width = `${Math.min(100, Math.max(0, used * 100))}%`;
    }
  };

  const mockStartTimer = () => {
    const engine = MOCK_TEST_ENGINE();
    const question = currentQuestion();
    const seconds = engine ? engine.secondsFor(question?.kind) : null;
    mockStopTimer();
    mockState.remaining = seconds;
    if (seconds === null || seconds === undefined) {
      mockRenderClock();
      return;
    }
    mockState.timer = window.setInterval(() => {
      mockState.remaining = engine.tick(mockState.remaining);
      if (mockState.remaining <= 0) {
        mockStopTimer();
        mockRenderClock();
        /* Time is up. Submissions stop and the result is shown without waiting
           for the reader to do anything. Whatever is in the editor is what gets
           marked, and the expiry path goes through the same check as a press of
           the button - so an empty editor is "not answered", not "wrong". */
        void mockSubmit({ expired: true });
        return;
      }
      mockRenderClock();
    }, 1000);
    mockRenderClock();
  };

  /* ------------------------------------------------------------ validation */

  /* Whether Submit may be pressed.
   *
   * A coding answer needs at least one character that is not whitespace. An
   * editor holding only spaces and blank lines is not an attempt, and letting it
   * through would produce a "did not compile" on an editor nobody typed in -
   * which reads as the reader's mistake rather than the panel's.
   *
   * Objective questions never go through this: they are answered by choosing,
   * and they have no editor. */
  /* How long the "no option chosen" message stays up. Long enough to be read,
     short enough that it is not still there when the reader picks an answer. */
  const MOCK_POPUP_MS = 2000;
  let mockPopupTimer = null;

  /* Takes the message down at once. */
  const mockHidePopup = () => {
    if (mockPopupTimer) { clearTimeout(mockPopupTimer); mockPopupTimer = null; }
    mockShow("mock-q-popup", false);
  };

  /* Says what went wrong, and says nothing else. Called only from the failed
     attempt, so no verdict has been produced and none can be leaked. */
  const mockShowPopup = (message) => {
    const popup = mockEl("mock-q-popup");
    if (!popup) return;
    if (mockPopupTimer) clearTimeout(mockPopupTimer);
    popup.textContent = message;
    mockShow("mock-q-popup", true);
    /* Restarted on every call, so two quick attempts get a full two seconds each
       rather than the second being cut short by the first one's timer. */
    mockPopupTimer = setTimeout(() => {
      mockPopupTimer = null;
      mockShow("mock-q-popup", false);
    }, MOCK_POPUP_MS);
  };

  /* Keeps the guard exactly on top of the button it stands in for.

     Measured from the button's own box rather than written as a CSS offset:
     the button is a small pill on a desktop and spans the screen on a phone,
     so any fixed number would be wrong on one of them. */
  const mockSyncGuard = (blocked) => {
    const guard = mockEl("mock-q-guard");
    const btn = mockEl("mock-submit-btn");
    if (!guard || !btn) return;
    mockShow("mock-q-guard", blocked);
    if (!blocked) return;
    guard.style.left = btn.offsetLeft + "px";
    guard.style.top = btn.offsetTop + "px";
    guard.style.width = btn.offsetWidth + "px";
    guard.style.height = btn.offsetHeight + "px";
  };

  const mockRefreshSubmit = () => {
    const engine = MOCK_TEST_ENGINE();
    const question = currentQuestion();
    const submitBtn = mockEl("mock-submit-btn");
    const note = mockEl("mock-q-validation");
    if (!submitBtn) return;

    /* A multiple-choice question has nothing to type, so the only thing that
       can make it submittable is a choice. Until then the button is dead, and
       choosing enables it on the spot rather than on the next thing typed. */
    if (!question || question.kind !== "coding") {
      const nothingChosen = Boolean(question) && mockState.chosenOption === null;
      /* Really disabled - the property, not an imitation of it. A button only
         marked unavailable can still be submitted by anything that reads the
         DOM rather than the pixels. */
      submitBtn.disabled = nothingChosen;
      submitBtn.setAttribute("aria-disabled", nothingChosen ? "true" : "false");
      mockSyncGuard(nothingChosen);
      mockShow("mock-q-validation", false);
      return;
    }

    /* The coding path keeps a genuinely dead button: its reason is already on
       screen, so there is nothing a press could usefully add. */
    submitBtn.setAttribute("aria-disabled", "false");
    mockSyncGuard(false);

    /* Closed questions cannot be submitted to. An expired one says so, because a
       button that is merely dead looks exactly like a fault. */
    if (mockState.final || mockState.submitted) {
      submitBtn.disabled = true;
      submitBtn.setAttribute("aria-disabled", "true");
      mockSyncGuard(false);
      if (mockTimeLeft() <= 0) {
        if (note) {
          note.textContent = "Time is up. This question is closed.";
          mockShow("mock-q-validation", true);
        }
      } else {
        mockShow("mock-q-validation", false);
      }
      return;
    }

    const code = mockEditor ? mockEditor.getValue() : "";
    const usable = engine ? engine.hasCode(code) : /\S/.test(code);
    submitBtn.disabled = !usable;

    if (!note) return;
    if (usable) {
      mockShow("mock-q-validation", false);
      return;
    }
    /* Two different messages, because they are two different mistakes: an
       untouched editor and an editor full of blank lines call for different
       next steps. */
    note.textContent = code.length === 0
      ? "Write your answer in the editor before submitting."
      : "That is only spaces and blank lines. Write your answer before submitting.";
    mockShow("mock-q-validation", true);
  };

  /* Draws one question: the prompt, and either a statement with an editor or a
     set of options. The two are never on screen together. */
  const mockOpenQuestion = async () => {
    const engine = MOCK_TEST_ENGINE();
    const question = currentQuestion();
    if (!engine || !question) return;

    mockStopTimer();
    mockState.submitted = false;
    mockState.final = false;
    mockState.chosenOption = null;
    mockState.submitting = false;

    const progress = mockEl("mock-run-progress");
    if (progress) {
      progress.textContent = `Question ${mockState.index + 1} of ${mockState.questions.length} · ${question.kind === "coding" ? "Coding" : "Multiple choice"}`;
    }
    const title = mockEl("mock-run-title");
    if (title) title.textContent = question.kind === "coding" ? "Coding problem" : "Multiple choice";

    /* Cleared, so a previous question's answer cannot be read on this one. */
    const result = mockEl("mock-q-result");
    if (result) result.replaceChildren();
    mockShow("mock-q-validation", false);

    const body = mockEl("mock-q-body");
    if (body) {
      body.replaceChildren();
      body.hidden = false;

      const badge = document.createElement("p");
      badge.className = "mock-q-kind";
      const bits = [];
      if (question.difficulty) bits.push(question.difficulty);
      if (question.num) bits.push(`#${question.num}`);
      if (question.platform && question.platform !== "leetcode") bits.push(question.platform);
      if (question.topic) bits.push(question.topic);
      badge.textContent = bits.join(" · ");
      body.appendChild(badge);

      const prompt = document.createElement("h4");
      prompt.className = "mock-q-title";
      prompt.textContent = question.prompt;
      body.appendChild(prompt);

      if (question.kind === "coding") {
        const statement = document.createElement("div");
        statement.className = "mock-q-statement";
        statement.innerHTML = '<p class="ql-desc-loading">Loading the problem statement…</p>';
        body.appendChild(statement);

        if (question.url) {
          const link = document.createElement("a");
          link.className = "prog-btn mock-q-link";
          link.href = question.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = window.EXTERNAL_LINK_LABEL || "Open in Website";
          body.appendChild(link);
        }

        void (async () => {
          let html = "";
          try {
            const result2 = await requestDescription(question.slug);
            html = result2?.html || "";
          } catch {
            html = "";
          }
          if (currentQuestion()?.slug !== question.slug) return;
          if (html) {
            renderDescHtml(html, statement);
          } else {
            statement.innerHTML = "";
            const p = document.createElement("p");
            p.className = "ql-desc-empty";
            p.textContent = navigator.onLine
              ? "This problem's statement is not stored on this device, so it cannot be shown here. Use the link above to read it."
              : "You are offline and this statement has not been saved on this device yet.";
            statement.appendChild(p);
          }
        })();
      } else {
        /* Multiple choice. Options are buttons, not radios, so the whole target
           is tappable and the chosen one is visibly marked. */
        const options = document.createElement("div");
        options.className = "mock-q-options";
        options.setAttribute("role", "group");
        options.setAttribute("aria-label", "Answer options");
        question.options.forEach((text, i) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "mock-q-option";
          button.dataset.index = String(i);
          button.textContent = text;
          button.addEventListener("click", () => {
            /* A judged question is closed to further answers. */
            if (mockState.submitted || mockState.final) return;
            mockState.chosenOption = i;
            for (const other of options.querySelectorAll(".mock-q-option")) {
              other.classList.toggle("is-chosen", other === button);
              other.setAttribute("aria-pressed", other === button ? "true" : "false");
            }
            /* The complaint was about not having chosen; that is now untrue, so
               it comes down rather than being left to time out. */
            mockHidePopup();
            mockRefreshSubmit();
          });
          options.appendChild(button);
        });
        body.appendChild(options);
      }
    }

    mockShow("mock-q-editor", question.kind === "coding");
    if (question.kind === "coding") {
      /* The editor is built on first use, then reused for every question. What
         changes between questions is only what it holds, and that is this
         question's own draft - which on a first pass is empty. */
      await ensureMockEditor().catch(() => {});
      /* Thawed per question. The previous one was frozen when it closed. */
      mockLockEditor(false);
      const language = normalizeLanguage(mockLanguageSelect?.value);
      mockEditorShowCode(language);
      /* Output and any run error belong to the previous question's attempt. */
      mockSetOutput("");
      mockOutput?.classList.remove("is-error");
      mockRenderClock();
    }

    /* Re-enabled and relabelled here, not just shown.
       Submit is disabled for the duration of a submit so a second press cannot
       mark the same answer twice, and it is also disabled while a coding editor
       is empty. Both have to be undone before the next question. */
    const submitBtn = mockEl("mock-submit-btn");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit answer";
    }
    mockShow("mock-submit-btn", true);
    mockShow("mock-next-btn", false);
    mockShow("mock-edit-btn", false);
    mockHidePopup();
    /* Labelled for where this question sits: the last one offers the results
       rather than another question that does not exist. */
    mockSetNextLabel();
    /* Last, so it reads the editor state this question actually left behind. */
    mockRefreshSubmit();
    mockStartTimer();
    mockEl("mock-run")?.scrollIntoView?.({ block: "nearest" });
  };

  /* ------------------------------------------------------------- submit */

  /* Is this code a standalone program, rather than a solution meant to be
     called by a harness?

     It matters for one narrow case. When there is no automatic check, Quanta
     runs what was submitted so that at least the compile and run result is real -
     but running a LeetCode-shaped Java or Python answer on its own fails to
     compile for a reason that has nothing to do with the reader's code, because
     there is no main method. Reporting that as "did not compile" would be
     blaming the reader for the harness. So the run is only allowed to produce a
     verdict when the code was meant to be run on its own. */
  const mockLooksStandalone = (code, language) => {
    const source = String(code || "");
    if (language === "java") return /static\s+void\s+main\s*\(/.test(source);
    if (language === "python") return !/class\s+Solution\b/.test(source);
    /* For JavaScript the harness recognises functions and classes; anything it
       cannot recognise is a plain script. */
    const engine = MOCK_TEST_ENGINE();
    if (!engine) return true;
    return engine.buildJsHarness(source, { args: {}, expected: "" }) === null;
  };

  /* Marks a coding answer by really running it.
   *
   * The evidence, in order of strength:
   *   1. the problem's own worked examples, run against the submitted code -
   *      the only thing that can say the answer is right;
   *   2. a harness that built but produced no readable result, which means the
   *      code itself broke;
   *   3. nothing checkable, in which case the submitted program is run on its own
   *      and whatever that shows is reported as observation, not as a verdict.
   *
   * Nothing here can produce a "correct" without at least one passing example. */
  const mockEvaluateCoding = async (question, code) => {
    const engine = MOCK_TEST_ENGINE();
    const language = normalizeLanguage(mockLanguageSelect?.value);

    let statementHtml = "";
    try {
      const res = await requestDescription(question.slug);
      statementHtml = res?.html || "";
    } catch {
      statementHtml = "";
    }
    const examples = engine ? engine.parseAllExamples(statementHtml, 5) : [];

    const tests = [];
    const harnessErrors = [];
    let harnessAttempts = 0;

    for (const example of examples) {
      const harness = engine.harnessFor(language, code, example);
      if (!harness) continue;
      harnessAttempts += 1;

      let outcome = null;
      try {
        outcome = await executeCode(language, harness, "");
      } catch {
        outcome = null;
      }
      if (!outcome) {
        harnessErrors.push("The check could not be run.");
        continue;
      }
      /* The comparison is handed the outcome already fetched rather than being
         allowed to run the harness a second time - one run per example, so the
         code is not executed twice for every question. */
      const row = await engine.runExampleTest({
        harness,
        expected: example.expected,
        expectedLabel: example.label,
        run: async () => outcome
      });
      if (row) tests.push(row);
      else harnessErrors.push((outcome.stderr || "").trim().slice(0, 400) || "The check produced no readable result.");
    }

    if (tests.length) {
      /* The examples decided it. The submitted program is never run on its own
         here, because a LeetCode-shaped answer has no main method and would
         "fail to compile" for a reason that has nothing to do with the reader. */
      return {
        ...engine.markCoding({ compiled: true, ran: true, tests, code }),
        tests,
        language,
        source: "examples"
      };
    }

    if (harnessAttempts) {
      /* A harness was built for this code and none of them produced an answer.
         That means the code did not compile or threw, not that Quanta was
         confused - so it is reported as a failure, with the real error. */
      return {
        ...engine.markCoding({ compiled: true, ran: false, stderr: harnessErrors[0] || "", code }),
        tests,
        language,
        source: "examples"
      };
    }

    /* Nothing could be checked automatically. */
    const standalone = mockLooksStandalone(code, language);
    let observation = { stdout: "", stderr: "", compiled: true, ran: true, timedOut: false };
    try {
      const result = await executeCode(language, code, "");
      observation = {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        compiled: result.phase !== "compile",
        ran: result.ok !== false,
        timedOut: Boolean(result.timedOut)
      };
    } catch (error) {
      observation = { stdout: "", stderr: String(error?.message || error), compiled: true, ran: false, timedOut: false };
    }

    const mark = standalone
      ? engine.markCoding({ ...observation, tests: [], code })
      /* A solution meant to be called by a harness cannot be run on its own, so
         its output is shown as an observation and the verdict stays honest. */
      : engine.markCoding({ compiled: true, ran: true, tests: [], code });

    return {
      ...mark,
      tests: [],
      language,
      source: standalone ? "run" : "none",
      observation: standalone ? "" : (observation.stdout || observation.stderr || "")
    };
  };

/* Whether the question still has time on the clock. A question with no clock
     - an objective one - is never out of time. */
  const mockTimeLeft = () =>
    typeof mockState.remaining === "number" ? mockState.remaining : Infinity;

  /* Freezes the editor.

     Read-only rather than hidden: the reader can still read what they wrote,
     which is exactly what they need when a runtime error is on screen. A
     disabled-looking but still editable box would let them change an answer
     after it has been judged, and the judged answer would no longer be the
     answer on screen. */
  const mockLockEditor = (locked) => {
    if (!mockEditor) return;
    mockEditor.updateOptions({ readOnly: locked });
    mockEditorNode?.classList.toggle("is-locked", locked);
  };

  /* The button that leaves a question. The last one in a test is not "next" -
     there is nothing after it - so it asks for the results instead. */
  const mockSetNextLabel = () => {
    const btn = mockEl("mock-next-btn");
    if (!btn) return;
    const last = mockState.index >= mockState.questions.length - 1;
    btn.textContent = last ? "Check All Answers" : "Next question";
  };

  /* Decides what happens after a submission.

     A wrong answer is not the end of the question while the clock is still
     running: the reader is given the editor back and another go, and the panel
     does not move them on by itself. An accepted answer, an expired clock, or a
     question that was never going to be marked closes it.

     "Unable to evaluate automatically" deliberately does not close a coding
     question. Quanta had nothing to check against, so the answer may well be
     right, and telling the reader to go back and rewrite it would be claiming
     their solution is broken when the missing thing is evidence. */
  const mockAfterSubmit = (mark, { expired }) => {
    const question = currentQuestion();
    const engine = MOCK_TEST_ENGINE();
    const coding = question?.kind === "coding";
    const outOfTime = mockTimeLeft() <= 0;

    /* Closed once the clock has gone, whatever the verdict. */
    const closed = expired || outOfTime || !coding || engine.isAccepted(mark);

    mockState.final = closed;
    /* Frozen after EVERY submission, not only after the question closes.

       The code on screen has to be the code that was judged. If it stayed
       editable while the verdict was showing, the reader could change it, see
       "Incorrect Answer" still sitting there, and leave with a result that
       described something they had already replaced. Edit & Resubmit is the way
       back, and it unfreezes deliberately. */
    if (coding) mockLockEditor(true);
    if (closed) mockStopTimer();

    mockEl("mock-q-body")?.querySelector(".mock-q-options")?.classList.add("is-answered");

    mockRenderResult(question, mark, { expired, final: closed, canRetry: !closed });

    mockShow("mock-q-validation", false);
    mockShow("mock-submit-btn", false);
    mockShow("mock-edit-btn", !closed);
    mockShow("mock-next-btn", true);
    mockSetNextLabel();
  };

  /* Hands the editor back after a wrong answer.

     The code stays exactly as it was - it is still in results[] and in the
     draft, so nothing is re-typed - and the clock keeps running, because the
     whole point is that there is time left to use. */
  const mockEditResubmit = () => {
    const question = currentQuestion();
    if (!question || mockState.final || mockState.submitting) return;
    /* No second go after the clock has gone, whatever the button says. */
    if (mockTimeLeft() <= 0) return;

    mockState.submitted = false;
    mockState.submitting = false;
    mockLockEditor(false);

    /* Cleared so the previous attempt's verdict is not still on screen while the
       reader edits - it would describe code they are in the middle of changing. */
    const result = mockEl("mock-q-result");
    if (result) result.replaceChildren();

    mockShow("mock-edit-btn", false);
    mockShow("mock-submit-btn", true);
    mockShow("mock-next-btn", false);
    mockShow("mock-q-validation", false);

    const submitBtn = mockEl("mock-submit-btn");
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit answer";
    }
    /* The editor still holds the previous answer, so Submit is available at once
       - and stays available if they delete it, which the validation catches. */
    mockRefreshSubmit();
    mockEditor?.focus();
    mockEl("mock-q-lock")?.scrollIntoView?.({ block: "nearest" });
  };

  const mockSubmit = async ({ expired = false } = {}) => {
    const engine = MOCK_TEST_ENGINE();
    const question = currentQuestion();
    if (!engine || !question) return;
    /* One submission at a time. */
    if (mockState.submitting) return;
    /* A closed question takes no more answers - which is also what stops the
       clock running out twice producing two results. */
    if (mockState.final && !expired) return;
    /* Already judged and not being reopened, so the next thing to do is edit. */
    if (mockState.submitted && !expired) return;

    if (question.kind === "objective") {
      if (mockState.chosenOption === null && !expired) {
        mockShowPopup("Please select your answer.");
        /* Visually pressed, so the button acknowledges the tap it is refusing
           rather than appearing not to have noticed it. */
        const btn = mockEl("mock-submit-btn");
        if (btn) {
          btn.classList.add("is-refused");
          setTimeout(() => btn.classList.remove("is-refused"), 400);
        }
        /* Put the reader's attention where the problem is: the options, not the
           button they have just been told will not work. Queried from the
           document rather than closed over - `options` belongs to the question
           that drew them and does not exist here. */
        mockEl("mock-q-body")?.querySelector(".mock-q-option")?.focus?.();
        return;
      }
      /* Nothing chosen and nothing to run: a question the reader skipped past,
         recorded as unanswered rather than guessed at. */
      if (mockState.chosenOption === null) {
        mark = {
          ...engine.markObjective(question, null),
          answered: false,
          correct: false,
          detail: "No option was selected."
        };
      }
    }

    /* The same check the button enforces, run again here. The button can be
       disabled, but a keypress or a screen reader can reach this function
       without going through it - and expiry has to be allowed through, so that
       an empty editor becomes "not answered" rather than an error. */
    if (question.kind === "coding") {
      const code = mockEditor ? mockEditor.getValue() : "";
      if (!engine.hasCode(code) && !expired) {
        mockRefreshSubmit();
        return;
      }
    }

    mockState.submitting = true;
    const submitBtn = mockEl("mock-submit-btn");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = expired ? "Time is up" : "Marking…";
    }
    if (mockEl("mock-edit-btn")) mockEl("mock-edit-btn").disabled = true;

    let mark;
    let submittedCode = "";

    if (question.kind === "coding") {
      /* Whatever is in the editor right now. On expiry that is whatever was
         half-written when the clock went, and it is judged as it stands. */
      submittedCode = mockEditor ? mockEditor.getValue() : "";
      const language = normalizeLanguage(mockLanguageSelect?.value);
      /* Kept against the question, not against the language, so switching
         languages and coming back finds this question's answer. */
      mockDraftSet(question, language, submittedCode);

      if (!engine.hasCode(submittedCode)) {
        /* Nothing to run. Recorded as unanswered rather than handed to a runner
           to produce a compile error about an empty program. */
        mark = {
          ...engine.markCoding({ compiled: false, tests: [], code: "" }),
          verdict: engine.VERDICT.UNANSWERED,
          tone: engine.VERDICT_TONE[engine.VERDICT.UNANSWERED],
          label: engine.VERDICT_LABEL[engine.VERDICT.UNANSWERED],
          answered: false,
          correct: false,
          detail: expired
            ? "The ten minutes ran out before anything was submitted."
            : "No code was submitted."
        };
      } else {
        mark = await mockEvaluateCoding(question, submittedCode);
      }
    } else if (mark === undefined) {
      mark = engine.markObjective(question, mockState.chosenOption);
    }

    mockState.submitted = true;
    mockState.submitting = false;
    if (mockEl("mock-edit-btn")) mockEl("mock-edit-btn").disabled = false;

    /* The previous attempt is kept alongside the new one rather than replaced,
       so the results screen can say how many goes it took and Review can show
       what changed. Only the last one counts: it is the final answer. */
    const previous = mockState.results[mockState.index];
    const attempt = (previous?.attempts || 0) + 1;
    mockState.results[mockState.index] = {
      question,
      mark,
      code: submittedCode,
      expired,
      attempts: attempt,
      previous: previous ? { mark: previous.mark, code: previous.code } : null
    };

    mockAfterSubmit(mark, { expired });
  };
  /* A past sitting belongs beside the start screen and the results screen, and
     nowhere else. Shown and hidden alongside the run panel so the two can never
     disagree about whether a test is in progress. */
  const mockSyncHistoryPanel = () => {
    /* Shown only while the run panel is out of the way - that is, on the start
       screen and on the results screen, and never during a test. */
    mockShow("mock-history-panel", Boolean(mockEl("mock-run")?.hasAttribute("hidden")));
  };

  /* -------------------------------------------------------------- result */

  /* A short status line with a shape, not just a colour: a tick for a right
     answer, a cross for a wrong one, a dash for one nobody could judge, and a
     dot for a question nobody answered. Colour alone would leave the same
     distinction to be guessed at. */
  const mockStatusMark = (tone) =>
    tone === "correct" ? "✓" : tone === "wrong" ? "✗" : tone === "error" ? "!" : tone === "unknown" ? "?" : "–";

  const mockStatusLine = (mark, { expired = false } = {}) => {
    const line = document.createElement("p");
    line.className = `mock-status is-${mark.tone || "unknown"}`;
    const glyph = document.createElement("span");
    glyph.className = "mock-status__mark";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = expired ? "⏱" : mockStatusMark(mark.tone);
    const text = document.createElement("span");
    text.className = "mock-status__text";
    text.textContent = expired && mark.verdict === "unanswered" ? "Time is up" : mark.label;
    line.append(glyph, text);
    return line;
  };

  /* The worked examples that were run, as rows a reader can check. */
  const mockTestTable = (tests) => {
    const table = document.createElement("div");
    table.className = "mock-tests";
    const head = document.createElement("p");
    head.className = "mock-tests__head";
    head.textContent = `${tests.filter((t) => t.passed).length} of ${tests.length} worked example${tests.length === 1 ? "" : "s"} passed`;
    table.appendChild(head);

    for (const test of tests) {
      const row = document.createElement("div");
      row.className = `mock-tests__row ${test.passed ? "is-pass" : "is-fail"}`;
      const name = document.createElement("span");
      name.className = "mock-tests__name";
      name.textContent = test.label;
      const detail = document.createElement("span");
      detail.className = "mock-tests__detail";
      detail.textContent = test.passed
        ? `returned ${test.got}`
        : `expected ${test.expected}, got ${test.got}`;
      const verdict = document.createElement("span");
      verdict.className = "mock-tests__verdict";
      verdict.textContent = test.passed ? "Passed" : "Failed";
      row.append(name, detail, verdict);
      table.appendChild(row);
    }
    return table;
  };

  /* The submitted code, kept whole. Used by the result card and by Review, so a
     reader can see exactly what they sent rather than a summary of it. */
  const mockCodeBlock = (code, label = "Your code") => {
    const wrap = document.createElement("details");
    wrap.className = "mock-code";
    const summary = document.createElement("summary");
    summary.textContent = label;
    const pre = document.createElement("pre");
    pre.className = "mock-result__code";
    pre.textContent = code;
    wrap.append(summary, pre);
    return wrap;
  };

  const mockRenderResult = (question, mark, { expired = false, final = false, canRetry = false } = {}) => {
    const engine = MOCK_TEST_ENGINE();
    const host = mockEl("mock-q-result");
    if (!host) return;
    host.replaceChildren();

    const card = document.createElement("div");
    card.className = `mock-result is-${mark.tone || "unknown"}`;

    card.appendChild(mockStatusLine(mark, { expired }));

    /* How many goes it took. One is the ordinary case; saying so is worth
       nothing, so it only appears when there was more than one - at which point
       the reader is looking at the answer that was judged, not the first one
       they tried. */
    const attempt = mockState.results[mockState.index]?.attempts || 1;
    if (attempt > 1) {
      const tried = document.createElement("p");
      tried.className = "mock-result__attempts";
      tried.textContent = `Attempt ${attempt} - this is the answer that was judged.`;
      card.appendChild(tried);
    }

    if (mark.detail) {
      const d = document.createElement("p");
      d.className = "mock-result__detail";
      d.textContent = mark.detail;
      card.appendChild(d);
    }

    /* What the check actually ran. This is the evidence behind the verdict, so
       it is shown even when the verdict was right. */
    if (mark.tests && mark.tests.length) card.appendChild(mockTestTable(mark.tests));

    if (mark.kind === "coding") {
      if (mark.stdout || mark.stderr || mark.observation) {
        const out = document.createElement("pre");
        out.className = "mock-result__output";
        out.textContent = mark.observation || (mark.stdout || "") + (mark.stderr ? (mark.stdout ? "\n" : "") + mark.stderr : "");
        card.appendChild(out);
      }
      if (mark.code) card.appendChild(mockCodeBlock(mark.code));
    }

    if (mark.kind === "objective") {
      const answer = document.createElement("p");
      answer.className = "mock-result__answer";
      answer.innerHTML = `<strong>The correct answer:</strong> ${escapeHtml(mark.correctText || "")}`;
      card.appendChild(answer);
      if (mark.explanation) {
        const why = document.createElement("div");
        why.className = "mock-result__why";
        why.innerHTML = renderExplanationHtml(mark.explanation);
        card.appendChild(why);
      }
    } else {
      /* Coding: the approach, its complexity, and an honest label for what that
         approach is. Quanta stores no reference solutions, so it does not claim
         to be showing "the optimal solution" for this problem. */
      const explanation = engine.explanationFor(question, window.PATTERNS || []);
      if (explanation.pattern) {
        const head = document.createElement("p");
        head.className = "mock-result__answer";
        head.innerHTML = `<strong>How this class of problem is solved — ${escapeHtml(explanation.pattern.title)}:</strong>`;
        card.appendChild(head);

        if (explanation.shape) {
          const shape = document.createElement("div");
          shape.className = "mock-result__why";
          shape.innerHTML = renderExplanationHtml(explanation.shape);
          card.appendChild(shape);
        }
        if (explanation.approach) {
          const code = document.createElement("pre");
          code.className = "mock-result__code";
          code.textContent = explanation.approach;
          card.appendChild(code);
        }
        if (explanation.checklist && explanation.checklist.length) {
          const list = document.createElement("ul");
          list.className = "mock-result__checks";
          for (const item of explanation.checklist) {
            const li = document.createElement("li");
            li.textContent = item;
            list.appendChild(li);
          }
          card.appendChild(list);
        }
        /* Complexity measured from the approach shown, by the app's own
           analyser - not a stored figure, and not a claim about the reader's
           code. */
        const complexity = estimateComplexityLabel(explanation.approach);
        if (complexity) {
          const c = document.createElement("p");
          c.className = "mock-result__complexity";
          c.innerHTML = `<strong>${escapeHtml(complexity.label)}</strong> — measured on the approach above, not on your code.`;
          card.appendChild(c);
        }
        const note2 = document.createElement("p");
        note2.className = "mock-result__note";
        note2.textContent = explanation.note;
        card.appendChild(note2);
      } else {
        const none = document.createElement("p");
        none.className = "mock-result__note";
        none.textContent = explanation.note;
        card.appendChild(none);
      }
    }

    /* Whether another go is possible, said plainly. A reader who has been marked
       wrong and sees nothing else has no way of telling whether that is the end
       of the question or just this attempt. */
    if (final) {
      const done = document.createElement("p");
      done.className = "mock-result__closed";
      const left = mockTimeLeft();
      done.textContent = expired || left <= 0
        ? "Time is up. This question is closed."
        : mark.kind === "coding" && MOCK_TEST_ENGINE()?.isAccepted(mark)
          ? "Accepted - this question is closed."
          : "This question is closed.";
      card.appendChild(done);
    } else if (canRetry) {
      const again = document.createElement("p");
      again.className = "mock-result__retry";
      const left = Math.max(0, Math.round(mockTimeLeft()));
      again.textContent = `There is still time. Edit your answer and submit again - ${Math.floor(left / 60)}m ${String(left % 60).padStart(2, "0")}s left.`;
      card.appendChild(again);
    }

    host.appendChild(card);
  };

  /* Runs the app's own complexity analyser over a piece of code and turns the
     result into a sentence. Returns null when it cannot say anything useful,
     rather than printing an empty or invented figure. */
  const estimateComplexityLabel = (code) => {
    const engine = window.solutionAnalysis;
    if (!engine || typeof engine.estimateComplexity !== "function") return null;
    try {
      const time = engine.estimateComplexity(code);
      const space = typeof engine.estimateSpace === "function" ? engine.estimateSpace(code) : null;
      const timeLabel = time?.time;
      const spaceLabel = space?.space;
      if (!timeLabel && !spaceLabel) return null;
      const parts = [];
      if (timeLabel) parts.push(`Time ${timeLabel}`);
      if (spaceLabel) parts.push(`Space ${spaceLabel}`);
      return { label: parts.join(" · "), reason: [time?.reason, space?.reason].filter(Boolean).join(" ") };
    } catch {
      /* The analyser refusing to say is fine. Nothing is shown, rather than a
         guess being presented as a measurement. */
      return null;
    }
  };

  /* Objective explanations are written by the Academy and the pattern trainer,
     with newlines meaning separate points. Rendered as paragraphs and lists
     rather than injected as markup. */
  const renderExplanationHtml = (text) => {
    const blocks = String(text || "").split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
    return blocks
      .map((block) => {
        const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
        if (lines.length > 1 && lines.every((l) => /^[-\u2022*]/.test(l))) {
          return `<ul>${lines.map((l) => `<li>${escapeHtml(l.replace(/^[-\u2022*]\s*/, ""))}</li>`).join("")}</ul>`;
        }
        return `<p>${escapeHtml(lines.join(" "))}</p>`;
      })
      .join("");
  };

  /* --------------------------------------------------------------- next */

  const mockNext = () => {
    mockStopTimer();
    mockState.final = true;
    if (mockState.index >= mockState.questions.length - 1) {
      mockFinishTest();
      return;
    }
    mockState.index += 1;
    void mockOpenQuestion();
  };

  /* ------------------------------------------------------------ results */

  /* The finished test.

     Cards, not a paragraph: the reader has three results to compare against each
     other, and a sentence has to be read while a card can be scanned. Each card
     carries the verdict, what was submitted, and a panel that opens onto the
     evidence - the worked examples that were run, the approach, the complexity -
     which is the same material the question screen showed, kept here so the test
     can be reviewed afterwards without being taken again.

     Review is deliberately read-only. It opens the saved answer; it does not put
     it back in the editor, so looking at question one cannot overwrite the code
     belonging to another question, and there is nothing on the results screen
     that could submit anything. */

  const mockResultsAnswerLine = (entry) => {
    const line = document.createElement("dl");
    line.className = "mock-res__meta";
    const add = (label, value) => {
      const group = document.createElement("div");
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      group.append(dt, dd);
      line.appendChild(group);
    };

    if (entry.question.kind === "objective") {
      add("Your answer", entry.mark.chosenText || "Nothing selected");
      add("Correct answer", entry.mark.correctText || "");
    } else if (!entry.mark.answered) {
      add("Your answer", entry.expired ? "Time ran out" : "Nothing submitted");
    } else {
      const passed = entry.mark.passed || 0;
      const tested = entry.mark.tested || 0;
      add("Your answer", tested
        ? `Code submitted — ${passed} of ${tested} worked example${tested === 1 ? "" : "s"} passed`
        : "Code submitted");
      /* Shown only when it happened: the final answer is what counts, and saying
         so stops it looking like the only thing tried. */
      if ((entry.attempts || 1) > 1) {
        add("Attempts", `${entry.attempts} — the last one is the answer that was judged`);
      }
    }
    return line;
  };

  const mockResultsDetail = (entry) => {
    const engine = MOCK_TEST_ENGINE();
    const panel = document.createElement("div");
    panel.className = "mock-res__detail";

    if (entry.mark.detail) {
      const p = document.createElement("p");
      p.className = "mock-res__why";
      p.textContent = entry.mark.detail;
      panel.appendChild(p);
    }

    if (entry.mark.tests && entry.mark.tests.length) panel.appendChild(mockTestTable(entry.mark.tests));

    if (entry.question.kind === "coding") {
      if (entry.mark.observation) {
        const out = document.createElement("pre");
        out.className = "mock-result__output";
        out.textContent = entry.mark.observation;
        panel.appendChild(out);
      } else if (entry.mark.stderr) {
        const out = document.createElement("pre");
        out.className = "mock-result__output";
        out.textContent = entry.mark.stderr;
        panel.appendChild(out);
      }
      if (entry.code) panel.appendChild(mockCodeBlock(entry.code, "The code you submitted"));

      if (entry.previous) {
        const was = document.createElement("p");
        was.className = "mock-res__previous";
        const previousVerdict = entry.previous.mark?.label || "an earlier result";
        was.textContent = `The first attempt was marked "${previousVerdict}". Only the last attempt counts towards the score.`;
        panel.appendChild(was);
        if (entry.previous.code) panel.appendChild(mockCodeBlock(entry.previous.code, "Your first attempt"));
      }

      const explanation = engine.explanationFor(entry.question, window.PATTERNS || []);
      if (explanation.pattern) {
        const head = document.createElement("p");
        head.className = "mock-res__answer";
        head.innerHTML = `<strong>How this class of problem is solved — ${escapeHtml(explanation.pattern.title)}:</strong>`;
        panel.appendChild(head);
        if (explanation.shape) {
          const shape = document.createElement("div");
          shape.className = "mock-res__why";
          shape.innerHTML = renderExplanationHtml(explanation.shape);
          panel.appendChild(shape);
        }
        if (explanation.approach) {
          const code = document.createElement("pre");
          code.className = "mock-result__code";
          code.textContent = explanation.approach;
          panel.appendChild(code);
        }
        if (explanation.checklist && explanation.checklist.length) {
          const list = document.createElement("ul");
          list.className = "mock-result__checks";
          for (const item of explanation.checklist) {
            const li = document.createElement("li");
            li.textContent = item;
            list.appendChild(li);
          }
          panel.appendChild(list);
        }
        const complexity = estimateComplexityLabel(explanation.approach);
        if (complexity) {
          const c = document.createElement("p");
          c.className = "mock-result__complexity";
          c.innerHTML = `<strong>${escapeHtml(complexity.label)}</strong> — measured on the approach above, not on your code.`;
          panel.appendChild(c);
        }
        const note = document.createElement("p");
        note.className = "mock-result__note";
        note.textContent = explanation.note;
        panel.appendChild(note);
      } else {
        const none = document.createElement("p");
        none.className = "mock-result__note";
        none.textContent = explanation.note;
        panel.appendChild(none);
      }
    } else if (entry.mark.explanation) {
      const why = document.createElement("div");
      why.className = "mock-res__why";
      why.innerHTML = renderExplanationHtml(entry.mark.explanation);
      panel.appendChild(why);
    }

    return panel;
  };

  const mockRenderResults = () => {
    const engine = MOCK_TEST_ENGINE();
    const marks = mockState.results.filter(Boolean).map((entry) => entry.mark);
    const tally = engine.summarise(marks);

    const score = mockEl("mock-score");
    if (score) {
      score.textContent = tally.total
        ? `${tally.correct} of ${tally.total} correct`
        : "Nothing was recorded";
    }

    /* Four tiles rather than one sentence, so "2 correct, 1 wrong, 1 not
       answered, 2 could not be checked" can be read at a glance. Each tile is
       only shown when it has something to report, except the first - an empty
       row of zeroes reads as a fault in the app rather than a fact about the
       test. */
    const tallyHost = mockEl("mock-results-tally");
    if (tallyHost) {
      tallyHost.replaceChildren();
      const tiles = [
        { tone: "correct", label: "Correct", value: tally.correct, always: true },
        { tone: "wrong", label: "Incorrect", value: tally.incorrect },
        { tone: "unanswered", label: "Not answered", value: tally.unanswered },
        { tone: "unknown", label: "Unable to evaluate", value: tally.unevaluated }
      ];
      for (const tile of tiles) {
        if (!tile.value && !tile.always) continue;
        const box = document.createElement("div");
        box.className = `mock-tile is-${tile.tone}`;
        const value = document.createElement("p");
        value.className = "mock-tile__value";
        value.textContent = String(tile.value);
        const label = document.createElement("p");
        label.className = "mock-tile__label";
        label.textContent = tile.label;
        box.append(value, label);
        tallyHost.appendChild(box);
      }
    }

    const list = mockEl("mock-summary-list");
    if (list) {
      list.replaceChildren();
      mockState.results.filter(Boolean).forEach((entry, i) => {
        const item = document.createElement("article");
        item.className = `mock-res__item is-${entry.mark.tone || "unknown"}`;

        const head = document.createElement("header");
        head.className = "mock-res__head";
        const n = document.createElement("span");
        n.className = "mock-res__n";
        n.textContent = `Q${i + 1}`;
        const kind = document.createElement("span");
        kind.className = "mock-res__kind";
        kind.textContent = entry.question.kind === "coding" ? "Coding" : "Multiple choice";
        head.append(n, kind, mockStatusLine(entry.mark, { expired: entry.expired }));
        item.appendChild(head);

        const title = document.createElement("h4");
        title.className = "mock-res__title";
        title.textContent = entry.question.prompt;
        item.appendChild(title);

        item.appendChild(mockResultsAnswerLine(entry));

        /* Opens onto the saved answer and the evidence. Not a link and not a
           form: there is nothing here that can be pressed into changing the
           record of what was submitted. */
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "mock-res__toggle";
        toggle.setAttribute("aria-expanded", "false");
        const toggleLabel = document.createElement("span");
        toggleLabel.textContent = "Review answer";
        const chevron = document.createElement("span");
        chevron.className = "mock-res__chevron";
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "▾";
        toggle.append(toggleLabel, chevron);

        const detail = mockResultsDetail(entry);
        detail.hidden = true;
        const panelId = `mock-res-detail-${i}`;
        detail.id = panelId;
        toggle.setAttribute("aria-controls", panelId);
        toggle.addEventListener("click", () => {
          const open = detail.hidden;
          detail.hidden = !open;
          toggle.setAttribute("aria-expanded", open ? "true" : "false");
          toggle.classList.toggle("is-open", open);
        });
        item.append(toggle, detail);
        list.appendChild(item);
      });
    }

    return tally;
  };

  const mockFinishTest = () => {
    mockStopTimer();
    if (mockState.finished) return;
    if (!mockState.results.filter(Boolean).length) return;
    mockState.finished = true;

    mockShow("mock-run", false);
    mockSyncHistoryPanel();
    mockShow("mock-summary", true);

    const tally = mockRenderResults();

    /* Recorded once, from this attempt only. The previous attempt's entry is a
       separate row in the history, not a second copy of this one. */
    mockState.history.unshift({
      questions: mockState.results.filter(Boolean).map((r) => r.question.prompt),
      right: tally.correct,
      total: tally.total,
      unchecked: tally.unevaluated,
      at: new Date().toISOString()
    });
    mockSaveHistory();
    mockRenderHistory();

    /* The attempt's state is released now that it has been recorded, so Retake
       starts from nothing and the editor cannot still be holding this test's
       code. The history keeps what happened; the test itself is gone. */
    mockState.results = [];
    mockState.questions = [];
    mockState.index = 0;
    mockState.finished = false;
    mockState.final = false;
    mockDraftsClear();
    if (mockEditor) {
      mockEditor.setValue("");
      mockLockEditor(false);
    }
    mockSetOutput("");

    mockEl("mock-summary")?.scrollIntoView?.({ block: "nearest" });
  };

  /* ------------------------------- history -------------------------------
   *
   * Finished tests are kept so the reader can see how the last few went. It
   * reuses the same storage key the old single-problem interview used, so a
   * reader who has used Quanta before does not lose their record when this panel
   * changes shape - old entries simply render without a score. */
  const mockLoadHistory = () => {
    const raw = readJson(window.MOCK_KEY || "quantaMockInterviewsV1", () => ({}));
    mockState.history = Array.isArray(raw?.history) ? raw.history : [];
  };

  const mockSaveHistory = () => {
    writeJson(window.MOCK_KEY || "quantaMockInterviewsV1", { history: mockState.history.slice(0, 20) });
  };

  const mockClockText = (seconds) => {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  };

  const mockRenderHistory = () => {
    const host = mockEl("mock-history");
    if (!host) return;
    host.replaceChildren();
    if (!mockState.history.length) {
      const none = document.createElement("p");
      none.className = "viz-note--plain";
      none.textContent = "No tests finished yet. Finish one and it will appear here.";
      host.appendChild(none);
      return;
    }
    const list = document.createElement("div");
    list.className = "mock-history__list";
    for (const item of mockState.history) {
      const row = document.createElement("div");
      row.className = "mock-history__row";
      const name = document.createElement("span");
      name.className = "mock-history__name";
      /* Entries written before this panel changed had a single title. Entries
         written now have a list of question names. Both are rendered, because
         deleting the reader's record to tidy up the code would be a poor
         trade. */
      name.textContent = Array.isArray(item.questions) ? item.questions.join(" · ") : item.title || "Mock test";
      const detail = document.createElement("span");
      detail.className = "mock-history__detail";
      detail.textContent =
        typeof item.right === "number"
          ? `${item.right} of ${item.total} correct${item.unchecked ? `, ${item.unchecked} unchecked` : ""}`
          : item.difficulty
            ? `${mockClockText(item.elapsed)} · ${item.difficulty}`
            : mockClockText(item.elapsed || 0);
      row.append(name, detail);
      list.appendChild(row);
    }
    host.appendChild(list);
  };

  /* ---------------------------------------------------------------- init */

  const initMock = () => {
    initMockWorkspace();
  };
  /* ------------------------------ mock editor -----------------------------
   *
   * The coding answer is written here, in the Code Lab's own editor, and run by
   * the Lab's own runner. Nothing about running code is reimplemented: same
   * Monaco setup, same language list, same executeCode(), so the same code
   * behaves the same in both places and the same runner answers for both.
   *
   * What is deliberately absent is the Lab's file management - sessions, tabs,
   * New/Rename/Delete, Save, zoom, auto-save. A test question needs somewhere to
   * type, not somewhere to organise files.
   *
   * Built on the first visit to the panel rather than at start-up: a second
   * Monaco instance is a real memory cost, and most sessions never open a mock
   * test. Safe to call on every visit, since it returns once it exists. */
  const mockEditorNode = byId("mock-monaco-editor");
  const mockLanguageSelect = byId("mock-language-select");
  const mockOutput = byId("mock-output");
  const mockRunBtn = byId("mock-run-btn");
  const MOCK_CODE_KEY = "quantaMockCodeV1";
  let mockEditor = null;
  /* Set while an editor is being built, so a second caller waits for that build
     instead of starting one of its own. */
  let mockEditorPromise = null;
  let mockRunning = false;

  const mockSetOutput = (text) => {
    if (!mockOutput) return;
    mockOutput.textContent = String(text == null ? "" : text);
    mockOutput.scrollTop = mockOutput.scrollHeight;
  };

  /* Which language is selected. Kept so a switch between questions puts the
     right draft on screen, not so a single buffer can be shared. */
  const mockCodeState = { language: DEFAULT_LANGUAGE };

  /* The language is remembered between visits, because choosing Java once and
     then being dropped back to Python each time a panel opens is its own small
     irritation. The CODE is not remembered - it belongs to a question. */
  const mockLoadCodeState = () => {
    try {
      const saved = readJson(MOCK_CODE_KEY, () => ({}));
      if (saved && typeof saved === "object") mockCodeState.language = normalizeLanguage(saved.language);
    } catch {
      /* A corrupt stored value must not stop the test starting. */
    }
  };

  const mockRenderLanguages = () => {
    if (!mockLanguageSelect || mockLanguageSelect.options.length) return;
    for (const id of LANGUAGE_IDS) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = getLanguageDef(id).label;
      mockLanguageSelect.appendChild(option);
    }
    mockLanguageSelect.value = mockCodeState.language;
  };

  /* Swapping language must save the question's draft for the language being
     left and load the one for the language being entered. Getting that backwards
     is how a half-written answer ends up filed against the wrong question. */
  const mockApplyModel = () => {
    if (!mockEditor || !window.monaco?.editor) return;
    const language = normalizeLanguage(mockLanguageSelect?.value);
    mockCodeState.language = language;
    const question = currentQuestion();
    /* An objective question has no editor, so there is no draft to key to.
       Anything typed here belongs to nobody, and is dropped on the next
       question rather than leaking into one. */
    const code = question && question.kind === "coding" ? mockDraftGet(question, language) : "";
    mockEditor.setModel(window.monaco.editor.createModel(code, getLanguageDef(language).monaco));
    syncMonacoTheme();
    mockRefreshSubmit();
  };

  const ensureMockEditor = async () => {
    mockRenderLanguages();
    if (!mockEditorNode) return null;
    if (mockEditor) {
      /* Monaco measures its container on demand. After the divider moves, or
         after the page was hidden while a question was open, that measurement is
         stale and the editor draws at the wrong size. */
      mockEditor.layout();
      return mockEditor;
    }
    /* A build is already under way - from the other caller. Waiting on that same
       promise is what keeps this to one editor. */
    if (mockEditorPromise) return mockEditorPromise;
    mockEditorPromise = buildMockEditor();
    try {
      return await mockEditorPromise;
    } finally {
      /* Cleared so a later failure does not leave a rejected promise behind for
         every future caller to inherit. The editor itself is kept. */
      mockEditorPromise = null;
    }
  };

  const buildMockEditor = async () => {
    /* Re-checked inside the build as well, because a caller that arrives while
       this one is awaiting Monaco will have been given this promise, not its
       own. */
    if (mockEditor) return mockEditor;
    const monaco = await ensureMonaco();
    mockCodeState.language = normalizeLanguage(mockLanguageSelect?.value || mockCodeState.language);
    mockEditor = monaco.editor.create(mockEditorNode, {
      /* Starts empty. Whatever this question needs is loaded straight after, from
         its own draft - so a question never inherits the previous one's answer. */
      value: "",
      language: getLanguageDef(mockCodeState.language).monaco,
      automaticLayout: true,
      tabSize: 4,
      insertSpaces: true,
      bracketPairColorization: { enabled: true },
      autoClosingBrackets: "always",
      autoClosingQuotes: "always",
      autoIndent: "full",
      formatOnPaste: true,
      formatOnType: true,
      minimap: { enabled: false },
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
    mockEditor.onDidChangeModelContent(() => {
      /* Files the text against the question that is open, and refreshes whether
         Submit may be pressed - the same keystroke that makes an empty editor
         usable is the one that has to notice. */
      const question = currentQuestion();
      if (question && question.kind === "coding") {
        mockDraftSet(question, mockCodeState.language, mockEditor.getValue());
      }
      mockRefreshSubmit();
    });
    syncMonacoTheme();
    return mockEditor;
  };

  /* Runs whatever is in the editor. Separate from submitting, so a reader can
     try their code without being marked - the answer is only marked when they
     press Submit. */
  const mockRun = async () => {
    if (mockRunning) return;
    const editor = await ensureMockEditor();
    if (!editor) return;
    mockRunning = true;
    if (mockRunBtn) {
      mockRunBtn.disabled = true;
      mockRunBtn.classList.add("is-running");
      const label = mockRunBtn.querySelector("span");
      if (label) label.textContent = "Running…";
    }
    mockSetOutput("Running…");
    mockOutput?.classList.remove("is-error");
    const language = normalizeLanguage(mockLanguageSelect?.value);
    try {
      const result = await executeCode(language, editor.getValue(), "");
      const parts = [];
      if (result.stdout) parts.push(result.stdout.replace(/\n$/, ""));
      if (result.stderr) parts.push(result.stderr.replace(/\n$/, ""));
      mockSetOutput(parts.length ? parts.join("\n") : "(no output)");
      if (result.timedOut || !result.ok) mockOutput?.classList.add("is-error");
    } catch (error) {
      mockSetOutput("Unexpected error: " + (error?.message || error));
      mockOutput?.classList.add("is-error");
    } finally {
      mockRunning = false;
      if (mockRunBtn) {
        mockRunBtn.disabled = false;
        mockRunBtn.classList.remove("is-running");
        const label = mockRunBtn.querySelector("span");
        if (label) label.textContent = "Run";
      }
    }
  };

  const initMockWorkspace = () => {
    mockLoadHistory();
    mockRenderHistory();
    mockLoadCodeState();
    mockRenderLanguages();

    mockLanguageSelect?.addEventListener("change", () => {
      /* The answer being left behind is filed against the question that is open
         now, before the language changes - otherwise it would be filed against
         the language being entered and read back as that language's content. */
      const question = currentQuestion();
      if (mockEditor && question && question.kind === "coding") {
        mockDraftSet(question, mockCodeState.language, mockEditor.getValue());
      }
      mockApplyModel();
    });
    mockRunBtn?.addEventListener("click", () => void mockRun());

    mockRenderPoolNote();
    mockEl("mock-start-btn")?.addEventListener("click", () => mockStartTest());
    mockEl("mock-submit-btn")?.addEventListener("click", () => void mockSubmit());
    mockEl("mock-q-guard")?.addEventListener("click", () => mockSubmit());
    /* The guard is measured from the button, and the button's box changes with
       the window - so the guard has to be measured again when it does. */
    window.addEventListener("resize", () => mockRefreshSubmit());
    mockEl("mock-edit-btn")?.addEventListener("click", () => mockEditResubmit());
    mockEl("mock-next-btn")?.addEventListener("click", () => mockNext());
    /* Retake: straight into a fresh test, not back to the start panel. */
    mockEl("mock-again-btn")?.addEventListener("click", () => mockStartTest());

    /* A page left in the background kept counting down without the reader
       seeing it. The clock is ticked so coming back shows time that really
       passed rather than time that quietly froze.

       Expiry goes through the same submit path as a press of the button, so an
       empty editor at expiry becomes "not answered" rather than an error, and a
       filled one is still evaluated properly. */
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden || mockState.remaining === null) return;
      mockState.remaining = MOCK_TEST_ENGINE().tick(mockState.remaining);
      mockRenderClock();
      if (mockState.remaining <= 0 && !mockState.submitted) {
        mockStopTimer();
        void mockSubmit({ expired: true });
      }
    });
  };

  /* ---------------------- solution comparison -------------------------- */
  /* The analysis lives in solutions.js, checked by scripts/test-solutions.js.
     This half renders it into the existing Solutions tab. It reads the code
     rather than the complexity the user typed, and shows both when they
     disagree instead of silently preferring either. */

  /* ======================= solution comparison UI ========================
     Adds a comparison view to the existing Solutions tab.

     The app already stored several named solutions per problem with free-text
     complexity fields, and listed them. This adds the missing half: reading the
     CODE, working out what the loops imply, ranking the versions against each
     other, and flagging any case where the written-down complexity disagrees with
     what the code actually does.

     It deliberately does not replace the user's own complexity notes. Where the
     two differ, both are shown and the disagreement is named - the reader is in a
     better position than either source alone to know which is right. */

  const solutionEl = (id) => document.getElementById(id);

  /* Reads the solutions already saved for a problem. It uses the existing
     `listSolutionsFor` accessor rather than reaching into storage, so the
     comparison works for solutions stored on the server and for ones saved
     offline while disconnected - exactly the same source the list below it
     renders from, so the two can never disagree. */
  const solutionSavedFor = async (slug) => {
    if (!slug) return [];
    try {
      const items = await listSolutionsFor(slug);
      return (Array.isArray(items) ? items : []).filter(
        (s) => s && typeof s.code === "string" && s.code.trim()
      );
    } catch {
      /* The solution list itself will report the failure. Comparison silently
         disappearing is better than replacing a working list with an error. */
      return [];
    }
  };

  /* Renders the comparison block above the existing solution list. Returns true
     when it drew something, so the caller can hide it when there is nothing to
     compare. */
  const renderSolutionComparison = async (slug, provided) => {
    const host = solutionEl("solution-compare");
    if (!host) return false;
    host.innerHTML = "";

    /* Takes the already-loaded solutions when the caller has them, so the
       comparison is guaranteed to describe exactly the list on screen rather
       than a second fetch that could disagree with it. */
    const source = Array.isArray(provided) ? provided : await solutionSavedFor(slug);
    const solutions = source.filter((s) => s && typeof s.code === "string" && s.code.trim());
    if (solutions.length < 1) {
      host.hidden = true;
      return false;
    }
    host.hidden = false;

    const analysis = window.solutionAnalysis;
    if (!analysis) {
      host.hidden = true;
      return false;
    }

    const { ranked, complete, unknownCount } = analysis.rankSolutions(
      solutions.map((solution) => ({
        id: solution.id,
        title: solution.title || "Untitled",
        language: solution.language || "",
        code: solution.code,
        statedTime: solution.timeComplexity || "",
        statedSpace: solution.spaceComplexity || ""
      }))
    );

    const heading = document.createElement("h4");
    heading.className = "solution-compare__title";
    heading.textContent =
      ranked.length > 1 ? "Comparing your versions" : "What the code says about this one";
    host.appendChild(heading);

    const intro = document.createElement("p");
    intro.className = "pattern-intro";
    intro.textContent =
      "Read from the code, not from the complexity you typed. Quanta cannot run your solution against the problem's hidden tests, so this says nothing about whether it is correct.";
    host.appendChild(intro);

    if (!complete) {
      const caveat = document.createElement("p");
      caveat.className = "solution-compare__caveat";
      caveat.textContent = `${unknownCount} of these could not be read from the shape of the code, so the order below is partial. Those are listed last rather than guessed at.`;
      host.appendChild(caveat);
    }

    const grid = document.createElement("div");
    grid.className = "solution-compare__grid";

    ranked.forEach((solution, index) => {
      const card = document.createElement("div");
      card.className = "solution-compare__card";
      if (solution.estimatedTime === null) card.classList.add("is-unknown");

      const head = document.createElement("div");
      head.className = "solution-compare__head";

      const rank = document.createElement("span");
      rank.className = "solution-compare__rank";
      /* Only a real fastest solution gets "fastest". An unreadable one is never
         crowned, even when it is the only one. */
      rank.textContent =
        solution.estimatedTime === null ? "?" : index === 0 && ranked[0].estimatedTime !== null ? "Fastest" : `#${index + 1}`;
      head.appendChild(rank);

      const name = document.createElement("span");
      name.className = "solution-compare__name";
      name.textContent = solution.title;
      head.appendChild(name);
      card.appendChild(head);

      const badges = document.createElement("div");
      badges.className = "solution-compare__badges";
      const time = document.createElement("span");
      time.className = "solution-compare__badge";
      time.textContent = `time ${solution.estimatedTime || "not readable"}`;
      badges.appendChild(time);
      if (solution.estimatedSpace) {
        const space = document.createElement("span");
        space.className = "solution-compare__badge";
        space.textContent = `space ${solution.estimatedSpace}`;
        badges.appendChild(space);
      }
      card.appendChild(badges);

      const why = document.createElement("p");
      why.className = "solution-compare__why";
      why.textContent = solution.timeReason;
      card.appendChild(why);

      /* The disagreement check, against whatever the user wrote down. */
      const statedTime = analysis.compareStated(solution.statedTime, solution.estimatedTime);
      const statedSpace = analysis.compareStated(solution.statedSpace, solution.estimatedSpace);
      for (const check of [statedTime, statedSpace]) {
        if (check.state === "unstated" || check.state === "unknown") continue;
        const line = document.createElement("p");
        line.className = `solution-compare__stated is-${check.state}`;
        line.textContent = check.text;
        card.appendChild(line);
      }

      grid.appendChild(card);
    });

    host.appendChild(grid);
    return true;
  };


  /* ---------------------- company preparation --------------------------- */
  /* The page reads real company records and can import a list the user
     already holds. It never scrapes one: no company question list is
     published as an API, and every imported row is labelled with where it
     came from so a claim is never shown as something Quanta verified. */

  /* ====================== company-wise preparation =======================
     The company page, and the import that gives it data.

     Two halves, because the truth about this feature is that the page works and
     the data does not exist:

       - The browse half reads companies, their problem counts and their
         difficulties from the database. It is fully functional and empty for a
         reason, which it states.
       - The import half takes a list the user already holds and loads it. That
         is the honest way to have company data: it is theirs, not harvested.

     Every imported row is labelled with where it came from, so a company list
     someone typed at a desk is never presented as though Quanta verified it. */

  const COMPANY_KEY = "quantaCompaniesV1";
  const companyState = { companies: [], note: "", selected: null, difficulty: "all", problems: [], importReport: null };

  const companyEl = (id) => document.getElementById(id);

  const companyLoadState = () => {
    const raw = readJson(COMPANY_KEY, () => ({}));
    const saved = raw && typeof raw === "object" ? raw : {};
    companyState.selected = typeof saved.selected === "string" ? saved.selected : null;
    companyState.difficulty = ["all", "Easy", "Medium", "Hard"].includes(saved.difficulty) ? saved.difficulty : "all";
    return raw;
  };

  const companySaveState = () => {
    writeJson(COMPANY_KEY, { selected: companyState.selected, difficulty: companyState.difficulty });
  };

  const companyFetch = async (path) => {
    const base = getApiBase();
    const response = await fetch(`${base}${path}`, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body?.error || `The server answered ${response.status}.`);
    }
    return response.json();
  };

  const companyRender = () => {
    const host = companyEl("company-list");
    const note = companyEl("company-note");
    const empty = companyEl("company-empty");
    if (!host) return;
    host.innerHTML = "";

    if (!companyState.companies.length) {
      if (note) {
        note.hidden = false;
        note.textContent = companyState.note || "No company lists are recorded yet.";
      }
      if (empty) empty.hidden = false;
      return;
    }
    if (note) note.hidden = true;
    if (empty) empty.hidden = true;

    for (const company of companyState.companies) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `company-chip${companyState.selected === company.slug ? " is-active" : ""}`;
      button.dataset.company = company.slug;

      const name = document.createElement("span");
      name.className = "company-chip__name";
      name.textContent = company.name;

      const count = document.createElement("span");
      count.className = "company-chip__count";
      count.textContent = String(company.problemCount);
      count.title = `${company.problemCount} problems in your catalog`;

      button.append(name, count);
      button.addEventListener("click", () => {
        companyState.selected = company.slug;
        companySaveState();
        companyRender();
        void companyLoadProblems();
      });
      host.appendChild(button);
    }
  };

  const companyLoadProblems = async () => {
    const host = companyEl("company-problems");
    if (!host) return;
    host.innerHTML = "";

    if (!companyState.selected) {
      const hint = document.createElement("p");
      hint.className = "viz-note--plain";
      hint.textContent = "Pick a company to see the problems recorded for it.";
      host.appendChild(hint);
      return;
    }

    const difficulty = companyState.difficulty === "all" ? "" : `&difficulty=${encodeURIComponent(companyState.difficulty)}`;
    try {
      const payload = await companyFetch(`/api/companies/${encodeURIComponent(companyState.selected)}/problems?${difficulty}`);
      companyState.problems = payload.items || [];
    } catch (error) {
      const failed = document.createElement("p");
      failed.className = "viz-note--error";
      failed.textContent = error.message;
      host.appendChild(failed);
      return;
    }

    const heading = document.createElement("p");
    heading.className = "pattern-intro";
    heading.textContent = companyState.problems.length
      ? `${companyState.problems.length} problem${companyState.problems.length === 1 ? "" : "s"}. Every one is tagged with where this record came from.`
      : "No problems recorded for this combination of filters.";
    host.appendChild(heading);

    for (const problem of companyState.problems) {
      const row = document.createElement("div");
      row.className = "company-problem";

      const meta = document.createElement("span");
      meta.className = `discovery-card__difficulty is-${String(problem.difficulty || "").toLowerCase()}`;
      meta.textContent = problem.difficulty || "";

      const name = document.createElement("span");
      name.className = "company-problem__name";
      name.textContent = problem.title;

      /* The provenance badge. This is the whole point: a company record says who
         claimed it, not that Quanta verified the claim. */
      const source = document.createElement("span");
      source.className = `company-problem__source is-${problem.confidence || "reported"}`;
      source.textContent = problem.confidence === "curated" ? "curated" : `from: ${problem.source || "an imported list"}`;
      source.title = problem.confidence === "curated"
        ? "Marked as curated rather than reported"
        : "Reported by an imported list, not verified by Quanta";

      const open = document.createElement("button");
      open.type = "button";
      open.className = "prog-btn";
      open.textContent = "Open";
      open.addEventListener("click", () => {
        const stored = Array.isArray(lcState?.problems) ? lcState.problems : [];
        const local = stored.find((p) => p.slug === problem.slug);
        if (local) {
          showPage("quantalab");
          selectLcProblem(local.id);
          return;
        }
        showPage("quantalab");
        const input = document.querySelector("#lc-search-input");
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(input, problem.title);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });

      row.append(meta, name, source, open);
      host.appendChild(row);
    }
  };

  /* Imports a list the user pasted or picked. Every outcome is reported: how
     many landed, which problems were not in the catalog, and which rows were
     unusable. A silent partial import would look like success. */
  const companyImport = async () => {
    const field = companyEl("company-import-data");
    const sourceField = companyEl("company-import-source");
    const report = companyEl("company-import-report");
    const button = companyEl("company-import-btn");
    if (!field || !button) return;

    const data = field.value.trim();
    if (!data) {
      if (report) {
        report.className = "viz-note--error";
        report.hidden = false;
        report.textContent = "Paste a list first.";
      }
      return;
    }

    button.disabled = true;
    const original = button.textContent;
    button.textContent = "Importing…";
    try {
      const base = getApiBase();
      const response = await fetch(`${base}/api/companies/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, source: sourceField?.value || "imported list" })
      });
      const payload = await response.json().catch(() => ({}));

      if (report) {
        report.hidden = false;
        if (!response.ok || !payload.ok) {
          report.className = "viz-note--error";
          report.textContent = payload.error || "The import did not go through.";
          if (Array.isArray(payload.rejected) && payload.rejected.length) {
            const list = document.createElement("ul");
            list.className = "company-import__rejects";
            for (const item of payload.rejected) {
              const li = document.createElement("li");
              li.textContent = `${item.slug}: ${item.why}`;
              list.appendChild(li);
            }
            report.appendChild(list);
          }
        } else {
          report.className = "company-import__ok";
          const parts = [
            `Linked ${payload.linked} problem${payload.linked === 1 ? "" : "s"} to ${payload.companies} compan${payload.companies === 1 ? "y" : "ies"}.`
          ];
          if (payload.skippedCount) {
            parts.push(`${payload.skippedCount} problem${payload.skippedCount === 1 ? " is" : "s are"} not in your catalog, so they were skipped.`);
          }
          report.textContent = parts.join(" ");
          field.value = "";
          await companyRefresh();
        }
      }
    } catch {
      if (report) {
        report.className = "viz-note--error";
        report.hidden = false;
        report.textContent = "The server could not be reached, so nothing was imported.";
      }
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  };

  const companyRefresh = async () => {
    try {
      const payload = await companyFetch("/api/companies");
      companyState.companies = payload.companies || [];
      companyState.note = payload.note || "";
    } catch (error) {
      companyState.companies = [];
      companyState.note = `Could not reach the server: ${error.message}`;
    }
    if (companyState.selected && !companyState.companies.some((c) => c.slug === companyState.selected)) {
      companyState.selected = null;
    }
    companyRender();
    await companyLoadProblems();
  };

  const initCompanies = () => {
    companyLoadState();

    const difficulty = companyEl("company-difficulty");
    if (difficulty) {
      difficulty.value = companyState.difficulty;
      difficulty.addEventListener("change", () => {
        companyState.difficulty = difficulty.value;
        companySaveState();
        void companyLoadProblems();
      });
    }

    companyEl("company-import-btn")?.addEventListener("click", () => void companyImport());

    /* There used to be a "change" listener here on #company-import-toggle. That
       element is a <details>, which fires "toggle" and has no .checked property
       - so the handler could never run, and had it run, `panel.hidden =
       !undefined` evaluates to true and would have hidden the panel. The section
       is a <details>, which already opens and closes on its own. */

    void companyRefresh();
  };


  /* ============================ contest arena ==============================
     Live contests, real standings, your real rating.

     The honesty rules on this page
     ------------------------------
     Everything here is fetched from Codeforces while you look at it. So:

       - If Codeforces cannot be reached, the page says so. It does not show an
         empty contest list, which is indistinguishable from "nothing is running".
       - If a contest has not started, its standings genuinely do not exist yet,
         and the page says that rather than showing a blank table.
       - If you have not entered a Codeforces handle, no rating is shown - not a
         zero, not an average, not someone else's.
       - Every number carries where it came from. A cached response says so.

     Why a handle is asked for but never required
     --------------------------------------------
     Contests are useful without one. A reader who only wants to know what is
     running should not have to sign up to Codeforces to find out, so the handle is
     optional and only unlocks the rating and "your row" features.

     The timers
     ----------
     A countdown that only updates when something else re-renders is a countdown
     that lies. One interval ticks the visible timers every second, and it is torn
     down when you leave the page - a page that keeps a timer running after you
     have closed it is a battery drain with no user benefit. */

  const ARENA_KEY = "quantaArenaV1";

  const arenaState = {
    handle: "",
    contests: { live: [], upcoming: [], recent: [], counts: {} },
    selected: null,
    detail: null,
    profile: null,
    /* Kept separately from `profile: null` so the reason a lookup failed can
       survive the re-render that follows it. */
    profileError: null,
    error: null,
    loadingContests: false,
    loadingDetail: false,
    /* Set when a contest fetch failed. Kept separately from `detail` because
       `detail === null` means two different things: "not asked for yet" and
       "asked for and it failed". Without this the two were indistinguishable and
       the failure rendered as an empty panel. */
    detailError: null,
    loadingProfile: false,
    note: null,
    ticker: null,
    seconds: 0
  };

  /* Exposed deliberately. This is the one page that keeps a timer running and
     reaches the network, so being able to ask "is that interval still alive?"
     and "what did it last fetch?" from the console is worth more than the
     tidiness of a module-scoped variable - and the browser test relies on it to
     prove the timer is really torn down when you leave the page.

     `open` is the one public action, so a particular round can be jumped to
     directly - which is how the browser test reaches a contest the reader has
     actually entered, rather than whichever round happens to be newest. */
  window.arenaState = arenaState;
  window.arena = { open: (contestId) => loadArenaContest(contestId), reload: () => loadArena() };

  const arenaEl = (id) => document.getElementById(id);

  const arenaLoadState = () => {
    const saved = readJson(ARENA_KEY, () => ({}));
    if (saved && typeof saved === "object") {
      arenaState.handle = typeof saved.handle === "string" ? saved.handle.slice(0, 32) : "";
    }
  };

  const arenaSaveState = () => {
    writeJson(ARENA_KEY, { handle: arenaState.handle });
  };

  const arenaApi = async (path) => {
    const response = await fetch(`${getApiBase()}${path}`, { headers: { Accept: "application/json" } });
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `The server answered ${response.status}.`);
    }
    return body;
  };

  /* One note under the page title, explaining where the numbers came from. Shown
     only when it is something the reader cannot see for themselves - a cached
     response, or a gap the API left. */
  const arenaSetNote = (text, kind = "plain") => {
    const host = arenaEl("arena-note");
    if (!host) return;
    host.hidden = !text;
    host.className = kind === "error" ? "viz-note--error" : "viz-note--plain";
    host.textContent = text || "";
  };

  const arenaClear = (hostId) => {
    const host = arenaEl(hostId);
    if (host) host.innerHTML = "";
  };

  const arenaErrorBox = (hostId, error, retryLabel) => {
    const host = arenaEl(hostId);
    if (!host) return;
    host.innerHTML = "";
    const box = document.createElement("div");
    box.className = "arena-error";
    const text = document.createElement("p");
    text.textContent = error?.message || String(error);
    box.appendChild(text);
    if (retryLabel) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "prog-btn";
      retry.textContent = retryLabel;
      retry.addEventListener("click", retryLabel === "Try again" ? () => void loadArena() : () => void loadArenaContest(arenaState.selected));
      box.appendChild(retry);
    }
    host.appendChild(box);
  };

  /* ------------------------------ contests -------------------------------- */

  const arenaContestCard = (contest, { showProgress = false } = {}) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `arena-contest${arenaState.selected === contest.id ? " is-active" : ""}`;
    row.dataset.contest = String(contest.id);

    const head = document.createElement("span");
    head.className = "arena-contest__head";

    const name = document.createElement("span");
    name.className = "arena-contest__name";
    name.textContent = contest.name;

    /* ICPC and CF rounds are scored differently, and the tag says which - the
       first thing you need to know before reading a standings table. */
    const badge = document.createElement("span");
    badge.className = `arena-contest__badge is-${String(contest.scoring || "points")}`;
    badge.textContent = contest.scoring === "penalty" ? "solves + penalty" : "points";
    head.append(name, badge);

    const meta = document.createElement("span");
    meta.className = "arena-contest__meta";
    meta.append(arenaTimeEl(contest));

    if (contest.durationSeconds) {
      const len = document.createElement("span");
      len.textContent = `${Math.round(contest.durationSeconds / 60)} min`;
      meta.appendChild(len);
    }

    row.append(head, meta);

    /* A live round gets a progress bar, because "42 minutes left" tells you how
       much runway you have and the bar tells you how far in you are. */
    if (showProgress) {
      const progress = document.createElement("span");
      progress.className = "arena-progress";
      const fill = document.createElement("span");
      fill.className = "arena-progress__fill";
      const ratio = window.contestEngine.contestProgress(contest, arenaState.seconds);
      fill.style.width = `${Math.round((ratio ?? 0) * 100)}%`;
      progress.appendChild(fill);
      row.appendChild(progress);
    }

    row.addEventListener("click", () => void loadArenaContest(contest.id));
    return row;
  };

  /* The clock on a card. Built once and kept, because rebuilding it every second
     would throw away the element mid-click and make the list feel broken. */
  const arenaTimeEl = (contest) => {
    const time = document.createElement("span");
    time.className = "arena-contest__time";

    const key = `${contest.id}`;
    arenaState.timers = arenaState.timers || {};
    const entry = arenaState.timers[key] || {};
    entry.el = time;
    entry.contest = contest;
    arenaState.timers[key] = entry;

    /* Painted by the shared painter, so a card countdown and the detail header
       clock are computed by the same code and cannot disagree. */
    paintArenaTimer(entry);
    return time;
  };

  const renderArenaContests = () => {
    const { live, upcoming, recent } = arenaState.contests;
    const total = (live || []).length + (upcoming || []).length + (recent || []).length;

    /* Clock entries are kept per contest id so a countdown is not thrown away
       and rebuilt every second. Nothing ever removed the entries for contests
       that had left the list, though: each one held a detached <span> that the
       shared ticker went on repainting once a second, forever. Bounded by the
       number of distinct contests ever seen, so it grew slowly rather than
       without limit - but it is a leak, and it is free to fix here by keeping
       only the ids about to be on screen, plus the open round's own clock. */
    arenaState.timers = arenaState.timers || {};
    const stillShown = new Set([...live, ...upcoming, ...recent].map((contest) => String(contest.id)));
    if (arenaState.selected) stillShown.add(String(arenaState.selected));
    for (const key of Object.keys(arenaState.timers)) {
      if (key !== "detail" && !stillShown.has(key)) delete arenaState.timers[key];
    }

    const summary = arenaEl("arena-summary");
    if (summary) {
      summary.textContent = arenaState.loadingContests && !total
        ? "Asking Codeforces what is running…"
        : `${live.length} running now · ${upcoming.length} coming up · ${recent.length} recent`;
    }

    const liveHost = arenaEl("arena-live");
    const upHost = arenaEl("arena-upcoming");
    const recentHost = arenaEl("arena-recent");

    if (liveHost) {
      arenaClear("arena-live");
      if (!live.length) {
        const p = document.createElement("p");
        p.className = "pattern-intro";
        p.textContent = "Nothing is running. Rounds usually start in the evening, so check back later.";
        liveHost.appendChild(p);
      } else {
        for (const contest of live) liveHost.appendChild(arenaContestCard(contest, { showProgress: true }));
      }
    }

    if (upHost) {
      arenaClear("arena-upcoming");
      if (!upcoming.length) {
        const p = document.createElement("p");
        p.className = "pattern-intro";
        p.textContent = "Codeforces has no rounds announced yet.";
        upHost.appendChild(p);
      } else {
        for (const contest of upcoming.slice(0, 8)) upHost.appendChild(arenaContestCard(contest));
      }
    }

    if (recentHost) {
      arenaClear("arena-recent");
      if (!recent.length) {
        const p = document.createElement("p");
        p.className = "pattern-intro";
        p.textContent = "No recent rounds.";
        recentHost.appendChild(p);
      } else {
        for (const contest of recent.slice(0, 12)) recentHost.appendChild(arenaContestCard(contest));
      }
    }
  };

  /* --------------------------- contest detail ----------------------------- */

  const renderArenaDetail = () => {
    const host = arenaEl("arena-detail");
    if (!host) return;
    host.innerHTML = "";

    const detail = arenaState.detail;
    if (arenaState.loadingDetail && !detail) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = "Loading the problems and standings…";
      host.appendChild(p);
      return;
    }
    /* A failed fetch is rendered here too, not only where it was raised, so that
       any other path which repaints this panel keeps the message and the retry
       button rather than blanking them. */
    if (arenaState.detailError && !detail) {
      arenaErrorBox("arena-detail", arenaState.detailError, "Try again");
      return;
    }
    if (!detail) {
      /* The markup ships a "pick a round above" placeholder, but this function
         empties its host on every entry, so after the first repaint the panel
         was left genuinely blank with nothing in it. Restored here so there is
         always something explaining what to do next. */
      const hint = document.createElement("p");
      hint.className = "pattern-intro";
      hint.textContent = "Pick a round above to see its problems, standings and what it is worth.";
      host.appendChild(hint);
      return;
    }

    const contest = detail.contest || {};
    const head = document.createElement("div");
    head.className = "arena-detail__head";

    const title = document.createElement("div");
    const h = document.createElement("h3");
    h.className = "arena-detail__title";
    h.textContent = contest.name || `Contest ${contest.id}`;
    const link = document.createElement("a");
    link.className = "arena-detail__link";
    link.href = contest.url || `https://codeforces.com/contests/${contest.id}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open on Codeforces ↗";
    title.append(h, link);

    const facts = document.createElement("div");
    facts.className = "arena-detail__facts";
    const startedAt = document.createElement("span");
    startedAt.className = "arena-detail__clock";
    facts.appendChild(startedAt);
    head.append(title, facts);

    /* The header clock is registered like the card clocks, so one tick updates
       all of them together. */
    const clockEntry = (arenaState.timers = arenaState.timers || {})["detail"] || { el: startedAt };
    clockEntry.el = startedAt;
    clockEntry.detail = contest;
    arenaState.timers.detail = clockEntry;

    const size = document.createElement("span");
    size.textContent = `${detail.problems?.length || 0} problems · ${(detail.rowCount || 0).toLocaleString()} took part`;
    facts.appendChild(size);

    /* How much of this sheet Quanta already holds, stated plainly. Without it
       the two "Solve here" buttons and the six off-site links look arbitrary -
       the reader cannot tell whether the app simply failed to find the others,
       or genuinely does not carry them. */
    if (detail.catalog && detail.catalog.total) {
      const overlap = document.createElement("span");
      overlap.className = "arena-detail__overlap";
      const held = detail.catalog.inCatalog;
      overlap.textContent = held
        ? `${held} of ${detail.catalog.total} in your catalog`
        : "none of these are in your catalog yet";
      facts.appendChild(overlap);
    }

    host.appendChild(head);

    /* The plan: what the round is actually worth, problem by problem. Generated
       from the real points, so it changes when the round's scoring does. */
    if (detail.plan?.rows?.length) {
      const plan = document.createElement("p");
      plan.className = "arena-advice";
      plan.textContent = detail.plan.advice;
      host.appendChild(plan);
    }

    /* Problems */
    const problemsHead = document.createElement("h4");
    problemsHead.className = "arena-sub";
    problemsHead.textContent = "Problems";
    host.appendChild(problemsHead);

    const table = document.createElement("div");
    table.className = "arena-problems";

    for (const problem of detail.problems || []) {
      const row = document.createElement("div");
      row.className = "arena-problem";

      const index = document.createElement("span");
      index.className = "arena-problem__index";
      index.textContent = problem.index;

      const name = document.createElement("span");
      name.className = "arena-problem__name";
      name.textContent = problem.name;
      row.append(index, name);

      if (problem.rating) {
        const rating = document.createElement("span");
        rating.className = "arena-problem__rating";
        rating.textContent = String(problem.rating);
        rating.title = "Codeforces difficulty estimate";
        row.appendChild(rating);
      } else {
        const unknown = document.createElement("span");
        unknown.className = "arena-problem__rating is-unknown";
        unknown.textContent = "—";
        unknown.title = "Codeforces has not published a difficulty for this one yet";
        row.appendChild(unknown);
      }

      const points = document.createElement("span");
      points.className = "arena-problem__points";
      points.textContent = problem.points != null ? String(problem.points) : "";
      points.title = "Points for solving this";
      row.appendChild(points);

      /* The link into Quanta, and only when the problem really is in the catalog.
         The join is on Codeforces' own problem id, so this is never a
         title-similarity guess. */
      if (problem.inCatalog && problem.slug) {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "prog-btn is-quiet";
        open.textContent = "Solve here";
        open.addEventListener("click", () => {
          const local = (Array.isArray(lcState?.problems) ? lcState.problems : []).find((p) => p.slug === problem.slug);
          if (local) {
            showPage("quantalab");
            selectLcProblem(local.id);
            return;
          }
          const input = document.querySelector("#lc-search-input");
          if (input) {
            Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, problem.name);
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
          showPage("quantalab");
        });
        row.appendChild(open);
      } else {
        const away = document.createElement("a");
        away.className = "arena-problem__away";
        away.href = problem.url;
        away.target = "_blank";
        away.rel = "noopener noreferrer";
        away.textContent = "View ↗";
        row.appendChild(away);
      }

      table.appendChild(row);
    }

    if (!detail.problems?.length) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = "Codeforces has not published this round's problems yet.";
      table.appendChild(p);
    }
    host.appendChild(table);

    /* Standings */
    const standingsHead = document.createElement("h4");
    standingsHead.className = "arena-sub";
    standingsHead.textContent = "Standings";
    host.appendChild(standingsHead);

    /* The standings arrive already analysed by the server. A finished Div. 2
       round is ten thousand rows and 7.8 MB of JSON, and there is no way to
       page Codeforces' endpoint - so the table is cut down to what can be
       shown on the way past, and the browser never sees the rest.

       The fallback to buildStandings here is for a response that somehow lacks
       them, not the normal path. */
    const built = detail.standings || window.contestEngine.buildStandings(detail, { handle: arenaState.handle, limit: 20 });
    renderArenaStandings(host, built, detail);
  };

  const renderArenaStandings = (host, built, detail) => {
    arenaClear("arena-standings");

    const note = document.createElement("p");
    /* Its own class rather than the shared intro style, so the standings note
       can be addressed directly - by a reader looking for it, or by a test
       proving the comparison against the field is on screen. */
    note.className = "arena-standings__note";
    if (built.you) {
      /* `positionInField` is the place in the field - how many entrants rank at
         or above you - and `total` is how many entered. Confusing the two
         produced "12th of 12 entrants" for someone who placed 12th out of
         9,709. */
      /* betterThanPercent is null when there is nobody to compare against - a
         round with a single entrant has no field. Rendering the number then
         printed "better than null% of the field". The comparison sentence is
         simply left out when there is nothing to compare. */
      const share = built.field.betterThanPercent;
      const better =
        share === null || share === undefined
          ? ""
          : ` That is better than ${share}% of the field, whose median was ${built.field.medianSolved} problem${built.field.medianSolved === 1 ? "" : "s"}.`;
      note.textContent = `You finished ${ordinal(built.you.rank)} of ${built.total.toLocaleString()} entrants, solving ${built.you.solved} of ${built.you.totalProblems}.${better}`;
    } else {
      note.textContent = arenaState.handle
        ? `${arenaState.handle} did not enter this round, so there is no row to point at. Showing the top of the table.`
        : `Add your Codeforces handle above and this becomes your round: your row, your solves, your position in the field. Showing the top of the table for now.`;
    }
    host.appendChild(note);

    const scoringNote = document.createElement("p");
    scoringNote.className = "arena-scoring";
    /* The penalty note carries the evidence for the decision to report
       Codeforces' figure rather than recompute one. Measured on this actual
       contest, not asserted in a footnote somewhere. */
    const check = detail?.penaltyCheck;
    const evidence = check && check.rows > 0 && check.disagree > 0
      ? ` Checked against the published formula on all ${check.rows.toLocaleString()} rows of this round: ${check.disagree.toLocaleString()} disagree, so Quanta reports Codeforces' number rather than showing a second, different one.`
      : "";
    scoringNote.textContent = built.scoring === "penalty"
      ? "This round is scored on solves first and penalty second. Penalties below are Codeforces' own figures." + evidence
      : "This round is scored on points. Codeforces reports no penalty for it, so the column is not shown.";
    host.appendChild(scoringNote);

    const table = document.createElement("div");
    table.className = "arena-standings";

    const header = document.createElement("div");
    header.className = "arena-standing is-head";
    for (const label of ["#", "Handle", "Solved", built.scoring === "penalty" ? "Penalty" : "", "Points"]) {
      const cell = document.createElement("span");
      cell.className = "arena-standing__cell";
      cell.textContent = label;
      header.appendChild(cell);
    }
    table.appendChild(header);

    /* How many rows carry each rank. Codeforces shares a rank between tied
       entrants and the next number skips, which reads as a bug unless it is
       explained where it can be seen. */
    const rankCounts = new Map();
    for (const row of built.rows) rankCounts.set(row.rank, (rankCounts.get(row.rank) || 0) + 1);

    for (const row of built.rows) {
      const line = document.createElement("div");
      line.className = `arena-standing${row.isYou ? " is-you" : ""}`;

      const rank = document.createElement("span");
      rank.className = "arena-standing__cell arena-standing__rank";
      rank.textContent = row.rank == null ? "—" : `#${row.rank}`;
      if (row.rank != null && rankCounts.get(row.rank) > 1) {
        line.classList.add("is-tied");
        rank.title = "Shared rank - Codeforces gives tied entrants the same rank and skips the next number";
      }
      line.appendChild(rank);

      const handle = document.createElement("span");
      handle.className = "arena-standing__cell arena-standing__handle";
      handle.textContent = row.team || "(unknown)";
      if (row.isTeam) handle.title = "A team entry - two or more handles";
      /* The marker is a real node rather than a CSS ::after. A pseudo-element
         is invisible to a screen reader, cannot be selected as text, and would
         be the only signal that a row is yours. The `is-you` class styles the
         row independently, so colour is never the only cue either. */
      if (row.isYou) {
        const you = document.createElement("span");
        you.className = "arena-standing__you";
        you.textContent = "you";
        line.appendChild(you);
      }
      line.appendChild(handle);

      const solved = document.createElement("span");
      solved.className = "arena-standing__cell";
      solved.textContent = row.solvedIndices.length ? row.solvedIndices.join(" ") : "—";
      solved.title = row.solvedIndices.length ? `Solved ${row.solvedIndices.join(", ")}` : "Solved nothing";
      line.appendChild(solved);

      if (built.scoring === "penalty") {
        const penalty = document.createElement("span");
        penalty.className = "arena-standing__cell";
        penalty.textContent = String(row.penalty);
        penalty.title = "Penalty as reported by Codeforces";
        line.appendChild(penalty);
      }

      const points = document.createElement("span");
      points.className = "arena-standing__cell";
      points.textContent = String(row.points);
      line.appendChild(points);

      table.appendChild(line);
    }

    if (!built.rows.length) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = "No entrants in this round.";
      table.appendChild(p);
    }

    host.appendChild(table);

    const foot = document.createElement("p");
    foot.className = "arena-foot";
    foot.textContent = built.you
      ? `Showing the rows around you out of ${built.total.toLocaleString()} entrants.`
      : `Showing the top ${built.rows.length} of ${built.total.toLocaleString()} entrants.`;
    host.appendChild(foot);
  };

  /* The year of a Unix timestamp, for the chart caption. A locale-formatted
     full date would be unreadable at the width available, and two dates from
     the same decade need only the years. */
  const yearOf = (seconds) => {
    const value = Number(seconds);
    if (!Number.isFinite(value)) return "";
    try {
      return String(new Date(value * 1000).getUTCFullYear());
    } catch {
      return "";
    }
  };

  const ordinal = (n) => {    const value = Number(n);
    if (!Number.isFinite(value)) return "?";
    const suffix = ["th", "st", "nd", "rd"][((value % 100) - 20) % 10] || ["th", "st", "nd", "rd"][value % 100] || "th";
    return `${value}${suffix}`;
  };

  /* -------------------------------- profile ------------------------------- */

  const renderArenaProfile = () => {
    const host = arenaEl("arena-profile");
    if (!host) return;

    if (arenaState.loadingProfile && !arenaState.profile) {
      host.innerHTML = "";
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = `Looking up ${arenaState.handle}…`;
      host.appendChild(p);
      return;
    }

    const profile = arenaState.profile;
    if (!profile) {
      host.innerHTML = "";
      /* The specific reason, carried over from the failed load rather than
         rendered and then immediately overwritten. An earlier version set the
         error text and re-rendered on top of it in the same tick, so the reader
         got "could not be loaded" instead of "Codeforces does not have that
         handle" - which is the difference between a typo and an outage. */
      if (arenaState.profileError) {
        const fail = document.createElement("p");
        fail.className = "viz-note--error";
        fail.textContent = arenaState.profileError;
        host.appendChild(fail);
        return;
      }
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = arenaState.handle
        ? "That handle could not be loaded."
        : "Add a Codeforces handle above to see your rating, your band and every rated round you have entered.";
      host.appendChild(p);
      return;
    }

    host.innerHTML = "";

    const head = document.createElement("div");
    head.className = "arena-profile__head";

    const name = document.createElement("div");
    const h = document.createElement("span");
    h.className = "arena-profile__handle";
    h.textContent = profile.handle;
    const band = document.createElement("span");
    band.className = "arena-profile__band";
    band.textContent = profile.rank;
    name.append(h, band);

    const rating = document.createElement("div");
    rating.className = "arena-profile__rating";
    rating.textContent = profile.rating == null ? "unrated" : String(profile.rating);
    rating.title = "Current rating";
    if (profile.maxRating != null) {
      const peak = document.createElement("span");
      peak.className = "arena-profile__peak";
      peak.textContent = `peak ${profile.maxRating}`;
      rating.appendChild(peak);
    }

    head.append(name, rating);
    host.appendChild(head);

    const facts = document.createElement("div");
    facts.className = "arena-profile__facts";
    const fact = (label, value, title) => {
      if (value == null || value === "") return;
      const cell = document.createElement("div");
      cell.className = "arena-profile__fact";
      const k = document.createElement("span");
      k.className = "arena-profile__fact-label";
      k.textContent = label;
      const v = document.createElement("span");
      v.className = "arena-profile__fact-value";
      v.textContent = String(value);
      if (title) cell.title = title;
      cell.append(k, v);
      facts.appendChild(cell);
    };
    fact("rated rounds", profile.ratedContests, "Rounds where you finished above the lowest rated band");
    fact("contribution", profile.contribution, "Your impact on Codeforces' difficulty estimates");
    if (profile.country) fact("country", profile.country);

    const linkFact = document.createElement("div");
    linkFact.className = "arena-profile__fact";
    const linkLabel = document.createElement("span");
    linkLabel.className = "arena-profile__fact-label";
    linkLabel.textContent = "profile";
    const linkValue = document.createElement("a");
    linkValue.className = "arena-profile__fact-value";
    linkValue.href = profile.url;
    linkValue.target = "_blank";
    linkValue.rel = "noopener noreferrer";
    linkValue.textContent = "open ↗";
    linkFact.append(linkLabel, linkValue);
    facts.appendChild(linkFact);

    host.appendChild(facts);

    /* The rating chart. Real points, one per rated round, and nothing drawn that
       is not in the data: no trend line, no "you are improving" verdict.

       It does carry a scale. A line with no axis is decoration - you cannot
       tell whether a dip is forty points or four hundred, and reading the shape
       is the entire point of the chart. The labels are the real peak and the
       real floor, not the ends of a padded range, which would show the reader
       numbers they never earned. */
    const series = profile.series;
    if (series.pointCount >= 2) {
      const wrap = document.createElement("div");
      wrap.className = "arena-chart";

      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", `0 0 ${series.width} ${series.height}`);
      svg.setAttribute("class", "arena-chart__svg");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", `Rating from ${series.min} to ${series.max} across ${series.pointCount} rated rounds`);

      if (series.areaPath) {
        const area = document.createElementNS("http://www.w3.org/2000/svg", "path");
        area.setAttribute("d", series.areaPath);
        area.setAttribute("class", "arena-chart__area");
        svg.appendChild(area);
      }

      const scale = (rating, label, placeAbove) => {
        const y = Math.round(series.height - ((rating - series.low) / (series.high - series.low)) * series.height);
        const grid = document.createElementNS("http://www.w3.org/2000/svg", "line");
        grid.setAttribute("x1", "0");
        grid.setAttribute("x2", String(series.width));
        grid.setAttribute("y1", String(y));
        grid.setAttribute("y2", String(y));
        grid.setAttribute("class", "arena-chart__grid");
        svg.appendChild(grid);

        const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
        text.setAttribute("x", "5");
        text.setAttribute("y", String(placeAbove ? y - 6 : y + 14));
        text.setAttribute("class", "arena-chart__tick");
        text.textContent = `${label} ${rating}`;
        svg.appendChild(text);
      };
      scale(series.max, "peak", true);
      scale(series.min, "low", false);

      const line = document.createElementNS("http://www.w3.org/2000/svg", "path");
      line.setAttribute("d", series.path);
      line.setAttribute("class", "arena-chart__line");
      svg.appendChild(line);

      for (const point of series.points) {
        const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        dot.setAttribute("cx", String(point.x));
        dot.setAttribute("cy", String(point.y));
        dot.setAttribute("r", "3");
        dot.setAttribute("class", "arena-chart__dot");
        const titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
        const row = series.rows.find((r) => r.contestId === point.contestId);
        titleEl.textContent = row ? `${row.contestName}: ${row.rating}${row.change > 0 ? ` (+${row.change})` : row.change < 0 ? ` (${row.change})` : ""}` : String(point.rating);
        dot.appendChild(titleEl);
        svg.appendChild(dot);
      }

      wrap.appendChild(svg);

      const caption = document.createElement("p");
      caption.className = "arena-chart__caption";
      const change = series.change == null
        ? "not enough rated rounds to show a change"
        : `${series.change > 0 ? "+" : ""}${series.change} over the last ${series.changeWindow} rated rounds`;
      /* The caption carries the numbers the axis does not, and the span of time
         the chart covers - a rating line without a date range is a shape with no
         meaning. Both ends come from Codeforces' own update timestamps. */
      const firstAt = series.rows[0]?.at;
      const lastAt = series.rows[series.rows.length - 1]?.at;
      const span = firstAt && lastAt ? `, ${yearOf(firstAt)} to ${yearOf(lastAt)}` : "";
      caption.textContent = `${series.pointCount} rated rounds · lowest ${series.min} · highest ${series.max}${span} · ${change}`;
      wrap.appendChild(caption);

      host.appendChild(wrap);
    } else {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = profile.ratedContests === 0
        ? `${profile.handle} has no rated rounds yet, so there is no rating history to draw. Unrated rounds do not count towards a rating.`
        : "Not enough rated rounds to draw a line yet.";
      host.appendChild(p);
    }

    const source = document.createElement("p");
    source.className = "arena-source";
    const when = new Date((profile.fetchedAt || 0) * 1000).toLocaleTimeString();
    source.textContent = `From ${profile.source}${profile.cached ? ` (cached, last fetched ${when})` : ` (fetched ${when})`}`;
    host.appendChild(source);
  };

  /* --------------------------------- loaders ------------------------------ */

  const loadArenaContests = async () => {
    arenaState.loadingContests = true;
    arenaState.error = null;
    arenaSetNote("");
    try {
      const payload = await arenaApi("/api/contests");
      arenaState.contests = {
        live: payload.live || [],
        upcoming: payload.upcoming || [],
        recent: payload.recent || [],
        counts: payload.counts || {}
      };
      /* The cache note matters on a countdown page: a list up to a minute old is
         the normal case, and saying so is better than letting someone trust a
         clock that has quietly stopped. */
      arenaSetNote(
        payload.cached
          ? "This list came from Quanta's cache rather than a fresh request, so a round that has just started may not appear yet. Reload to check."
          : "",
        "plain"
      );
    } catch (error) {
      arenaState.contests = { live: [], upcoming: [], recent: [], counts: {} };
      arenaState.error = error;
      arenaSetNote(`Could not load contests from Codeforces: ${error.message}`, "error");
    } finally {
      arenaState.loadingContests = false;
      renderArenaContests();
    }
  };

  const loadArenaContest = async (contestId) => {
    if (!contestId) return;
    arenaState.selected = Number(contestId);
    arenaState.loadingDetail = true;
    /* Cleared here rather than on success, so that picking a different round
       after a failed one replaces the old error rather than leaving it on screen
       beside the new round's loading state. */
    arenaState.detailError = null;
    renderArenaContests();
    renderArenaDetail();
    try {
      /* Built with URLSearchParams rather than by concatenating a query string
         onto a path. The first version appended "&handle=..." to a path that
         had no "?", so every request made with a handle set asked for a contest
         called "2271&handle=tourist" and got a 400. A handle is optional, which
         is exactly the condition under which a hand-built query string goes
         unchecked: without one the URL is simply correct. */
      const query = new URLSearchParams();
      if (arenaState.handle) query.set("handle", arenaState.handle);
      const suffix = query.toString() ? `?${query}` : "";
      const detail = await arenaApi(`/api/contests/${arenaState.selected}${suffix}`);
      /* A slow request for a contest the reader has already navigated away from
         must not overwrite the one they are looking at. */
      if (arenaState.selected !== Number(contestId)) return;
      arenaState.detail = detail;
    } catch (error) {
      if (arenaState.selected !== Number(contestId)) return;
      arenaState.detail = null;
      arenaState.detailError = error;
      arenaErrorBox("arena-detail", error, "Try again");
    } finally {
      if (arenaState.selected === Number(contestId)) {
        arenaState.loadingDetail = false;
        /* renderArenaDetail() empties its host on entry. Calling it after the
           catch therefore erased the message and the "Try again" button that
           arenaErrorBox had just written into that same host, leaving a blank
           panel with no way to retry. When the fetch failed there is nothing to
           render but the error, so the error is left standing. */
        if (!arenaState.detailError) renderArenaDetail();
      }
    }
  };

  const loadArenaProfile = async () => {
    if (!arenaState.handle) {
      arenaState.profile = null;
      arenaState.profileError = null;
      renderArenaProfile();
      return;
    }
    arenaState.loadingProfile = true;
    arenaState.profileError = null;
    renderArenaProfile();
    /* Captured, so a slow answer to a question the reader has already changed
       can be recognised and dropped rather than replacing what they are now
       looking at. */
    const askedFor = arenaState.handle;
    const stillWanted = () => askedFor.toLowerCase() === arenaState.handle.toLowerCase();
    try {
      const profile = await arenaApi(`/api/codeforces/profile?${new URLSearchParams({ handle: askedFor })}`);
      if (!stillWanted()) return;
      arenaState.profile = profile;
      arenaState.profileError = null;
    } catch (error) {
      if (!stillWanted()) return;
      arenaState.profile = null;
      /* Kept in state rather than written straight into the DOM. An earlier
         version did the latter and then re-rendered over the top of it in the
         same tick, so the specific reason - "Codeforces does not have that
         handle", or an outage - was replaced by a vague one. */
      arenaState.profileError = error.message;
    } finally {
      if (stillWanted()) {
        arenaState.loadingProfile = false;
        renderArenaProfile();
      }
    }
  };

  const loadArena = async () => {
    arenaState.seconds = Math.round(Date.now() / 1000);
    renderArenaContests();
    await loadArenaContests();
    if (arenaState.handle) await loadArenaProfile();
  };

  /* --------------------------------- clock --------------------------------- */

  /* One interval for every visible timer. Started when the page is shown and
     stopped when it is left, because a page that is not on screen has no reason
     to wake up once a second. */
  const arenaStartClock = () => {
    if (arenaState.ticker) return;
    arenaState.ticker = setInterval(() => {
      arenaState.seconds = Math.round(Date.now() / 1000);
      for (const entry of Object.values(arenaState.timers || {})) {
        if (entry.el && entry.contest) paintArenaTimer(entry);
      }
    }, 1000);
  };

  const arenaStopClock = () => {
    if (arenaState.ticker) {
      clearInterval(arenaState.ticker);
      arenaState.ticker = null;
    }
  };

  /* The paint function, shared by the card timers and the detail header, so a
     countdown on a card and a clock in the header can never read differently. */
  const paintArenaTimer = (entry) => {
    const contest = entry.contest || entry.detail;
    if (!contest || !entry.el) return;
    const now = arenaState.seconds;
    const start = Number(contest.startTimeSeconds);
    const duration = Number(contest.durationSeconds || 0);
    const end = start + duration;

    if (entry.detail) {
      if (!Number.isFinite(start)) {
        entry.el.textContent = "start time not published";
      } else if (now >= end && duration) {
        const ago = window.contestEngine.countdown(now - end);
        entry.el.textContent = `finished ${ago.spoken} ago`;
      } else if (now >= start) {
        const left = window.contestEngine.countdown(end - now);
        entry.el.textContent = `running · ${left.expired ? "ending" : `${left.spoken} left`}`;
      } else {
        const away = window.contestEngine.countdown(start - now);
        entry.el.textContent = `starts in ${away.spoken}`;
      }
      return;
    }

    if (!Number.isFinite(start)) {
      entry.el.textContent = "time not published";
    } else if (now >= end && duration) {
      const ago = window.contestEngine.countdown(now - end);
      entry.el.textContent = `ended ${ago.spoken} ago`;
    } else if (now >= start) {
      const left = window.contestEngine.countdown(end - now);
      entry.el.textContent = left.expired ? "ending" : `${left.spoken} left`;
      entry.el.classList.add("is-live");
    } else {
      const away = window.contestEngine.countdown(start - now);
      entry.el.textContent = away.spoken ? `starts in ${away.spoken}` : "starting";
      entry.el.classList.remove("is-live");
    }
  };

  /* ============================ interactive debugger =======================
     Step through JavaScript and watch every variable change.

     The one rule this page is built around
     --------------------------------------
     It runs the reader's code. It does not interpret it, approximate it, or
     replay a canned trace. Every value in the state panel was read out of a
     scope that was live at that exact statement, and the tests check the debugger's
     answers against what plain JavaScript does with the same snippet.

     That is why the supported syntax is a subset. A construct the instrumenter
     cannot rewrite correctly is refused, with its line and its name, rather than
     run approximately - an approximation here would be indistinguishable from the
     truth while being wrong, which is the one thing a learning tool must not be.

     What the controls mean
     ----------------------
     There is no separate "step into" and "step over". Every function in the
     snippet is instrumented, so stepping always enters what it can and reports
     honestly when a function runs as one step - an object method, a callback, a
     constructor. Saying so beats offering a control that quietly does nothing
     different.

     Running happens on the main thread, in this page, on the reader's machine.
     Nothing is uploaded. A step cap means an infinite loop stops at a real
     boundary instead of freezing the tab. */

  const DEBUG_KEY = "quantaDebuggerV1";

  /* Snippets that are worth stepping through because the thing they teach is
     invisible when you only read them: the loop counter, the call stack, the
     moment a closure sees an updated binding. Each is real code that runs. */
  const DEBUG_EXAMPLES = [
    {
      key: "loop",
      title: "A loop, one pass at a time",
      why: "Shows the loop counter and the accumulator at each statement, and the pass number.",
      code: `let total = 0;
  for (let i = 1; i <= 5; i++) {
    total += i;
  }
  console.log("total", total);`
    },
    {
      key: "stack",
      title: "What the call stack looks like",
      why: "The stack panel fills and unwinds as add() is called from three places.",
      code: `function add(a, b) {
    return a + b;
  }

  let first = add(1, 2);
  let second = add(3, 4);
  let sum = first + second;
  console.log("sum", sum);`
    },
    {
      key: "recursion",
      title: "Recursion, frame by frame",
      why: "Each call gets its own copy of n. The stack grows, then unwinds.",
      code: `function fact(n) {
    if (n <= 1) return 1;
    return n * fact(n - 1);
  }

  console.log("5! is", fact(5));`
    },
    {
      key: "closure",
      title: "A closure reading a live binding",
      why: "Two calls to the same function see two different values of c. A snapshot taken at declaration time could not.",
      code: `let count = 0;

  function bump() {
    count += 1;
  }

  bump();
  console.log("after one", count);
  bump();
  console.log("after two", count);`
    },
    {
      key: "array",
      title: "Mutating an array and an object",
      why: "The state panel shows the real collection after each mutation, not a copy from earlier.",
      code: `const scores = [3, 1, 2];
  const tally = {};

  for (const score of scores) {
    tally[score] = (tally[score] || 0) + 1;
    scores.push(score);
  }

  console.log(scores);
  console.log(tally);`
    },
    {
      key: "binary-search",
      title: "Binary search, the reason it works",
      why: "Watch lo and hi cross. This is the part people cannot see by reading.",
      code: `function search(xs, target) {
    let lo = 0;
    let hi = xs.length - 1;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (xs[mid] === target) return mid;
      if (xs[mid] < target) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }

  const sorted = [1, 3, 5, 8, 13, 21];
  console.log("index of 13:", search(sorted, 13));
  console.log("index of 4:", search(sorted, 4));`
    },
    {
      key: "error",
      title: "An error, caught where it happens",
      why: "The panel names the real error and the line it came from.",
      code: `function firstItem(xs) {
    return xs[0];
  }

  const empty = [];
  console.log(firstItem(empty));`
    },
    {
      key: "two-sum",
      title: "Two Sum, the wrong way first",
      why: "The nested loop is what makes this O(n^2). Watch the inner counter climb, then compare with the map version.",
      code: `const nums = [2, 7, 11, 15];
  const target = 9;

  function bruteForce(a, want) {
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) {
        if (a[i] + a[j] === want) return [i, j];
      }
    }
    return [];
  }

  console.log(bruteForce(nums, target));`
    }
  ];

  const debugState = {
    source: DEBUG_EXAMPLES[0].code,
    example: "loop",
    breakpoints: new Set(),
    session: null,
    analysed: null,
    error: null,
    warnings: [],
    /* The line the gutter should highlight, and the one the reader clicked. */
    cursorLine: 1
  };

  const dbgEl = (id) => document.getElementById(id);

  const dbgLoadState = () => {
    const saved = readJson(DEBUG_KEY, () => ({}));
    if (saved && typeof saved === "object") {
      if (typeof saved.source === "string" && saved.source.trim()) debugState.source = saved.source;
      if (Array.isArray(saved.breakpoints)) debugState.breakpoints = new Set(saved.breakpoints.filter((n) => Number.isInteger(n)));
      /* Saved alongside the code. It used to be dropped, so after a reload the
         dropdown showed "loop" and the caption described the loop example while
         the editor held the reader's own snippet. Validated against the real
         example list so a stale value cannot name an example that is gone. */
      if (typeof saved.example === "string" && (saved.example === "" || DEBUG_EXAMPLES.some((e) => e.key === saved.example))) {
        debugState.example = saved.example;
      }
    }
  };

  const dbgSaveState = () => {
    writeJson(DEBUG_KEY, { source: debugState.source, breakpoints: [...debugState.breakpoints], example: debugState.example });
  };

  /* ------------------------------ compiling ------------------------------- */

  /* Turns the editor's contents into a runnable session, or into a refusal.

     Refusal is a first-class outcome here, not an error state: the page shows
     the line and the construct, and the previous working session stays put so a
     reader who mistypes a brace sees an empty panel that says why, rather than the
   old trace still sitting there looking current. */
  const dbgCompile = ({ reset = true } = {}) => {
    const editor = dbgEl("dbg-code");
    if (editor) debugState.source = editor.value;
    debugState.error = null;

    try {
      const prepared = window.debuggerEngine.prepare(debugState.source, { maxSteps: 5000 });
      debugState.analysed = prepared.analysed;
      debugState.warnings = prepared.analysed.warnings || [];
      debugState.session = prepared.session;
      if (reset) {
        debugState.session.reset();
        debugState.breakpoints = new Set(
          [...debugState.breakpoints].filter((line) => line <= prepared.analysed.source.split("\n").length)
        );
      }
    } catch (error) {
      debugState.error = {
        message: error.message,
        line: error.line ?? null,
        construct: error.construct ?? null
      };
      /* Cleared so no panel can show a trace belonging to code that has since
         been replaced. A stale value that looks current is worse than an empty
         panel that says why it is empty. */
      debugState.session = null;
      debugState.analysed = null;
      debugState.warnings = [];
    }
    dbgSaveState();
    dbgRenderAll();
  };

  /* ------------------------------- the gutter ----------------------------- */

  /* Line numbers down the side, doubling as the breakpoint control and the
     "you are here" indicator. A plain textarea with a synced scroll rather than a
     full code editor: the thing this page needs from an editor is clickable line
     numbers, and Monaco's line decorations are not worth the wiring when a gutter
     does the job and stays correct. */
  const dbgRenderGutter = () => {
    const gutter = dbgEl("dbg-gutter");
    if (!gutter) return;
    const lines = debugState.source.split("\n");
    const current = debugState.session?.state.current;

    gutter.innerHTML = "";
    for (let line = 1; line <= lines.length; line += 1) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "dbg-line";
      row.dataset.line = String(line);
      row.setAttribute("aria-label", `Line ${line}`);

      if (debugState.breakpoints.has(line)) {
        row.classList.add("has-breakpoint");
        row.title = `Breakpoint on line ${line}. Click to remove.`;
      } else {
        row.title = `Toggle a breakpoint on line ${line}`;
      }
      if (current?.line === line) {
        row.classList.add("is-current");
        row.title += current.finished ? " - the program finished here" : " - executing now";
      }

      const dot = document.createElement("span");
      dot.className = "dbg-line__mark";
      dot.setAttribute("aria-hidden", "true");
      const number = document.createElement("span");
      number.className = "dbg-line__number";
      number.textContent = String(line);
      row.append(dot, number);

      row.addEventListener("click", () => {
        if (debugState.breakpoints.has(line)) debugState.breakpoints.delete(line);
        else debugState.breakpoints.add(line);
        dbgSaveState();
        dbgRenderGutter();
      });

      gutter.appendChild(row);
    }

    /* Kept in step with the textarea. Without this the two disagree the moment
       either is scrolled, and the line you are looking at is not the line marked
       as current. */
    const editor = dbgEl("dbg-code");
    if (editor) gutter.scrollTop = editor.scrollTop;
  };

  /* ------------------------------- rendering ------------------------------ */

  const dbgRenderStatus = () => {
    const host = dbgEl("dbg-status");
    if (!host) return;
    const state = debugState.session?.state;
    host.innerHTML = "";

    const add = (label, value, className) => {
      const cell = document.createElement("span");
      cell.className = `dbg-status__item${className ? ` ${className}` : ""}`;
      const k = document.createElement("span");
      k.className = "dbg-status__label";
      k.textContent = label;
      const v = document.createElement("span");
      v.className = "dbg-status__value";
      v.textContent = value;
      cell.append(k, v);
      host.appendChild(cell);
    };

    if (debugState.error) {
      add("not run", debugState.error.construct || "refused", "is-error");
      return;
    }
    if (!state) {
      add("ready", "press Step");
      return;
    }

    const current = state.current;
    add("step", `${state.stepCount}${state.maxSteps ? ` of ${state.maxSteps}` : ""}`);
    if (current) {
      add(current.finished ? "finished at" : "at line", current.finished ? "end of snippet" : String(current.line));
      if (current.loopId) add("pass", String(current.iteration ?? 1), "is-loop");
    }
    if (state.error) add("threw", `${state.error.name}: ${state.error.message}`, "is-error");
    else if (state.capped) add("stopped", `step limit of ${state.maxSteps} reached`, "is-warn");
    else if (state.finished) add("state", "ran to the end", "is-done");
    else add("state", "paused", "is-live");
  };

  const dbgRenderVariables = () => {
    const host = dbgEl("dbg-variables");
    if (!host) return;
    host.innerHTML = "";

    const current = debugState.session?.state.current;
    if (!current) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = debugState.error
        ? "Nothing to show until the snippet compiles."
        : "Press Step to run. Every variable is read out of the live scope at that point.";
      host.appendChild(p);
      return;
    }

    const rows = current.variables;
    const visible = rows.filter((row) => row.present);
    const hidden = rows.filter((row) => !row.present);

    if (!visible.length) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = "No variables are in scope here.";
      host.appendChild(p);
    }

    for (const row of visible) {
      const line = document.createElement("div");
      line.className = `dbg-var${row.undeclared ? " is-undeclared" : ""}`;

      const name = document.createElement("span");
      name.className = "dbg-var__name";
      name.textContent = row.name;
      if (row.undeclared) name.title = "Not declared with let, const or var - a global, or assigned without a declaration";

      const type = document.createElement("span");
      type.className = "dbg-var__type";
      type.textContent = row.kind;
      type.title = `JavaScript type: ${row.kind}`;

      const value = document.createElement("span");
      value.className = `dbg-var__value is-${row.kind}`;
      value.textContent = row.display;

      line.append(name, type, value);
      host.appendChild(line);
    }

    /* Out of scope names are listed, not hidden. "Where did x go?" is the single
       most common question at a debugger, and an empty row is a worse answer than
       one that says so. */
    if (hidden.length) {
      const note = document.createElement("p");
      note.className = "dbg-var__hidden";
      note.textContent = `Not in scope here: ${hidden.map((row) => row.name).join(", ")}`;
      host.appendChild(note);
    }
  };

  const dbgRenderStack = () => {
    const host = dbgEl("dbg-stack");
    if (!host) return;
    host.innerHTML = "";

    const current = debugState.session?.state.current;
    if (!current || !current.stack.length) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = "The call stack appears once the snippet is running.";
      host.appendChild(p);
      return;
    }

    /* Innermost first, which is the order you read a stack trace in. */
    [...current.stack].reverse().forEach((frame, index) => {
      const line = document.createElement("div");
      line.className = `dbg-frame${index === 0 ? " is-top" : ""}`;
      const depth = document.createElement("span");
      depth.className = "dbg-frame__depth";
      depth.textContent = String(index);
      const name = document.createElement("span");
      name.className = "dbg-frame__name";
      name.textContent = frame;
      line.append(depth, name);
      host.appendChild(line);
    });

    const note = document.createElement("p");
    note.className = "dbg-frame__note";
    note.textContent = current.stack.length > 1
      ? "Functions Quanta rewrote can be entered. Object methods, callbacks and constructors run as one step, because rewriting them would change what calling them returns."
      : "Nothing is on the stack but the snippet itself.";
    host.appendChild(note);
  };

  const dbgRenderOutput = () => {
    const host = dbgEl("dbg-output");
    if (!host) return;
    host.innerHTML = "";

    const output = debugState.session?.state.output || [];
    if (!output.length) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = "console.log output appears here as the snippet runs, not afterwards.";
      host.appendChild(p);
      return;
    }
    for (const entry of output) {
      const line = document.createElement("div");
      line.className = `dbg-log is-${entry.level}`;
      line.textContent = entry.text;
      host.appendChild(line);
    }
  };

  const dbgRenderNotice = () => {
    const host = dbgEl("dbg-notice");
    if (!host) return;
    host.innerHTML = "";

    if (debugState.error) {
      const box = document.createElement("div");
      box.className = "dbg-notice__box is-error";
      const text = document.createElement("p");
      text.textContent = debugState.error.message;
      box.appendChild(text);
      if (debugState.error.line) {
        const where = document.createElement("p");
        where.className = "dbg-notice__where";
        where.textContent = `Line ${debugState.error.line}${debugState.error.construct ? ` (${debugState.error.construct})` : ""}. Quanta did not run any of it.`;
        box.appendChild(where);
      }
      host.appendChild(box);
      return;
    }

    if (debugState.warnings.length) {
      const box = document.createElement("div");
      box.className = "dbg-notice__box";
      for (const warning of debugState.warnings) {
        const p = document.createElement("p");
        p.textContent = warning;
        box.appendChild(p);
      }
      host.appendChild(box);
    }
  };

  const dbgRenderAll = () => {
    dbgRenderNotice();
    dbgRenderStatus();
    dbgRenderGutter();
    dbgRenderVariables();
    dbgRenderStack();
    dbgRenderOutput();
  };

  /* -------------------------------- controls ------------------------------ */

  const dbgStep = () => {
    if (debugState.error || !debugState.session) return;
    debugState.session.advance();
    dbgRenderAll();
  };

  const dbgContinue = () => {
    if (debugState.error || !debugState.session) return;
    /* With no breakpoints this is the same as running to the end, and the button
       says so rather than pretending to have done something less. */
    if (!debugState.breakpoints.size) {
      debugState.session.runToEnd();
    } else {
      debugState.session.runTo(debugState.breakpoints);
    }
    dbgRenderAll();
  };

  const dbgRunToEnd = () => {
    if (debugState.error || !debugState.session) return;
    debugState.session.runToEnd();
    dbgRenderAll();
  };

  const dbgReset = () => {
    dbgCompile({ reset: true });
  };

  const dbgLoadExample = (key) => {
    const example = DEBUG_EXAMPLES.find((e) => e.key === key);

    /* "Your own code" is a real choice. It used to return immediately, so the
       dropdown said "Your own code" while the editor still held the previous
       example and the caption underneath still described that example's
       snippet - the control was claiming something untrue. Selecting it keeps
       what the reader has typed and only drops the example caption. */
    if (!example) {
      debugState.example = "";
      const why = dbgEl("dbg-example-why");
      if (why) why.textContent = "Your own code. Nothing here is written or sent anywhere - it runs on this device.";
      dbgSaveState();
      return;
    }
    debugState.example = key;
    debugState.source = example.code;
    const editor = dbgEl("dbg-code");
    if (editor) editor.value = example.code;
    dbgCompile({ reset: true });
  };

  /* =============================== code review =============================
     A static reviewer for a solution you have written.

     What this is
     ------------
     A static analyser. It parses the code, walks the tree, and reports conditions
     it can establish from that tree - how many loops are nested, whether a
     function can fall off the end, whether the array being modified is the array
     being iterated.

     What this is not
     ----------------
     It is not a language model, and it does not pretend to be one. There is no
     model behind this page and nothing is sent anywhere. It cannot tell you why
     your algorithm is right, it does not read the problem statement, and it will
     never say "looks good" - because a tool that hands you a verdict you have not
     earned is worse than one that hands you nothing.

     So every finding carries the evidence that produced it. You are meant to
     check it and disagree with it. A finding you have reasoned past and dismissed
     is the page working; a finding you accept without reading is the page failing.

     The complexity figure is a heuristic and is labelled as one throughout
     ---------------------------------------------------------------------
     Counting nested loops gives a real bound for loop-shaped code and nothing at
     all for work hidden behind a call. Array.sort inside a loop is O(n) to the
     counter and O(n log n) in reality. Every estimate therefore lists what it was
     derived from and what it could not see, and the ceiling it compares against
     is stated as a rough one. */

  const REVIEW_KEY = "quantaReviewV1";

  const REVIEW_EXAMPLES = [
    {
      key: "two-sum-map",
      title: "Two Sum, linear",
      code: `function twoSum(nums, target) {
    const seen = new Map();
    for (let i = 0; i < nums.length; i++) {
      const need = target - nums[i];
      if (seen.has(need)) return [seen.get(need), i];
      seen.set(nums[i], i);
    }
    return [];
  }`,
      problem: { paramHint: "nums", constraintsHint: "2 <= nums.length <= 1e5" }
    },
    {
      key: "two-sum-brute",
      title: "Two Sum, the version that times out",
      code: `function twoSum(nums, target) {
    for (let i = 0; i < nums.length; i++) {
      for (let j = i + 1; j < nums.length; j++) {
        if (nums[i] + nums[j] === target) return [i, j];
      }
    }
    return [];
  }`,
      problem: { paramHint: "nums", constraintsHint: "2 <= nums.length <= 1e9" }
    },
    {
      key: "mutate-while-looping",
      title: "Removing duplicates by splicing",
      code: `function removeDuplicates(nums) {
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] === nums[i + 1]) {
        nums.splice(i, 1);
      }
    }
    return nums;
  }`,
      problem: null
    },
    {
      key: "clean-accumulator",
      title: "Filtering, done correctly",
      code: `function evenNumbers(nums) {
    const out = [];
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] % 2 === 0) {
        out.push(nums[i]);
      }
    }
    return out;
  }`,
      problem: { paramHint: "nums", constraintsHint: "1 <= nums.length <= 1e4" }
    },
    {
      key: "missing-return",
      title: "A function that forgets to return",
      code: `function indexOfValue(nums, target) {
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] === target) {
        return i;
      }
    }
  }`,
      problem: null
    },
    {
      key: "loose-equality",
      title: "Equality, the lazy way",
      code: `function sameLength(a, b) {
    return a.length == b.length;
  }

  function isMissing(value) {
    return value == null;
  }`,
      problem: null
    }
  ];

  /* reviewState.problem is what the complexity cross-check measures against.

     It used to default to REVIEW_EXAMPLES[0].problem, which carries a hard-coded
     "1e5" constraint, while the constraints box on screen was empty. So after a
     reload the panel would state "within range" for a constraint the reader had
     never typed, on a problem they had not selected - a confident claim about
     something nobody could see or change.

     It now starts empty. Nothing is asserted until the reader supplies a problem
     or picks an example, and the cross-check says so when there is nothing to
     compare against. */
  const reviewState = {
    source: REVIEW_EXAMPLES[0].code,
    example: "two-sum-map",
    problem: null,
    constraintsHint: "",
    paramHint: "",
    result: null,
    filter: "all",
    expanded: new Set()
  };

  const revEl = (id) => document.getElementById(id);

  const revLoadState = () => {
    const saved = readJson(REVIEW_KEY, () => ({}));
    if (saved && typeof saved === "object") {
      if (typeof saved.source === "string" && saved.source.trim()) reviewState.source = saved.source;
      if (saved.filter && ["all", "serious", "warning", "notice"].includes(saved.filter)) reviewState.filter = saved.filter;
      /* The example choice is saved too. It used to be dropped on reload, so the
         dropdown said "Two Sum, linear" while the editor held whatever the
         reader had typed - the control was describing something other than what
         was on screen. It is validated against the real example list so a stale
         or hand-edited value cannot point at an example that no longer exists. */
      if (typeof saved.example === "string" && REVIEW_EXAMPLES.some((e) => e.key === saved.example)) {
        reviewState.example = saved.example;
      }
      /* The constraints the reader typed are part of what the panel is about:
         the complexity cross-check compares the estimate against them. Saving
         only the code meant a reload showed empty constraint boxes while the
         report below still quoted a constraint nobody could see. */
      if (typeof saved.constraints === "string") reviewState.constraintsHint = saved.constraints;
      if (typeof saved.param === "string") reviewState.paramHint = saved.param;
    }
  };

  const revSaveState = () => {
    writeJson(REVIEW_KEY, {
      source: reviewState.source,
      filter: reviewState.filter,
      example: reviewState.example,
      constraints: reviewState.constraintsHint,
      param: reviewState.paramHint
    });
  };

  /* ------------------------------ rendering ------------------------------- */

  const SEVERITY_LABEL = { serious: "Worth fixing", warning: "Check this", notice: "Minor" };

  const renderComplexity = () => {
    const host = revEl("rev-complexity");
    if (!host) return;
    host.innerHTML = "";
    const result = reviewState.result;
    /* Used to return silently, leaving this section of the page completely
       blank with no explanation - three output areas, two of which said nothing
       at all when the snippet could not be parsed. It now says why. */
    if (!result?.ok) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = result?.error || "Nothing to estimate until there is code to read.";
      host.appendChild(p);
      return;
    }

    const complexity = result.complexity;

    const grid = document.createElement("div");
    grid.className = "rev-complexity__grid";

    const cell = (label, value, note, tone) => {
      const item = document.createElement("div");
      item.className = `rev-complexity__item${tone ? ` is-${tone}` : ""}`;
      const k = document.createElement("span");
      k.className = "rev-complexity__label";
      k.textContent = label;
      const v = document.createElement("span");
      v.className = "rev-complexity__value";
      /* The caveat is real text, not a CSS ::after. A pseudo-element is
         invisible to a screen reader, absent from the accessibility tree, and
         cannot be copied - and this is the one thing stopping the number from
         reading as a verdict. */
      v.textContent = tone === "heuristic" ? `${value} (estimate)` : value;
      item.append(k, v);
      if (note) {
        const n = document.createElement("span");
        n.className = "rev-complexity__note";
        n.textContent = note;
        item.appendChild(n);
      }
      grid.appendChild(item);
    };

    cell("Time", complexity.time, complexity.basis, "heuristic");
    cell("Space", complexity.space, null);
    cell("Shape", `${complexity.loopCount} loop${complexity.loopCount === 1 ? "" : "s"}, deepest nest ${complexity.loopDepth}`,
      complexity.recursion.length ? `recurses: ${complexity.recursion.map((r) => r.name).join(", ")}` : null);

    host.appendChild(grid);

    /* The caveats are the honest half of the estimate, so they sit directly under
       it rather than in a footnote at the bottom of the page. */
    if (complexity.caveats.length) {
      const box = document.createElement("div");
      box.className = "rev-caveats";
      const title = document.createElement("p");
      title.className = "rev-caveats__title";
      title.textContent = "The loop count cannot see this";
      box.appendChild(title);
      for (const caveat of complexity.caveats) {
        const row = document.createElement("p");
        row.className = "rev-caveats__item";
        row.textContent = `${caveat.title} — ${caveat.detail}, so ${caveat.cost}`;
        box.appendChild(row);
      }
      host.appendChild(box);
    }
  };

  const renderFindings = () => {
    const host = revEl("rev-findings");
    if (!host) return;
    host.innerHTML = "";

    const result = reviewState.result;
    if (!result) return;

    if (!result.ok) {
      const box = document.createElement("div");
      box.className = "rev-notice is-error";
      const p = document.createElement("p");
      p.textContent = result.error;
      box.appendChild(p);
      if (result.line) {
        const where = document.createElement("p");
        where.className = "rev-notice__where";
        where.textContent = `Line ${result.line}. Nothing below was checked, because nothing could be parsed.`;
        box.appendChild(where);
      }
      host.appendChild(box);
      return;
    }

    const all = result.findings;
    const shown = reviewState.filter === "all" ? all : all.filter((f) => f.severity === reviewState.filter);

    /* The empty state is careful. "No problems found" would be a claim about
       correctness that this page has no standing to make. */
    if (!all.length) {
      const box = document.createElement("div");
      box.className = "rev-notice is-clear";
      const p = document.createElement("p");
      p.textContent = "None of the checks here fired.";
      const why = document.createElement("p");
      why.className = "rev-notice__where";
      why.textContent = `That is ${window.reviewEngine.REVIEW_RULES.length} specific conditions, each either true or false about the syntax tree — not a judgement that the code is correct. Whether the algorithm is right is still your call.`;
      box.append(p, why);
      host.appendChild(box);
    }

    if (all.length && !shown.length) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = "Nothing at this level.";
      host.appendChild(p);
      return;
    }

    for (const finding of shown) {
      const card = document.createElement("article");
      card.className = `rev-finding is-${finding.severity}`;

      const head = document.createElement("button");
      head.type = "button";
      head.className = "rev-finding__head";
      head.setAttribute("aria-expanded", String(reviewState.expanded.has(finding.key)));

      const badge = document.createElement("span");
      badge.className = "rev-finding__badge";
      badge.textContent = SEVERITY_LABEL[finding.severity] || finding.severity;

      const title = document.createElement("span");
      title.className = "rev-finding__title";
      title.textContent = finding.title;

      const where = document.createElement("span");
      where.className = "rev-finding__where";
      where.textContent = finding.line ? `line ${finding.line}` : "whole file";

      head.append(badge, title, where);
      card.appendChild(head);

      /* The detail is always visible - the line number and the one-line reason
         are the part you scan - and the explanation is what you open. */
      const body = document.createElement("div");
      body.className = "rev-finding__body";
      body.hidden = !reviewState.expanded.has(finding.key);

      if (finding.detail) {
        const code = document.createElement("code");
        code.className = "rev-finding__code";
        code.textContent = finding.detail.replace(/`/g, "");
        body.appendChild(code);
      }
      const why = document.createElement("p");
      why.className = "rev-finding__why";
      why.textContent = finding.why;
      body.appendChild(why);
      if (finding.whyItMatters) {
        const matters = document.createElement("p");
        matters.className = "rev-finding__matters";
        matters.textContent = finding.whyItMatters;
        body.appendChild(matters);
      }
      if (finding.evidence) {
        const evidence = document.createElement("p");
        evidence.className = "rev-finding__evidence";
        evidence.textContent = `How Quanta knows: ${finding.evidence}`;
        body.appendChild(evidence);
      }
      card.appendChild(body);

      head.addEventListener("click", () => {
        if (reviewState.expanded.has(finding.key)) reviewState.expanded.delete(finding.key);
        else reviewState.expanded.add(finding.key);
        /* This card only. Re-rendering the whole list detaches the button that
           was just pressed, so focus falls back to the body and keyboard use
           breaks after a single toggle. */
        const isOpen = reviewState.expanded.has(finding.key);
        body.hidden = !isOpen;
        head.setAttribute("aria-expanded", String(isOpen));
      });

      host.appendChild(card);
    }
  };

  const renderCross = () => {
    const host = revEl("rev-cross");
    if (!host) return;
    host.innerHTML = "";
    const result = reviewState.result;
    if (!result?.ok) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = result?.error || "Nothing to cross-check until there is code to read.";
      host.appendChild(p);
      return;
    }

    if (!result.cross.checks.length) {
      const p = document.createElement("p");
      p.className = "pattern-intro";
      p.textContent = result.cross.summary || "Nothing to cross-check.";
      host.appendChild(p);
      return;
    }

    for (const check of result.cross.checks) {
      const row = document.createElement("div");
      row.className = `rev-check is-${check.severity}`;
      const title = document.createElement("span");
      title.className = "rev-check__title";
      title.textContent = check.title;
      const detail = document.createElement("span");
      detail.className = "rev-check__detail";
      detail.textContent = check.detail;
      row.append(title, detail);
      host.appendChild(row);
    }
  };

  const renderReviewAll = () => {
    const editor = revEl("rev-code");
    if (editor && editor.value !== reviewState.source) editor.value = reviewState.source;

    const counts = revEl("rev-counts");
    if (counts) {
      const result = reviewState.result;
      counts.innerHTML = "";
      if (!result?.ok) {
        const pill = document.createElement("span");
        pill.className = "rev-pill is-error";
        pill.textContent = "could not parse";
        counts.appendChild(pill);
      } else {
        const total = result.findings.length;
        const pill = document.createElement("span");
        pill.className = `rev-pill${total ? "" : " is-clear"}`;
        pill.textContent = total ? `${total} to look at` : "nothing fired";
        counts.appendChild(pill);
        for (const severity of ["serious", "warning", "notice"]) {
          const n = result.counts[severity];
          if (!n) continue;
          const p = document.createElement("span");
          p.className = `rev-pill is-${severity}`;
          p.textContent = `${n} ${SEVERITY_LABEL[severity].toLowerCase()}`;
          counts.appendChild(p);
        }
      }
    }

    renderComplexity();
    renderFindings();
    renderCross();
  };

  /* ------------------------------- running -------------------------------- */

  const runReview = () => {
    const editor = revEl("rev-code");
    if (editor) reviewState.source = editor.value;
    revSaveState();

    /* Guarded. This runs from initReview(), which runs at start-up, so a
       review.js that failed to load threw here and - being in the middle of the
       start-up sequence - took every initialiser after it down with it. The app
       came up blank rather than showing a broken reviewer. */
    if (!window.reviewEngine || typeof window.reviewEngine.review !== "function") {
      reviewState.result = { ok: false, findings: [], issues: [], error: "The code review module did not load on this device." };
      renderReviewAll();
      return;
    }

    /* In the page, not over the network. `review` is synchronous and touches
       nothing else. Wrapped anyway: a parser that throws on some input should
       cost that one snippet its report, not the whole panel. */
    try {
      reviewState.result = window.reviewEngine.review(reviewState.source, reviewState.problem);
    } catch (error) {
      reviewState.result = {
        ok: false,
        findings: [],
        issues: [],
        error: `The reviewer could not read this snippet: ${error?.message || error}`
      };
    }
    renderReviewAll();
  };

  const loadReviewExample = (key) => {
    const example = REVIEW_EXAMPLES.find((e) => e.key === key);

    /* "Your own code" is a real choice, not a no-op. Selecting it used to return
       immediately, so the dropdown said "Your own code" while the editor, the
       constraints boxes and the previous example's hard-coded limits were all
       still that example's - the control claimed something that was not true.
       Choosing it clears the example's problem so the cross-check stops
       asserting a constraint belonging to a snippet that is no longer loaded. */
    if (!example) {
      reviewState.example = "";
      reviewState.problem = null;
      reviewState.constraintsHint = "";
      reviewState.paramHint = "";
      const box = revEl("rev-constraints");
      if (box) box.value = "";
      const nameBox = revEl("rev-param");
      if (nameBox) nameBox.value = "";
      revSaveState();
      runReview();
      return;
    }
    reviewState.example = key;
    reviewState.source = example.code;
    reviewState.problem = example.problem;
    reviewState.expanded = new Set();
    /* The severity filter goes back to Everything. Loading new code produces a
       new set of findings, and carrying a filter over from the previous snippet
       left the reader looking at an empty list with no visible reason. */
    reviewState.filter = "all";
    for (const button of revEl("rev-filters")?.querySelectorAll(".rev-filter") || []) {
      button.classList.toggle("is-active", button.textContent === "Everything");
    }
    const editor = revEl("rev-code");
    if (editor) editor.value = example.code;
    const problem = revEl("rev-constraints");
    if (problem) problem.value = example.problem?.constraintsHint || "";
    const param = revEl("rev-param");
    if (param) param.value = example.problem?.paramHint || "";
    runReview();
  };

  /* Reads the two problem fields back into the object the reviewer takes. Both
     optional: without them the review still runs, it just cannot compare against
     constraints. */
  const readProblemFields = () => {
    const constraints = (revEl("rev-constraints")?.value || "").trim();
    const param = (revEl("rev-param")?.value || "").trim();
    reviewState.constraintsHint = constraints;
    reviewState.paramHint = param;
    reviewState.problem = constraints || param ? { constraintsHint: constraints, paramHint: param } : null;
  };

  /* ---------------------------------- init -------------------------------- */

  const initReview = () => {
    revLoadState();

    const editor = revEl("rev-code");
    if (editor) {
      editor.value = reviewState.source;
      let timer = null;
      editor.addEventListener("input", () => {
        reviewState.source = editor.value;
        clearTimeout(timer);
        timer = setTimeout(runReview, 500);
      });
      editor.addEventListener("keydown", (event) => {
        if (event.key !== "Tab") return;
        event.preventDefault();
        const start = editor.selectionStart;
        editor.setRangeText("  ", start, editor.selectionEnd, "end");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    revEl("rev-run")?.addEventListener("click", () => {
      readProblemFields();
      runReview();
    });

    const picker = revEl("rev-examples");
    if (picker) {
      picker.innerHTML = "";
      for (const example of REVIEW_EXAMPLES) {
        const option = document.createElement("option");
        option.value = example.key;
        option.textContent = example.title;
        picker.appendChild(option);
      }
      const own = document.createElement("option");
      own.value = "";
      own.textContent = "Your own code";
      picker.appendChild(own);
      picker.value = reviewState.example || "";
      picker.addEventListener("change", () => loadReviewExample(picker.value));
    }

    const filters = revEl("rev-filters");
    if (filters) {
      filters.innerHTML = "";
      for (const [value, label] of [["all", "Everything"], ["serious", "Worth fixing"], ["warning", "Check this"], ["notice", "Minor"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `rev-filter${reviewState.filter === value ? " is-active" : ""}`;
        button.textContent = label;
        button.addEventListener("click", () => {
          reviewState.filter = value;
          revSaveState();
          for (const other of filters.querySelectorAll(".rev-filter")) other.classList.remove("is-active");
          button.classList.add("is-active");
          renderFindings();
        });
        filters.appendChild(button);
      }
    }

    /* The two problem fields feed the cross-check, and changing them re-runs it
       without touching the code. */
    for (const id of ["rev-constraints", "rev-param"]) {
      revEl(id)?.addEventListener("input", () => {
        readProblemFields();
        runReview();
      });
    }

    /* The two problem fields are restored from storage too, so the cross-check
       below is comparing against the constraints the reader can actually see.
       readProblemFields() then rebuilds reviewState.problem from what is on
       screen, which is the only place it should come from - a constraint held
       only in a variable is one the reader cannot see or correct. */
    const savedConstraints = revEl("rev-constraints");
    if (savedConstraints) savedConstraints.value = reviewState.constraintsHint || "";
    const savedParam = revEl("rev-param");
    if (savedParam) savedParam.value = reviewState.paramHint || "";
    readProblemFields();

    runReview();
  };


  /* ---------------------------------- init -------------------------------- */

  const initDebugger = () => {
    dbgLoadState();

    const editor = dbgEl("dbg-code");
    if (editor) {
      editor.value = debugState.source;
      /* Recompiled on a pause rather than on every keystroke. Compiling is cheap
         but the trace resets, and losing your place because you were still typing
         is the fastest way to make someone stop using a debugger. */
      let timer = null;
      editor.addEventListener("input", () => {
        debugState.source = editor.value;
        clearTimeout(timer);
        timer = setTimeout(() => dbgCompile({ reset: true }), 700);
      });
      editor.addEventListener("scroll", () => {
        const gutter = dbgEl("dbg-gutter");
        if (gutter) gutter.scrollTop = editor.scrollTop;
      });
      editor.addEventListener("keydown", (event) => {
        /* Tab indents rather than leaving the editor, which is what a person
           writing code in a textarea expects. */
        if (event.key !== "Tab") return;
        event.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.setRangeText("  ", start, end, "end");
        editor.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }

    dbgEl("dbg-step")?.addEventListener("click", dbgStep);
    dbgEl("dbg-continue")?.addEventListener("click", dbgContinue);
    dbgEl("dbg-run-end")?.addEventListener("click", dbgRunToEnd);
    dbgEl("dbg-reset")?.addEventListener("click", dbgReset);

    const picker = dbgEl("dbg-examples");
    if (picker) {
      picker.innerHTML = "";
      for (const example of DEBUG_EXAMPLES) {
        const option = document.createElement("option");
        option.value = example.key;
        option.textContent = example.title;
        option.title = example.why;
        picker.appendChild(option);
      }
      /* The current text is a snippet of the reader's own if it no longer matches
         one of the examples, so the picker says "your own" rather than pretending
         to have a selection that does not exist. */
      const custom = document.createElement("option");
      custom.value = "";
      custom.textContent = "Your own code";
      picker.appendChild(custom);
      picker.value = debugState.example || "";
      picker.addEventListener("change", () => dbgLoadExample(picker.value));
    }

    const why = dbgEl("dbg-example-why");
    if (why) {
      const sync = () => {
        const example = DEBUG_EXAMPLES.find((e) => e.key === picker?.value);
        why.textContent = example ? example.why : "Paste any JavaScript above. It runs here, in this page, and is never uploaded.";
      };
      sync();
      picker?.addEventListener("change", sync);
    }

    dbgCompile({ reset: true });
  };


  /* ---------------------------------- init -------------------------------- */

  const initArena = () => {
    arenaLoadState();
    arenaState.seconds = Math.round(Date.now() / 1000);

    const input = arenaEl("arena-handle");
    if (input) {
      input.value = arenaState.handle;
      input.addEventListener("change", () => {
        const value = input.value.trim().slice(0, 32);
        arenaState.handle = value;
        arenaSaveState();
        void loadArenaProfile();
        /* The standings need the handle too, so the open round redraws with the
           reader's row in it. */
        if (arenaState.selected) void loadArenaContest(arenaState.selected);
      });
    }

    const refresh = arenaEl("arena-refresh");
    /* Refresh used to reload the contest list and the profile but not the round
       already open, so the detail stayed stale while everything around it
       updated - the one thing a reader pressing Refresh is most likely to be
       asking about. The open round is reloaded too, when there is one. */
    refresh?.addEventListener("click", () => {
      void loadArena();
      if (arenaState.selected) void loadArenaContest(arenaState.selected);
    });

    void loadArena();
  };

  const arenaOnShow = () => {
    arenaStartClock();
    /* Refreshed on every visit rather than cached in the page, because the whole
       reason to come back here is to see what changed. */
    void loadArena();
  };

  const arenaOnHide = () => {
    arenaStopClock();
  };


  /* -------------------------------- init -------------------------------- */

  /* Start-up used to be a flat list of calls. One throwing initialiser - a
     module that failed to load, a browser that lacks something the panel
     assumes - skipped every line after it, including showPage() at the end, and
     the reader got a blank screen with no error anywhere. Every panel is now
     started inside this wrapper, so a failure is confined to the panel that
     caused it and the rest of the app still comes up.

     A failure is reported rather than swallowed: the panel says so on screen,
     and the reason is logged so it can be diagnosed. */
  const initFailures = [];
  /* Maps an initialiser to the page element it owns, so a failure can say so on
     screen. Keys are the initialiser names used below; the values are the real
     element ids in index.html, which are not all the name you would guess. */
  const INIT_PANEL_IDS = {
    initRevisionReminderSettings: "page-settings",
    initConnectionDiagnostics: "page-settings",
    initVisualizer: "page-visualizer",
    initDiscovery: "page-discovery",
    initAcademy: "page-academy",
    initPatterns: "page-patterns",
    initMock: "page-mock",
    initDebugger: "page-debugger",
    initReview: "page-review",
    initCompanies: "page-companies",
    initArena: "page-arena",
    initLcFilters: "page-quantalab",
    renderTabs: "page-quantalab",
    renderLcAll: "page-quantalab",
    renderPersonalNotes: "page-notes"
  };

  const initSafely = (name, fn, ...args) => {
    try {
      fn(...args);
    } catch (error) {
      initFailures.push({ name, error });
      console.error(`Quanta: ${name} failed to start.`, error);
      try {
        const host = byId(INIT_PANEL_IDS[name] || "");
        if (host) {
          const note = document.createElement("p");
          /* Reuses an existing class rather than inventing one, so the message
             is styled like every other error in the app without a new rule. */
          note.className = "viz-note--error";
          note.textContent = `${name.replace(/^init/, "")} could not start on this device. The rest of Quanta is unaffected.`;
          host.appendChild(note);
        }
      } catch {
        /* Nothing to attach the message to; the console entry above stands. */
      }
    }
  };

  ensureActiveSession();
  labAutoSaveToggle.checked = labState.autoSave;
  initSafely("initRevisionReminderSettings", initRevisionReminderSettings);
  /* Connection diagnostics run once in the background and then only when the
     network changes or the user asks. Nothing here blocks start-up. */
  initSafely("initConnectionDiagnostics", initConnectionDiagnostics);
  initSafely("initVisualizer", initVisualizer);
  initSafely("initDiscovery", initDiscovery);
  /* window.initAcademy rather than the local name: academy.js publishes it on
     window, so a module that did not load used to throw here and take the whole
     app with it. */
  initSafely("initAcademy", () => {
    if (typeof window.initAcademy !== "function") {
      throw new Error("The Academy module (academy.js) did not load.");
    }
    window.initAcademy();
  });
  initSafely("initPatterns", initPatterns);
  initSafely("initMock", initMock);
  initSafely("initDebugger", initDebugger);
  initSafely("initReview", initReview);
  initSafely("initCompanies", initCompanies);
  initSafely("initArena", initArena);
  initSafely("initLcFilters", initLcFilters);
  initSafely("renderTabs", renderTabs);
  initSafely("renderLcAll", renderLcAll);
  initSafely("renderPersonalNotes", renderPersonalNotes);
  /* Deliberately outside the wrapper: without this the reader gets a blank
     page, and that is the one failure worth stopping for. */
  showPage("quantalab", { resetScroll: true });
  void fetchRunCapabilities();
  /* Pull problems marked solved on another device (e.g. the phone). */
  void syncSolvedFromServer();

  if (initFailures.length) {
    console.warn(
      `Quanta started with ${initFailures.length} panel(s) unavailable: ${initFailures.map((f) => f.name).join(", ")}.`
    );
  }
})();
