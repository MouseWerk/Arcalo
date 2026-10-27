//! `arcalo-cli` – headless access to an Arcalo workspace database (see `lib.rs`); the app's program
//! `arcalo` runs the same commands.

fn main() -> std::process::ExitCode {
    arcalo_cli::main()
}
