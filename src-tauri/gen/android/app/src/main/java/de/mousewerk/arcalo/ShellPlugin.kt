package de.mousewerk.arcalo

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.webkit.WebView
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class BarsArgs {
    var dark: Boolean = false
    lateinit var top: String
    lateinit var bottom: String
}

/**
 * The window around the WebView (src-tauri/src/mobile/android.rs): the colors behind the status
 * and navigation bars follow the app's theme (not only the system's), the back button at the
 * app's root sends it to the background like other Android apps, and text shared to Arcalo from
 * another app („Teilen“ → Arcalo) waits here until the UI takes it into a capture.
 */
@TauriPlugin
class ShellPlugin(private val activity: Activity) : Plugin(activity) {
    @Volatile private var shared: String? = null

    override fun load(webView: WebView) {
        take(activity.intent)
    }

    override fun onNewIntent(intent: Intent) {
        take(intent)
    }

    private fun take(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("text/") != true) return
        val text = intent.getStringExtra(Intent.EXTRA_TEXT)?.trim().orEmpty()
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.trim().orEmpty()
        // Browsers share a page as its title (subject) and address (text).
        val joined = when {
            subject.isEmpty() || text.contains(subject) -> text
            text.isEmpty() -> subject
            else -> subject + "\n" + text
        }
        if (joined.isNotEmpty()) shared = joined
        // Taken once: a later restart of the activity must not capture it again.
        intent.action = Intent.ACTION_MAIN
    }

    /** The text shared to the app since the last call (once), or nothing. */
    @Command
    fun sharedText(invoke: Invoke) {
        val ret = JSObject()
        shared?.let { ret.put("text", it) }
        shared = null
        invoke.resolve(ret)
    }

    /**
     * The window's colors behind the status bar (top) and the navigation bar (bottom), and light
     * or dark icons on them. The WebView sits between the bars (MainActivity pads it), so the
     * window shows only at the edges: a gradient that holds the top color for the upper third and
     * the bottom color for the lower third.
     */
    @Command
    fun setBars(invoke: Invoke) {
        val args = invoke.parseArgs(BarsArgs::class.java)
        val top = parse(args.top)
        val bottom = parse(args.bottom) ?: top
        activity.runOnUiThread {
            val window = activity.window
            if (top != null && bottom != null) {
                window.decorView.background =
                    GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM, intArrayOf(top, top, bottom, bottom))
            }
            val bars = WindowCompat.getInsetsController(window, window.decorView)
            bars.isAppearanceLightStatusBars = !args.dark
            bars.isAppearanceLightNavigationBars = !args.dark
        }
        invoke.resolve()
    }

    private fun parse(color: String): Int? = try {
        Color.parseColor(color)
    } catch (e: IllegalArgumentException) {
        null
    }

    /** Back at the app's root: to the background (the app keeps its state), as Android 12+ does. */
    @Command
    fun moveToBack(invoke: Invoke) {
        activity.runOnUiThread { activity.moveTaskToBack(true) }
        invoke.resolve()
    }
}
