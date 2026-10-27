# The full app on large Android screens, 1.20

State of the plan item „The full app on large Android screens“ (plan.md). How it works is in docs/android.md →
„Phone app or full app“; the manual checklist for a tablet, a phone in desktop mode on an external display and
an Android PC is in docs/release/android.md → „Checklist for Android (manual)“.

No Android SDK or NDK was at hand: the Kotlin code (ShellPlugin: `display`, `uriName`, `copyFromUri`,
`copyToUri`, `openFile`, the configuration and input device announcements) is reviewed against the plugin
API of Tauri 2.11.6 and compiles first in the Android workflow; the Rust side was type-checked and
clippy-checked for `aarch64-linux-android` on the host with the C builds stubbed. Everything else is tested on
the host.

| Part | State | How it was checked |
|---|---|---|
| Choosing the interface (sizes, desktop setting, PC, hysteresis, setting, loop guard) | done | `ui/src/lib/uimode.test.ts` |
| The setting „Oberfläche auf Android“ (`appearance.android_interface`, step 18, not synced) | done | `settings_migrate` tests (`the_android_interface_is_written_once_and_a_choice_stays`, the chain tests), schema test |
| Following the window, storing text first (`uiswitch.ts`, `flush.ts`) | done | type-checked; the switch itself needs a device (checklist) |
| One command list, desktop-only commands named | done | `platform::tests::the_desktop_only_commands_are_the_ones_android_does_not_register`; the phone check (`e2e/mobile/shots.mjs`) reads the same list |
| Capabilities and hiding in the UI | done | `ui/src/lib/capabilities.test.ts` (menu, agreement with the backend), `e2e/tests/400-android-full-app.test.js` with `ARCALO_SIMULATE_ANDROID=1` (refused commands, ribbon, palette, every settings section, start page, no console errors) |
| Commands off Android's main thread | done | type-checked for Android; needs a device |
| Git sync of the full app as the phone's | done | type-checked for Android; the companion sync's tests (`gitsync`, `companion` on libgit2) as before |
| Files of the document picker, opening attachments | done | `picked::tests` (paths, names); the copies need a device |
| Tasks from the start page (`capture_submit` on Android) | done | e2e 400 (on the desktop's command); Android's stand-in type-checked |
| Hover only for hovering pointers, reveal on touch | done | `ui/src/lib/hoverMedia.test.ts`; every built rule checked (all `:hover` rules of the app's CSS in `(hover: hover)`), the desktop e2e suites unchanged |
| Long press for menus, no tooltip on tap, finger-wide grips | done | `ui/src/lib/longpress.test.ts`, e2e 400 (long press on a tree row) |
| Back button in the full app | done | `ui/src/lib/androidBack.test.ts`; needs a device |
| Screenshots at 800x1280, 1280x800 and 1480x920, light and dark | done | e2e 400 (`android-*`), looked at |

What only a device or CI can prove is the checklist in docs/release/android.md (the first build of the new
Kotlin code in `android.yml`, the switch on a real resize and display move, desktop mode, the document picker,
another app opening an attachment, touch and a long press in Android's WebView, drag and drop by touch).
