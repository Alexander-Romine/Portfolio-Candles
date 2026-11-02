# Focus-safe native-button test: locates the native caption button via
# WM_NCHITTEST (passive query), then posts the exact non-client mouse sequence
# a real click generates (WM_NCMOUSEMOVE -> WM_NCLBUTTONDOWN -> WM_NCLBUTTONUP)
# with realistic timing between messages. Messages are POSTED (never sent) so
# the target can't block us, z-order is irrelevant, no focus steal.
# Usage: powershell -File scripts\win-nclick.ps1 [-Button maximize|restore]
param(
  [string]$ExeName = 'electron.exe',
  [string]$Match = 'portfolio-candles',
  [ValidateSet('maximize', 'restore')][string]$Button = 'maximize',
  [int]$SettleMs = 1800
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinNC {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static IntPtr FindMain(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetClassName(h, sb, 256);
      if (sb.ToString() == "Chrome_WidgetWin_1") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[WinNC]::SetProcessDPIAware() | Out-Null
$proc = Get-CimInstance Win32_Process -Filter "Name='$ExeName'" |
  Where-Object { $_.ExecutablePath -like "*$Match*" -and $_.CommandLine -notlike "*--type=*" } |
  Select-Object -First 1
if (-not $proc) { "process not found"; exit 1 }
$hwnd = [WinNC]::FindMain([uint32]$proc.ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { "main window not found"; exit 1 }

# If minimized, show WITHOUT activating (messages need a live visible window).
if ([WinNC]::IsIconic($hwnd)) { [WinNC]::ShowWindow($hwnd, 4) | Out-Null; Start-Sleep -Milliseconds 700 }

$r = New-Object WinNC+RECT
[WinNC]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { "bad rect"; exit 1 }

# --- locate the maximize/restore button by hit-test (window-relative scan) ---
$HTMAX = 9
$minX = [int]::MaxValue; $maxX = -1; $minY = [int]::MaxValue; $maxY = -1
$found = $false
for ($y = 2; $y -le 44; $y += 2) {
  for ($x = $w - 160; $x -lt ($w - 2); $x += 2) {
    $sx = $r.Left + $x
    $sy = $r.Top + $y
    $lp = [IntPtr]((([uint32]($sy -band 0xFFFF)) -shl 16) -bor ([uint32]($sx -band 0xFFFF)))
    $code = [WinNC]::SendMessage($hwnd, 0x0084, [IntPtr]0, $lp).ToInt64() -band 0xFFFF  # WM_NCHITTEST
    if ($code -eq $HTMAX) {
      $found = $true
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if (-not $found) { "HTMAXBUTTON not found in top-right strip (window ${w}x${h})"; exit 2 }
$cx = $r.Left + [int](($minX + $maxX) / 2)
$cy = $r.Top + [int](($minY + $maxY) / 2)
"window: ${w}x${h} @ $($r.Left),$($r.Top)  button rel($minX..$maxX, $minY..$maxY) center screen($cx,$cy)  [$Button]"

$fgBefore = [WinNC]::GetForegroundWindow()
$HTB = [IntPtr]$HTMAX
$lparam = [IntPtr]((([uint32]($cy -band 0xFFFF)) -shl 16) -bor ([uint32]($cx -band 0xFFFF)))

# realistic click timing: hover, then down, then up (gives Chromium time to
# process each message and update its internal caption-button state)
[WinNC]::PostMessage($hwnd, 0x00A0, $HTB, $lparam) | Out-Null   # WM_NCMOUSEMOVE
Start-Sleep -Milliseconds 300
[WinNC]::PostMessage($hwnd, 0x00A1, $HTB, $lparam) | Out-Null   # WM_NCLBUTTONDOWN
Start-Sleep -Milliseconds 200
[WinNC]::PostMessage($hwnd, 0x00A2, $HTB, $lparam) | Out-Null   # WM_NCLBUTTONUP
Start-Sleep -Milliseconds $SettleMs

[WinNC]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$fgAfter = [WinNC]::GetForegroundWindow()
"after: $($r.Right - $r.Left)x$($r.Bottom - $r.Top) @ $($r.Left),$($r.Top) iconic=$([WinNC]::IsIconic($hwnd)) focusStolen=$($fgAfter -ne $fgBefore -and $fgAfter -eq $hwnd)"
