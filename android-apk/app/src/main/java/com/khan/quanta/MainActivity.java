package com.khan.quanta;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.widget.LinearLayout;
import android.widget.FrameLayout;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * Quanta — native Android wrapper.
 *
 * Serves the entire web app from bundled assets at https://localhost/ so the
 * WebView treats it as a secure origin (localStorage, workers, Monaco all work),
 * while real external links (LeetCode, GitHub, …) open in the user's browser.
 * Compile & run requests go over the LAN to the PC server (Settings → Connection).
 */
public class MainActivity extends Activity {

    private WebView webView;

    /* Set by the page (QuantaBack bridge) right before Back is pressed: true when
       there is typed work that has not been saved yet. */
    private volatile boolean pendingUnsavedWork = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(Color.parseColor("#04110C"));
        window.setNavigationBarColor(Color.parseColor("#04110C"));

        // Root layout: [status-bar spacer][WebView]. WebView.setPadding() does
        // NOT move web content, so the only reliable way to keep the web UI
        // (header, burger, Exit) below the clock/battery/notch is a native
        // spacer view that we resize from real window insets.
        final LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#04110C"));

        final View statusBarSpacer = new View(this);
        root.addView(statusBarSpacer, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#04110C"));
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Grow the spacer by the real status-bar height (plus camera cutout).
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                int top;
                if (Build.VERSION.SDK_INT >= 30) {
                    top = insets.getInsets(
                            WindowInsets.Type.statusBars() | WindowInsets.Type.displayCutout()).top;
                } else {
                    @SuppressWarnings("deprecation")
                    int legacy = insets.getSystemWindowInsetTop();
                    top = legacy;
                }
                statusBarSpacer.getLayoutParams().height = top;
                statusBarSpacer.requestLayout();
                // Consume the top inset here: the native spacer is the ONLY
                // place the status-bar height is applied. Returning the
                // insets untouched made the WebView report the same top inset
                // again via env(safe-area-inset-top), so the CSS pushed the
                // header down twice (the extra gap under the status bar).
                if (Build.VERSION.SDK_INT >= 30) {
                    return insets.inset(0, top, 0, 0);
                }
                @SuppressWarnings("deprecation")
                WindowInsets legacy = insets.replaceSystemWindowInsets(
                        insets.getSystemWindowInsetLeft(), 0,
                        insets.getSystemWindowInsetRight(),
                        insets.getSystemWindowInsetBottom());
                return legacy;
            }
        });

        // Bridge the web "Exit -> Yes" button to actually finish the app.
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void closeApp() {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        MainActivity.this.finish();
                    }
                });
            }
        }, "QuantaApp");

        // The hardware Back button used to leave the app straight away, which
        // threw away typing that was never saved. It now asks the page first:
        // when there is unsaved work the page shows its own confirmation, and
        // when there is none the app closes exactly as before.
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void reportUnsavedWork(final boolean hasUnsavedWork) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        pendingUnsavedWork = hasUnsavedWork;
                    }
                });
            }
        }, "QuantaBack");

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setTextZoom(100);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Lets the web app detect that it runs inside the Quanta wrapper.
        settings.setUserAgentString(settings.getUserAgentString() + " QuantaAndroid/1.0");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        }

        webView.setWebViewClient(new QuantaWebViewClient());
        // Required so window.prompt / confirm / alert work inside the WebView.
        webView.setWebChromeClient(new WebChromeClient());
        webView.loadUrl("http://localhost/index.html");
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        pendingUnsavedWork = false;
        webView.evaluateJavascript(
            "(function(){try{return window.QuantaBack && window.QuantaBack.reportUnsavedWork("
                + "!!(window.quantaHasUnsavedWork && window.quantaHasUnsavedWork()));}catch(e){return true;}})()",
            new ValueCallback<String>() {
                @Override
                public void onReceiveValue(String value) {
                    if ("true".equals(value) && pendingUnsavedWork) {
                        // The page owns the confirmation; it decides what to do.
                        webView.evaluateJavascript(
                            "window.quantaHandleBack && window.quantaHandleBack()", null);
                        return;
                    }
                    finish();
                }
            });
    }

    private class QuantaWebViewClient extends WebViewClient {

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme();

            if (scheme.equals("http") || scheme.equals("https")) {
                String host = uri.getHost() == null ? "" : uri.getHost();
                if (host.equals("localhost") || host.equals("127.0.0.1")) {
                    // Our own origin (assets + run API base) stays inside the app.
                    return false;
                }
            }
            // LeetCode, GitHub, mailto, etc. open outside the app.
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
            }
            return true;
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            String scheme = url.getScheme() == null ? "" : url.getScheme();
            if (!("http".equals(scheme) || "https".equals(scheme)) || !"localhost".equals(url.getHost())) {
                return null; // compiler-server traffic goes to the network normally
            }
            String path = url.getPath();
            if (path == null || path.isEmpty() || "/".equals(path)) {
                path = "/index.html";
            }
            final String assetPath = path.startsWith("/") ? path.substring(1) : path;

            InputStream stream;
            try {
                stream = getAssets().open(assetPath);
            } catch (IOException e) {
                // API paths must NEVER fall back to the app shell: the web app
                // would try to parse index.html as JSON. A clean JSON 404 lets
                // it show a friendly offline message instead of crashing.
                if (assetPath.startsWith("api/")) {
                    return apiNotFound();
                }
                // SPA-ish fallback: unknown extensionless path gets the app shell.
                try {
                    stream = getAssets().open("index.html");
                } catch (IOException e2) {
                    return notFound();
                }
            }

            String mime = guessMime(assetPath);
            String encoding = mime.startsWith("text/") || mime.contains("javascript")
                    || mime.contains("json") ? "utf-8" : null;
            WebResourceResponse response = new WebResourceResponse(mime, encoding, stream);
            response.setResponseHeaders(java.util.Collections.singletonMap(
                    "Access-Control-Allow-Origin", "*"));
            return response;
        }

        private WebResourceResponse notFound() {
            return new WebResourceResponse("text/plain", "utf-8",
                    new ByteArrayInputStream("Not found".getBytes()));
        }

        private WebResourceResponse apiNotFound() {
            String body = "{\"ok\":false,\"error\":\"Compiler server unreachable. Connect to the PC running Quanta (Settings > Connection).\"}";
            return new WebResourceResponse("application/json", "utf-8", 404, "Not Found",
                    java.util.Collections.singletonMap("Access-Control-Allow-Origin", "*"),
                    new ByteArrayInputStream(body.getBytes()));
        }

        private String guessMime(String path) {
            String lower = path.toLowerCase();
            if (lower.endsWith(".html")) return "text/html";
            if (lower.endsWith(".js")) return "application/javascript";
            if (lower.endsWith(".css")) return "text/css";
            if (lower.endsWith(".json") || lower.endsWith(".webmanifest")) return "application/json";
            if (lower.endsWith(".png")) return "image/png";
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
            if (lower.endsWith(".svg")) return "image/svg+xml";
            if (lower.endsWith(".ico")) return "image/x-icon";
            if (lower.endsWith(".woff2")) return "font/woff2";
            if (lower.endsWith(".woff")) return "font/woff";
            if (lower.endsWith(".ttf")) return "font/ttf";
            if (lower.endsWith(".wasm")) return "application/wasm";
            return "application/octet-stream";
        }
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
