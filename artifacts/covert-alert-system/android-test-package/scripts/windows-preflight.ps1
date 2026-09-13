<#
.SYNOPSIS
    Read-only Windows preflight for the CAS Pixel Gate 0A workstation.

.DESCRIPTION
    Checks the local Java, Android SDK, ADB, Gradle, and Git Bash prerequisites and writes
    JSON and Markdown results that can be attached to a CAS field-run record.
    The default mode does not install software, change device state, or send
    messages. -PrepareSdk can install missing SDK packages only after an
    explicit confirmation.

    This script never installs an APK, changes Device Owner state, reboots a
    device, sends input, sends a message, or captures evidence.
#>

[CmdletBinding()]
param(
    [ValidateSet('physical', 'emulator', 'both')]
    [string]$Target = 'physical',

    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\preflight-results'),

    [switch]$PrepareSdk,

    [switch]$ConfirmSdkInstall
)

$ErrorActionPreference = 'Stop'
$script:Checks = @()
$script:Actions = @()

function Add-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][ValidateSet('PASS', 'WARN', 'BLOCKED', 'SKIPPED')][string]$Status,
        [Parameter(Mandatory = $true)][bool]$Required,
        [string]$Observed = '',
        [string]$Expected = '',
        [string[]]$NextSteps = @()
    )

    $script:Checks += [pscustomobject]@{
        id = $Id
        name = $Name
        status = $Status
        required = $Required
        observed = $Observed
        expected = $Expected
        nextSteps = @($NextSteps)
    }

    $color = switch ($Status) {
        'PASS' { 'Green' }
        'WARN' { 'Yellow' }
        'BLOCKED' { 'Red' }
        default { 'DarkGray' }
    }
    Write-Host ('[{0}] {1}: {2}' -f $Status, $Name, $Observed) -ForegroundColor $color
}

function Find-CommandPath {
    param([Parameter(Mandatory = $true)][string]$Name)

    try {
        $command = Get-Command $Name -ErrorAction Stop
        if ($command.Path) {
            return $command.Path
        }
        return $command.Source
    } catch {
        return $null
    }
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

function Get-MajorVersion {
    param([string]$Text)

    $match = [regex]::Match($Text, '(?<!\d)(\d+)(?:\.\d+)?(?:\.\d+)?')
    if ($match.Success) {
        return [int]$match.Groups[1].Value
    }
    return $null
}

function Get-Version {
    param([string]$Text)

    $match = [regex]::Match($Text, '(?<!\d)(\d+)\.(\d+)(?:\.(\d+))?')
    if (-not $match.Success) {
        return $null
    }
    $patch = if ($match.Groups[3].Success) { $match.Groups[3].Value } else { '0' }
    try {
        return [version]::new(
            [int]$match.Groups[1].Value,
            [int]$match.Groups[2].Value,
            [int]$patch
        )
    } catch {
        return $null
    }
}

function Test-PathEntry {
    param([Parameter(Mandatory = $true)][string]$PathEntry)

    $entries = @($env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\') } | Where-Object { $_ })
    $wanted = $PathEntry.Trim().TrimEnd('\')
    return ($entries | Where-Object { $_ -ieq $wanted }).Count -gt 0
}

function Get-SdkManagerPath {
    param([string]$SdkRoot)

    if (-not $SdkRoot) {
        return $null
    }

    $latest = Join-Path $SdkRoot 'cmdline-tools\latest\bin\sdkmanager.bat'
    if (Test-Path $latest -PathType Leaf) {
        return $latest
    }

    $cmdlineTools = Join-Path $SdkRoot 'cmdline-tools'
    if (Test-Path $cmdlineTools -PathType Container) {
        $candidate = Get-ChildItem $cmdlineTools -Directory |
            Sort-Object Name -Descending |
            ForEach-Object { Join-Path $_.FullName 'bin\sdkmanager.bat' } |
            Where-Object { Test-Path $_ -PathType Leaf } |
            Select-Object -First 1
        if ($candidate) {
            return $candidate
        }
    }
    return $null
}

function Get-OverallStatus {
    if (@($script:Checks | Where-Object { $_.status -eq 'BLOCKED' }).Count -gt 0) {
        return 'BLOCKED'
    }
    if (@($script:Checks | Where-Object { $_.status -eq 'WARN' }).Count -gt 0) {
        return 'WARN'
    }
    return 'PASS'
}

function Convert-ToMarkdownCell {
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) {
        return ''
    }
    return (($Value.ToString() -replace '\|', '\|') -replace "`r?`n", ' ')
}

Write-Host ''
Write-Host 'CAS Pixel Gate 0A - Windows workstation preflight' -ForegroundColor Cyan
Write-Host ('Target mode: {0}' -f $Target)
Write-Host 'Default behavior is read-only. No APK, device policy, reboot, message, or evidence action is performed.'
Write-Host ''

$sdkRoot = $null
$sdkRootCandidates = @($env:ANDROID_SDK_ROOT, $env:ANDROID_HOME) |
    Where-Object { $_ -and $_.Trim() } |
    ForEach-Object { [System.IO.Path]::GetFullPath($_.Trim()) } |
    Select-Object -Unique

if ($sdkRootCandidates.Count -eq 0) {
    Add-Check `
        -Id 'environment.android-sdk' `
        -Name 'Android SDK environment variables' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'ANDROID_SDK_ROOT and ANDROID_HOME are both empty.' `
        -Expected 'Set ANDROID_SDK_ROOT or ANDROID_HOME to the Android SDK folder.' `
        -NextSteps @(
            'Install Android Studio or the Android command-line tools with user consent.',
            'Set ANDROID_SDK_ROOT to the SDK folder, usually %LOCALAPPDATA%\Android\Sdk.',
            'Close and reopen this window, then run the preflight again.'
        )
} else {
    $sdkRoot = $sdkRootCandidates[0]
    $sdkVariableStatus = 'PASS'
    $sdkVariableObserved = 'Using {0}' -f $sdkRoot
    $sdkVariableNextSteps = @()
    if ($sdkRootCandidates.Count -gt 1) {
        if ($sdkRootCandidates[0].TrimEnd('\') -ine $sdkRootCandidates[1].TrimEnd('\')) {
            $sdkVariableStatus = 'BLOCKED'
            $sdkVariableObserved = 'ANDROID_SDK_ROOT and ANDROID_HOME point to different folders.'
            $sdkVariableNextSteps = @('Set both variables to the same SDK folder, or clear the older variable, then rerun this check.')
        } else {
            $sdkVariableObserved = 'ANDROID_SDK_ROOT and ANDROID_HOME agree on {0}' -f $sdkRoot
        }
    }
    Add-Check `
        -Id 'environment.android-sdk' `
        -Name 'Android SDK environment variables' `
        -Status $sdkVariableStatus `
        -Required $true `
        -Observed $sdkVariableObserved `
        -Expected 'ANDROID_SDK_ROOT or ANDROID_HOME points to the Android SDK folder.' `
        -NextSteps $sdkVariableNextSteps
}

$javaHome = $env:JAVA_HOME
$javaHomePath = if ($javaHome) { [System.IO.Path]::GetFullPath($javaHome.Trim()) } else { $null }
$javaPath = if ($javaHomePath) { Join-Path $javaHomePath 'bin\java.exe' } else { Find-CommandPath 'java.exe' }

if (-not $javaHomePath) {
    Add-Check `
        -Id 'environment.java-home' `
        -Name 'JAVA_HOME' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'JAVA_HOME is not set.' `
        -Expected 'JAVA_HOME points to a JDK 17 or newer installation.' `
        -NextSteps @(
            'Install a JDK 17 or newer with user consent.',
            'Set JAVA_HOME to the JDK folder, not its bin folder.',
            'Close and reopen this window, then rerun the preflight.'
        )
} elseif (-not (Test-Path $javaHomePath -PathType Container)) {
    Add-Check `
        -Id 'environment.java-home' `
        -Name 'JAVA_HOME' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed ('JAVA_HOME does not exist: {0}' -f $javaHomePath) `
        -Expected 'JAVA_HOME points to a JDK 17 or newer installation.' `
        -NextSteps @('Correct JAVA_HOME to the installed JDK folder, then reopen this window.')
} else {
    Add-Check `
        -Id 'environment.java-home' `
        -Name 'JAVA_HOME' `
        -Status 'PASS' `
        -Required $true `
        -Observed $javaHomePath `
        -Expected 'JAVA_HOME points to a JDK 17 or newer installation.'
}

if (-not $javaPath -or -not (Test-Path $javaPath -PathType Leaf)) {
    Add-Check `
        -Id 'java.command' `
        -Name 'Java command' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'java.exe was not found.' `
        -Expected 'java.exe is available from JAVA_HOME\bin or PATH.' `
        -NextSteps @('Add the JDK bin folder to PATH, reopen this window, and rerun the preflight.')
} else {
    $javaResult = Invoke-Tool -Path $javaPath -Arguments @('-version')
    $javaMajor = Get-MajorVersion $javaResult.output
    if (-not $javaResult.succeeded -or $null -eq $javaMajor) {
        Add-Check `
            -Id 'java.command' `
            -Name 'Java command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('java.exe did not report a version. {0}' -f $javaResult.output) `
            -Expected 'JDK 17 or newer.' `
            -NextSteps @('Install or select a working JDK 17 or newer, then rerun the preflight.')
    } elseif ($javaMajor -lt 17) {
        Add-Check `
            -Id 'java.command' `
            -Name 'Java command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('Java major version {0}' -f $javaMajor) `
            -Expected 'JDK 17 or newer.' `
            -NextSteps @('Install JDK 17 or newer and point JAVA_HOME and PATH to it.')
    } else {
        Add-Check `
            -Id 'java.command' `
            -Name 'Java command' `
            -Status 'PASS' `
            -Required $true `
            -Observed ('Java major version {0} at {1}' -f $javaMajor, $javaPath) `
            -Expected 'JDK 17 or newer.'
    }
}

$javaBin = if ($javaHomePath) { Join-Path $javaHomePath 'bin' } else { $null }
if ($javaBin -and (Test-Path $javaBin -PathType Container) -and (Test-PathEntry $javaBin)) {
    Add-Check `
        -Id 'path.java' `
        -Name 'Java PATH entry' `
        -Status 'PASS' `
        -Required $true `
        -Observed $javaBin `
        -Expected 'JAVA_HOME\bin is present in PATH.'
} else {
    Add-Check `
        -Id 'path.java' `
        -Name 'Java PATH entry' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'The JDK bin folder is not present in PATH.' `
        -Expected 'JAVA_HOME\bin is present in PATH.' `
        -NextSteps @('Add JAVA_HOME\bin to PATH, close and reopen this window, then rerun the preflight.')
}

$adbPath = Find-CommandPath 'adb.exe'
$adbExpectedPath = if ($sdkRoot) { Join-Path $sdkRoot 'platform-tools\adb.exe' } else { $null }
if (-not $sdkRoot) {
    Add-Check `
        -Id 'android.sdk-folder' `
        -Name 'Android SDK folder' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'Android SDK location is unknown.' `
        -Expected 'An existing Android SDK folder.' `
        -NextSteps @('Set ANDROID_SDK_ROOT or ANDROID_HOME, then rerun the preflight.')
} elseif (-not (Test-Path $sdkRoot -PathType Container)) {
    Add-Check `
        -Id 'android.sdk-folder' `
        -Name 'Android SDK folder' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed ('SDK folder does not exist: {0}' -f $sdkRoot) `
        -Expected 'An existing Android SDK folder.' `
        -NextSteps @('Correct the Android SDK environment variable, then rerun the preflight.')
} else {
    Add-Check `
        -Id 'android.sdk-folder' `
        -Name 'Android SDK folder' `
        -Status 'PASS' `
        -Required $true `
        -Observed $sdkRoot `
        -Expected 'An existing Android SDK folder.'
}

if ($sdkRoot -and (Test-Path $adbExpectedPath -PathType Leaf)) {
    Add-Check `
        -Id 'android.platform-tools' `
        -Name 'Android platform-tools' `
        -Status 'PASS' `
        -Required $true `
        -Observed $adbExpectedPath `
        -Expected 'platform-tools\adb.exe exists in the selected SDK.'
} else {
    Add-Check `
        -Id 'android.platform-tools' `
        -Name 'Android platform-tools' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'platform-tools\adb.exe was not found in the selected SDK.' `
        -Expected 'platform-tools\adb.exe exists in the selected SDK.' `
        -NextSteps @(
            'Install Android SDK Platform-Tools from Android Studio SDK Manager, or use the approved command-line tools.',
            'Do not download an untrusted adb.exe from a third-party site.'
        )
}

$platformToolsPath = if ($sdkRoot) { Join-Path $sdkRoot 'platform-tools' } else { $null }
if ($platformToolsPath -and (Test-PathEntry $platformToolsPath)) {
    Add-Check `
        -Id 'path.platform-tools' `
        -Name 'platform-tools PATH entry' `
        -Status 'PASS' `
        -Required $true `
        -Observed $platformToolsPath `
        -Expected 'The SDK platform-tools folder is present in PATH.'
} else {
    Add-Check `
        -Id 'path.platform-tools' `
        -Name 'platform-tools PATH entry' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'The SDK platform-tools folder is not present in PATH.' `
        -Expected 'The SDK platform-tools folder is present in PATH.' `
        -NextSteps @('Add the platform-tools folder to PATH, close and reopen this window, then rerun the preflight.')
}

if (-not $adbPath -and $adbExpectedPath -and (Test-Path $adbExpectedPath -PathType Leaf)) {
    $adbPath = $adbExpectedPath
}

if (-not $adbPath) {
    Add-Check `
        -Id 'adb.command' `
        -Name 'ADB command' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'adb.exe was not found on PATH.' `
        -Expected 'ADB is available as a working platform-tools command.' `
        -NextSteps @('Fix the platform-tools PATH entry, reopen this window, and rerun the preflight.')
} else {
    $adbResult = Invoke-Tool -Path $adbPath -Arguments @('version')
    if (-not $adbResult.succeeded) {
        Add-Check `
            -Id 'adb.command' `
            -Name 'ADB command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('ADB did not respond successfully. {0}' -f $adbResult.output) `
            -Expected 'ADB responds to adb version.' `
            -NextSteps @('Confirm the platform-tools installation is complete and rerun the preflight.')
    } else {
        $adbVersionLine = ($adbResult.output -split "`r?`n" | Where-Object { $_ -match 'Android Debug Bridge' } | Select-Object -First 1)
        Add-Check `
            -Id 'adb.command' `
            -Name 'ADB command' `
            -Status 'PASS' `
            -Required $true `
            -Observed ($adbVersionLine | ForEach-Object { $_.Trim() }) `
            -Expected 'ADB responds to adb version.'
    }
}

$buildToolsPath = if ($sdkRoot) { Join-Path $sdkRoot 'build-tools' } else { $null }
$buildTools = @()
if ($buildToolsPath -and (Test-Path $buildToolsPath -PathType Container)) {
    $buildTools = @(Get-ChildItem $buildToolsPath -Directory | Where-Object {
        $null -ne (Get-Version $_.Name)
    } | Sort-Object { Get-Version $_.Name } -Descending)
}
$minimumBuildTools = [version]'35.0.0'
$selectedBuildTools = $buildTools | Where-Object { (Get-Version $_.Name) -ge $minimumBuildTools } | Select-Object -First 1
if ($selectedBuildTools) {
    Add-Check `
        -Id 'android.build-tools' `
        -Name 'Android build-tools' `
        -Status 'PASS' `
        -Required $true `
        -Observed $selectedBuildTools.Name `
        -Expected 'Build-tools 35.0.0 or newer.'
} else {
    Add-Check `
        -Id 'android.build-tools' `
        -Name 'Android build-tools' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'No build-tools 35.0.0 or newer was found.' `
        -Expected 'Build-tools 35.0.0 or newer.' `
        -NextSteps @('Install Android SDK Build-Tools 35.0.0 or newer, then rerun the preflight.')
}

$platform35Path = if ($sdkRoot) { Join-Path $sdkRoot 'platforms\android-35\android.jar' } else { $null }
if ($platform35Path -and (Test-Path $platform35Path -PathType Leaf)) {
    Add-Check `
        -Id 'android.api-35' `
        -Name 'Android API 35 platform' `
        -Status 'PASS' `
        -Required $true `
        -Observed $platform35Path `
        -Expected 'platforms\android-35\android.jar exists.'
} else {
    Add-Check `
        -Id 'android.api-35' `
        -Name 'Android API 35 platform' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'Android API 35 was not found in the selected SDK.' `
        -Expected 'platforms\android-35\android.jar exists.' `
        -NextSteps @('Install Android SDK Platform 35, then rerun the preflight.')
}

$bashCandidates = @(
    (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
    (Join-Path $env:ProgramFiles 'Git\usr\bin\bash.exe')
)
if (${env:ProgramFiles(x86)}) {
    $bashCandidates += Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'
}
$bashPath = $bashCandidates |
    Where-Object { $_ -and (Test-Path $_ -PathType Leaf) } |
    Select-Object -First 1
if (-not $bashPath) {
    $bashPath = Find-CommandPath 'bash.exe'
}
if ($bashPath) {
    Add-Check `
        -Id 'git-bash.command' `
        -Name 'Git Bash command' `
        -Status 'PASS' `
        -Required $true `
        -Observed $bashPath `
        -Expected 'Git Bash is available for the guarded Pixel 11 Gate 0A runner.'
} else {
    Add-Check `
        -Id 'git-bash.command' `
        -Name 'Git Bash command' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'Git Bash bash.exe was not found.' `
        -Expected 'Git Bash is available for the guarded Pixel 11 Gate 0A runner.' `
        -NextSteps @('Install approved Git for Windows, close and reopen this window, then rerun the preflight.')
}

$gradlePath = Find-CommandPath 'gradle.exe'
if (-not $gradlePath) {
    $gradlePath = Find-CommandPath 'gradle'
}
if (-not $gradlePath) {
    Add-Check `
        -Id 'gradle.command' `
        -Name 'Gradle command' `
        -Status 'BLOCKED' `
        -Required $true `
        -Observed 'gradle was not found on PATH.' `
        -Expected 'Gradle 8.9 or newer is available on PATH.' `
        -NextSteps @(
            'Install the approved Gradle 8.9 or newer distribution with user consent.',
            'Add its bin folder to PATH, close and reopen this window, then rerun the preflight.'
        )
} else {
    $gradleResult = Invoke-Tool -Path $gradlePath -Arguments @('--version')
    $gradleVersion = Get-Version $gradleResult.output
    $minimumGradle = [version]'8.9.0'
    if (-not $gradleResult.succeeded -or $null -eq $gradleVersion) {
        Add-Check `
            -Id 'gradle.command' `
            -Name 'Gradle command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('Gradle did not report a version. {0}' -f $gradleResult.output) `
            -Expected 'Gradle 8.9 or newer.' `
            -NextSteps @('Install or select a working Gradle 8.9 or newer distribution, then rerun the preflight.')
    } elseif ($gradleVersion -lt $minimumGradle) {
        Add-Check `
            -Id 'gradle.command' `
            -Name 'Gradle command' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed ('Gradle {0}' -f $gradleVersion) `
            -Expected 'Gradle 8.9 or newer.' `
            -NextSteps @('Upgrade Gradle to 8.9 or newer, then rerun the preflight.')
    } else {
        Add-Check `
            -Id 'gradle.command' `
            -Name 'Gradle command' `
            -Status 'PASS' `
            -Required $true `
            -Observed ('Gradle {0} at {1}' -f $gradleVersion, $gradlePath) `
            -Expected 'Gradle 8.9 or newer.'
    }
}

$sdkManagerPath = Get-SdkManagerPath $sdkRoot
if ($sdkManagerPath) {
    Add-Check `
        -Id 'android.command-line-tools' `
        -Name 'Android command-line tools' `
        -Status 'PASS' `
        -Required $false `
        -Observed $sdkManagerPath `
        -Expected 'sdkmanager.bat is available for optional, confirmed SDK preparation.'
} else {
    $commandLineToolsStatus = if ($PrepareSdk) { 'BLOCKED' } else { 'SKIPPED' }
    $commandLineToolsNextSteps = if ($PrepareSdk) {
        @('Install the official Android SDK Command-line Tools before using -PrepareSdk.')
    } else {
        @()
    }
    Add-Check `
        -Id 'android.command-line-tools' `
        -Name 'Android command-line tools' `
        -Status $commandLineToolsStatus `
        -Required $false `
        -Observed 'sdkmanager.bat was not found.' `
        -Expected 'sdkmanager.bat is available if this script will prepare SDK packages.' `
        -NextSteps $commandLineToolsNextSteps
}

if ($Target -eq 'physical' -or $Target -eq 'both') {
    if (-not $adbPath) {
        Add-Check `
            -Id 'device.physical' `
            -Name 'Physical-device ADB status' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed 'ADB is unavailable, so the physical-device status cannot be read.' `
            -Expected 'An authorized physical device appears as device in adb devices -l.' `
            -NextSteps @('Complete the ADB checks above before connecting the approved Pixel.')
    } else {
        $deviceOutput = (Invoke-Tool -Path $adbPath -Arguments @('devices', '-l')).output
        $physicalLines = @($deviceOutput -split "`r?`n" | Where-Object {
            $_ -match '^[^\s]+(\s+device|\s+unauthorized|\s+offline)(\s|$)' -and $_ -notmatch '^emulator-'
        })
        $authorizedPhysical = @($physicalLines | Where-Object { $_ -match '^\S+\s+device(\s|$)' })
        $unauthorizedPhysical = @($physicalLines | Where-Object { $_ -match '^\S+\s+(unauthorized|offline)(\s|$)' })
        if ($authorizedPhysical.Count -gt 0) {
            Add-Check `
                -Id 'device.physical' `
                -Name 'Physical-device ADB status' `
                -Status 'PASS' `
                -Required $true `
                -Observed ('Authorized physical device detected: {0}' -f ($authorizedPhysical -join '; ')) `
                -Expected 'An authorized physical device appears as device in adb devices -l.'
        } elseif ($unauthorizedPhysical.Count -gt 0) {
            Add-Check `
                -Id 'device.physical' `
                -Name 'Physical-device ADB status' `
                -Status 'BLOCKED' `
                -Required $true `
                -Observed ('Physical device is not authorized: {0}' -f ($unauthorizedPhysical -join '; ')) `
                -Expected 'An authorized physical device appears as device in adb devices -l.' `
                -NextSteps @(
                    'Unlock the device and accept the RSA debugging prompt on the device screen.',
                    'If no prompt appears, revoke USB debugging authorizations in Developer options, reconnect, and retry.',
                    'Do not use this script to change Device Owner state or install an APK.'
                )
        } else {
            Add-Check `
                -Id 'device.physical' `
                -Name 'Physical-device ADB status' `
                -Status 'BLOCKED' `
                -Required $true `
                -Observed 'No physical device is currently visible to ADB.' `
                -Expected 'An authorized physical device appears as device in adb devices -l.' `
                -NextSteps @(
                    'For a physical run, connect the approved Pixel with USB debugging enabled.',
                    'Unlock it and accept the RSA prompt, then rerun this preflight.',
                    'If this is only a workstation setup check, this warning can be resolved at the field site.'
                )
        }
    }
} else {
    Add-Check `
        -Id 'device.physical' `
        -Name 'Physical-device ADB status' `
        -Status 'SKIPPED' `
        -Required $false `
        -Observed 'Skipped because target mode is emulator.' `
        -Expected 'Not evaluated.'
}

if ($Target -eq 'emulator' -or $Target -eq 'both') {
    $emulatorPath = if ($sdkRoot) { Join-Path $sdkRoot 'emulator\emulator.exe' } else { $null }
    if ($emulatorPath -and (Test-Path $emulatorPath -PathType Leaf)) {
        Add-Check `
            -Id 'android.emulator' `
            -Name 'Android Emulator tool' `
            -Status 'PASS' `
            -Required $true `
            -Observed $emulatorPath `
            -Expected 'emulator\emulator.exe exists in the selected SDK.'
    } else {
        Add-Check `
            -Id 'android.emulator' `
            -Name 'Android Emulator tool' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed 'emulator.exe was not found in the selected SDK.' `
            -Expected 'emulator\emulator.exe exists in the selected SDK.' `
            -NextSteps @('Install the Android Emulator package with user consent, then rerun the preflight.')
    }

    if (-not $adbPath) {
        Add-Check `
            -Id 'device.emulator' `
            -Name 'Emulator ADB status' `
            -Status 'BLOCKED' `
            -Required $true `
            -Observed 'ADB is unavailable, so emulator status cannot be read.' `
            -Expected 'A running emulator appears as an authorized adb device.' `
            -NextSteps @('Complete the ADB checks above before starting the approved emulator.')
    } else {
        $deviceOutput = (Invoke-Tool -Path $adbPath -Arguments @('devices', '-l')).output
        $emulatorLines = @($deviceOutput -split "`r?`n" | Where-Object {
            $_ -match '^emulator-\S+\s+(device|unauthorized|offline)(\s|$)'
        })
        $authorizedEmulator = @($emulatorLines | Where-Object { $_ -match '^emulator-\S+\s+device(\s|$)' })
        if ($authorizedEmulator.Count -gt 0) {
            Add-Check `
                -Id 'device.emulator' `
                -Name 'Emulator ADB status' `
                -Status 'PASS' `
                -Required $true `
                -Observed ('Authorized emulator detected: {0}' -f ($authorizedEmulator -join '; ')) `
                -Expected 'A running emulator appears as an authorized adb device.'
        } else {
            Add-Check `
                -Id 'device.emulator' `
                -Name 'Emulator ADB status' `
                -Status 'BLOCKED' `
                -Required $true `
                -Observed 'No running authorized emulator is currently visible to ADB.' `
                -Expected 'A running emulator appears as an authorized adb device.' `
                -NextSteps @(
                    'Start the approved pinned emulator from Android Studio or the approved emulator procedure.',
                    'Rerun this preflight after the emulator reaches the home screen.'
                )
        }
    }
} else {
    Add-Check `
        -Id 'android.emulator' `
        -Name 'Android Emulator tool' `
        -Status 'SKIPPED' `
        -Required $false `
        -Observed 'Skipped because target mode is physical.' `
        -Expected 'Not evaluated.'
    Add-Check `
        -Id 'device.emulator' `
        -Name 'Emulator ADB status' `
        -Status 'SKIPPED' `
        -Required $false `
        -Observed 'Skipped because target mode is physical.' `
        -Expected 'Not evaluated.'
}

if ($PrepareSdk) {
    if (-not $sdkManagerPath) {
        Add-Check `
            -Id 'prepare.sdk' `
            -Name 'Optional SDK preparation' `
            -Status 'BLOCKED' `
            -Required $false `
            -Observed 'Cannot prepare packages because sdkmanager.bat is unavailable.' `
            -Expected 'Official Android SDK Command-line Tools are installed.' `
            -NextSteps @('Install the official command-line tools, then rerun with -PrepareSdk.')
    } else {
        $packages = @('platform-tools', 'platforms;android-35', 'build-tools;35.0.0')
        if ($Target -eq 'emulator' -or $Target -eq 'both') {
            $packages += @(
                'emulator',
                'system-images;android-35;google_apis;x86_64'
            )
        }

        $approved = $false
        if ($ConfirmSdkInstall) {
            $approved = $true
        } else {
            Write-Host ''
            Write-Host 'The next command will install or update only these Android SDK packages:' -ForegroundColor Yellow
            $packages | ForEach-Object { Write-Host ('  - {0}' -f $_) }
            Write-Host 'It will not install an APK, change Device Owner state, reboot a device, or send messages.'
            $answer = Read-Host 'Type INSTALL to continue, or press Enter to cancel'
            $approved = ($answer -ceq 'INSTALL')
        }

        if (-not $approved) {
            $script:Actions += 'SDK preparation was offered but not approved; no SDK packages were changed.'
            Add-Check `
                -Id 'prepare.sdk' `
                -Name 'Optional SDK preparation' `
                -Status 'WARN' `
                -Required $false `
                -Observed 'Skipped because explicit confirmation was not provided.' `
                -Expected 'No installation occurs without an explicit INSTALL confirmation.' `
                -NextSteps @('Rerun with -PrepareSdk and type INSTALL if the approved SDK packages need to be prepared.')
        } else {
            try {
                $script:Actions += 'SDK preparation was explicitly approved by the operator.'
                $sdkResult = Invoke-Tool -Path $sdkManagerPath -Arguments (@("--sdk_root=$sdkRoot") + $packages)
                if ($sdkResult.succeeded) {
                    $script:Actions += 'sdkmanager completed for the approved package list.'
                    Add-Check `
                        -Id 'prepare.sdk' `
                        -Name 'Optional SDK preparation' `
                        -Status 'PASS' `
                        -Required $false `
                        -Observed ('sdkmanager completed for: {0}' -f ($packages -join ', ')) `
                        -Expected 'Only explicitly approved SDK packages are installed or updated.'
                } else {
                    $script:Actions += 'sdkmanager returned a failure; no device action was attempted.'
                    Add-Check `
                        -Id 'prepare.sdk' `
                        -Name 'Optional SDK preparation' `
                        -Status 'WARN' `
                        -Required $false `
                        -Observed ('sdkmanager failed with exit code {0}: {1}' -f $sdkResult.exitCode, $sdkResult.output) `
                        -Expected 'Only explicitly approved SDK packages are installed or updated.' `
                        -NextSteps @('Review the sdkmanager message, fix permissions or network access, and rerun the preflight.')
                }
            } catch {
                Add-Check `
                    -Id 'prepare.sdk' `
                    -Name 'Optional SDK preparation' `
                    -Status 'WARN' `
                    -Required $false `
                    -Observed $_.Exception.Message `
                    -Expected 'Only explicitly approved SDK packages are installed or updated.' `
                    -NextSteps @('Review the SDK installation permissions and rerun the preflight.')
            }
        }
    }
}

$overallStatus = Get-OverallStatus
$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$outputPath = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputPath | Out-Null
$jsonPath = Join-Path $outputPath ('cas-windows-preflight-{0}.json' -f $timestamp)
$markdownPath = Join-Path $outputPath ('cas-windows-preflight-{0}.md' -f $timestamp)

$result = [ordered]@{
    schemaVersion = 'cas-windows-preflight-v1'
    generatedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    overallStatus = $overallStatus
    targetMode = $Target
    host = [ordered]@{
        computerName = $env:COMPUTERNAME
        operatingSystem = $env:OS
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        powershellEdition = $PSVersionTable.PSEdition
    }
    contract = [ordered]@{
        java = 'JDK 17 or newer'
        androidSdk = 'Android SDK with API 35'
        platformTools = 'Android platform-tools with adb'
        buildTools = 'Android build-tools 35.0.0 or newer'
        gradle = 'Gradle 8.9 or newer'
        environment = 'JAVA_HOME plus ANDROID_SDK_ROOT or ANDROID_HOME; Java and platform-tools on PATH'
    }
    checks = @($script:Checks)
    actions = @($script:Actions)
    safety = [ordered]@{
        deviceActionsPerformed = $false
        apkInstalled = $false
        deviceOwnerChanged = $false
        deviceRebooted = $false
        messagesSent = $false
        evidenceCaptured = $false
    }
    attachments = @(
        [System.IO.Path]::GetFileName($jsonPath),
        [System.IO.Path]::GetFileName($markdownPath)
    )
}

$result | ConvertTo-Json -Depth 10 | Set-Content -Path $jsonPath -Encoding UTF8

$markdown = @(
    '# CAS Pixel Gate 0A Windows preflight',
    '',
    ('- **Overall status:** `{0}`' -f $overallStatus),
    ('- **Generated (UTC):** `{0}`' -f $result.generatedAtUtc),
    ('- **Target mode:** `{0}`' -f $Target),
    ('- **Computer:** `{0}`' -f $env:COMPUTERNAME),
    '',
    '## Checks',
    '',
    '| Status | Required | Check | Observed | Expected |',
    '| --- | --- | --- | --- | --- |'
)
foreach ($check in $script:Checks) {
    $markdown += ('| {0} | {1} | {2} | {3} | {4} |' -f `
        (Convert-ToMarkdownCell $check.status), `
        (Convert-ToMarkdownCell $check.required), `
        (Convert-ToMarkdownCell $check.name), `
        (Convert-ToMarkdownCell $check.observed), `
        (Convert-ToMarkdownCell $check.expected))
    if (@($check.nextSteps).Count -gt 0) {
        foreach ($step in $check.nextSteps) {
            $markdown += ('|  |  | Next step | {0} |  |' -f (Convert-ToMarkdownCell $step))
        }
    }
}
$markdown += @(
    '',
    '## Safety record',
    '',
    '- This preflight does not install an APK, change Device Owner state, reboot a device, send a message, or capture evidence.',
    ('- Device actions performed: `{0}`' -f $result.safety.deviceActionsPerformed),
    ('- SDK preparation actions: `{0}`' -f ($(if ($script:Actions.Count -gt 0) { $script:Actions -join ' ' } else { 'None' }))),
    '',
    '## Attachments',
    '',
    'Attach this Markdown file and the matching JSON file to the CAS field-run record. A `BLOCKED` result means the Gate 0A run must not continue. A `WARN` result requires the operator to resolve or document the warning before the field run.'
)
$markdown | Set-Content -Path $markdownPath -Encoding UTF8

Write-Host ''
Write-Host ('Overall status: {0}' -f $overallStatus) -ForegroundColor $(switch ($overallStatus) {
    'PASS' { 'Green' }
    'WARN' { 'Yellow' }
    default { 'Red' }
})
Write-Host ('JSON result: {0}' -f $jsonPath)
Write-Host ('Markdown result: {0}' -f $markdownPath)
Write-Host 'Attach both files to the CAS field-run record.'

if ($overallStatus -eq 'BLOCKED') {
    exit 2
}
if ($overallStatus -eq 'WARN') {
    exit 1
}
exit 0