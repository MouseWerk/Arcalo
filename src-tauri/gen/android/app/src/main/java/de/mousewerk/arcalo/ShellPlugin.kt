package de.mousewerk.arcalo

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.hardware.input.InputManager
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Base64
import android.view.Display
import android.view.InputDevice
import android.webkit.MimeTypeMap
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.WindowCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.KeyStore

@InvokeArg
class UriArgs {
    lateinit var uri: String
}

@InvokeArg
class CopyArgs {
    lateinit var uri: String
    lateinit var path: String
}

@InvokeArg
class OpenArgs {
    lateinit var path: String
}

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
 * another app („Teilen“ → Arcalo) waits here until the UI takes it into a capture. Also what the
 * built-in git needs of Android's network: the proxy and the certificates the user installed.
 *
 * Since 1.20 also what the app needs to show the full app on a large screen: the window and the
 * device (`display`; a change is announced to the page as the DOM event `arcalo-display`, see
 * ui/src/lib/uiswitch.ts) and the files picked with Android's document picker (`content://`
 * addresses, read and written through copies, src-tauri/src/picked.rs).
 */
@TauriPlugin
class ShellPlugin(private val activity: Activity) : Plugin(activity) {
    @Volatile private var shared: String? = null
    private var webView: WebView? = null

    private val devices = object : InputManager.InputDeviceListener {
        override fun onInputDeviceAdded(deviceId: Int) = announceDisplay()
        override fun onInputDeviceRemoved(deviceId: Int) = announceDisplay()
        override fun onInputDeviceChanged(deviceId: Int) = announceDisplay()
    }

    override fun load(webView: WebView) {
        this.webView = webView
        take(activity.intent)
        val input = activity.getSystemService(Context.INPUT_SERVICE) as InputManager
        input.registerInputDeviceListener(devices, Handler(Looper.getMainLooper()))
    }

    override fun onDestroy(activity: AppCompatActivity) {
        val input = activity.getSystemService(Context.INPUT_SERVICE) as InputManager
        input.unregisterInputDeviceListener(devices)
        webView = null
    }

    // The window's size, display or mode changed (the manifest keeps the activity, so the page
    // stays).
    override fun onConfigurationChanged(newConfig: Configuration) {
        announceDisplay()
    }

    /**
     * The window was resized, moved to another display or changed its mode, or a mouse or
     * keyboard came or went: the page asks `display` again and may switch between the phone app
     * and the full app.
     */
    private fun announceDisplay() {
        val view = webView ?: return
        view.post { view.evaluateJavascript("window.dispatchEvent(new Event('arcalo-display'))", null) }
    }

    /**
     * The app's window and the device: the window's size in dp, the smallest width of the display,
     * Android on a PC, desktop mode (a dock or Android's desktop), a freely sized window, split
     * screen, an external display, a mouse or touchpad and a hardware keyboard.
     */
    @Command
    fun display(invoke: Invoke) {
        val config = activity.resources.configuration
        val multi = activity.isInMultiWindowMode
        val ret = JSObject()
        ret.put("width", config.screenWidthDp)
        ret.put("height", config.screenHeightDp)
        ret.put("smallestWidth", config.smallestScreenWidthDp)
        // PackageManager.FEATURE_PC (API 27), by its value: the app runs from API 26.
        ret.put("pc", activity.packageManager.hasSystemFeature("android.hardware.type.pc"))
        ret.put("desk", (config.uiMode and Configuration.UI_MODE_TYPE_MASK) == Configuration.UI_MODE_TYPE_DESK)
        ret.put("multiWindow", multi)
        ret.put("freeform", multi && freeform())
        ret.put("external", displayId() != Display.DEFAULT_DISPLAY)
        ret.put("mouse", hasMouse())
        ret.put(
            "keyboard",
            config.keyboard == Configuration.KEYBOARD_QWERTY && config.hardKeyboardHidden == Configuration.HARDKEYBOARDHIDDEN_NO
        )
        invoke.resolve(ret)
    }

    /**
     * A window smaller than the display on both sides: a freely sized window of Android's
     * desktop windowing (split screen fills the display on one side). Android has no public
     * flag for it; before Android 11 the window's bounds are not known and it counts as none.
     */
    private fun freeform(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return false
        val wm = activity.windowManager
        val now = wm.currentWindowMetrics.bounds
        val max = wm.maximumWindowMetrics.bounds
        return now.width() < max.width() && now.height() < max.height()
    }

    @Suppress("DEPRECATION")
    private fun displayId(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            activity.display?.displayId ?: Display.DEFAULT_DISPLAY
        } else {
            activity.windowManager.defaultDisplay.displayId
        }

    /** A real (not virtual) mouse or touchpad among the input devices. */
    private fun hasMouse(): Boolean = InputDevice.getDeviceIds().any { id ->
        val d = InputDevice.getDevice(id) ?: return@any false
        !d.isVirtual && (d.supportsSource(InputDevice.SOURCE_MOUSE) || d.supportsSource(InputDevice.SOURCE_TOUCHPAD))
    }

    /** The name Android shows for a picked file (`content://…`), `file` without one. */
    @Command
    fun uriName(invoke: Invoke) {
        val args = invoke.parseArgs(UriArgs::class.java)
        var name: String? = null
        try {
            activity.contentResolver.query(Uri.parse(args.uri), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) name = c.getString(0)
            }
        } catch (e: Exception) {
            // No name: the caller uses a plain one.
        }
        val ret = JSObject()
        ret.put("name", name?.takeIf { it.isNotBlank() } ?: (Uri.parse(args.uri).lastPathSegment ?: "file"))
        invoke.resolve(ret)
    }

    /** Copies the picked file at `uri` into the app's own file `path` (in its cache). */
    @Command
    fun copyFromUri(invoke: Invoke) {
        val args = invoke.parseArgs(CopyArgs::class.java)
        try {
            val input = activity.contentResolver.openInputStream(Uri.parse(args.uri))
            if (input == null) {
                invoke.reject("the file cannot be read")
                return
            }
            input.use { from -> FileOutputStream(File(args.path)).use { to -> from.copyTo(to) } }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    /**
     * Opens a copy of an attachment (in the cache's `open` folder, res/xml/file_paths.xml) with the
     * app Android has for its type; Android asks when there are several.
     */
    @Command
    fun openFile(invoke: Invoke) {
        val args = invoke.parseArgs(OpenArgs::class.java)
        val file = File(args.path)
        val ext = file.extension.lowercase()
        val type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        try {
            val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, type)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            activity.startActivity(Intent.createChooser(intent, null).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
            invoke.resolve()
        } catch (e: ActivityNotFoundException) {
            invoke.reject("no app for this file")
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
    }

    /** Copies the app's own file `path` to the file at `uri` the document picker created. */
    @Command
    fun copyToUri(invoke: Invoke) {
        val args = invoke.parseArgs(CopyArgs::class.java)
        try {
            val output = activity.contentResolver.openOutputStream(Uri.parse(args.uri), "wt")
            if (output == null) {
                invoke.reject("the file cannot be written")
                return
            }
            output.use { to -> FileInputStream(File(args.path)).use { from -> from.copyTo(to) } }
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject(e.message ?: e.toString())
        }
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

    /**
     * Android's proxy for the app: the global one, else the one of the network in use (a Wi-Fi's
     * own proxy). Host and port of an HTTP proxy (with a PAC script: the local proxy Android runs
     * for it), its exclusions and the PAC address; nothing without a proxy. The Git sync uses it
     * when the app has no proxy of its own (src-tauri/src/mobile/mod.rs, `refresh_network`).
     */
    @Command
    fun proxy(invoke: Invoke) {
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val info = cm.defaultProxy
        val ret = JSObject()
        if (info != null) {
            info.host?.let { ret.put("host", it) }
            ret.put("port", info.port)
            ret.put("exclusions", info.exclusionList?.joinToString(",") ?: "")
            val pac = info.pacFileUrl
            if (pac != null && pac != Uri.EMPTY) ret.put("pac", pac.toString())
        }
        invoke.resolve(ret)
    }

    /**
     * The CA certificates the user installed (Einstellungen → Sicherheit → Verschlüsselung &
     * Anmeldedaten), as PEM. The app's network security config trusts them
     * (res/xml/network_security_config.xml), so the built-in git, which checks servers with its
     * own bundle (OpenSSL), gets them added to it. Certificates the user switched off are not listed.
     */
    @Command
    fun userCertificates(invoke: Invoke) {
        val pem = StringBuilder()
        try {
            val store = KeyStore.getInstance("AndroidCAStore")
            store.load(null)
            for (alias in store.aliases().toList()) {
                if (!alias.startsWith("user:")) continue
                val cert = store.getCertificate(alias) ?: continue
                pem.append("-----BEGIN CERTIFICATE-----\n")
                pem.append(Base64.encodeToString(cert.encoded, Base64.NO_WRAP).chunked(64).joinToString("\n"))
                pem.append("\n-----END CERTIFICATE-----\n")
            }
        } catch (e: Exception) {
            // No readable store: the system's certificates only.
        }
        val ret = JSObject()
        ret.put("pem", pem.toString())
        invoke.resolve(ret)
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
