# Arcalo: reads calendars of Outlook Classic through its COM object model and writes the result
# as one line of JSON to standard output. Only ASCII is written (other characters as \uXXXX), so
# the console code page does not matter. The file itself is ASCII too: Windows PowerShell reads
# scripts without a byte order mark as ANSI.
#
# -Mode read (default): the appointments of the default calendar, or with -Calendars (a JSON
#   file: [{id, default, entryId, storeId, recipient}]) of every listed calendar, each with its
#   own result ({id, ok, items} or {id, ok:false, error, message}); one calendar that cannot be
#   read never fails the others. A colleague's calendar shared as free/busy only is read through
#   Recipient.FreeBusy (times and status, no subjects) and marked freeBusy.
# -Mode discover: every calendar folder: the default calendar and the other calendar folders of
#   every store (own mailbox, further mailboxes and shared mailboxes in the profile, PST files),
#   the calendars in the navigation pane (shared calendars of colleagues, rooms, groups) and the
#   default calendars of the people listed in -Recipients (a JSON file of names or addresses).
# -Mode write: the appointments of Arcalo's focus blocks in the default calendar, from -Ops (a
#   JSON file: [{id, op: upsert|delete, entryId, subject, start, end, category}], local times):
#   busy, no reminder, the category; one result per write ({id, ok, entryId, globalId}). Only an
#   Outlook that already runs is used, it is never started: {"ok":false,"error":"not_running"}.
#   Ops with kind 'entry' are appointments created, changed or deleted in Arcalo's Kalender
#   ({id, kind, op: create|update|delete|restore, marker, entryId, deletedId, calendar: {default,
#   entryId, storeId}, fields, seen, send}): only the fields given are written; a field changed
#   in Outlook since Arcalo saw it (seen) answers {ok:false, error:'conflict', current}; series and
#   received meetings are refused; an organized meeting with attendees is changed only with send
#   (the update then goes to them) and never deleted here; a delete moves the item to Deleted
#   Items (deletedId), a restore moves it back. Results add {modified, deletedId}.
# -Mode show: opens the appointment -EntryId (of the store -StoreId, when given) in an Outlook
#   window (In Outlook oeffnen).
#
# Errors are reported as {"ok":false,"error":"<code>","message":"..."}; Arcalo shows its own text.
# Private appointments keep only their time unless -Private is given; the text of an
# appointment is only read for -Body (kept) or -Links (only web addresses are passed on).

param(
    [string]$From = '',                            # local time, yyyy-MM-ddTHH:mm:ss
    [string]$To = '',
    [string]$FilterFrom = '',                      # the same in the user's short date/time format (Restrict)
    [string]$FilterTo = '',
    [switch]$Private,
    [switch]$Body,
    [switch]$Links,
    [string]$Mode = 'read',
    [string]$Calendars = '',
    [string]$Recipients = '',
    [string]$Ops = '',
    [string]$EntryId = '',
    [string]$StoreId = ''
)

$ErrorActionPreference = 'Stop'
$inv = [Globalization.CultureInfo]::InvariantCulture

function Write-Json($obj) {
    $json = ConvertTo-Json -InputObject $obj -Depth 8 -Compress
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

# A JSON array from a file, as a list (Windows PowerShell 5 does not enumerate ConvertFrom-Json arrays).
function Read-JsonFile($path) {
    $list = New-Object System.Collections.ArrayList
    if ($path) {
        $v = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($path, [Text.Encoding]::UTF8))
        foreach ($x in $v) { [void]$list.Add($x) }
    }
    return ,$list
}

# ---------------------------------------------------------------- write

if ($Mode -eq 'write') {
    if (-not (Get-Process -Name 'OUTLOOK' -ErrorAction SilentlyContinue)) {
        if (Get-Process -Name 'olk' -ErrorAction SilentlyContinue) { Fail 'new_outlook' '' }
        Fail 'not_running' ''
    }
    try {
        $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application')
    } catch {
        Fail 'not_running' $_.Exception.Message
    }
    try {
        $ns = $outlook.GetNamespace('MAPI')
        $calendar = $ns.GetDefaultFolder(9)
    } catch {
        Fail 'folder' $_.Exception.Message
    }
    # The appointment of a block by its marker (user property ArcaloBlock), or $null.
    function Find-Marked($marker) {
        if (-not $marker) { return $null }
        try { return $calendar.Items.Find("[ArcaloBlock] = '" + ([string]$marker).Replace("'", "''") + "'") } catch { return $null }
    }
    $fmt = 'yyyy-MM-ddTHH:mm:ss'
    # The calendar of an appointment written from the Kalender: the default one or another own one.
    function Get-EntryCalendar($c) {
        if (-not $c -or $c.default) { return $calendar }
        return $ns.GetFolderFromID([string]$c.entryId, [string]$c.storeId)
    }
    # An item by its EntryID in the store of $folder (an own calendar in a PST file or a second
    # mailbox is not always found without it), else in the default store.
    function Get-ItemById($id, $folder) {
        $item = $null
        try { $item = $ns.GetItemFromID([string]$id, [string]$folder.StoreID) } catch { $item = $null }
        if (-not $item) { try { $item = $ns.GetItemFromID([string]$id) } catch { $item = $null } }
        return $item
    }
    # The appointment by its EntryID (still in that calendar), else by its marker (ArcaloEntry).
    function Find-Entry($folder, $o) {
        $item = $null
        if ($o.entryId) {
            $item = Get-ItemById $o.entryId $folder
            try { if ($item -and $item.Parent.EntryID -ne $folder.EntryID) { $item = $null } } catch { $item = $null }
        }
        if (-not $item -and $o.marker) {
            try { $item = $folder.Items.Find("[ArcaloEntry] = '" + ([string]$o.marker).Replace("'", "''") + "'") } catch { $item = $null }
        }
        return $item
    }
    # People invited besides the organizer (recipient type 0 is the organizer).
    function Count-Invited($item) {
        $n = 0
        try { foreach ($r in $item.Recipients) { if ([int]$r.Type -ne 0) { $n++ } } } catch { }
        return $n
    }
    function Get-Values($item) {
        return @{ subject = [string]$item.Subject; start = $item.Start.ToString($fmt, $inv); end = $item.End.ToString($fmt, $inv); location = [string]$item.Location }
    }
    # Only the fields given (a title Arcalo never had, a text it never read stay as they are). A
    # new Start alone keeps the End (Outlook would move it along to keep the length).
    function Set-Fields($item, $f) {
        if ($null -eq $f) { return }
        if ($null -ne $f.subject) { $item.Subject = [string]$f.subject }
        $end = $null
        if ($null -ne $f.end) { $end = [datetime]::ParseExact([string]$f.end, $fmt, $inv) }
        elseif ($null -ne $f.start) { $end = $item.End }
        if ($null -ne $f.start) { $item.Start = [datetime]::ParseExact([string]$f.start, $fmt, $inv) }
        if ($null -ne $end) { $item.End = $end }
        if ($null -ne $f.location) { $item.Location = [string]$f.location }
    }
    function Write-Entry($o) {
        $res = [ordered]@{ id = [string]$o.id; ok = $true; entryId = ''; globalId = ''; modified = ''; deletedId = '' }
        $folder = Get-EntryCalendar $o.calendar
        $f = $o.fields
        if ($o.op -eq 'restore') {
            $item = Get-ItemById $o.deletedId $folder
            if (-not $item) { $res.ok = $false; $res.error = 'not_found'; return $res }
            # Moved back already by a try whose answer got lost (an EntryID that stays on a move).
            $back = $false
            try { $back = $item.Parent.EntryID -eq $folder.EntryID } catch { }
            if (-not $back) { $item = $item.Move($folder) }
            Set-Fields $item $f
            $item.Save()
        } else {
            $item = Find-Entry $folder $o
            if ($o.op -eq 'create') {
                if (-not $item) {
                    $item = $folder.Items.Add(1)
                    $p = $item.UserProperties.Add('ArcaloEntry', 1, $true)
                    $p.Value = [string]$o.marker
                }
                Set-Fields $item $f
                $item.Save()
            } else {
                if (-not $item) {
                    # Already gone: a delete is done, a change has nothing to go to.
                    if ($o.op -ne 'delete') { $res.ok = $false; $res.error = 'not_found' }
                    return $res
                }
                if ($item.IsRecurring) { $res.ok = $false; $res.error = 'series'; return $res }
                $status = [int]$item.MeetingStatus
                if ($status -ne 0 -and $status -ne 1) { $res.ok = $false; $res.error = 'received'; return $res }
                # Recipients of an appointment that is no meeting (MeetingStatus 0) were never invited.
                $invited = 0
                if ($status -ne 0) { $invited = Count-Invited $item }
                if ($o.op -eq 'delete') {
                    # A meeting with attendees is cancelled in Outlook, never deleted here.
                    if ($invited -gt 0) { $res.ok = $false; $res.error = 'needs_send'; return $res }
                    # Deleted Items of the calendar's own store (a PST file has its own).
                    $trash = $null
                    try { $trash = $folder.Store.GetDefaultFolder(3) } catch { $trash = $null }
                    if (-not $trash) { $trash = $ns.GetDefaultFolder(3) }
                    $moved = $item.Move($trash)
                    $res.deletedId = [string]$moved.EntryID
                    return $res
                }
                if ($invited -gt 0 -and -not $o.send) { $res.ok = $false; $res.error = 'needs_send'; return $res }
                # A field changed in Outlook since Arcalo saw it (to another value than Arcalo's) is a
                # conflict. Arcalo reads texts trimmed, so spaces around them are no change.
                $now = Get-Values $item
                $current = [ordered]@{}
                foreach ($k in @('subject', 'start', 'end', 'location')) {
                    $seen = $null
                    $mine = $null
                    if ($o.seen) { $seen = $o.seen.$k }
                    if ($f) { $mine = $f.$k }
                    $is = ([string]$now[$k]).Trim()
                    if ($null -ne $seen -and $is -cne ([string]$seen).Trim() -and $is -cne ([string]$mine).Trim()) { $current[$k] = $now[$k] }
                }
                if ($current.Count -gt 0) { $res.ok = $false; $res.error = 'conflict'; $res.current = $current; return $res }
                Set-Fields $item $f
                $item.Save()
                # Only for a meeting the user organizes and only after the user confirmed it in Arcalo.
                if ($o.send -and $status -eq 1 -and $invited -gt 0) { $item.Send() }
            }
        }
        $res.entryId = [string]$item.EntryID
        try { $res.globalId = [string]$item.GlobalAppointmentID } catch { }
        try { $res.modified = $item.LastModificationTime.ToUniversalTime().ToString($fmt, $inv) + 'Z' } catch { }
        return $res
    }
    $categoryDone = $false
    $results = New-Object System.Collections.ArrayList
    foreach ($o in (Read-JsonFile $Ops)) {
        if ($o.kind -eq 'entry') {
            try {
                [void]$results.Add((Write-Entry $o))
            } catch {
                [void]$results.Add([ordered]@{ id = [string]$o.id; ok = $false; error = 'save'; message = [string]$_.Exception.Message })
            }
            continue
        }
        $res = [ordered]@{ id = [string]$o.id; ok = $true; entryId = ''; globalId = '' }
        try {
            $item = $null
            if ($o.entryId) {
                try { $item = $ns.GetItemFromID([string]$o.entryId) } catch { $item = $null }
                # Deleted in Outlook (now in Deleted Items): gone from the calendar.
                try { if ($item -and $item.Parent.EntryID -ne $calendar.EntryID) { $item = $null } } catch { $item = $null }
            }
            # No EntryID yet (or a stale one): an earlier write may have saved it without its
            # answer arriving.
            if (-not $item) { $item = Find-Marked $o.marker }
            if ($o.op -eq 'delete') {
                if ($item) { $item.Delete() }
            } else {
                # Gone from Outlook meanwhile (deleted there): written again.
                if (-not $item) {
                    $item = $calendar.Items.Add(1)
                    if ($o.marker) {
                        try { $p = $item.UserProperties.Add('ArcaloBlock', 1, $true); $p.Value = [string]$o.marker } catch { }
                    }
                }
                $item.Subject = [string]$o.subject
                $item.Start = [datetime]::ParseExact([string]$o.start, 'yyyy-MM-ddTHH:mm:ss', $inv)
                $item.End = [datetime]::ParseExact([string]$o.end, 'yyyy-MM-ddTHH:mm:ss', $inv)
                $item.BusyStatus = 2
                $item.ReminderSet = $false
                if ($o.category) {
                    # Into the master category list once, so Outlook shows it with a color.
                    if (-not $categoryDone) {
                        $categoryDone = $true
                        try {
                            $known = $false
                            foreach ($c in $ns.Categories) { if ($c.Name -eq [string]$o.category) { $known = $true } }
                            if (-not $known) { [void]$ns.Categories.Add([string]$o.category) }
                        } catch { }
                    }
                    $item.Categories = [string]$o.category
                }
                $item.Save()
                $res.entryId = [string]$item.EntryID
                try { $res.globalId = [string]$item.GlobalAppointmentID } catch { }
            }
        } catch {
            $res.ok = $false
            $res.error = 'save'
            $res.message = [string]$_.Exception.Message
        }
        [void]$results.Add($res)
    }
    Write-Json ([ordered]@{ ok = $true; results = @($results) })
    exit 0
}

# ---------------------------------------------------------------- show

if ($Mode -eq 'show') {
    try {
        $outlook = New-Object -ComObject Outlook.Application
        $ns = $outlook.GetNamespace('MAPI')
    } catch {
        if (Get-Process -Name 'olk' -ErrorAction SilentlyContinue) { Fail 'new_outlook' '' }
        Fail 'not_installed' $_.Exception.Message
    }
    $item = $null
    if ($StoreId) { try { $item = $ns.GetItemFromID($EntryId, $StoreId) } catch { $item = $null } }
    if (-not $item) { try { $item = $ns.GetItemFromID($EntryId) } catch { Fail 'not_found' $_.Exception.Message } }
    $item.Display()
    Write-Json ([ordered]@{ ok = $true })
    exit 0
}

if ($Mode -ne 'discover') {
    $start = [datetime]::ParseExact($From, 'yyyy-MM-ddTHH:mm:ss', $inv)
    $end = [datetime]::ParseExact($To, 'yyyy-MM-ddTHH:mm:ss', $inv)
}

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
    $defaultFolder = $ns.GetDefaultFolder(9)
} catch {
    Fail 'folder' $_.Exception.Message
}

$version = ''
try { $version = [string]$outlook.Version } catch { }

# The code of a COM error: no permission, folder gone, anything else.
function Error-Code($e) {
    $hr = $e.HResult
    if ($e.InnerException) { $hr = $e.InnerException.HResult }
    if ($hr -eq -2147024891) { return 'denied' }        # E_ACCESSDENIED
    if ($hr -eq -2147221233) { return 'not_found' }     # MAPI_E_NOT_FOUND
    if ([string]$e.Message -match 'permission|Berechtigung|Zugriff|access') { return 'denied' }
    return 'open'
}

function Resolve-Person($name) {
    if (-not $name) { return $null }
    try {
        $r = $ns.CreateRecipient([string]$name)
        [void]$r.Resolve()
        if ($r.Resolved) { return $r }
    } catch { }
    return $null
}

# ---------------------------------------------------------------- discover

if ($Mode -eq 'discover') {
    $found = New-Object System.Collections.ArrayList
    $seen = @{}
    $script:visited = 0
    $defaultEntry = ''
    $defaultStore = ''
    try { $defaultEntry = [string]$defaultFolder.EntryID } catch { }
    try { $defaultStore = [string]$defaultFolder.StoreID } catch { }

    function Is-Default($entry, $storeId) {
        if (-not $entry -or -not $defaultEntry) { return $false }
        if ($entry -eq $defaultEntry) { return $true }
        try { return [bool]($ns.CompareEntryIDs($entry, $defaultEntry) -and $storeId -eq $defaultStore) } catch { return $false }
    }

    function New-Info($store, $storeType, $filePath) {
        return [ordered]@{ store = $store; storeType = $storeType; filePath = $filePath; nav = $false; group = ''; groupType = -1; owner = ''; recipient = ''; person = $false }
    }

    function Add-Calendar($f, $info) {
        $entry = ''
        $storeId = ''
        try { $entry = [string]$f.EntryID } catch { }
        try { $storeId = [string]$f.StoreID } catch { }
        $key = $storeId + '|' + $entry
        if ($entry -and $seen.ContainsKey($key)) { return }
        if ($entry) { $seen[$key] = $true }
        $o = [ordered]@{
            entryId   = $entry
            storeId   = $storeId
            name      = ''
            path      = ''
            store     = [string]$info.store
            storeType = [int]$info.storeType
            filePath  = [string]$info.filePath
            'default' = (Is-Default $entry $storeId)
            nav       = [bool]$info.nav
            group     = [string]$info.group
            groupType = [int]$info.groupType
            owner     = [string]$info.owner
            recipient = [string]$info.recipient
            person    = [bool]$info.person
            items     = -1
            freeBusy  = $false
            error     = ''
            message   = ''
        }
        try { $o.name = [string]$f.Name } catch { }
        try { $o.path = [string]$f.FolderPath } catch { }
        # Items.Count is a property of the folder (cheap); it fails without read permission.
        try { $o.items = [int]$f.Items.Count } catch {
            $o.error = Error-Code $_.Exception
            $o.message = $_.Exception.Message
        }
        [void]$found.Add($o)
    }

    # A calendar that cannot be opened: listed with its error; free/busy only when that works.
    function Add-Unopened($name, $info, $err) {
        $code = Error-Code $err
        $o = [ordered]@{
            entryId = ''; storeId = ''; name = [string]$name; path = ''; store = [string]$info.store
            storeType = [int]$info.storeType; filePath = ''; 'default' = $false; nav = [bool]$info.nav
            group = [string]$info.group; groupType = [int]$info.groupType; owner = [string]$info.owner
            recipient = [string]$info.recipient; person = [bool]$info.person; items = -1; freeBusy = $false
            error = $code; message = [string]$err.Message
        }
        $r = Resolve-Person $info.recipient
        if ($r) {
            try {
                [void]$r.FreeBusy((Get-Date).Date, 60, $true)
                $o.freeBusy = $true
                $o.error = ''
                $o.message = ''
                try { $o.owner = [string]$r.Name } catch { }
            } catch { }
        }
        [void]$found.Add($o)
    }

    # Calendar folders below $folder: calendars are searched through completely, other folders
    # only near the top of the store (a mailbox can hold thousands of mail folders).
    function Walk($folder, $depth, $info, $skip) {
        if ($depth -gt 8 -or $script:visited -gt 3000) { return }
        $subs = $null
        try { $subs = $folder.Folders } catch { return }
        foreach ($sub in $subs) {
            $script:visited++
            $eid = ''
            try { $eid = [string]$sub.EntryID } catch { }
            if ($skip -and $eid -eq $skip) { continue }
            $type = -1
            try { $type = [int]$sub.DefaultItemType } catch { }
            if ($type -eq 1) {
                Add-Calendar $sub $info
                Walk $sub ($depth + 1) $info $skip
            } elseif ($depth -lt 2) {
                Walk $sub ($depth + 1) $info $skip
            }
        }
    }

    # The default calendar first, then every store of the profile.
    Add-Calendar $defaultFolder (New-Info '' 0 '')
    try { $found[0].store = [string]$defaultFolder.Store.DisplayName } catch { }
    foreach ($store in $ns.Stores) {
        $st = -1
        try { $st = [int]$store.ExchangeStoreType } catch { }
        if ($st -eq 2) { continue }   # public folders
        $sname = ''
        $fp = ''
        try { $sname = [string]$store.DisplayName } catch { }
        try { $fp = [string]$store.FilePath } catch { }
        $info = New-Info $sname $st $fp
        $info.owner = $sname
        $deleted = ''
        try { $deleted = [string]$store.GetDefaultFolder(3).EntryID } catch { }
        try { Add-Calendar ($store.GetDefaultFolder(9)) $info } catch { }
        $root = $null
        try { $root = $store.GetRootFolder() } catch { }
        if ($root) { Walk $root 0 $info $deleted }
    }

    # The navigation pane of the calendar module: shared calendars of colleagues, rooms, groups.
    $navError = ''
    try {
        $exp = $outlook.ActiveExplorer()
        $made = $false
        if (-not $exp) {
            # An explorer that is never shown.
            $exp = $defaultFolder.GetExplorer()
            $made = $true
        }
        $module = $exp.NavigationPane.Modules.GetNavigationModule(1)   # olModuleCalendar
        foreach ($g in $module.NavigationGroups) {
            $gname = ''
            $gtype = -1
            try { $gname = [string]$g.Name } catch { }
            try { $gtype = [int]$g.GroupType } catch { }
            foreach ($nf in $g.NavigationFolders) {
                $dn = ''
                try { $dn = [string]$nf.DisplayName } catch { }
                # A colleague's calendar is named after the person ("Anna Mueller" or "Anna Mueller - Projekt").
                $owner = $dn
                $i = $dn.IndexOf(' - ')
                if ($i -gt 0) { $owner = $dn.Substring(0, $i) }
                $info = New-Info '' (-1) ''
                $info.nav = $true
                $info.group = $gname
                $info.groupType = $gtype
                $f = $null
                try { $f = $nf.Folder } catch {
                    $info.owner = $owner
                    $info.recipient = $owner
                    Add-Unopened $dn $info $_.Exception
                    continue
                }
                try {
                    $info.store = [string]$f.Store.DisplayName
                    $info.storeType = [int]$f.Store.ExchangeStoreType
                    $info.filePath = [string]$f.Store.FilePath
                } catch { }
                $info.owner = $owner
                if ($info.store -and $info.storeType -ne 0) { $info.owner = $info.store }
                if ($gtype -eq 4 -or $gtype -eq 6) { $info.recipient = $owner }
                Add-Calendar $f $info
            }
        }
        if ($made) { try { $exp.Close() } catch { } }
    } catch {
        $navError = $_.Exception.Message
    }

    # People whose default calendar the user asked for by name or address.
    foreach ($name in (Read-JsonFile $Recipients)) {
        $info = New-Info '' 1 ''
        $info.person = $true
        $info.recipient = [string]$name
        $info.owner = [string]$name
        $r = Resolve-Person $name
        if (-not $r) {
            $o = [ordered]@{ entryId = ''; storeId = ''; name = [string]$name; path = ''; store = ''; storeType = 1; filePath = ''; 'default' = $false; nav = $false; group = ''; groupType = -1; owner = [string]$name; recipient = [string]$name; person = $true; items = -1; freeBusy = $false; error = 'unresolved'; message = '' }
            [void]$found.Add($o)
            continue
        }
        try { $info.owner = [string]$r.Name } catch { }
        try {
            $f = $ns.GetSharedDefaultFolder($r, 9)
            Add-Calendar $f $info
        } catch {
            Add-Unopened $info.owner $info $_.Exception
        }
    }

    Write-Json ([ordered]@{ ok = $true; version = $version; navError = $navError; calendars = @($found) })
    exit 0
}

# ---------------------------------------------------------------- read

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
        modified       = ''
        recipients     = 0
        location       = ''
        organizer      = ''
        attendees      = @()
        categories     = ''
        body           = $null
        urls           = @()
    }
    try { $o.globalId = [string]$it.GlobalAppointmentID } catch { }
    # For writing back: Outlook's last change (conflicts) and whether anyone is invited.
    try { $o.modified = $it.LastModificationTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss', $inv) + 'Z' } catch { }
    try { foreach ($r in $it.Recipients) { if ([int]$r.Type -ne 0) { $o.recipients++ } } } catch { }
    if (-not $hidden) {
        # A calendar shared with less than full details refuses some fields: keep what is allowed.
        try { $o.subject = [string]$it.Subject } catch { }
        try { $o.location = [string]$it.Location } catch { }
        try { $o.categories = [string]$it.Categories } catch { }
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
                # Meeting links (also behind Safe Links / URL Defense wrappers) first, so a Teams
                # link at the end of a long agenda is never cut off by the limit.
                $found = [regex]::Matches(([string]$o.location) + ' ' + $text, 'https?://[^\s<>"]+')
                $meet = 'teams\.|zoom|webex|meet\.|goto|lync|skype|jit\.si|whereby|chime\.aws|bluejeans|ringcentral|safelinks|urldefense|google\.com/url'
                foreach ($m in $found) {
                    if ($urls.Count -ge 20) { break }
                    if ($m.Value -match $meet) { [void]$urls.Add($m.Value) }
                }
                foreach ($m in $found) {
                    if ($urls.Count -ge 20) { break }
                    if ($m.Value -notmatch $meet) { [void]$urls.Add($m.Value) }
                }
                $o.urls = @($urls)
            }
        }
    }
    [void]$script:list.Add($o)
}

# The appointments of one folder into $script:list ($script:mode, $script:skipped).
function Read-Folder($folder) {
    $script:list = New-Object System.Collections.ArrayList
    $script:skipped = 0
    $items = $folder.Items
    $items.Sort('[Start]')
    $items.IncludeRecurrences = $true

    # Restrict with the dates in the user's format (Outlook parses them per the regional
    # settings); every item is checked against the real range again.
    $ff = $FilterFrom
    $ft = $FilterTo
    if (-not $ff) { $ff = $start.ToString('g') }
    if (-not $ft) { $ft = $end.ToString('g') }
    $restricted = $null
    try {
        $restricted = $items.Restrict("[Start] < '" + $ft + "' AND [End] > '" + $ff + "'")
    } catch {
        $restricted = $null
    }
    $script:mode = 'restrict'
    if ($restricted) {
        $n = 0
        $it = $restricted.GetFirst()
        while ($it -ne $null -and $n -lt 20000) {
            $n++
            try { if ($it.Start -lt $end -and $it.End -gt $start) { Add-Appointment $it } } catch { $script:skipped++ }
            $it = $restricted.GetNext()
        }
    }
    # Nothing found (or Restrict refused the dates): walk the sorted items instead.
    if ($script:list.Count -eq 0) {
        $script:mode = 'scan'
        $n = 0
        $it = $items.GetFirst()
        while ($it -ne $null -and $n -lt 50000) {
            $n++
            if ($it.Start -ge $end) { break }
            try { if ($it.End -gt $start) { Add-Appointment $it } } catch { $script:skipped++ }
            $it = $items.GetNext()
        }
    }
}

# Free/busy only: blocks of 15 minutes with their status (0 free, 1 tentative, 2 busy, 3 out of
# office, 4 working elsewhere), joined, without subjects.
function Read-FreeBusy($r) {
    $script:list = New-Object System.Collections.ArrayList
    $script:skipped = 0
    $script:mode = 'freebusy'
    $day = $start.Date
    $fb = [string]$r.FreeBusy($day, 15, $true)
    $n = $fb.Length
    $i = 0
    while ($i -lt $n) {
        $ch = $fb[$i]
        if ($ch -eq '0') { $i++; continue }
        $j = $i
        while ($j -lt $n -and $fb[$j] -eq $ch) { $j++ }
        $s = $day.AddMinutes(15 * $i)
        $e = $day.AddMinutes(15 * $j)
        if ($s -ge $end) { break }
        if ($e -gt $start) {
            [void]$script:list.Add([ordered]@{
                entryId = ''; globalId = 'fb-' + $s.ToString('yyyyMMddTHHmm', $inv); subject = ''
                start = $s.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss', $inv) + 'Z'
                end = $e.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss', $inv) + 'Z'
                startLocal = $s.ToString('yyyy-MM-ddTHH:mm:ss', $inv); endLocal = $e.ToString('yyyy-MM-ddTHH:mm:ss', $inv)
                allDay = $false; recurring = $false; busy = [int][string]$ch; sensitivity = 0
                responseStatus = 0; meetingStatus = 0; freeBusy = $true
            })
        }
        $i = $j
    }
}

if (-not $Calendars) {
    # Only the default calendar (the output of Arcalo before calendar selection).
    try { Read-Folder $defaultFolder } catch { Fail 'folder' $_.Exception.Message }
    Write-Json ([ordered]@{ ok = $true; version = $version; mode = $script:mode; skipped = $script:skipped; items = @($script:list) })
    exit 0
}

$results = New-Object System.Collections.ArrayList
foreach ($c in (Read-JsonFile $Calendars)) {
    $res = [ordered]@{ id = [string]$c.id; ok = $true; mode = ''; skipped = 0; freeBusy = $false; items = @() }
    $folder = $null
    $err = $null
    try {
        if ($c.default) { $folder = $defaultFolder }
        elseif ($c.entryId) { $folder = $ns.GetFolderFromID([string]$c.entryId, [string]$c.storeId) }
    } catch { $err = $_.Exception }
    $r = $null
    if (-not $folder -and $c.recipient) {
        $r = Resolve-Person $c.recipient
        if ($r) {
            try { $folder = $ns.GetSharedDefaultFolder($r, 9) } catch { $err = $_.Exception }
        }
    }
    $done = $false
    if ($folder) {
        try {
            Read-Folder $folder
            $done = $true
        } catch { $err = $_.Exception }
    }
    if (-not $done -and $c.recipient) {
        if (-not $r) { $r = Resolve-Person $c.recipient }
        if ($r) {
            try {
                Read-FreeBusy $r
                $res.freeBusy = $true
                $done = $true
            } catch { if (-not $err) { $err = $_.Exception } }
        }
    }
    if ($done) {
        $res.mode = $script:mode
        $res.skipped = $script:skipped
        $res.items = @($script:list)
    } else {
        $res.ok = $false
        $res.Remove('items')
        if ($err) {
            $res.error = Error-Code $err
            $res.message = [string]$err.Message
        } else {
            $res.error = 'not_found'
            $res.message = ''
        }
    }
    [void]$results.Add($res)
}

Write-Json ([ordered]@{ ok = $true; version = $version; calendars = @($results) })
