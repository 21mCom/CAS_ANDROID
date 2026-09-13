import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const artifactRoot = resolve(here, '..');
const outputPath = resolve(artifactRoot, 'public/gate0a-run-guide.pdf');
const htmlPath = resolve('/tmp', 'cas-gate0a-run-guide-readable.html');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CAS Gate 0A Operator Guide</title>
<style>
  @page { size: A4; margin: 12mm 14mm 12mm; }
  :root { --ink:#18313c; --muted:#52676a; --line:#c7d0cb; --soft:#f1f5f1; --amber:#8a5a00; --amber-bg:#fff7df; --red:#8f2e25; --red-bg:#fff0ed; --green-bg:#edf8f0; }
  * { box-sizing:border-box; }
  body { margin:0; color:var(--ink); background:#fff; font-family:Arial,Helvetica,sans-serif; font-size:10.5pt; line-height:1.36; print-color-adjust:exact; -webkit-print-color-adjust:exact; }
  h1,h2,h3,p { margin:0; }
  h1 { font-size:29pt; line-height:1.04; letter-spacing:-.04em; }
  h2 { font-size:18pt; line-height:1.1; letter-spacing:-.02em; }
  h3 { font-size:12.5pt; line-height:1.2; }
  p { margin-bottom:7px; }
  .page { min-height:273mm; position:relative; }
  .page + .page { page-break-before:always; }
  .masthead { display:flex; justify-content:space-between; border-bottom:2px solid var(--ink); padding-bottom:7px; margin-bottom:15px; }
  .brand,.eyebrow,.label { font-size:8pt; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
  .brand { color:var(--ink); }
  .eyebrow,.number { color:var(--amber); }
  .page-number { color:var(--muted); font:8.5pt "Courier New",monospace; }
  .intro { color:var(--muted); font-size:13.5pt; line-height:1.4; max-width:160mm; margin-top:11px; }
  .gold-rule { height:4px; width:30mm; background:#b47a00; margin:15px 0; }
  .section { margin-top:12px; }
  .section-heading { display:flex; gap:8px; align-items:baseline; border-bottom:1px solid var(--line); padding-bottom:5px; margin-bottom:9px; }
  .number { font:700 9.5pt "Courier New",monospace; }
  .box { border:1px solid var(--line); background:var(--soft); padding:9px 11px; margin:8px 0; }
  .danger { border:2px solid var(--red); background:var(--red-bg); }
  .danger h3 { color:var(--red); }
  .warning { border:1px solid #dfc47a; background:var(--amber-bg); }
  .helper { border:2px solid #8da7a0; background:#f2f7f4; }
  .helper h3 { color:#1f5c40; }
  .green { border:1px solid #acd2b8; background:var(--green-bg); }
  .checklist { list-style:none; padding:0; margin:0; }
  .checklist li { position:relative; padding-left:22px; margin:6px 0; }
  .checklist li::before { content:"☐"; position:absolute; left:0; top:-2px; font-size:16pt; line-height:1; }
  .tight li { margin:4px 0; }
  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:6px 22px; }
  .field-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 14px; }
  .field { border-bottom:1px solid #6d7c7e; min-height:31px; padding-top:14px; }
  .field .label { color:var(--muted); font-size:7.5pt; }
  ol { margin:6px 0 0 22px; padding:0; }
  ol li { padding-left:3px; margin:6px 0; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#eaf0ed; border-left:4px solid var(--ink); padding:8px 10px; margin:7px 0; font:9pt/1.32 "Courier New",monospace; }
  code { font:inherit; }
  .small { color:var(--muted); font-size:9pt; }
  .sample { display:grid; grid-template-columns:32mm 1fr 39mm; min-height:18mm; border-bottom:1px solid var(--line); }
  .sample > div { padding:6px 7px 5px 0; }
  .sample .name { font-weight:700; }
  .sample .name span { display:block; color:var(--amber); font:8.5pt "Courier New",monospace; }
  .write-lines { min-height:27mm; margin-top:7px; background:repeating-linear-gradient(to bottom,transparent 0,transparent 8mm,#d5ddda 8.1mm,#d5ddda 8.4mm); }
  table { width:100%; border-collapse:collapse; margin-top:8px; }
  td,th { border:1px solid var(--line); padding:7px; text-align:left; vertical-align:top; }
  th { background:var(--soft); font-size:8pt; text-transform:uppercase; letter-spacing:.06em; }
  .footer { position:absolute; bottom:0; left:0; right:0; border-top:1px solid var(--line); padding-top:5px; display:flex; justify-content:space-between; color:var(--muted); font-size:8pt; }
  .avoid { break-inside:avoid; page-break-inside:avoid; }
  .muted { color:var(--muted); }
  .pill { display:inline-block; border:1px solid #c7d0cb; padding:2px 6px; font:8.5pt "Courier New",monospace; }
  @media screen { body { max-width:210mm; margin:0 auto; padding:10mm 14mm; } .page { min-height:auto; padding-bottom:17mm; } .footer { position:static; margin-top:18px; } }
</style>
</head>
<body>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">1 / 6</div></div>
  <div class="eyebrow">Operator guide · supervised physical run</div>
  <h1>Prepare the Pixel.<br>Measure the handoff.</h1>
  <p class="intro">Use this guide with the technical helper and an ordinary observer. It covers the approved Google Pixel 8a, the disposable debug APK, and the workstation timing script. It does not authorize a Gate 0A pass.</p>
  <div class="gold-rule"></div>

  <div class="box danger avoid">
    <h3>Safety boundary — stop before changing the device</h3>
    <p><strong>Do not flash an ISO or custom ROM, root, reformat, factory-reset, provision, or otherwise modify the Pixel</strong> except through the device owner’s already-approved managed-device procedure.</p>
    <p><strong>Do not enable or use live SMS, XMPP, carrier messaging, network messaging, location, camera, microphone, evidence capture, or production covert behavior.</strong></p>
    <p style="margin-bottom:0">The prepared package is local-only. It records device-local observations and launches the selected app’s normal launcher intent.</p>
  </div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">01</span><h2>Record the run</h2></div>
    <div class="field-grid">
      <div class="field"><span class="label">Date / UTC start</span></div>
      <div class="field"><span class="label">Run name or ID</span></div>
      <div class="field"><span class="label">Operator</span></div>
      <div class="field"><span class="label">Observer</span></div>
      <div class="field"><span class="label">Required device</span><br>Google Pixel 8a</div>
      <div class="field"><span class="label">Required platform</span><br>Stock Android · API 35</div>
    </div>
  </div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">02</span><h2>Physical-run no-go conditions</h2></div>
    <ul class="checklist tight">
      <li>The device is not the approved managed Google Pixel 8a, stock Android, API 35.</li>
      <li>ADB shows no device, more than one device, or a target marked <strong>unauthorized</strong> or <strong>offline</strong>.</li>
      <li>Only an emulator is available. Emulator output is not physical validation.</li>
      <li>The device owner cannot confirm the approved managed-device or device-owner procedure.</li>
      <li>The cover app is missing or has no normal launcher entry.</li>
    </ul>
    <div class="box warning"><strong>Stop / NO-GO:</strong> disconnect from the run, write the reason in the notes, and contact the technical helper or device owner. Do not repair a wrong device by resetting or modifying it. Do not infer a result from a screenshot, emulator, or host timing log.</div>
  </div>

  <div class="footer"><span>Physical validation requires the approved Pixel and an observer.</span><span>CAS Gate 0A</span></div>
</section>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">2 / 6</div></div>
  <div class="section-heading"><span class="number">03</span><h2>Laptop and ADB preflight</h2></div>
  <p>Have the technical helper run the version and SDK checks in the laptop’s PowerShell or terminal. Use PowerShell for the build/install commands and Git Bash, WSL, or another approved Bash environment for <code>measure-gate0a.sh</code>. The Android package has no checked-in Gradle wrapper; use the workstation’s installed toolchain.</p>

  <div class="box helper avoid">
    <h3>Expected workstation prerequisites</h3>
    <ul class="checklist tight">
      <li>JDK 17 is active. The Android build uses Java 17 source and target compatibility.</li>
      <li>Android SDK platform <strong>android-35</strong> and Android build-tools are installed.</li>
      <li>Gradle is installed and on PATH; the package intentionally uses the system <code>gradle</code> command.</li>
      <li>ADB is installed and on PATH. Enable USB debugging only under the approved device procedure.</li>
    </ul>
    <p class="label" style="margin-top:9px">Version and SDK checks</p>
    <pre>java -version
gradle --version
adb version

# PowerShell: use the configured SDK root, or replace $Sdk with its path.
$Sdk = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { $env:ANDROID_HOME }
Test-Path "$Sdk\platforms\android-35\android.jar"
Get-ChildItem "$Sdk\build-tools" | Sort-Object Name | Select-Object -Last 1</pre>
    <p class="small" style="margin-bottom:0">The SDK test must return <strong>True</strong> and the build-tools directory must contain an installed version. If the commands fail, stop and fix the workstation before touching the Pixel.</p>
  </div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">04</span><h2>Authorize exactly one target</h2></div>
    <pre>adb devices -l
adb shell getprop ro.product.model
adb shell getprop ro.build.version.sdk
adb shell getprop ro.build.version.release</pre>
    <p>In <code>adb devices -l</code>, there must be exactly one target row ending in <strong>device</strong>. On the phone, accept the USB-debugging RSA prompt only when the helper confirms this is the approved Pixel. The model check must read <strong>Pixel 8a</strong>; the SDK check must read <strong>35</strong>.</p>
    <div class="box warning"><strong>Do not continue on “unauthorized”, “offline”, a second target, or a different model/API.</strong> Stop and contact the device owner. Never use <code>adb -s</code> to hide an extra target or bypass the no-go decision.</div>
  </div>

  <div class="footer"><span>Helper runs preflight; operator records the observed values.</span><span>CAS Gate 0A</span></div>
</section>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">3 / 6</div></div>
  <div class="section-heading"><span class="number">05</span><h2>Build and install the disposable APK</h2></div>
  <p>There are two prepared executables. Do not confuse them:</p>
  <div class="two-col">
    <div class="box green avoid"><p class="label">Executable A · Pixel</p><h3>Disposable debug APK</h3><p class="small">Built on the laptop, then installed on the Pixel. The file is <code>app/build/outputs/apk/debug/app-debug.apk</code>. It provides the <strong>CAS Pixel Gate 0A</strong> screen, proxy, local journal, and report copy action.</p></div>
    <div class="box avoid"><p class="label">Executable B · workstation</p><h3><code>measure-gate0a.sh</code></h3><p class="small">Run from the laptop after installation. It starts the local proxy through ADB and writes a host timing log. It is not installed on the Pixel and is not a physical result by itself.</p></div>
  </div>

  <div class="box helper avoid">
    <h3>Build and install from the package directory</h3>
    <pre>cd artifacts/covert-alert-system/android-test-package
gradle :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk</pre>
    <p class="small" style="margin-bottom:0">Confirm the build succeeds before installing. The install command targets the one authorized device from preflight and uses the exact prepared APK filename. Do not substitute a release APK, emulator APK, or another package.</p>
  </div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">06</span><h2>Open the test package and set the cover</h2></div>
    <ol>
      <li>On the Pixel, open the normal launcher and start <strong>CAS Pixel Gate 0A</strong>.</li>
      <li>Enter the exact package name of a harmless app already installed on the Pixel, then press <strong>Save cover app</strong>.</li>
      <li>Verify that the selected app has a normal launcher entry and that it is the app the observer expects to see.</li>
      <li>If the package is blank, missing, or has no normal launcher intent, stop and record <strong>NO-GO</strong>. The proxy records <code>NOT_LAUNCHED</code> and does not take another action.</li>
    </ol>
    <div class="field"><span class="label">Cover app / exact package name</span></div>
  </div>

  <div class="footer"><span>APK output stays in the package build directory; the installed copy stays local to the Pixel.</span><span>CAS Gate 0A</span></div>
</section>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">4 / 6</div></div>
  <div class="section-heading"><span class="number">07</span><h2>Request and confirm the launcher shortcut</h2></div>
  <ol>
    <li>In <strong>CAS Pixel Gate 0A</strong>, press <strong>Request pinned proxy shortcut</strong>.</li>
    <li>Accept the request in the Pixel launcher if the launcher asks for confirmation.</li>
    <li>Return to the home screen and visually confirm the <strong>Test cover launch</strong> shortcut is actually pinned.</li>
    <li>Only after the shortcut is visible, press it once and confirm that the selected cover app opens normally.</li>
  </ol>
  <div class="box warning"><strong>The app can only request a pin.</strong> The launcher owns the final result. A returned request, button press, in-app <code>REQUESTED</code> event, or screenshot of the request is not proof that the launcher pinned it. If the shortcut is absent, stop / NO-GO.</div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">08</span><h2>Prepare the supported measurements</h2></div>
    <p>Keep the technical helper beside the laptop. The observer watches the Pixel and writes what actually happens. The helper must explicitly supervise the script’s Enter prompt, power-key lock/unlock steps, and reboot. Do not run the reboot step unattended.</p>
    <div class="two-col">
      <div class="box green"><p class="label">Device-side checks</p><ul class="checklist tight"><li>Cold / first launch</li><li>Warm launch</li><li>Locked-screen launch</li><li>Post-reboot launch</li></ul></div>
      <div class="box green"><p class="label">Observer checks</p><ul class="checklist tight"><li>Back, Home, and Recents</li><li>Settings → App info</li><li>Notifications and Quick Settings</li><li>Extra splash, frame, wrong task, or dead end</li></ul></div>
    </div>
  </div>

  <div class="footer"><span>Launcher pin state and screen behavior must be observed on the Pixel.</span><span>CAS Gate 0A</span></div>
</section>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">5 / 6</div></div>
  <div class="section-heading"><span class="number">09</span><h2>Run the host timing script</h2></div>
  <p>From the package directory on the workstation, give the log a run-specific name. The script waits for ADB, verifies the package, launches the local proxy with <code>am start -W</code>, and records host-side start/end/elapsed markers.</p>
  <pre>cd artifacts/covert-alert-system/android-test-package
bash scripts/measure-gate0a.sh gate0a-&lt;RUN-ID&gt;.log</pre>
  <div class="box helper avoid">
    <h3>What the helper must supervise</h3>
    <ol>
      <li>The script runs <strong>cold-or-first</strong> and <strong>warm</strong> samples.</li>
      <li>When it prints “Unlock the device if needed, then press Enter for locked-screen sample,” make the agreed device state ready and press Enter only with the helper present.</li>
      <li>The script sends a power key event, runs the <strong>locked</strong> sample, then sends another power key event.</li>
      <li>The script prints “Rebooting device for the post-reboot sample,” runs <code>adb reboot</code>, waits for <code>sys.boot_completed=1</code>, and runs <strong>after-reboot</strong>. The helper must supervise this reboot and wait.</li>
      <li>At the end, confirm the host log is saved as <code>gate0a-&lt;RUN-ID&gt;.log</code> in the package directory, unless an explicit path was supplied.</li>
    </ol>
  </div>
  <div class="box warning avoid"><strong>Important:</strong> this script does not perform an automated 200-repeat run. Any repeat-launch sample required by the handoff is a supervised physical repetition using the pinned shortcut and the approved repeat procedure; record the count and first failure in the notes. A host log, emulator run, or local timing value never substitutes for physical observation.</div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">10</span><h2>Record the five launch rows</h2></div>
    <div class="sample"><div class="name"><span>A</span>Cold / first</div><div>Agreed ready state; press the confirmed pinned shortcut once.</div><div>Result / time:<br>________________</div></div>
    <div class="sample"><div class="name"><span>B</span>Warm</div><div>Without rebooting, press the pinned shortcut again.</div><div>Result / time:<br>________________</div></div>
    <div class="sample"><div class="name"><span>C</span>Locked</div><div>Follow the helper’s lock-screen instruction; observe the transition.</div><div>Result / time:<br>________________</div></div>
    <div class="sample"><div class="name"><span>D</span>Post-reboot</div><div>After the helper confirms boot completed, press the shortcut.</div><div>Result / time:<br>________________</div></div>
    <div class="sample"><div class="name"><span>E</span>Repeats</div><div>Use the approved supervised repeat procedure; record count and first failure.</div><div>Count / result:<br>________________</div></div>
  </div>

  <div class="footer"><span>Host log is timing evidence only; the Pixel and observer establish physical observations.</span><span>CAS Gate 0A</span></div>
</section>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">6 / 6</div></div>
  <div class="section-heading"><span class="number">11</span><h2>Copy the report and preserve the handoff</h2></div>
  <ol>
    <li>On the Pixel’s <strong>CAS Pixel Gate 0A</strong> screen, press <strong>Copy JSON report</strong>. The app copies the current device-local report to the Android clipboard.</li>
    <li>Using the approved workstation handoff, paste the clipboard text into <code>gate0a-&lt;RUN-ID&gt;-report.json</code>. Keep the file as JSON; do not edit or trim its contents.</li>
    <li>Keep <code>gate0a-&lt;RUN-ID&gt;.log</code> from the workstation beside the JSON. Preserve the printed guide, repeat count, observer notes, and any NO-GO reason together.</li>
    <li>In the CAS console, open <strong>Feasibility gates</strong>. In <strong>Import Gate 0A report</strong>, choose the JSON file and press <strong>Validate &amp; import report</strong>.</li>
  </ol>

  <div class="box green avoid">
    <h3>Report contract to check before handoff</h3>
    <p class="small">The report copied from the app is <code>cas-gate0a-report-v1</code>. It contains the target (Pixel 8a, API 35, stock Android), local-only safety flags, cover package, device-owner report, permissions, shortcut state, tasks, Recents, Back, observer review flags, and device-local <code>events</code> with <code>wallClockMs</code> and <code>elapsedRealtimeMs</code>.</p>
  </div>

  <div class="box warning avoid">
    <h3>Import is not a pass</h3>
    <p style="margin-bottom:0">CAS maps an accepted report to the <strong>Proxy Launch</strong> physical observation as <strong>INCONCLUSIVE</strong>. It preserves the raw timestamp notes for human review. Importing never creates Pass or GO; the final decision must use the physical screen observations, observer notes, and any failures.</p>
  </div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">12</span><h2>Observer review and final record</h2></div>
    <ul class="checklist two-col">
      <li>Cover app looked normal.</li>
      <li>Back and Home behaved normally.</li>
      <li>Recents had no stray proxy card.</li>
      <li>Settings → App info looked expected.</li>
      <li>Notifications looked expected.</li>
      <li>Quick Settings looked expected.</li>
      <li>No extra splash/frame or wrong task appeared.</li>
      <li>No dead end or unexpected transition appeared.</li>
    </ul>
    <p class="label" style="margin-top:13px">Observer notes / failures / repeat count</p>
    <div class="write-lines"></div>
    <table>
      <tr><th>Record one</th><th>Reason or next action</th></tr>
      <tr><td>☐ GO — only after human review of all required physical observations</td><td></td></tr>
      <tr><td>☐ NO-GO — blocked, wrong device, unsafe state, or failed check</td><td></td></tr>
      <tr><td>☐ INCONCLUSIVE — physical evidence or review is incomplete</td><td></td></tr>
    </table>
  </div>

  <div class="footer"><span>Keep JSON, host log, guide, and observer notes together.</span><span>CAS Gate 0A</span></div>
</section>

</body>
</html>`;

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(htmlPath, html);
const chromium = process.env.CHROMIUM_PATH || '/repl/tools/bin/chromium';
const result = spawnSync(chromium, [
  '--headless',
  '--no-sandbox',
  '--disable-gpu',
  '--disable-dev-shm-usage',
  '--no-pdf-header-footer',
  '--run-all-compositor-stages-before-draw',
  `--print-to-pdf=${outputPath}`,
  `file://${htmlPath}`,
], { encoding:'utf8' });

if (result.status !== 0) {
  process.stderr.write(result.stderr || 'Chromium PDF export failed.\\n');
  process.exit(result.status || 1);
}
process.stdout.write(`Generated ${outputPath}\n`);