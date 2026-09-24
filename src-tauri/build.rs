fn main() {
    // The updater's public key is compiled in (`option_env!`); release builds set it.
    println!("cargo:rerun-if-env-changed=ANNALO_UPDATER_PUBKEY");
    tauri_build::build()
}
