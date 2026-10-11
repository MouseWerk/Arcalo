package de.mousewerk.arcalo

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.MessageDigest

@InvokeArg
class ApkPathArgs {
    lateinit var path: String
}

/**
 * The app's own updates (src-tauri/src/mobile/apkupdate.rs does the feed, the download and the
 * signature check): what Android knows about the installed app and a downloaded APK, whether the
 * network is metered, the „Unbekannte Apps installieren“ permission and the hand-over of a
 * verified APK to Android's package installer, which asks the user to confirm.
 *
 * The installer is opened with ACTION_VIEW on a FileProvider address of the APK in the app's
 * cache. That works the same from Android 8 to 15; the PackageInstaller session API would only
 * add a status callback, and on success this process is replaced anyway. Package, version code
 * and signing key are checked before (the session API would report a key mismatch only after the
 * user confirmed).
 */
@TauriPlugin
class UpdatePlugin(private val activity: Activity) : Plugin(activity) {

    /** The installed app: package, version code and name, signer, whether it may install APKs. */
    @Command
    fun installed(invoke: Invoke) {
        val pm = activity.packageManager
        val info = packageInfo(pm, activity.packageName)
        val ret = facts(info)
        ret.put("canInstall", canInstall())
        invoke.resolve(ret)
    }

    /** A downloaded APK as Android reads it (an empty package when it cannot read it). */
    @Command
    fun archive(invoke: Invoke) {
        val args = invoke.parseArgs(ApkPathArgs::class.java)
        val pm = activity.packageManager
        val info = archiveInfo(pm, args.path)
        invoke.resolve(facts(info))
    }

    /** Whether there is a network and whether it is metered (mobile data, a hotspot). */
    @Command
    fun network(invoke: Invoke) {
        val cm = activity.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val caps = cm.activeNetwork?.let { cm.getNetworkCapabilities(it) }
        val ret = JSObject()
        ret.put("connected", caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true)
        ret.put("metered", cm.isActiveNetworkMetered)
        invoke.resolve(ret)
    }

    /** Opens Android's „Unbekannte Apps installieren“ page of this app; resolves on return. */
    @Command
    fun openInstallSettings(invoke: Invoke) {
        val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName))
        try {
            startActivityForResult(invoke, intent, "installSettingsClosed")
        } catch (e: Exception) {
            // Some devices have no such page: the general settings of the app instead.
            val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + activity.packageName))
            startActivityForResult(invoke, fallback, "installSettingsClosed")
        }
    }

    @ActivityCallback
    private fun installSettingsClosed(invoke: Invoke, result: ActivityResult) {
        val ret = JSObject()
        ret.put("canInstall", canInstall())
        invoke.resolve(ret)
    }

    /**
     * Hands the APK to Android's installer. Resolves with `started` false and a `reason`
     * ("permission", "missing") when it cannot.
     */
    @Command
    fun install(invoke: Invoke) {
        val args = invoke.parseArgs(ApkPathArgs::class.java)
        val ret = JSObject()
        val file = File(args.path)
        if (!file.isFile) {
            ret.put("started", false)
            ret.put("reason", "missing")
            invoke.resolve(ret)
            return
        }
        if (!canInstall()) {
            ret.put("started", false)
            ret.put("reason", "permission")
            invoke.resolve(ret)
            return
        }
        val uri = FileProvider.getUriForFile(activity, activity.packageName + ".fileprovider", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            activity.startActivity(intent)
            ret.put("started", true)
        } catch (e: Exception) {
            ret.put("started", false)
            ret.put("reason", "installer")
        }
        invoke.resolve(ret)
    }

    private fun canInstall(): Boolean = activity.packageManager.canRequestPackageInstalls()

    private fun facts(info: PackageInfo?): JSObject {
        val ret = JSObject()
        ret.put("package", info?.packageName ?: "")
        ret.put("versionCode", info?.let { versionCode(it) } ?: 0L)
        ret.put("versionName", info?.versionName ?: "")
        signer(info)?.let { ret.put("signer", it) }
        return ret
    }

    @Suppress("DEPRECATION")
    private fun versionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun packageInfo(pm: PackageManager, name: String): PackageInfo? = try {
        if (Build.VERSION.SDK_INT >= 28) {
            pm.getPackageInfo(name, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            pm.getPackageInfo(name, PackageManager.GET_SIGNATURES)
        }
    } catch (e: Exception) {
        null
    }

    @Suppress("DEPRECATION")
    private fun archiveInfo(pm: PackageManager, path: String): PackageInfo? = try {
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        pm.getPackageArchiveInfo(path, flags)
    } catch (e: Exception) {
        null
    }

    /** SHA-256 of the signing certificate in uppercase hex (as apksigner prints it, without colons). */
    @Suppress("DEPRECATION")
    private fun signer(info: PackageInfo?): String? {
        if (info == null) return null
        val certs = if (Build.VERSION.SDK_INT >= 28) {
            info.signingInfo?.apkContentsSigners
        } else {
            info.signatures
        }
        val cert = certs?.firstOrNull() ?: return null
        return MessageDigest.getInstance("SHA-256").digest(cert.toByteArray()).joinToString("") { "%02X".format(it) }
    }
}
