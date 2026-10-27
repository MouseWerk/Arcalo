// Temporary: the dead-app paths of device.start() and the CI logcat reader.
import * as device from "./device.js";
import fs from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
device.install(process.env.ARCALO_APK);
device.fresh();
device.shell("log -t ARCALO_MARK after-clear");
const pid = await device.start();
console.log(`started, pid ${pid}`);
await sleep(3000);
device.shell(`am crash ${device.PKG}`);
await sleep(3000);
console.log(`after am crash: pidOf=${device.pidOf()} crash buffer has the app: ${!!device.appCrash()}`);
device.diagnose("/tmp/diag.txt");
// A start whose process dies at once: the crash from the buffer, not a pidof error.
device.shell(`am start -W -n ${device.PKG}/.MainActivity`);
try { await device.start(5000); console.log("start after crash: ok (relaunch)"); } catch (e) { console.log(`start after crash: ${e.message.split("\n")[0]}`); }
device.fresh();
try { device.shell("am start -W -n de.mousewerk.arcalo/.NoSuchActivity"); console.log("bad activity: am did not error"); } catch (e) { console.log(`bad activity threw: ${e.message.split("\n")[0]}`); }
const log = fs.readFileSync(`${process.env.GITHUB_WORKSPACE}/e2e/logcat.txt`, "utf8");
console.log(`logcat.txt: ${log.split("\n").length} lines, marker after clear: ${log.includes("after-clear")}, FATAL: ${/FATAL EXCEPTION/.test(log)}`);
