package eu.redforged.introvert

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var currentWebView: WebView? = null
  private var lastInsetsJs: String? = null

  inner class AndroidBridge {
    @JavascriptInterface
    fun updateTheme(isLight: Boolean) {
      runOnUiThread {
        val insetsController = WindowCompat.getInsetsController(window, window.decorView)
        insetsController.isAppearanceLightStatusBars = isLight
        insetsController.isAppearanceLightNavigationBars = isLight
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    // Ensure system bars are transparent so WebView content and dynamic theme background flow seamlessly behind them
    window.statusBarColor = Color.TRANSPARENT
    window.navigationBarColor = Color.TRANSPARENT

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      window.isStatusBarContrastEnforced = false
      window.isNavigationBarContrastEnforced = false
    }

    val contentView = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(contentView) { _, insets ->
      val systemBars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val density = resources.displayMetrics.density
      val topDp = if (density > 0) (systemBars.top / density).toInt() else systemBars.top
      val bottomDp = if (density > 0) (systemBars.bottom / density).toInt() else systemBars.bottom
      val leftDp = if (density > 0) (systemBars.left / density).toInt() else systemBars.left
      val rightDp = if (density > 0) (systemBars.right / density).toInt() else systemBars.right

      val js = """
        (function() {
          var root = document.documentElement;
          root.style.setProperty('--safe-area-top', '${topDp}px');
          root.style.setProperty('--safe-area-bottom', '${bottomDp}px');
          root.style.setProperty('--safe-area-left', '${leftDp}px');
          root.style.setProperty('--safe-area-right', '${rightDp}px');
        })();
      """.trimIndent()

      lastInsetsJs = js
      currentWebView?.post {
        currentWebView?.evaluateJavascript(js, null)
      }

      insets
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    currentWebView = webView

    // Transparent background so the app's dynamic theme/canvas colors show through
    webView.setBackgroundColor(Color.TRANSPARENT)
    webView.addJavascriptInterface(AndroidBridge(), "AndroidBridge")

    lastInsetsJs?.let { js ->
      webView.post {
        webView.evaluateJavascript(js, null)
      }
    }
  }
}
