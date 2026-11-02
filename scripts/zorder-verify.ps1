# Verifies the widget's "background app" behavior:
#   1. launches the app (dev or installed) in an isolated profile with the
#      widget enabled
#   2. asserts the widget sits BELOW the main window but ABOVE the desktop
#      layer (Progman/WorkerW), and is not a topmost window
#   3. real-input test: PostMessage a click onto the widget's ✕ — a
#      non-focusable window must still receive mouse input and destroy itself
# Usage:
#   powershell -File scripts\zorder-verify.ps1 -Exe <electron.exe> -Dir <projectDir>

param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Dir
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class ZVerify {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public struct W { public IntPtr Hwnd; public uint Pid; public string Cls; public string Title; public bool Vis; }

  public static List<W> List() {
    List<W> list = new List<W>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      StringBuilder cb = new StringBuilder(256);
      GetClassName(h, cb, 256);
      StringBuilder tb = new StringBuilder(512);
      GetWindowText(h, tb, 512);
      W w;
      w.Hwnd = h; w.Pid = pid; w.Cls = cb.ToString(); w.Title = tb.ToString(); w.Vis = IsWindowVisible(h);
      list.Add(w);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  public static int ExStyle(IntPtr h) { return GetWindowLong(h, -20); } // GWL_EXSTYLE

  public static bool ClickAt(IntPtr h, int cx, int cy) {
    IntPtr lp = (IntPtr)((cy << 16) | (cx & 0xFFFF));
    PostMessage(h, 0x0200, IntPtr.Zero, lp);                       // WM_MOUSEMOVE
    System.Threading.Thread.Sleep(60);
    PostMessage(h, 0x0201, (IntPtr)1, lp);                         // WM_LBUTTONDOWN (MK_LBUTTON)
    System.Threading.Thread.Sleep(60);
    return PostMessage(h, 0x0202, IntPtr.Zero, lp);                // WM_LBUTTONUP
  }
}
"@
[ZVerify]::SetProcessDPIAware() | Out-Null

# ---- isolated profile (BOM-free writes; PowerShell UTF8 would add one) ----
$testData = Join-Path $env:TEMP 'pc-zorder'
Remove-Item $testData -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $testData -Force | Out-Null
$settings = "{`"apiKey`": `"`", `"mode`": `"demo`", `"quotePollSeconds`": 30, `"startWithWindows`": false, `"widgetEnabled`": true}"
$portfolio = "{`"version`": 2, `"activeId`": `"pf_zv`", `"portfolios`": [{`"id`": `"pf_zv`", `"name`": `"ZV`", `"positions`": [{`"symbol`": `"AAPL`", `"quantity`": 10, `"avgCost`": 100}]}]}"
[System.IO.File]::WriteAllText((Join-Path $testData 'settings.json'), $settings)
[System.IO.File]::WriteAllText((Join-Path $testData 'portfolio.json'), $portfolio)
$env:PC_USER_DATA = $testData

$errors = @()
$proc = Start-Process -FilePath $Exe -ArgumentList '.' -WorkingDirectory $Dir -PassThru
try {
  Start-Sleep -Seconds 9
  if ($proc.HasExited) { Write-Host 'app exited immediately'; exit 1 }
  $appPids = @($proc.Id)

  $main = $null; $widget = $null
  for ($i = 0; $i -lt 20 -and (-not $main -or -not $widget); $i++) {
    $all = [ZVerify]::List()
    $app = @($all | Where-Object { $appPids -contains $_.Pid -and $_.Title })
    $main = $app | Where-Object { $_.Title -like '*Portfolio Candles*' } | Select-Object -First 1
    $widget = $app | Where-Object { $_.Title -eq 'Widget' } | Select-Object -First 1
    if (-not $main -or -not $widget) { Start-Sleep -Milliseconds 500 }
  }
  if (-not $main) { $errors += 'main window not found' }
  if (-not $widget) { $errors += 'widget window not found' }
  if ($errors.Count) { $errors | ForEach-Object { Write-Host "FAIL: $_" }; exit 1 }

  Start-Sleep -Milliseconds 800 # let send-behind land
  $z = [ZVerify]::List()
  $visIdx = @{}
  $i = 0
  $firstDesktopIdx = -1
  foreach ($e in $z) {
    if ($e.Vis) {
      $visIdx[$e.Hwnd] = $i
      if ($firstDesktopIdx -lt 0 -and ($e.Cls -eq 'Progman' -or $e.Cls -eq 'WorkerW')) { $firstDesktopIdx = $i }
      $i++
    }
  }
  $mw = $visIdx[$main.Hwnd]; $ww = $visIdx[$widget.Hwnd]
  Write-Host "z-order: mainIdx=$mw widgetIdx=$ww firstDesktopIdx=$firstDesktopIdx (top=0)"

  if ($ww -lt $mw) { $errors += "widget (idx $ww) is ABOVE the main window (idx $mw)" }
  if ($firstDesktopIdx -ge 0 -and $ww -gt $firstDesktopIdx) {
    $errors += "widget (idx $ww) is BELOW the desktop layer (idx $firstDesktopIdx) - hidden behind wallpaper"
  }
  $ex = [ZVerify]::ExStyle($widget.Hwnd)
  if (($ex -band 0x8) -ne 0) { $errors += ("widget has WS_EX_TOPMOST (exstyle 0x{0:X})" -f $ex) }

  # real-input test: click the ✕ (frameless window -> outer rect == client)
  $rc = New-Object ZVerify+RECT
  [ZVerify]::GetWindowRect($widget.Hwnd, [ref]$rc) | Out-Null
  $w = $rc.Right - $rc.Left
  $cx = $w - 20; $cy = 20
  [ZVerify]::ClickAt($widget.Hwnd, $cx, $cy) | Out-Null
  $gone = $false
  for ($i = 0; $i -lt 10 -and -not $gone; $i++) {
    Start-Sleep -Milliseconds 400
    $still = @([ZVerify]::List() | Where-Object { $_.Hwnd -eq $widget.Hwnd -and $_.Vis })
    if (-not $still.Count) { $gone = $true }
  }
  if (-not $gone) { $errors += 'widget did not close from a posted click on its ✕' }
  else { Write-Host 'input test: widget closed from posted ✕ click (non-focusable window still receives clicks)' }
} finally {
  if (-not $proc.HasExited) { taskkill /PID $proc.Id /T /F 2>$null | Out-Null }
  Remove-Item Env:\PC_USER_DATA -ErrorAction SilentlyContinue
}

if ($errors.Count) {
  $errors | ForEach-Object { Write-Host "FAIL: $_" }
  exit 1
}
Write-Host 'Z-ORDER OK: widget behind apps, above desktop, clickable'
exit 0
