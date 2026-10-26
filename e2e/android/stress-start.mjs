// Temporary: starts the app many times as openApp does and records what `am start -W` said and
// when `pidof` first saw the process.
import * as device from "./device.js";
import { execFileSync } from "node:child_process";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pidof = () => { try { return execFileSync("adb", ["shell", `pidof ${device.PKG}`], { encoding: "utf8" }).trim(); } catch (e) { return `(exit ${e.status}) ${(e.stdout ?? "").trim()}`; } };
device.install(process.env.ARCALO_APK);
const sizes = [[412, 915], [360, 800], [360, 800], [412, 915], [412, 915]];
const N = Number(process.env.N ?? 80);
let late = 0, never = 0;
for (let i = 0; i < N; i++) {
  const [w, h] = sizes[i % sizes.length];
  device.fresh();
  device.setScreen(w, h, 2);
  const t0 = Date.now();
  const am = device.shell(`am start -W -n ${device.PKG}/.MainActivity`).replace(/\s+/g, " ").trim();
  const tAm = Date.now() - t0;
  const first = pidof();
  let pid = /^\d/.test(first) ? first : "", waited = 0;
  while (!pid && waited < 30000) { await sleep(100); waited += 100; const p = pidof(); if (/^\d/.test(p)) pid = p; }
  const crash = device.adb("logcat", "-d", "-b", "crash").trim();
  const ps = device.shell(`ps -A -o PID,NAME | grep -i -e arcalo -e pre-init || true`).replace(/\s+/g, " ").trim();
  if (!/^\d/.test(first)) { if (pid) late++; else never++; }
  console.log(`#${i} ${w}x${h} am ${tAm}ms first-pidof=[${first}] pid=${pid || "none"} after +${waited}ms | ${am} | ps: ${ps}${crash ? ` | CRASH: ${crash.slice(0, 2000)}` : ""}`);
  await sleep(1500 + (i % 3) * 1500);
}
console.log(`summary: ${N} starts, pidof empty right after am start -W: ${late + never} (process appeared later: ${late}, never: ${never})`);
