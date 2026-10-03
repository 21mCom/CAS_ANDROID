#Requires -Version 5.1
<#
.SYNOPSIS
  Runner for the one-tap self-update field proof (CAS Pixel 11).

  Steps:
    InstallN       uninstall any old-key install, then install build N
                   (app-v9-release-signed.apk, versionCode 9).
    CrossKey       attempt to install app-v10-crosskey.apk (same versionCode 10,
                   signed with the DEFAULT ANDROID DEBUG KEY) over the field
                   install. Android must REFUSE it - that refusal is the proof
                   that a wrong-key (or tampered-and-resigned) update cannot
                   replace the field app.
    CaptureJournal pull the app's debug journal, list every UPDATE_* event
                   in order, and verify the metered-consent sequence (a
                   download over mobile data is only lawful after a SHOWN +
                   ACCEPTED consent) - paste the output into the report
                   template.
    SelfTest       exercise the journal parsing and consent validation
                   against built-in fixtures (no device needed). CI runs this.

  This file is the CANONICAL SOURCE of the pack script. The shipped pack
  (deliverables/CAS-Pixel11-OneTap-Update-Proof-*.zip, staged in
  .cache/onetap-pack) carries a copy - regenerate the pack from here.
  The pack's baseline APK must journal the consent beats (builds that
  predate consent journaling fail CaptureJournal by design, so the proof
  can never silently pass on the tester's word again).

  Run from an elevated-or-normal PowerShell window with adb on PATH and the
  Pixel connected + USB-authorized. The script resolves its own folder, so it
  works from anywhere:
    powershell -ExecutionPolicy Bypass -File .\Install-Update-Proof.ps1 -Step InstallN
#>
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('InstallN', 'CrossKey', 'CaptureJournal', 'SelfTest')]
  [string]$Step
)
$ErrorActionPreference = 'Stop'

# Resolve script-relative paths AFTER parameter binding (5.1 evaluates default
# parameter values before the body runs).
$pkg  = 'com.covertalert.pixeltest'
$apkN = Join-Path $PSScriptRoot 'app-v9-release-signed.apk'
$apkX = Join-Path $PSScriptRoot 'app-v10-crosskey.apk'

# Native stderr under $ErrorActionPreference='Stop' turns merged 2>&1 output
# into a terminating error on Windows PowerShell 5.1 - drop to Continue around
# adb calls and check output text + $LASTEXITCODE instead.
function Invoke-Adb {
  param([string[]]$AdbArgs)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $text = (& adb @AdbArgs 2>&1 | Out-String)
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return @{ Text = $text; Code = $code }
}

# Parses the shared_prefs XML and returns the journal's UPDATE_* events as
# objects, in journal order. The events payload is a single JSON array whose
# event details can themselves contain JSON (e.g. an HTTP error body with
# braces and quotes) - entity-escaped by the XML - so regex extraction drops
# exactly the failure events a proof must see. Parse the XML, let the parser
# undo the escaping, then deserialize the JSON.
function Get-JournalUpdateEvents {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$PrefsXml)
  [xml]$prefs = $PrefsXml.Trim()
  $node = $prefs.SelectSingleNode('/map/string[@name="events"]')
  if ($null -eq $node -or [string]::IsNullOrWhiteSpace($node.InnerText)) { return @() }
  $events = @($node.InnerText | ConvertFrom-Json)
  return @($events | Where-Object { $_.type -like 'UPDATE_*' })
}

# The metered-consent contract - the same rule as UpdateCheck.consentViolations
# (pinned in CI by scripts/test-update-check.sh): a download result over a
# metered link is only lawful after a SHOWN prompt and an ACCEPTED decision,
# and one consent covers exactly one download attempt. Returns the violations;
# empty means the journal proves consent by itself.
function Test-ConsentSequence {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][array]$Events)
  $promptShown = $false
  $accepted = $false
  $violations = @()
  $beat = 0
  foreach ($e in $Events) {
    if ($e.type -ne 'UPDATE_DOWNLOAD') { continue }
    $beat++
    $consent = $e.consent
    $outcome = $e.outcome
    $metered = $e.metered   # $null on beats from builds predating consent journaling
    if ($consent -eq 'SHOWN') {
      $promptShown = $true
      $accepted = $false
    } elseif ($consent -eq 'ACCEPTED') {
      if (-not $promptShown) { $violations += "beat ${beat}: consent ACCEPTED without a preceding SHOWN prompt" }
      else { $accepted = $true }
    } elseif ($consent -eq 'DECLINED') {
      if (-not $promptShown) { $violations += "beat ${beat}: consent DECLINED without a preceding SHOWN prompt" }
      $promptShown = $false
      $accepted = $false
    }
    if ($null -ne $outcome) {
      if ($null -eq $metered) {
        $violations += "beat ${beat}: UPDATE_DOWNLOAD $outcome carries no metered marker - the installed build predates consent journaling, so this proof cannot verify itself"
      } elseif ($metered -and -not $accepted) {
        $violations += "beat ${beat}: metered download ($outcome) without a preceding SHOWN + ACCEPTED consent"
      }
      $promptShown = $false
      $accepted = $false
    }
  }
  return $violations
}

# Builds a shared_prefs document the way the phone writes it: the events JSON
# entity-escaped inside <string name="events">.
function New-PrefsXml {
  param([Parameter(Mandatory = $true)][string]$EventsJson)
  $escaped = [System.Security.SecurityElement]::Escape($EventsJson)
  return "<?xml version='1.0' encoding='utf-8' standalone='yes' ?>`n<map><string name=`"events`">$escaped</string></map>"
}

$script:SelfTestChecks = 0
function Assert-SelfTest([bool]$condition, [string]$label) {
  if (-not $condition) { throw "SELFTEST FAILED: $label" }
  $script:SelfTestChecks++
}

function Invoke-SelfTest {
  $script:SelfTestChecks = 0

  # A well-formed metered run: consent beats then a verified download.
  $good = New-PrefsXml '[{"type":"UPDATE_CHECK","outcome":"UPDATE_AVAILABLE"},{"type":"UPDATE_DOWNLOAD","consent":"SHOWN","metered":true,"versionCode":8},{"type":"UPDATE_DOWNLOAD","consent":"ACCEPTED","metered":true,"versionCode":8},{"type":"UPDATE_DOWNLOAD","outcome":"VERIFIED","metered":true,"versionCode":8},{"type":"UPDATE_INSTALL","outcome":"INSTALLED"}]'
  $goodEvents = @(Get-JournalUpdateEvents -PrefsXml $good)
  Assert-SelfTest ($goodEvents.Count -eq 5) 'all five UPDATE_* events are extracted'
  Assert-SelfTest (@(Test-ConsentSequence -Events $goodEvents).Count -eq 0) 'a well-formed metered run has no violations'

  # Regression: a FAILED download whose detail is a JSON error body (braces,
  # quotes) must still be extracted - regex extraction used to drop exactly
  # these events - and a metered failure without consent must be flagged.
  $braces = New-PrefsXml '[{"type":"UPDATE_CHECK","outcome":"UPDATE_AVAILABLE"},{"type":"UPDATE_DOWNLOAD","outcome":"FAILED","metered":true,"detail":"HTTP 500 {\"error\":{\"code\":\"boom\"}}"}]'
  $bracesEvents = @(Get-JournalUpdateEvents -PrefsXml $braces)
  Assert-SelfTest ($bracesEvents.Count -eq 2) 'a download whose detail contains JSON braces is extracted, not dropped'
  Assert-SelfTest (@(Test-ConsentSequence -Events $bracesEvents).Count -eq 1) 'a FAILED metered download without consent is flagged (it still burned data)'

  # Regression: a journal from a build that predates consent journaling (no
  # metered marker - the shape the pack''s original baseline APK produces) is
  # rejected, so a stale pack can never pass on the tester''s word.
  $legacy = New-PrefsXml '[{"type":"UPDATE_CHECK","outcome":"UPDATE_AVAILABLE"},{"type":"UPDATE_DOWNLOAD","outcome":"VERIFIED","versionCode":8}]'
  $legacyEvents = @(Get-JournalUpdateEvents -PrefsXml $legacy)
  $legacyViolations = @(Test-ConsentSequence -Events $legacyEvents)
  Assert-SelfTest ($legacyViolations.Count -eq 1) 'a pre-consent-journaling baseline is flagged'
  Assert-SelfTest ($legacyViolations[0] -match 'predates consent journaling') 'the stale-baseline violation says why'

  # An unmetered (Wi-Fi) download needs no consent beats.
  $wifi = New-PrefsXml '[{"type":"UPDATE_DOWNLOAD","outcome":"VERIFIED","metered":false}]'
  Assert-SelfTest (@(Test-ConsentSequence -Events @(Get-JournalUpdateEvents -PrefsXml $wifi)).Count -eq 0) 'a Wi-Fi download needs no consent'

  # One consent covers exactly one download attempt.
  $reuse = New-PrefsXml '[{"type":"UPDATE_DOWNLOAD","consent":"SHOWN","metered":true},{"type":"UPDATE_DOWNLOAD","consent":"ACCEPTED","metered":true},{"type":"UPDATE_DOWNLOAD","outcome":"VERIFIED","metered":true},{"type":"UPDATE_DOWNLOAD","outcome":"VERIFIED","metered":true}]'
  Assert-SelfTest (@(Test-ConsentSequence -Events @(Get-JournalUpdateEvents -PrefsXml $reuse)).Count -eq 1) 'the second metered download on one consent is flagged'

  # A declined prompt downloads nothing and is a clean run.
  $declined = New-PrefsXml '[{"type":"UPDATE_DOWNLOAD","consent":"SHOWN","metered":true},{"type":"UPDATE_DOWNLOAD","consent":"DECLINED","metered":true}]'
  Assert-SelfTest (@(Test-ConsentSequence -Events @(Get-JournalUpdateEvents -PrefsXml $declined)).Count -eq 0) 'a declined prompt has no violations'

  # Non-UPDATE events in the journal do not disturb extraction.
  $noisy = New-PrefsXml '[{"type":"PROXY_TRIGGER"},{"type":"UPDATE_DOWNLOAD","outcome":"VERIFIED","metered":false},{"type":"BOOT_OBSERVED"}]'
  Assert-SelfTest (@(Get-JournalUpdateEvents -PrefsXml $noisy).Count -eq 1) 'non-UPDATE events are excluded'

  Write-Host "SELFTEST OK checks=$script:SelfTestChecks"
}

switch ($Step) {
  'InstallN' {
    if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
      Write-Host "ERROR: adb is not on PATH. Install Android platform-tools, then re-open PowerShell."
      exit 1
    }
    if (-not (Test-Path $apkN)) { Write-Host "ERROR: $apkN not found next to this script."; exit 1 }
    Write-Host "== InstallN: removing any previous install (old debug key) =="
    $u = Invoke-Adb @('uninstall', $pkg)
    Write-Host $u.Text
    Write-Host "== InstallN: installing build N (versionCode 9, field release key) =="
    $i = Invoke-Adb @('install', $apkN)
    Write-Host $i.Text
    if ($i.Text -notmatch '(?m)^Success') {
      Write-Host "ERROR: install of build N did not report Success (see output above)."
      exit 1
    }
    Write-Host "OK: build N installed. Continue in the run guide (step 3: open app, save alert server, enroll)."
    exit 0
  }
  'CrossKey' {
    if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
      Write-Host "ERROR: adb is not on PATH. Install Android platform-tools, then re-open PowerShell."
      exit 1
    }
    if (-not (Test-Path $apkX)) { Write-Host "ERROR: $apkX not found next to this script."; exit 1 }
    Write-Host "== CrossKey: attempting to install the debug-key-signed v10 APK over the field install =="
    $i = Invoke-Adb @('install', '-r', $apkX)
    Write-Host $i.Text
    if ($i.Text -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE|INSTALL_FAILED_UPDATE_WRONG_KEY|INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES|signatures do not match|INSTALL_FAILED_VERSION_DOWNGRADE') {
      Write-Host "PROOF OK: Android refused the cross-key update package. The field install is untouched."
      exit 0
    }
    if ($i.Text -match '(?m)^Success') {
      Write-Host "ERROR: the cross-key package INSTALLED - Android's same-signing-key enforcement did not fire. Stop and report this."
      exit 1
    }
    Write-Host "ERROR: unexpected adb result - neither a known refusal nor Success (see output above)."
    exit 1
  }
  'CaptureJournal' {
    if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
      Write-Host "ERROR: adb is not on PATH. Install Android platform-tools, then re-open PowerShell."
      exit 1
    }
    Write-Host "== CaptureJournal: pulling UPDATE_* events from the app's debug journal =="
    $j = Invoke-Adb @('shell', "run-as $pkg cat /data/user_de/0/$pkg/shared_prefs/gate0a-local-journal.xml")
    if ($j.Code -ne 0 -or [string]::IsNullOrWhiteSpace($j.Text)) {
      Write-Host "ERROR: journal unreadable (is the app installed and was it opened at least once?). Raw output:"
      Write-Host $j.Text
      exit 1
    }
    $updates = @(Get-JournalUpdateEvents -PrefsXml $j.Text)
    if ($updates.Count -eq 0) {
      Write-Host "No UPDATE_* events found in the journal. Open the app once so the update check runs, then retry."
      exit 1
    }
    foreach ($e in $updates) { Write-Host ($e | ConvertTo-Json -Compress) }
    Write-Host "== $($updates.Count) UPDATE_* event(s). Paste everything between the == lines into the report template. =="

    $violations = @(Test-ConsentSequence -Events $updates)
    if ($violations.Count -gt 0) {
      Write-Host "CONSENT CONTRACT VIOLATIONS:"
      foreach ($v in $violations) { Write-Host "  - $v" }
      exit 1
    }
    Write-Host "PROOF OK: every metered download in the journal is preceded by a SHOWN + ACCEPTED consent."
    exit 0
  }
  'SelfTest' {
    Invoke-SelfTest
    exit 0
  }
}
