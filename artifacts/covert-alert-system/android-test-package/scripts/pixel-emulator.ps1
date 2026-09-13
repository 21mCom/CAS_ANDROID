<#
.SYNOPSIS
    Lifecycle and validation commands for the pinned CAS Gate 0A emulator.

.DESCRIPTION
    Creates, starts, validates, resets, stops, or reports the CAS_Pixel_8a_API_35
    Android Virtual Device. Every result is explicitly simulated emulator
    evidence and cannot establish physical Pixel readiness.

    The script never selects a physical ADB serial. It only acts on an emulator
    whose ro.boot.qemu.avd_name matches the pinned AVD name.
#>

[CmdletBinding()]
param(
    [ValidateSet('create', 'start', 'wait', 'reset', 'stop', 'status')]
    [string]$Action = 'start',

    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\emulator-results'),

    [int]$BootTimeoutSeconds = 180
)

$ErrorActionPreference = 'Stop'

$script:AvdName = 'CAS_Pixel_8a_API_35'
$script:ApiLevel = 35
$script:Abi = 'x86_64'
$script:SystemImage = 'system-images;android-35;google_apis;x86_64'
$script:DeviceProfile = 'pixel_8a'
$script:EvidenceClass = 'simulated-emulator'
$script:OutputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
$script:Checks = @()

function Fail {
    param([Parameter(Mandatory = $true)][string]$Message)
    throw $Message
}

function Invoke-Tool {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Arguments = @()
    )

    try {
        $output = (& $Path @Arguments 2>&1 | Out-String).Trim()
        return [pscustomobject]@{
            succeeded = ($LASTEXITCODE -eq 0)
            exitCode = $LASTEXITCODE
            output = $output
        }
    } catch {
        return [pscustomobject]@{
            succeeded = $false
            exitCode = -1
            output = $_.Exception.Message
        }
    }
}

function Get-SdkRoot {
    $candidates = @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME) |
        Where-Object { $_ -and $_.Trim() } |
        ForEach-Object { [System.IO.Path]::GetFullPath($_.Trim()) } |
        Select-Object -Unique

    if ($candidates.Count -eq 0) {
        Fail 'ANDROID_SDK_ROOT or ANDROID_HOME must point to the Android SDK.'
    }
    if ($candidates.Count -gt 1 -and $candidates[0].TrimEnd('\') -ine $candidates[1].TrimEnd('\')) {
        Fail 'ANDROID_SDK_ROOT and ANDROID_HOME point to different folders.'
    }
    if (-not (Test-Path $candidates[0] -PathType Container)) {
        Fail ('Android SDK folder does not exist: {0}' -f $candidates[0])
    }
    return $candidates[0]
}

function Find-SdkTool {
    param(
        [Parameter(Mandatory = $true)][string]$SdkRoot,
        [Parameter(Mandatory = $true)][string]$Name
    )

    $direct = Join-Path $SdkRoot ('emulator\{0}.exe' -f $Name)
    if (Test-Path $direct -PathType Leaf) {
        return $direct
    }
    $cmdlineTools = Join-Path $SdkRoot 'cmdline-tools'
    if (Test-Path $cmdlineTools -PathType Container) {
        $latest = Join-Path $cmdlineTools ('latest\bin\{0}.bat' -f $Name)
        if (Test-Path $latest -PathType Leaf) {
            return $latest
        }
        $candidate = Get-ChildItem $cmdlineTools -Directory |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName ('bin\{0}.bat' -f $Name) } |
            Where-Object { Test-Path $_ -PathType Leaf } |
            Select-Object -First 1
        if ($candidate) {
            return $candidate
        }
    }
    return $null
}

function Get-Tools {
    $sdkRoot = Get-SdkRoot
    $tools = [ordered]@{
        sdkRoot = $sdkRoot
        adb = Join-Path $sdkRoot 'platform-tools\adb.exe'
        emulator = Join-Path $sdkRoot 'emulator\emulator.exe'
        avdmanager = Find-SdkTool -SdkRoot $sdkRoot -Name 'avdmanager'
    }
    foreach ($key in @('adb', 'emulator')) {
        if (-not (Test-Path $tools[$key] -PathType Leaf)) {
            Fail ('Required Android tool is missing: {0}' -f $tools[$key])
        }
    }
    return [pscustomobject]$tools
}

function Get-AvdDirectory {
    $userProfile = [Environment]::GetFolderPath('UserProfile')
    return Join-Path $userProfile ('.android\avd\{0}.avd' -f $script:AvdName)
}

function Get-AvdConfig {
    $configPath = Join-Path (Get-AvdDirectory) 'config.ini'
    if (-not (Test-Path $configPath -PathType Leaf)) {
        return $null
    }
    $values = @{}
    foreach ($line in Get-Content $configPath) {
        if ($line -match '^\s*([^#=]+?)\s*=\s*(.*?)\s*$') {
            $values[$matches[1].Trim()] = $matches[2].Trim()
        }
    }
    return [pscustomobject]@{
        path = $configPath
        values = $values
    }
}

function Get-ConfigValue {
    param(
        [Parameter(Mandatory = $true)][object]$Config,
        [Parameter(Mandatory = $true)][string]$Name
    )
    if ($Config.values.ContainsKey($Name)) {
        return [string]$Config.values[$Name]
    }
    return ''
}

function Assert-PinnedAvd {
    $config = Get-AvdConfig
    if (-not $config) {
        Fail ('Pinned AVD does not exist. Run this command first: scripts\run-pixel-emulator.cmd -Action create')
    }

    $imageSysdir = (Get-ConfigValue -Config $config -Name 'image.sysdir.1').Replace('/', '\').TrimStart('\')
    $expectedSysdir = 'system-images\android-35\google_apis\x86_64\'
    $abiType = Get-ConfigValue -Config $config -Name 'abi.type'
    $deviceName = Get-ConfigValue -Config $config -Name 'hw.device.name'

    if ($imageSysdir -ine $expectedSysdir) {
        Fail ('Pinned AVD image mismatch. Expected {0}, found {1}.' -f $script:SystemImage, $imageSysdir)
    }
    if ($abiType -ine $script:Abi) {
        Fail ('Pinned AVD architecture mismatch. Expected {0}, found {1}.' -f $script:Abi, $abiType)
    }
    if ($deviceName -ine $script:DeviceProfile) {
        Fail ('Pinned AVD device profile mismatch. Expected {0}, found {1}.' -f $script:DeviceProfile, $deviceName)
    }
    return $config
}

function Ensure-PinnedAvd {
    param([Parameter(Mandatory = $true)][object]$Tools)

    if (-not $Tools.avdmanager) {
        Fail 'avdmanager.bat was not found in the Android command-line tools.'
    }

    $config = Get-AvdConfig
    if ($config) {
        Assert-PinnedAvd | Out-Null
        return
    }

    $imageDir = Join-Path $Tools.sdkRoot 'system-images\android-35\google_apis\x86_64'
    if (-not (Test-Path $imageDir -PathType Container)) {
        Fail ('Pinned system image is missing: {0}. Run the approved SDK preparation with explicit operator approval, then retry.' -f $script:SystemImage)
    }

    Write-Host ('Creating pinned AVD {0} from {1}.' -f $script:AvdName, $script:SystemImage) -ForegroundColor Cyan
    $result = Invoke-Tool -Path $Tools.avdmanager -Arguments @(
        'create', 'avd',
        '--name', $script:AvdName,
        '--package', $script:SystemImage,
        '--device', $script:DeviceProfile,
        '--force'
    )
    if (-not $result.succeeded) {
        Fail ('avdmanager could not create the pinned AVD: {0}' -f $result.output)
    }
    Assert-PinnedAvd | Out-Null
}

function Invoke-Adb {
    param(
        [Parameter(Mandatory = $true)][object]$Tools,
        [string]$Serial = '',
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    $adbArgs = @()
    if ($Serial) {
        $adbArgs += @('-s', $Serial)
    }
    $adbArgs += $Arguments
    return Invoke-Tool -Path $Tools.adb -Arguments $adbArgs
}

function Get-Prop {
    param(
        [Parameter(Mandatory = $true)][object]$Tools,
        [Parameter(Mandatory = $true)][string]$Serial,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $result = Invoke-Adb -Tools $Tools -Serial $Serial -Arguments @('shell', 'getprop', $Name)
    if (-not $result.succeeded) {
        return ''
    }
    return ($result.output -split "`r?`n" | Select-Object -Last 1).Trim()
}

function Get-Emulator {
    param([Parameter(Mandatory = $true)][object]$Tools)

    $result = Invoke-Adb -Tools $Tools -Arguments @('devices')
    if (-not $result.succeeded) {
        return $null
    }
    $serials = @($result.output -split "`r?`n" | ForEach-Object {
        if ($_ -match '^(emulator-\d+)\s+device(\s|$)') { $matches[1] }
    } | Where-Object { $_ })

    foreach ($serial in $serials) {
        $avdName = Get-Prop -Tools $Tools -Serial $serial -Name 'ro.boot.qemu.avd_name'
        if (-not $avdName) {
            $emuName = Invoke-Adb -Tools $Tools -Serial $serial -Arguments @('emu', 'avd', 'name')
            if ($emuName.succeeded) {
                $avdName = ($emuName.output -split "`r?`n" | Where-Object { $_ -and $_ -notmatch '^OKAY' } | Select-Object -First 1).Trim()
            }
        }
        if ($avdName -eq $script:AvdName) {
            return [pscustomobject]@{
                serial = $serial
                avdName = $avdName
            }
        }
    }
    return $null
}

function Add-ValidationCheck {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][ValidateSet('PASS', 'BLOCKED')][string]$Status,
        [Parameter(Mandatory = $true)][string]$Observed,
        [Parameter(Mandatory = $true)][string]$Expected
    )
    $script:Checks += [ordered]@{
        id = $Id
        name = $Name
        status = $Status
        observed = $Observed
        expected = $Expected
    }
    Write-Host ('[{0}] {1}: {2}' -f $Status, $Name, $Observed) -ForegroundColor $(if ($Status -eq 'PASS') { 'Green' } else { 'Red' })
}

function Test-WritableState {
    param(
        [Parameter(Mandatory = $true)][object]$Tools,
        [Parameter(Mandatory = $true)][string]$Serial
    )
    $token = 'cas-gate0a-' + [guid]::NewGuid().ToString('N')
    $remotePath = '/data/local/tmp/cas-gate0a-writable-state.txt'
    $write = Invoke-Adb -Tools $Tools -Serial $Serial -Arguments @('shell', 'sh', '-c', ('printf "{0}" > {1}' -f $token, $remotePath))
    $read = Invoke-Adb -Tools $Tools -Serial $Serial -Arguments @('shell', 'cat', $remotePath)
    $remove = Invoke-Adb -Tools $Tools -Serial $Serial -Arguments @('shell', 'rm', '-f', $remotePath)
    return [pscustomobject]@{
        passed = $write.succeeded -and $read.succeeded -and ($read.output.Trim() -eq $token) -and $remove.succeeded
        path = $remotePath
        tokenMatched = ($read.output.Trim() -eq $token)
    }
}

function Set-RepeatableSettings {
    param(
        [Parameter(Mandatory = $true)][object]$Tools,
        [Parameter(Mandatory = $true)][string]$Serial
    )
    foreach ($setting in @(
        @('global', 'window_animation_scale', '0'),
        @('global', 'transition_animation_scale', '0'),
        @('global', 'animator_duration_scale', '0'),
        @('global', 'stay_on_while_plugged_in', '3')
    )) {
        $result = Invoke-Adb -Tools $Tools -Serial $Serial -Arguments @('shell', 'settings', 'put', $setting[0], $setting[1], $setting[2])
        if (-not $result.succeeded) {
            Fail ('Could not apply emulator setting {0}: {1}' -f $setting[1], $result.output)
        }
    }
}

function Get-RequiredSettings {
    param(
        [Parameter(Mandatory = $true)][object]$Tools,
        [Parameter(Mandatory = $true)][string]$Serial
    )
    $names = @('window_animation_scale', 'transition_animation_scale', 'animator_duration_scale', 'stay_on_while_plugged_in')
    $values = [ordered]@{}
    foreach ($name in $names) {
        $result = Invoke-Adb -Tools $Tools -Serial $Serial -Arguments @('shell', 'settings', 'get', 'global', $name)
        $values[$name] = if ($result.succeeded) { $result.output.Trim() } else { '' }
    }
    return $values
}

function Wait-And-Validate {
    param(
        [Parameter(Mandatory = $true)][object]$Tools,
        [switch]$ApplySettings
    )

    Invoke-Adb -Tools $Tools -Arguments @('start-server') | Out-Null
    $deadline = (Get-Date).AddSeconds($BootTimeoutSeconds)
    $emulator = $null
    while ((Get-Date) -lt $deadline) {
        $emulator = Get-Emulator -Tools $Tools
        if ($emulator) {
            $bootCompleted = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'sys.boot_completed'
            if ($bootCompleted -eq '1') {
                break
            }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $emulator) {
        Fail ('Pinned emulator {0} did not appear as an authorized ADB device within {1} seconds.' -f $script:AvdName, $BootTimeoutSeconds)
    }
    if ((Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'sys.boot_completed') -ne '1') {
        Fail ('Pinned emulator {0} did not report sys.boot_completed=1 within {1} seconds.' -f $script:AvdName, $BootTimeoutSeconds)
    }

    if ($ApplySettings) {
        Set-RepeatableSettings -Tools $Tools -Serial $emulator.serial
    }

    $api = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.build.version.sdk'
    $abiList = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.product.cpu.abilist'
    $qemu = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.kernel.qemu'
    $model = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.product.model'
    $device = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.product.device'
    $product = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.product.name'
    $fingerprint = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.build.fingerprint'
    $release = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.build.version.release'
    $securityPatch = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.build.version.security_patch'
    $hardware = Get-Prop -Tools $Tools -Serial $emulator.serial -Name 'ro.hardware'
    $settings = Get-RequiredSettings -Tools $Tools -Serial $emulator.serial
    $writable = Test-WritableState -Tools $Tools -Serial $emulator.serial

    Add-ValidationCheck -Id 'emulator.avd' -Name 'Pinned AVD identity' -Status $(if ($emulator.avdName -eq $script:AvdName) { 'PASS' } else { 'BLOCKED' }) -Observed $emulator.avdName -Expected $script:AvdName
    Add-ValidationCheck -Id 'emulator.api' -Name 'Android API level' -Status $(if ($api -eq [string]$script:ApiLevel) { 'PASS' } else { 'BLOCKED' }) -Observed $api -Expected ([string]$script:ApiLevel)
    Add-ValidationCheck -Id 'emulator.architecture' -Name 'Emulator architecture' -Status $(if ($abiList -match '(^|,)x86_64(,|$)') { 'PASS' } else { 'BLOCKED' }) -Observed $abiList -Expected 'ro.product.cpu.abilist includes x86_64'
    Add-ValidationCheck -Id 'emulator.boot' -Name 'Boot completion' -Status 'PASS' -Observed 'sys.boot_completed=1' -Expected 'sys.boot_completed=1'
    Add-ValidationCheck -Id 'emulator.qemu' -Name 'Simulated runtime marker' -Status $(if ($qemu -eq '1') { 'PASS' } else { 'BLOCKED' }) -Observed $qemu -Expected 'ro.kernel.qemu=1'
    $settingsExpected = ($settings.window_animation_scale -eq '0' -and $settings.transition_animation_scale -eq '0' -and $settings.animator_duration_scale -eq '0' -and $settings.stay_on_while_plugged_in -eq '3')
    Add-ValidationCheck -Id 'emulator.settings' -Name 'Repeatable emulator settings' -Status $(if ($settingsExpected) { 'PASS' } else { 'BLOCKED' }) -Observed (($settings.GetEnumerator() | ForEach-Object { '{0}={1}' -f $_.Key, $_.Value }) -join ', ') -Expected 'animation scales=0; stay_on_while_plugged_in=3'
    Add-ValidationCheck -Id 'emulator.writable-state' -Name 'Writable test state' -Status $(if ($writable.passed) { 'PASS' } else { 'BLOCKED' }) -Observed ('{0}; tokenMatched={1}' -f $writable.path, $writable.tokenMatched) -Expected 'Write, read, and remove a file under /data/local/tmp'

    $failed = @($script:Checks | Where-Object { $_.status -eq 'BLOCKED' }).Count -gt 0
    return [ordered]@{
        serial = $emulator.serial
        avdName = $emulator.avdName
        model = $model
        device = $device
        product = $product
        apiLevel = [int]$api
        architecture = $script:Abi
        abiList = $abiList
        androidRelease = $release
        securityPatch = $securityPatch
        buildFingerprint = $fingerprint
        hardware = $hardware
        qemu = $qemu
        image = $script:SystemImage
        deviceProfile = $script:DeviceProfile
        settings = $settings
        writableState = $writable
        overallStatus = if ($failed) { 'BLOCKED' } else { 'PASS' }
    }
}

function Stop-PinnedEmulator {
    param([Parameter(Mandatory = $true)][object]$Tools)
    $emulator = Get-Emulator -Tools $Tools
    if (-not $emulator) {
        return [pscustomobject]@{ stopped = $true; serial = ''; detail = 'Pinned emulator was not running.' }
    }
    $result = Invoke-Adb -Tools $Tools -Serial $emulator.serial -Arguments @('emu', 'kill')
    if (-not $result.succeeded) {
        Fail ('Could not stop pinned emulator {0}: {1}' -f $emulator.serial, $result.output)
    }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        if (-not (Get-Emulator -Tools $Tools)) {
            return [pscustomobject]@{ stopped = $true; serial = $emulator.serial; detail = 'Pinned emulator stopped.' }
        }
        Start-Sleep -Seconds 1
    }
    Fail ('Pinned emulator {0} did not stop within 30 seconds.' -f $emulator.serial)
}

function Start-PinnedEmulator {
    param(
        [Parameter(Mandatory = $true)][object]$Tools,
        [switch]$WipeData
    )
    $existing = Get-Emulator -Tools $Tools
    if ($existing) {
        if ($WipeData) {
            Stop-PinnedEmulator -Tools $Tools | Out-Null
        } else {
            return Wait-And-Validate -Tools $Tools -ApplySettings
        }
    }

    $logPath = Join-Path $script:OutputPath ('emulator-{0}.log' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
    New-Item -ItemType File -Force -Path $logPath | Out-Null
    $arguments = @('-avd', $script:AvdName, '-no-snapshot', '-no-boot-anim', '-gpu', 'swiftshader_indirect')
    if ($WipeData) {
        $arguments += '-wipe-data'
    }
    Write-Host ('Starting {0} (log: {1}).' -f $script:AvdName, $logPath) -ForegroundColor Cyan
    $errorLogPath = Join-Path $script:OutputPath ('emulator-{0}.err.log' -f (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))
    Start-Process -FilePath $Tools.emulator -ArgumentList $arguments -RedirectStandardOutput $logPath -RedirectStandardError $errorLogPath | Out-Null
    return Wait-And-Validate -Tools $Tools -ApplySettings
}

function Convert-ToMarkdownCell {
    param([AllowNull()][object]$Value)
    if ($null -eq $Value) { return '' }
    return (($Value.ToString() -replace '\|', '\|') -replace "`r?`n", ' ')
}

function Write-Result {
    param([Parameter(Mandatory = $true)][object]$Result)
    New-Item -ItemType Directory -Force -Path $script:OutputPath | Out-Null
    $timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
    $jsonPath = Join-Path $script:OutputPath ('cas-pixel-emulator-{0}.json' -f $timestamp)
    $markdownPath = Join-Path $script:OutputPath ('cas-pixel-emulator-{0}.md' -f $timestamp)
    $Result | ConvertTo-Json -Depth 12 | Set-Content -Path $jsonPath -Encoding UTF8

    $markdown = @(
        '# CAS Gate 0A pinned Pixel emulator validation',
        '',
        '- **Evidence class:** `simulated-emulator`',
        '- **Physical readiness proof:** `false`',
        ('- **Action:** `{0}`' -f $Result.action),
        ('- **Overall status:** `{0}`' -f $Result.overallStatus),
        ('- **Generated (UTC):** `{0}`' -f $Result.generatedAtUtc),
        '',
        '## Contract',
        '',
        ('- AVD: `{0}`' -f $script:AvdName),
        ('- Device profile: `{0}`' -f $script:DeviceProfile),
        ('- Android image: `{0}`' -f $script:SystemImage),
        ('- Architecture: `{0}`' -f $script:Abi),
        '',
        '## Checks',
        '',
        '| Status | Check | Observed | Expected |',
        '| --- | --- | --- | --- |'
    )
    foreach ($check in @($Result.checks)) {
        $markdown += ('| {0} | {1} | {2} | {3} |' -f `
            (Convert-ToMarkdownCell $check.status), `
            (Convert-ToMarkdownCell $check.name), `
            (Convert-ToMarkdownCell $check.observed), `
            (Convert-ToMarkdownCell $check.expected))
    }
    $markdown += @(
        '',
        '## Emulator identity and image',
        '',
        ('- Serial: `{0}`' -f $Result.emulator.serial),
        ('- Model/device/product: `{0}` / `{1}` / `{2}`' -f $Result.emulator.model, $Result.emulator.device, $Result.emulator.product),
        ('- API/release/security patch: `{0}` / `{1}` / `{2}`' -f $Result.emulator.apiLevel, $Result.emulator.androidRelease, $Result.emulator.securityPatch),
        ('- Build fingerprint: `{0}`' -f $Result.emulator.buildFingerprint),
        ('- ABI list: `{0}`' -f $Result.emulator.abiList),
        '',
        '## Safety boundary',
        '',
        '- This result is simulated emulator evidence only.',
        '- It does not prove carrier SMS, GPS, SystemUI, managed Device Owner, physical lock-screen behavior, or production readiness.',
        '- The lifecycle script acts only on the pinned emulator ADB serial and never sends recipient traffic.',
        '',
        '## Attachments',
        '',
        ('- JSON: `{0}`' -f [System.IO.Path]::GetFileName($jsonPath)),
        ('- Markdown: `{0}`' -f [System.IO.Path]::GetFileName($markdownPath))
    )
    $markdown | Set-Content -Path $markdownPath -Encoding UTF8
    Write-Host ('JSON result: {0}' -f $jsonPath)
    Write-Host ('Markdown result: {0}' -f $markdownPath)
    return [pscustomobject]@{ jsonPath = $jsonPath; markdownPath = $markdownPath }
}

function New-BaseResult {
    param([Parameter(Mandatory = $true)][string]$Status)
    return [ordered]@{
        schemaVersion = 'cas-pixel-emulator-validation-v1'
        generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        action = $Action
        overallStatus = $Status
        evidenceClass = $script:EvidenceClass
        simulatedEvidence = $true
        physicalReadinessProof = $false
        contract = [ordered]@{
            avdName = $script:AvdName
            deviceProfile = $script:DeviceProfile
            androidApi = $script:ApiLevel
            systemImage = $script:SystemImage
            architecture = $script:Abi
            requiredSettings = [ordered]@{
                window_animation_scale = '0'
                transition_animation_scale = '0'
                animator_duration_scale = '0'
                stay_on_while_plugged_in = '3'
            }
        }
        emulator = [ordered]@{}
        checks = @()
        safety = [ordered]@{
            physicalDeviceTouched = $false
            apkInstalled = $false
            deviceOwnerChanged = $false
            messagesSent = $false
            evidenceCaptured = $false
        }
    }
}

try {
    New-Item -ItemType Directory -Force -Path $script:OutputPath | Out-Null
    $tools = Get-Tools
    $script:Checks = @()
    $emulatorResult = $null

    switch ($Action) {
        'create' {
            Ensure-PinnedAvd -Tools $tools
            Add-ValidationCheck -Id 'avd.config' -Name 'Pinned AVD configuration' -Status 'PASS' -Observed $script:AvdName -Expected ('{0}, API {1}, {2}' -f $script:DeviceProfile, $script:ApiLevel, $script:Abi)
        }
        'start' {
            Ensure-PinnedAvd -Tools $tools
            $emulatorResult = Start-PinnedEmulator -Tools $tools
        }
        'wait' {
            Assert-PinnedAvd | Out-Null
            $emulatorResult = Wait-And-Validate -Tools $tools
        }
        'reset' {
            Ensure-PinnedAvd -Tools $tools
            $emulatorResult = Start-PinnedEmulator -Tools $tools -WipeData
        }
        'stop' {
            $stop = Stop-PinnedEmulator -Tools $tools
            Add-ValidationCheck -Id 'emulator.stop' -Name 'Pinned emulator stopped' -Status 'PASS' -Observed $stop.detail -Expected 'No CAS pinned emulator remains running'
        }
        'status' {
            Assert-PinnedAvd | Out-Null
            $emulatorResult = Wait-And-Validate -Tools $tools
        }
    }

    $status = if (@($script:Checks | Where-Object { $_.status -eq 'BLOCKED' }).Count -gt 0) { 'BLOCKED' } else { 'PASS' }
    $result = New-BaseResult -Status $status
    $config = Get-AvdConfig
    $result.emulator = if ($emulatorResult) {
        $emulatorResult
    } else {
        [ordered]@{
            avdName = $script:AvdName
            config = if ($config) { $config.path } else { '' }
        }
    }
    $result.checks = @($script:Checks)
    Write-Result -Result $result | Out-Null
    if ($status -eq 'BLOCKED') { exit 2 }
    exit 0
} catch {
    $result = New-BaseResult -Status 'BLOCKED'
    $result.error = $_.Exception.Message
    $result.checks = @($script:Checks)
    Write-Result -Result $result | Out-Null
    Write-Error $_.Exception.Message
    exit 2
}