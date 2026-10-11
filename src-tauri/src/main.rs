// Hide the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() -> std::process::ExitCode {
    // `arcalo pages list` and the other commands of docs/cli.md: the command line, not the app.
    if let Some(code) = arcalo_lib::command_line() {
        return code;
    }
    arcalo_lib::run();
    std::process::ExitCode::SUCCESS
}
