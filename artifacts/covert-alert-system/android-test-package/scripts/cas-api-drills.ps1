#Requires -Version 5.1
<#
.SYNOPSIS
  CAS console API drills for the Windows handoff operator.

.DESCRIPTION
  Drives the CAS alert API without the phone: trigger incidents, watch outbox
  state, simulate handset receipts, re-queue dead letters, and read the dev
  provider inbox (what the XMPP/email providers received). Dot-source this
  file, then call the functions. See HANDOFF-TEST-KIT.md for the full matrix.

.EXAMPLE
  . .\scripts\cas-api-drills.ps1 -BaseUrl https://your-host.replit.dev -DeviceToken <handset-token> -AlertToken <alert-credential>
  Invoke-CasTrigger
  Get-CasOutboxStatus
#>
param(
  [Parameter(Mandatory = $true)]
  [string]$BaseUrl,
  # Shared handset credential (the server's CAS_DEVICE_TOKEN secret). The
  # device pickup/receipt endpoints refuse calls without it (401).
  [string]$DeviceToken,
  # Alert credential (the server's CAS_ALERT_TOKEN secret), sent as
  # Authorization: Bearer. The trigger, ack/resolve, and re-queue endpoints
  # refuse calls without it (401).
  [string]$AlertToken
)

# Script-relative/pipeline state is resolved after parameter binding, never
# inside the param block (Windows PowerShell evaluates defaults too early).
$script:CasBase = $BaseUrl.TrimEnd('/') + '/api'
$script:DeviceToken = $DeviceToken
$script:AlertToken = $AlertToken

function Invoke-CasApi {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Path,
    [object]$Body
  )
  $args = @{
    Method      = $Method
    Uri         = $script:CasBase + $Path
    ContentType = 'application/json'
  }
  $headers = @{}
  if ($script:DeviceToken) { $headers['X-CAS-Device-Token'] = $script:DeviceToken }
  if ($script:AlertToken) { $headers['Authorization'] = "Bearer $script:AlertToken" }
  if ($headers.Count -gt 0) { $args.Headers = $headers }
  if ($null -ne $Body) { $args.Body = ($Body | ConvertTo-Json -Depth 8) }
  try {
    return Invoke-RestMethod @args
  } catch {
    $response = $_.Exception.Response
    if ($null -ne $response) {
      $reader = New-Object System.IO.StreamReader($response.GetResponseStream())
      $text = $reader.ReadToEnd()
      Write-Warning ("CAS API {0} {1} -> HTTP {2}: {3}" -f $Method, $Path, [int]$response.StatusCode, $text)
    } else {
      Write-Warning ("CAS API {0} {1} failed: {2}" -f $Method, $Path, $_.Exception.Message)
    }
    throw
  }
}

function Invoke-CasTrigger {
  # Creates a P1 incident (or folds into the active one) and returns it.
  Invoke-CasApi -Method POST -Path '/cas/incidents/trigger'
}

function Get-CasOutboxStatus {
  # Pipeline health: counts by state, delivery mode, device channels, worker heartbeat.
  Invoke-CasApi -Method GET -Path '/cas/outbox/status'
}

function Get-CasDevicePending {
  # Items waiting for the handset (device channels only).
  (Invoke-CasApi -Method GET -Path '/cas/outbox/device-pending').items
}

function Get-CasActiveIncident {
  # The active incident with events and outbox items, or $null.
  (Invoke-CasApi -Method GET -Path '/cas/state').activeIncident
}

function Send-CasDeviceReceipt {
  # Simulates the handset reporting a delivery outcome for an incident.
  param(
    [Parameter(Mandatory = $true)][string]$IncidentId,
    [ValidateSet('SMS', 'WHATSAPP')][string]$Channel = 'SMS',
    [Parameter(Mandatory = $true)][string]$Recipient,
    [bool]$Ok = $true,
    [string]$ErrorText
  )
  $result = @{ recipient = $Recipient; ok = $Ok }
  if (-not $Ok -and $ErrorText) { $result.error = $ErrorText }
  Invoke-CasApi -Method POST -Path "/cas/incidents/$IncidentId/device-receipt" `
    -Body @{ channel = $Channel; results = @($result) }
}

function Invoke-CasRequeue {
  # Re-queues a dead-lettered outbox item, e.g. '<incidentId>-sms'.
  param(
    [Parameter(Mandatory = $true)][string]$OutboxItemId,
    [string]$Note
  )
  $body = @{}
  if ($Note) { $body.note = $Note }
  Invoke-CasApi -Method POST -Path "/cas/outbox/$OutboxItemId/requeue" -Body $body
}

function Resolve-CasIncident {
  param([Parameter(Mandatory = $true)][string]$IncidentId)
  Invoke-CasApi -Method POST -Path "/cas/incidents/$IncidentId/ack" | Out-Null
  Invoke-CasApi -Method POST -Path "/cas/incidents/$IncidentId/resolve"
}

function Get-CasProviderInbox {
  # What the dev provider sink received (proves XMPP/email delivery in dev).
  (Invoke-CasApi -Method GET -Path '/cas/dev/provider-inbox').deliveries
}

function Clear-CasProviderInbox {
  Invoke-CasApi -Method DELETE -Path '/cas/dev/provider-inbox' | Out-Null
}

function Watch-CasOutbox {
  # Polls an incident's outbox until every item is terminal or time runs out.
  param(
    [Parameter(Mandatory = $true)][string]$IncidentId,
    [int]$TimeoutSeconds = 30
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $incident = Get-CasActiveIncident
    if ($null -eq $incident -or $incident.id -ne $IncidentId) {
      Write-Host "incident $IncidentId is no longer active"
      return $incident
    }
    $pending = @($incident.outbox | Where-Object { -not $_.terminal })
    $incident.outbox | ForEach-Object { Write-Host ("  {0}: {1} (attempts {2})" -f $_.transport, $_.state, $_.attempts) }
    if ($pending.Count -eq 0) { return $incident }
    Start-Sleep -Seconds 3
    Write-Host '---'
  }
  Write-Warning "timed out after ${TimeoutSeconds}s with items still pending"
  return $incident
}

Write-Host "CAS drills loaded. API base: $script:CasBase"
Write-Host 'Functions: Invoke-CasTrigger, Get-CasOutboxStatus, Get-CasDevicePending, Get-CasActiveIncident,'
Write-Host '  Send-CasDeviceReceipt, Invoke-CasRequeue, Resolve-CasIncident, Get-CasProviderInbox,'
Write-Host '  Clear-CasProviderInbox, Watch-CasOutbox'
