# Annalo: reads the appointments of the default calendar of Outlook Classic through its COM
# object model and writes them as one line of JSON to standard output. Only ASCII is written
# (other characters as \uXXXX), so the console code page does not matter. The file itself is
# ASCII too: Windows PowerShell reads scripts without a byte order mark as ANSI.
#
# Errors are reported as {"ok":false,"error":"<code>","message":"..."}; Annalo shows its own text.
# Private appointments keep only their time unless -Private is given; the text of an
# appointment is only read for -Body (kept) or -Links (only web addresses are passed on).

param(
    [Parameter(Mandatory = $true)][string]$From,   # local time, yyyy-MM-ddTHH:mm:ss
    [Parameter(Mandatory = $true)][string]$To,
    [string]$FilterFrom = '',                      # the same in the user's short date/time format (Restrict)
    [string]$FilterTo = '',
    [switch]$Private,
    [switch]$Body,
    [switch]$Links
)

$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture

function Write-Json($obj) {
    $json = ConvertTo-Json -InputObject $obj -Depth 6 -Compress
    $ascii = [regex]::Replace($json, '[^\x00-\x7E]', { param($m) '\u{0:x4}' -f [int][char]$m.Value })
    [Console]::Out.Write($ascii)
}

function Fail($code, $message) {
    Write-Json ([ordered]@{ ok = $false; error = $code; message = [string]$message })
    exit 0
}

trap {
    Fail 'script' $_.Exception.Message
}

if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
    Fail 'constrained' $ExecutionContext.SessionState.LanguageMode
}

$start = [datetime]::ParseExact($From, 'yyyy-MM-ddTHH:mm:ss', $inv)
$end = [datetime]::ParseExact($To, 'yyyy-MM-ddTHH:mm:ss', $inv)

try {
    $outlook = New-Object -ComObject Outlook.Application
} catch {
    $hr = $_.Exception.HResult
    if ($_.Exception.InnerException) { $hr = $_.Exception.InnerException.HResult }
    $newOutlook = Get-Process -Name 'olk' -ErrorAction SilentlyContinue
    if ($hr -eq -2147221164) {
        if ($newOutlook) { Fail 'new_outlook' $_.Exception.Message }
        Fail 'not_installed' $_.Exception.Message
    }
    if ($hr -eq -2146959355) { Fail 'server_exec' $_.Exception.Message }
    Fail 'com' $_.Exception.Message
}

try {
    $ns = $outlook.GetNamespace('MAPI')
    $folder = $ns.GetDefaultFolder(9)
    $items = $folder.Items
    $items.Sort('[Start]')
    $items.IncludeRecurrences = $true
} catch {
    Fail 'folder' $_.Exception.Message
}

$version = ''
try { $version = [string]$outlook.Version } catch { }

$list = New-Object System.Collections.ArrayList
$teamsUrl = 'http://schemas.microsoft.com/mapi/string/{00020329-0000-0000-C000-000000000046}/SkypeTeamsMeetingUrl'

function Add-Appointment($it) {
    if ($it.Class -ne 26) { return }
    $sensitivity = [int]$it.Sensitivity
    $hidden = (($sensitivity -eq 2) -or ($sensitivity -eq 3)) -and -not $Private
    $o = [ordered]@{
        entryId        = [string]$it.EntryID
        globalId       = ''
        subject        = ''
        start          = $it.StartUTC.ToString('yyyy-MM-ddTHH:mm:ss', $inv) + 'Z'
        end            = $it.EndUTC.ToString('yyyy-MM-ddTHH:mm:ss', $inv) + 'Z'
        startLocal     = $it.Start.ToString('yyyy-MM-ddTHH:mm:ss', $inv)
        endLocal       = $it.End.ToString('yyyy-MM-ddTHH:mm:ss', $inv)
        allDay         = [bool]$it.AllDayEvent
        recurring      = [bool]$it.IsRecurring
        busy           = [int]$it.BusyStatus
        sensitivity    = $sensitivity
        responseStatus = [int]$it.ResponseStatus
        meetingStatus  = [int]$it.MeetingStatus
        location       = ''
        organizer      = ''
        attendees      = @()
        categories     = ''
        body           = $null
        urls           = @()
    }
    try { $o.globalId = [string]$it.GlobalAppointmentID } catch { }
    if (-not $hidden) {
        $o.subject = [string]$it.Subject
        $o.location = [string]$it.Location
        $o.categories = [string]$it.Categories
        try { $o.organizer = [string]$it.Organizer } catch { }
        try {
            $names = New-Object System.Collections.ArrayList
            foreach ($a in (([string]$it.RequiredAttendees) + ';' + ([string]$it.OptionalAttendees)).Split(';')) {
                $n = $a.Trim()
                if ($n -and -not $names.Contains($n)) { [void]$names.Add($n) }
            }
            $o.attendees = @($names)
        } catch { }
        if ($Body -or $Links) {
            $text = ''
            try { $text = [string]$it.Body } catch { }
            if ($Body -and $text) {
                if ($text.Length -gt 20000) { $text = $text.Substring(0, 20000) }
                $o.body = $text
            }
            if ($Links) {
                $urls = New-Object System.Collections.ArrayList
                try {
                    $t = [string]$it.PropertyAccessor.GetProperty($teamsUrl)
                    if ($t) { [void]$urls.Add($t) }
                } catch { }
                foreach ($m in [regex]::Matches(([string]$o.location) + ' ' + $text, 'https://[^\s<>"]+')) {
                    if ($urls.Count -ge 20) { break }
                    [void]$urls.Add($m.Value)
                }
                $o.urls = @($urls)
            }
        }
    }
    [void]$list.Add($o)
}

# Restrict with the dates in the user's format (Outlook parses them per the regional
# settings); every item is checked against the real range again.
if (-not $FilterFrom) { $FilterFrom = $start.ToString('g') }
if (-not $FilterTo) { $FilterTo = $end.ToString('g') }
$restricted = $null
try {
    $restricted = $items.Restrict("[Start] < '" + $FilterTo + "' AND [End] > '" + $FilterFrom + "'")
} catch {
    $restricted = $null
}
$mode = 'restrict'
$skipped = 0
if ($restricted) {
    $n = 0
    $it = $restricted.GetFirst()
    while ($it -ne $null -and $n -lt 20000) {
        $n++
        try { if ($it.Start -lt $end -and $it.End -gt $start) { Add-Appointment $it } } catch { $skipped++ }
        $it = $restricted.GetNext()
    }
}
# Nothing found (or Restrict refused the dates): walk the sorted items instead.
if ($list.Count -eq 0) {
    $mode = 'scan'
    $n = 0
    $it = $items.GetFirst()
    while ($it -ne $null -and $n -lt 50000) {
        $n++
        if ($it.Start -ge $end) { break }
        try { if ($it.End -gt $start) { Add-Appointment $it } } catch { $skipped++ }
        $it = $items.GetNext()
    }
}

Write-Json ([ordered]@{ ok = $true; version = $version; mode = $mode; skipped = $skipped; items = @($list) })
