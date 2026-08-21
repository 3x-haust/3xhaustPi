$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ThreeXhaustNativeDesktop {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@

function Bounded-Text([object]$Value) {
  if ($null -eq $Value) { return "" }
  $normalized = ([string]$Value -replace "\s+", " ").Trim()
  if ($normalized.Length -gt 512) { return $normalized.Substring(0, 512) }
  return $normalized
}

function Canonical-Identity([System.Windows.Automation.AutomationElement]$Element) {
  $programmatic = $Element.Current.ControlType.ProgrammaticName
  $role = switch ($programmatic) {
    "ControlType.Button" { "button" }
    "ControlType.CheckBox" { "button" }
    "ControlType.RadioButton" { "button" }
    "ControlType.Hyperlink" { "link" }
    "ControlType.Edit" { "field" }
    "ControlType.ComboBox" { "field" }
    "ControlType.MenuItem" { "menu-item" }
    "ControlType.Window" { "window" }
    "ControlType.Pane" { "window" }
    default { $null }
  }
  if ($null -eq $role) { return $null }
  $name = Bounded-Text $Element.Current.Name
  if (-not $name) { $name = Bounded-Text $Element.Current.LocalizedControlType }
  if (-not $name) { return $null }
  return [PSCustomObject]@{ role = $role; name = $name }
}

function Process-Root([int]$Pid) {
  $process = Get-Process -Id $Pid -ErrorAction Stop
  if ($process.MainWindowHandle -eq [IntPtr]::Zero) {
    throw "Windows UI Automation application has no main window: $Pid"
  }
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
  if ($null -eq $root) { throw "Windows UI Automation root is unavailable: $Pid" }
  return [PSCustomObject]@{ process = $process; root = $root }
}

function Child-At([System.Windows.Automation.AutomationElement]$Parent, [int]$Index) {
  if ($Index -lt 0 -or $Index -gt 4096) { throw "Windows UI Automation child index is invalid." }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $child = $walker.GetFirstChild($Parent)
  for ($position = 0; $position -lt $Index -and $null -ne $child; $position += 1) {
    $child = $walker.GetNextSibling($child)
  }
  if ($null -eq $child) { throw "Windows UI Automation element path is stale." }
  return $child
}

function Resolve-Path([System.Windows.Automation.AutomationElement]$Root, [object[]]$Path) {
  if ($Path.Count -lt 1 -or $Path.Count -gt 17) { throw "Windows UI Automation path is invalid." }
  if ([int]$Path[0] -eq -1) {
    if ($Path.Count -ne 1) { throw "Windows UI Automation root path is invalid." }
    return $Root
  }
  $element = $Root
  foreach ($part in $Path) { $element = Child-At $element ([int]$part) }
  return $element
}

function Observe-Application([object]$Request) {
  $resolved = Process-Root ([int]$Request.target.pid)
  $limit = [Math]::Max(1, [Math]::Min(512, [int]$Request.maxElements))
  $elements = [System.Collections.Generic.List[object]]::new()
  $counter = [PSCustomObject]@{ value = 0 }

  function Visit-Element([System.Windows.Automation.AutomationElement]$Element, [int[]]$Path, [int]$Depth) {
    if ($elements.Count -ge $limit -or $counter.value -ge 512 -or $Depth -gt 10) { return }
    $counter.value += 1
    $identity = Canonical-Identity $Element
    if ($null -ne $identity) {
      $elements.Add([PSCustomObject]@{ role = $identity.role; name = $identity.name; path = [int[]]$Path })
    }
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $child = $walker.GetFirstChild($Element)
    $index = 0
    while ($null -ne $child -and $elements.Count -lt $limit -and $counter.value -lt 512) {
      Visit-Element $child ([int[]]($Path + $index)) ($Depth + 1)
      $child = $walker.GetNextSibling($child)
      $index += 1
    }
  }

  $identity = Canonical-Identity $resolved.root
  if ($null -ne $identity) {
    $elements.Add([PSCustomObject]@{ role = $identity.role; name = $identity.name; path = [int[]]@(-1) })
  }
  $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
  $child = $walker.GetFirstChild($resolved.root)
  $childIndex = 0
  while ($null -ne $child -and $elements.Count -lt $limit -and $counter.value -lt 512) {
    Visit-Element $child ([int[]]@($childIndex)) 1
    $child = $walker.GetNextSibling($child)
    $childIndex += 1
  }
  return [PSCustomObject]@{
    application = [PSCustomObject]@{
      pid = [int]$resolved.process.Id
      name = Bounded-Text $resolved.process.ProcessName
      frontmost = ($resolved.process.MainWindowHandle -eq [ThreeXhaustNativeDesktop]::GetForegroundWindow())
    }
    trusted = $true
    elements = $elements
  }
}

function Get-Pattern([System.Windows.Automation.AutomationElement]$Element, [System.Windows.Automation.AutomationPattern]$Pattern) {
  $value = $null
  if ($Element.TryGetCurrentPattern($Pattern, [ref]$value)) { return $value }
  return $null
}

function Perform-Action([object]$Request) {
  if ($Request.coordinateFallback) {
    if ($Request.action.action -ne "click" -or $Request.action.button -ne "left") {
      throw "Windows coordinate fallback supports approved left clicks only."
    }
    [void][ThreeXhaustNativeDesktop]::SetCursorPos([int]$Request.action.coordinates.x, [int]$Request.action.coordinates.y)
    [ThreeXhaustNativeDesktop]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [ThreeXhaustNativeDesktop]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    return [PSCustomObject]@{ method = "coordinates" }
  }

  $resolved = Process-Root ([int]$Request.target.pid)
  $element = Resolve-Path $resolved.root @($Request.path)
  $identity = Canonical-Identity $element
  if ($null -eq $identity -or $identity.role -ne $Request.expected.role -or $identity.name -ne $Request.expected.name) {
    throw "Windows UI Automation element identity changed before action."
  }

  if ($Request.action.action -eq "click") {
    if ($Request.action.button -ne "left") { throw "Semantic UI Automation clicks support the left button only." }
    $invoke = Get-Pattern $element ([System.Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $invoke) { ([System.Windows.Automation.InvokePattern]$invoke).Invoke() }
    else {
      $selection = Get-Pattern $element ([System.Windows.Automation.SelectionItemPattern]::Pattern)
      if ($null -ne $selection) { ([System.Windows.Automation.SelectionItemPattern]$selection).Select() }
      else {
        $toggle = Get-Pattern $element ([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -eq $toggle) { throw "Windows UI Automation element has no semantic click pattern." }
        ([System.Windows.Automation.TogglePattern]$toggle).Toggle()
      }
    }
  } elseif ($Request.action.action -eq "type") {
    $value = Get-Pattern $element ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -eq $value) { throw "Windows UI Automation element has no editable value pattern." }
    $element.SetFocus()
    ([System.Windows.Automation.ValuePattern]$value).SetValue([string]$Request.action.text)
  } elseif ($Request.action.action -eq "key") {
    $keys = @{
      Enter = "{ENTER}"; Escape = "{ESC}"; Tab = "{TAB}"; ArrowUp = "{UP}"
      ArrowDown = "{DOWN}"; ArrowLeft = "{LEFT}"; ArrowRight = "{RIGHT}"
    }
    $element.SetFocus()
    [System.Windows.Forms.SendKeys]::SendWait($keys[[string]$Request.action.key])
  } else {
    $scroll = Get-Pattern $element ([System.Windows.Automation.ScrollPattern]::Pattern)
    if ($null -eq $scroll) { throw "Windows UI Automation element has no semantic scroll pattern." }
    $amount = if ([int]$Request.action.deltaY -ge 0) {
      [System.Windows.Automation.ScrollAmount]::SmallIncrement
    } else {
      [System.Windows.Automation.ScrollAmount]::SmallDecrement
    }
    $count = [Math]::Max(1, [Math]::Min(12, [Math]::Ceiling([Math]::Abs([int]$Request.action.deltaY) / 800)))
    for ($index = 0; $index -lt $count; $index += 1) {
      ([System.Windows.Automation.ScrollPattern]$scroll).Scroll(
        [System.Windows.Automation.ScrollAmount]::NoAmount,
        $amount
      )
    }
  }
  return [PSCustomObject]@{ method = "accessibility" }
}

function List-Applications {
  $foreground = [ThreeXhaustNativeDesktop]::GetForegroundWindow()
  $applications = Get-Process | Where-Object {
    $_.Id -gt 0 -and $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.ProcessName
  } | ForEach-Object {
    [PSCustomObject]@{
      pid = [int]$_.Id
      name = Bounded-Text $_.ProcessName
      bundleId = "win32:$($_.ProcessName)"
      active = ($_.MainWindowHandle -eq $foreground)
    }
  } | Sort-Object @{ Expression = "active"; Descending = $true }, name | Select-Object -First 128
  return [PSCustomObject]@{ platform = "win32"; trusted = $true; applications = @($applications) }
}

try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $result = if ($request.operation -eq "list") {
    List-Applications
  } elseif ($request.operation -eq "observe") {
    Observe-Application $request
  } elseif ($request.operation -eq "perform") {
    Perform-Action $request
  } else {
    throw "Unknown Windows UI Automation operation."
  }
  $result | ConvertTo-Json -Depth 24 -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
