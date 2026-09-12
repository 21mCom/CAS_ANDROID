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
<title>CAS Gate 0A Simple Run Checklist</title>
<style>
  @page { size: A4; margin: 13mm 15mm 13mm; }
  :root { --ink:#18313c; --muted:#52676a; --line:#c7d0cb; --soft:#f1f5f1; --amber:#8a5a00; --amber-bg:#fff7df; --red:#8f2e25; --red-bg:#fff0ed; --green-bg:#edf8f0; }
  * { box-sizing:border-box; }
  body { margin:0; color:var(--ink); background:#fff; font-family:Arial,Helvetica,sans-serif; font-size:11.2pt; line-height:1.4; print-color-adjust:exact; -webkit-print-color-adjust:exact; }
  h1,h2,h3,p { margin:0; }
  h1 { font-size:31pt; line-height:1.05; letter-spacing:-.04em; }
  h2 { font-size:19pt; line-height:1.12; letter-spacing:-.02em; }
  h3 { font-size:13pt; line-height:1.2; }
  p { margin-bottom:8px; }
  .page { min-height:271mm; position:relative; }
  .page + .page { page-break-before:always; }
  .masthead { display:flex; justify-content:space-between; border-bottom:2px solid var(--ink); padding-bottom:8px; margin-bottom:18px; }
  .brand,.eyebrow,.label { font-size:8.5pt; font-weight:700; letter-spacing:.12em; text-transform:uppercase; }
  .brand { color:var(--ink); }
  .eyebrow,.number { color:var(--amber); }
  .page-number { color:var(--muted); font:9pt "Courier New",monospace; }
  .intro { color:var(--muted); font-size:14pt; line-height:1.45; max-width:155mm; margin-top:12px; }
  .gold-rule { height:5px; width:32mm; background:#b47a00; margin:17px 0; }
  .section { margin-top:14px; }
  .section-heading { display:flex; gap:9px; align-items:baseline; border-bottom:1px solid var(--line); padding-bottom:6px; margin-bottom:10px; }
  .number { font:700 10pt "Courier New",monospace; }
  .box { border:1px solid var(--line); background:var(--soft); padding:11px 12px; margin:10px 0; }
  .danger { border:2px solid var(--red); background:var(--red-bg); }
  .danger h3 { color:var(--red); }
  .warning { border:1px solid #dfc47a; background:var(--amber-bg); }
  .helper { border:2px solid #8da7a0; background:#f2f7f4; }
  .helper h3 { color:#1f5c40; }
  .green { border:1px solid #acd2b8; background:var(--green-bg); }
  .checklist { list-style:none; padding:0; margin:0; }
  .checklist li { position:relative; padding-left:25px; margin:8px 0; }
  .checklist li::before { content:"☐"; position:absolute; left:0; top:-3px; font-size:18pt; line-height:1; }
  .tight li { margin:5px 0; }
  .two-col { display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; }
  .field-grid { display:grid; grid-template-columns:1fr 1fr; gap:12px 16px; }
  .field { border-bottom:1px solid #6d7c7e; min-height:34px; padding-top:17px; }
  .field .label { color:var(--muted); font-size:8pt; }
  ol { margin:7px 0 0 24px; padding:0; }
  ol li { padding-left:3px; margin:8px 0; }
  pre { white-space:pre-wrap; overflow-wrap:anywhere; background:#eaf0ed; border-left:4px solid var(--ink); padding:10px 11px; margin:8px 0; font:10pt/1.4 "Courier New",monospace; }
  code { font:inherit; }
  .small { color:var(--muted); font-size:9.5pt; }
  .sample { display:grid; grid-template-columns:34mm 1fr 38mm; min-height:21mm; border-bottom:1px solid var(--line); }
  .sample > div { padding:8px 8px 7px 0; }
  .sample .name { font-weight:700; }
  .sample .name span { display:block; color:var(--amber); font:9pt "Courier New",monospace; }
  .write-lines { min-height:30mm; margin-top:8px; background:repeating-linear-gradient(to bottom,transparent 0,transparent 9mm,#d5ddda 9.1mm,#d5ddda 9.4mm); }
  table { width:100%; border-collapse:collapse; margin-top:10px; }
  td,th { border:1px solid var(--line); padding:8px; text-align:left; vertical-align:top; }
  th { background:var(--soft); font-size:8.5pt; text-transform:uppercase; letter-spacing:.06em; }
  .footer { position:absolute; bottom:0; left:0; right:0; border-top:1px solid var(--line); padding-top:6px; display:flex; justify-content:space-between; color:var(--muted); font-size:8.5pt; }
  .avoid { break-inside:avoid; page-break-inside:avoid; }
  @media screen { body { max-width:210mm; margin:0 auto; padding:12mm 15mm; } .page { min-height:auto; padding-bottom:18mm; } .footer { position:static; margin-top:20px; } }
</style>
</head>
<body>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">1 / 4</div></div>
  <div class="eyebrow">Simple field checklist</div>
  <h1>Check the Pixel.<br>Write down what you see.</h1>
  <p class="intro">This guide is for one short, supervised test. You do not need to know Android. A technical helper prepares the device; you and an observer watch what happens on the screen.</p>
  <div class="gold-rule"></div>

  <div class="box danger avoid">
    <h3>Safety first</h3>
    <p><strong>Do not flash an ISO, install a custom ROM, reformat, root, or factory-reset the Pixel</strong> unless an authorized device procedure specifically tells the helper to do so.</p>
    <p style="margin-bottom:0">This test package is local-only. It does not send messages, use the network, find your location, or capture evidence.</p>
  </div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">1</span><h2>Write down the run</h2></div>
    <div class="field-grid">
      <div class="field"><span class="label">Date</span></div>
      <div class="field"><span class="label">Run name or ID</span></div>
      <div class="field"><span class="label">Your name</span></div>
      <div class="field"><span class="label">Observer’s name</span></div>
      <div class="field"><span class="label">Device</span><br>Google Pixel 8a</div>
      <div class="field"><span class="label">Android</span><br>Stock Android · API 35</div>
    </div>
  </div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">2</span><h2>Stop if any of these are true</h2></div>
    <ul class="checklist tight">
      <li>The device is not a Google Pixel 8a with Android API 35.</li>
      <li>The device is not the approved managed test phone.</li>
      <li>The helper cannot authorize it with ADB, or only an emulator is available.</li>
      <li>The chosen cover app is missing or will not open like a normal app.</li>
    </ul>
    <div class="box warning"><strong>When in doubt, stop.</strong> Write “NO-GO” and ask the person who manages the test device. Do not make up a result from a screenshot or emulator.</div>
  </div>

  <div class="footer"><span>Keep this page with the run notes.</span><span>CAS Gate 0A</span></div>
</section>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">2 / 4</div></div>
  <div class="section-heading"><span class="number">3</span><h2>Get the phone ready</h2></div>
  <p>Ask the technical helper to do the items in the green box. You only need to check each box when the helper says it is done.</p>

  <div class="box helper avoid">
    <h3>Technical helper — please do these checks</h3>
    <ul class="checklist tight">
      <li>Confirm JDK 17, Android SDK/API 35, Android build tools, Gradle, and ADB are installed.</li>
      <li>Confirm one authorized device appears: Google Pixel 8a, Android API 35.</li>
      <li>Confirm the managed-device / device-owner status using the approved test-device procedure.</li>
      <li>Build and install the disposable Gate 0A test package.</li>
    </ul>
    <p class="label" style="margin-top:10px">Helper commands — copy exactly</p>
    <pre>java -version
gradle --version
adb version
adb devices -l
adb shell getprop ro.product.model
adb shell getprop ro.build.version.sdk

cd artifacts/covert-alert-system/android-test-package
gradle :app:assembleDebug &amp;&amp; adb install -r app/build/outputs/apk/debug/app-debug.apk</pre>
  </div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">4</span><h2>Choose the cover app</h2></div>
    <p>Choose a normal, harmless app that is already on the Pixel. The proxy should open this app after the shortcut is pressed.</p>
    <div class="field"><span class="label">Cover app name and package name</span></div>
    <ul class="checklist tight" style="margin-top:10px">
      <li>The cover app is installed.</li>
      <li>The helper saved its exact package name in <strong>CAS Pixel Gate 0A</strong>.</li>
      <li>The helper confirmed the cover app has a normal launcher button.</li>
    </ul>
  </div>

  <div class="footer"><span>Technical helper prepares; operator and observer confirm.</span><span>CAS Gate 0A</span></div>
</section>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">3 / 4</div></div>
  <div class="section avoid" style="margin-top:0">
    <div class="section-heading"><span class="number">5</span><h2>Pin the shortcut</h2></div>
    <ol>
      <li>In CAS Pixel Gate 0A, choose <strong>Request pinned proxy shortcut</strong>.</li>
      <li>Accept the request in the Pixel launcher.</li>
      <li>Look at the home screen and confirm the shortcut is really there.</li>
    </ol>
    <div class="box warning"><strong>If the shortcut is not visible, stop.</strong> A button press or screenshot is not proof that the launcher pinned it.</div>
  </div>
  <div class="section-heading"><span class="number">6</span><h2>Run the five checks</h2></div>
  <p>For every row, press the pinned shortcut and write what you saw. The observer should watch the phone with you.</p>

  <div class="sample"><div class="name"><span>A</span>Cold start</div><div>Start from the agreed ready state. Press the shortcut once.</div><div>Result / time:<br>________________</div></div>
  <div class="sample"><div class="name"><span>B</span>Warm start</div><div>Without rebooting, press the shortcut again.</div><div>Result / time:<br>________________</div></div>
  <div class="sample"><div class="name"><span>C</span>Locked phone</div><div>Lock the phone, then use the shortcut as instructed.</div><div>Result / time:<br>________________</div></div>
  <div class="sample"><div class="name"><span>D</span>After restart</div><div>Restart the phone using the approved procedure. Wait until it is ready, then press the shortcut.</div><div>Result / time:<br>________________</div></div>
  <div class="sample"><div class="name"><span>E</span>Repeat test</div><div>Ask the helper to repeat the shortcut at least 200 times. Write the number completed and any first failure.</div><div>Count / result:<br>________________</div></div>

  <div class="box helper avoid" style="margin-top:14px">
    <h3>Technical helper — record the timings</h3>
    <p class="small">Run the supplied measurement script. It records the local proxy timing and does not send messages or change device policy.</p>
    <pre>cd artifacts/covert-alert-system/android-test-package
bash scripts/measure-gate0a.sh gate0a-&lt;RUN-ID&gt;.log</pre>
    <p class="small" style="margin-bottom:0">For the 200 repeats, the helper should use the approved repeat procedure and save its timing log. Do not replace physical results with emulator timings.</p>
  </div>

  <div class="footer"><span>Write what happened, not what you hoped would happen.</span><span>CAS Gate 0A</span></div>
</section>

<section class="page">
  <div class="masthead"><div class="brand">CovertAlert / Gate 0A</div><div class="page-number">4 / 4</div></div>
  <div class="section-heading"><span class="number">7</span><h2>Observer check</h2></div>
  <p>Ask an ordinary observer to look at the phone. Check each item only after it was actually seen.</p>
  <ul class="checklist two-col">
    <li>The cover app looks normal.</li>
    <li>Back behaves normally.</li>
    <li>Home behaves normally.</li>
    <li>Recents has no stray test card.</li>
    <li>Settings → App info looks expected.</li>
    <li>Notifications look expected.</li>
    <li>Quick Settings looks expected.</li>
    <li>No extra screen, wrong app, or dead end appeared.</li>
  </ul>
  <p class="label" style="margin-top:16px">Observer notes</p>
  <div class="write-lines"></div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">8</span><h2>Save and hand in the results</h2></div>
    <ol>
      <li>On the Gate 0A test package, press <strong>Copy JSON report</strong>.</li>
      <li>Save the copied text as <code>gate0a-&lt;RUN-ID&gt;-report.json</code>.</li>
      <li>Ask the helper to save the timing log beside it.</li>
      <li>In the CAS console, open <strong>Feasibility gates</strong> → <strong>Import Gate 0A report</strong>.</li>
      <li>Choose the JSON file and press <strong>Validate &amp; import report</strong>.</li>
      <li>Attach the JSON, timing log, and these notes to the run.</li>
    </ol>
    <div class="box warning"><strong>Important:</strong> importing a report does not create a pass. It stays <strong>INCONCLUSIVE</strong> until a person reviews the physical observations.</div>
  </div>

  <div class="section avoid">
    <div class="section-heading"><span class="number">9</span><h2>Final result</h2></div>
    <table>
      <tr><th>Choose one</th><th>Why?</th></tr>
      <tr><td>☐ GO — every required check passed</td><td></td></tr>
      <tr><td>☐ NO-GO — something was blocked or failed</td><td></td></tr>
      <tr><td>☐ INCONCLUSIVE — more review is needed</td><td></td></tr>
    </table>
  </div>

  <div class="footer"><span>Keep the JSON, timing log, and notes together.</span><span>CAS Gate 0A</span></div>
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