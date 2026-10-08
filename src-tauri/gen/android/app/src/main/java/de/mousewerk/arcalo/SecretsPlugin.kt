package de.mousewerk.arcalo

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class SecretAccountArgs {
    lateinit var account: String
}

@InvokeArg
class SecretPutArgs {
    lateinit var account: String
    lateinit var secret: String
}

/**
 * Secrets of the app (the Git access token): AES-GCM with a key that is created in and never
 * leaves the Android Keystore. Only the encrypted values are kept, in the app's private
 * preferences. A value that cannot be decrypted (the key is gone after a restore onto another
 * device) reads as missing, so the user enters it again.
 */
@TauriPlugin
class SecretsPlugin(private val activity: Activity) : Plugin(activity) {
    private val prefs by lazy { activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    @Command
    fun get(invoke: Invoke) {
        val args = invoke.parseArgs(SecretAccountArgs::class.java)
        val ret = JSObject()
        val stored = prefs.getString(args.account, null)
        if (stored != null) {
            try {
                ret.put("secret", decrypt(stored))
            } catch (e: Exception) {
                // Unreadable: treated as not set.
            }
        }
        invoke.resolve(ret)
    }

    @Command
    fun set(invoke: Invoke) {
        val args = invoke.parseArgs(SecretPutArgs::class.java)
        try {
            prefs.edit().putString(args.account, encrypt(args.secret)).commit()
            invoke.resolve(JSObject())
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Keystore")
        }
    }

    @Command
    fun delete(invoke: Invoke) {
        val args = invoke.parseArgs(SecretAccountArgs::class.java)
        prefs.edit().remove(args.account).commit()
        invoke.resolve(JSObject())
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return b64(cipher.iv) + ":" + b64(sealed)
    }

    private fun decrypt(stored: String): String {
        val parts = stored.split(":")
        require(parts.size == 2)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, unb64(parts[0])))
        return String(cipher.doFinal(unb64(parts[1])), Charsets.UTF_8)
    }

    private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun unb64(text: String) = Base64.decode(text, Base64.NO_WRAP)

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "arcalo-secrets"
        private const val PREFS = "arcalo-secrets"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
