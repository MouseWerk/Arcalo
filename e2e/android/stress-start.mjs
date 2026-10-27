// Temporary: the dead-app paths of device.start() and device.connect().
import * as device from "./device.js";
import { spawn } from "node:child_process";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const P = device.PKG;
device.install(process.env.ARCALO_APK);
device.fresh();
let pid = await device.start();
await sleep(3000);
device.shell(`am crash ${P}`);
await sleep(4000);
console.log(`R1 after am crash: pidOf=${device.pidOf()} appCrash=${!!device.appCrash()}`);
console.log(device.adb("logcat", "-d", "-v", "brief").split("\n").filter((l) => /FATAL|AndroidRuntime|has died|crash/i.test(l)).slice(0, 25).join("\n"));
console.log(`R1 crash buffer:\n${device.adb("logcat", "-d", "-b", "crash").slice(0, 3000)}`);
device.fresh();
pid = await device.start();
device.shell(`run-as ${P} kill -9 ${pid}`);
await sleep(1500);
console.log(`R2 after kill -9: pidOf=${device.pidOf()}`);
try { await device.connect(pid, 5000); console.log("R2 connect: ok?!"); } catch (e) { console.log(`R2 connect failed: ${e.message.split("\n")[0]}`); }
device.fresh();
// Kills the app as soon as it has its name, as a crash at start would.
const killer = spawn("adb", ["shell", `while true; do p=$(pidof ${P}) && run-as ${P} kill -9 $p; done`], { stdio: "ignore" });
const t0 = Date.now();
try { pid = await device.start(10000); console.log(`R3 start: pid ${pid}, alive 1 s later: ${(await sleep(1000), device.pidOf())}`); } catch (e) { console.log(`R3 start failed after ${Date.now() - t0} ms: ${e.message.split("\n")[0]}`); }
killer.kill();
