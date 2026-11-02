# Verifies the widget's content-driven height:
#   A) 12 positions near the top  -> grows well past the old fixed 150px box
#   B) 12 positions dragged low   -> clamped so it never hangs off the screen
#      (rows get a scrollbar instead — check the optional screenshot)
# Usage:
#   powershell -File scripts\widget-size-verify.ps1 -Exe <electron.exe> -Dir <projectDir> [-Screenshots]

param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Dir,
  [switch]$Screenshots
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Wsz {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static IntPtr FindWidget(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      StringBuilder tb = new StringBuilder(256);
      GetWindowText(h, tb, 256);
      if (tb.ToString() == "Widget") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[Wsz]::SetProcessDPIAware() | Out-Null

$wa = [System.Windows.Forms.SystemInformation]::WorkingArea
$shotDir = Join-Path $env:TEMP 'pc-widget-size'
if ($Screenshots) {
  Remove-Item $shotDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $shotDir -Force | Out-Null
}

function New-Profile([int]$positions, [int]$widgetY = 14) {
  $data = Join-Path $env:TEMP 'pc-wsz'
  Remove-Item $data -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $data -Force | Out-Null
  $pArr = @()
  for ($i = 1; $i -le $positions; $i++) {
    $pArr += [pscustomobject]@{ symbol = "T$i"; quantity = $i; avgCost = 100 }
  }
  # build JSON with ConvertTo-Json — no manual string escaping to get wrong
  $settings = [pscustomobject]@{
    apiKey = ''; mode = 'demo'; quotePollSeconds = 30
    startWithWindows = $false; widgetEnabled = $true
  } | ConvertTo-Json -Compress
  $portfolio = [pscustomobject]@{
    version = 2; activeId = 'pf_a'
    portfolios = @([pscustomobject]@{ id = 'pf_a'; name = 'SZ'; positions = $pArr })
  } | ConvertTo-Json -Depth 5 -Compress
  $wstate = [pscustomobject]@{ widgetX = 20; widgetY = $widgetY } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText((Join-Path $data 'settings.json'), $settings)
  [System.IO.File]::WriteAllText((Join-Path $data 'portfolio.json'), $portfolio)
  [System.IO.File]::WriteAllText((Join-Path $data 'window-state.json'), $wstate)
  return $data
}

function Measure-Widget([int]$positions, [int]$widgetY, [string]$label) {
  $data = New-Profile $positions $widgetY
  $env:PC_USER_DATA = $data
  $proc = $null
  try {
    $proc = Start-Process -FilePath $Exe -ArgumentList '.' -WorkingDirectory $Dir -PassThru
    Start-Sleep -Seconds 9
    if ($proc.HasExited) { Write-Host "FAIL($label): app exited immediately"; return $null }
    $h = [IntPtr]::Zero
    for ($i = 0; $i -lt 12 -and $h -eq [IntPtr]::Zero; $i++) {
      $h = [Wsz]::FindWidget([uint32]$proc.Id)
      if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }
    }
    if ($h -eq [IntPtr]::Zero) { Write-Host "FAIL($label): widget window not found"; return $null }
    Start-Sleep -Seconds 2 # let the height sync + clamp settle
    $rc = New-Object Wsz+RECT
    [Wsz]::GetWindowRect($h, [ref]$rc) | Out-Null
    $res = @{ x = $rc.Left; y = $rc.Top; w = $rc.Right - $rc.Left; h = $rc.Bottom - $rc.Top; bottom = $rc.Bottom }
    Write-Host ("{0}: {1}x{2} at ({3},{4}) bottom={5}" -f $label, $res.w, $res.h, $res.x, $res.y, $res.bottom
    )
    if ($Screenshots) {
      $pad = 8
      $rx = [Math]::Max(0, $rc.Left - $pad); $ry = [Math]::Max(0, $rc.Top - $pad)
      $rw = [Math]::Min($res.w + $pad * 2, 1920 - $rx); $rh = [Math]::Min($res.h + $pad * 2, 1080 - $ry)
      $bmp = New-Object System.Drawing.Bitmap $rw, $rh
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($rx, $ry, 0, 0, (New-Object System.Drawing.Size $rw, $rh))
      $out = Join-Path $shotDir "$label.png"
      $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
      $g.Dispose(); $bmp.Dispose()
      Write-Host ("{0}: screenshot -> {1}" -f $label, $out)
    }
    return $res
  } finally {
    if ($proc -and -not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>$null | Out-Null }
    Remove-Item Env:\PC_USER_DATA -ErrorAction SilentlyContinue
  }
}

$errors = @()

# A) 12 positions, top of screen: grows past the old fixed 150px box
$a = Measure-Widget 12 14 'a-12-top'
if (-not $a) { $errors += 'phase A produced no measurement' }
elseif ($a.h -le 300) { $errors += "phase A: height $($a.h) did not grow for 12 positions" }

# B) same content, dragged near the bottom: must clamp to the work area
$b = Measure-Widget 12 ($wa.Height - 160) 'b-12-low'
if (-not $b) { $errors += 'phase B produced no measurement' }
else {
  $natural = if ($a) { $a.h } else { 999 }
  if ($b.h -ge $natural) { $errors += "phase B: height $($b.h) not clamped below natural $natural" }
  if ($b.bottom -gt ($wa.Bottom + 2)) { $errors += "phase B: widget bottom $($b.bottom) hangs off the screen (wa bottom $($wa.Bottom))" }
}

if ($errors.Count) {
  $errors | ForEach-Object { Write-Host "FAIL: $_" }
  exit 1
}
Write-Host 'WIDGET SIZE OK: grows with content, clamps to the screen'
exit 0
