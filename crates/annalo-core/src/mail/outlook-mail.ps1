# Arcalo: e-mails from Outlook Classic through its COM object model, as one line of JSON on
# standard output. Only ASCII is written (other characters as \uXXXX), so the console code page
# does not matter. The file itself is ASCII too: Windows PowerShell reads scripts without a byte
# order mark as ANSI.
#
#   -Mode read   the mails selected in the Outlook window in front (explorer selection), or the
#                mail open in the inspector in front: ids, subject, sender, recipients, time,
#                importance, categories, the text (plain, cut at -MaxBody characters) and the
#                names and sizes of the attachments (nothing is saved).
#   -Mode save   saves the attachments -Indexes (1-based, "1,3") of one mail into -Dir\<index>\.
#   -Mode open   shows one mail (Namespace.GetItemFromID) in its own Outlook window.
#   -Mode flagged  the flagged mails of the To-Do list (all folders; the inbox when the To-Do
#                folder cannot be read), the earliest due first, at most -MaxItems: what "read"
#                returns per mail (text cut at -MaxBody) plus flagDue (yyyy-MM-dd) and flagRequest.
#
# Outlook is never started for "read": an Outlook that is not running has nothing selected.
# Errors are reported as {"ok":false,"error":"<code>","message":"..."}; Arcalo shows its own text.

param(
    [ValidateSet('read', 'save', 'open', 'flagged')][string]$Mode = 'read',
    [string]$EntryId = '',
    [string]$StoreId = '',
    [string]$Indexes = '',
    [string]$Dir = '',
    [int]$MaxItems = 20,
    [int]$MaxBody = 20000
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

# The running Outlook; "open" and "save" may start it (the mail is stored in the profile).
$outlook = $null
try {
    $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
} catch {
    $outlook = $null
}
if (-not $outlook) {
    $classic = Get-Process -Name 'OUTLOOK' -ErrorAction SilentlyContinue
    $newOutlook = Get-Process -Name 'olk' -ErrorAction SilentlyContinue
    $registered = [Type]::GetTypeFromProgID('Outlook.Application')
    if (-not $registered) {
        if ($newOutlook) { Fail 'new_outlook' 'olk' }
        Fail 'not_installed' 'Outlook.Application'
    }
    if (-not $classic -and ($Mode -eq 'read' -or $Mode -eq 'flagged')) {
        if ($newOutlook) { Fail 'new_outlook' 'olk' }
        Fail 'not_running' 'OUTLOOK'
    }
    try {
        $outlook = New-Object -ComObject Outlook.Application
    } catch {
        $hr = $_.Exception.HResult
        if ($_.Exception.InnerException) { $hr = $_.Exception.InnerException.HResult }
        if ($hr -eq -2147221164) { Fail 'not_installed' $_.Exception.Message }
        if ($hr -eq -2146959355) { Fail 'server_exec' $_.Exception.Message }
        Fail 'com' $_.Exception.Message
    }
}

$ns = $null
try { $ns = $outlook.GetNamespace('MAPI') } catch { Fail 'com' $_.Exception.Message }

$smtpTag = 'http://schemas.microsoft.com/mapi/proptag/0x5D01001F'
$cidTag = 'http://schemas.microsoft.com/mapi/proptag/0x3712001F'
$hiddenTag = 'http://schemas.microsoft.com/mapi/proptag/0x7FFE000B'

function Get-Item-ById($id, $store) {
    try {
        if ($store) { return $ns.GetItemFromID($id, $store) }
        return $ns.GetItemFromID($id)
    } catch {
        try { return $ns.GetItemFromID($id) } catch { Fail 'not_found' $_.Exception.Message }
    }
}

# The SMTP address of the sender; Exchange senders have an X.500 address in SenderEmailAddress.
function Get-Sender-Smtp($m) {
    $address = ''
    try { $address = [string]$m.SenderEmailAddress } catch { }
    $type = ''
    try { $type = [string]$m.SenderEmailType } catch { }
    if ($type -eq 'EX' -or $address.StartsWith('/')) {
        try {
            $user = $m.Sender.GetExchangeUser()
            if ($user -and $user.PrimarySmtpAddress) { return [string]$user.PrimarySmtpAddress }
        } catch { }
        try {
            $smtp = [string]$m.PropertyAccessor.GetProperty($smtpTag)
            if ($smtp) { return $smtp }
        } catch { }
    }
    return $address
}

function Read-Mail($m) {
    $o = [ordered]@{
        entryId      = [string]$m.EntryID
        storeId      = ''
        subject      = [string]$m.Subject
        senderName   = ''
        senderEmail  = ''
        to           = ''
        cc           = ''
        received     = ''
        conversation = ''
        importance   = 1
        categories   = ''
        body         = ''
        truncated    = $false
        attachments  = @()
    }
    try { $o.storeId = [string]$m.Parent.StoreID } catch { }
    try { $o.senderName = [string]$m.SenderName } catch { }
    try { $o.senderEmail = Get-Sender-Smtp $m } catch { }
    try { $o.to = [string]$m.To } catch { }
    try { $o.cc = [string]$m.CC } catch { }
    try { $o.received = $m.ReceivedTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss', $inv) + 'Z' } catch { }
    try { $o.conversation = [string]$m.ConversationTopic } catch { }
    try { $o.importance = [int]$m.Importance } catch { }
    try { $o.categories = [string]$m.Categories } catch { }
    try {
        $text = [string]$m.Body
        if ($text.Length -gt $MaxBody) {
            $text = $text.Substring(0, $MaxBody)
            $o.truncated = $true
        }
        $o.body = $text
    } catch { }
    $list = New-Object System.Collections.ArrayList
    try {
        $n = $m.Attachments.Count
        for ($i = 1; $i -le $n; $i++) {
            $a = $m.Attachments.Item($i)
            $inline = $false
            try { if ([string]$a.PropertyAccessor.GetProperty($cidTag)) { $inline = $true } } catch { }
            try { if ([bool]$a.PropertyAccessor.GetProperty($hiddenTag)) { $inline = $true } } catch { }
            $name = ''
            try { $name = [string]$a.FileName } catch { }
            if (-not $name) { try { $name = [string]$a.DisplayName } catch { } }
            [void]$list.Add([ordered]@{ index = $i; name = $name; size = [int64]$a.Size; type = [int]$a.Type; inline = $inline })
        }
    } catch { }
    $o.attachments = @($list)
    return $o
}

function Is-Mail($it) {
    try { $c = [int]$it.Class } catch { return $false }
    # olMail, olMeetingRequest .. olMeetingTentative, olReport (43, 53-57, 46)
    return ($c -eq 43) -or ($c -ge 53 -and $c -le 57) -or ($c -eq 46)
}

if ($Mode -eq 'flagged') {
    $folder = $null
    try { $folder = $ns.GetDefaultFolder(28) } catch { $folder = $null }
    if (-not $folder) {
        try { $folder = $ns.GetDefaultFolder(6) } catch { Fail 'com' $_.Exception.Message }
    }
    $found = New-Object System.Collections.ArrayList
    try {
        $items = $folder.Items.Restrict('[FlagStatus] = 2')
        foreach ($it in $items) {
            try { if ([int]$it.Class -ne 43) { continue } } catch { continue }
            $o = Read-Mail $it
            $o.flagDue = ''
            $o.flagRequest = ''
            try {
                $due = $it.TaskDueDate
                if ($due.Year -lt 4000) { $o.flagDue = $due.ToString('yyyy-MM-dd', $inv) }
            } catch { }
            try { $o.flagRequest = [string]$it.FlagRequest } catch { }
            [void]$found.Add($o)
            if ($found.Count -ge 200) { break }
        }
    } catch { Fail 'com' $_.Exception.Message }
    $sorted = @($found | Sort-Object @{ Expression = { if ($_.flagDue) { $_.flagDue } else { '9999' } } }, @{ Expression = { $_.received }; Descending = $true })
    Write-Json ([ordered]@{ ok = $true; version = [string]$outlook.Version; items = @($sorted | Select-Object -First $MaxItems) })
    exit 0
}

if ($Mode -eq 'open') {
    $item = Get-Item-ById $EntryId $StoreId
    try {
        $item.Display($false)
        try { $item.GetInspector.Activate() } catch { }
    } catch {
        Fail 'com' $_.Exception.Message
    }
    Write-Json ([ordered]@{ ok = $true })
    exit 0
}

if ($Mode -eq 'save') {
    $item = Get-Item-ById $EntryId $StoreId
    $files = New-Object System.Collections.ArrayList
    foreach ($part in $Indexes.Split(',')) {
        $i = 0
        if (-not [int]::TryParse($part.Trim(), [ref]$i)) { continue }
        if ($i -lt 1 -or $i -gt $item.Attachments.Count) { continue }
        $a = $item.Attachments.Item($i)
        $name = [string]$a.FileName
        if (-not $name) { $name = 'Anhang' + $i }
        foreach ($c in [IO.Path]::GetInvalidFileNameChars()) { $name = $name.Replace([string]$c, '-') }
        $folder = Join-Path $Dir ([string]$i)
        [void](New-Item -ItemType Directory -Force -Path $folder)
        $path = Join-Path $folder $name
        try {
            $a.SaveAsFile($path)
            [void]$files.Add([ordered]@{ index = $i; name = $name; path = $path })
        } catch {
            Fail 'save' ($name + ': ' + $_.Exception.Message)
        }
    }
    Write-Json ([ordered]@{ ok = $true; files = @($files) })
    exit 0
}

# read: the window in front decides (an open mail, or the selection of the main window).
$mails = New-Object System.Collections.ArrayList
$window = $null
try { $window = $outlook.ActiveWindow() } catch { }
$source = 'selection'
$inspector = $null
if ($window) {
    try { if ([int]$window.Class -eq 35) { $inspector = $window } } catch { }
}
if (-not $inspector -and -not $outlook.ActiveExplorer()) {
    try { $inspector = $outlook.ActiveInspector() } catch { }
}
if ($inspector) {
    $source = 'inspector'
    try {
        $it = $inspector.CurrentItem
        if (Is-Mail $it) { [void]$mails.Add((Read-Mail $it)) }
    } catch { }
} else {
    try {
        $sel = $outlook.ActiveExplorer().Selection
        $n = [Math]::Min($sel.Count, $MaxItems)
        for ($i = 1; $i -le $n; $i++) {
            $it = $sel.Item($i)
            if (Is-Mail $it) { [void]$mails.Add((Read-Mail $it)) }
        }
    } catch { }
}
if ($mails.Count -eq 0) { Fail 'no_selection' $source }

$version = ''
try { $version = [string]$outlook.Version } catch { }
Write-Json ([ordered]@{ ok = $true; version = $version; source = $source; items = @($mails) })
