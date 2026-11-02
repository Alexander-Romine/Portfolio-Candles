# Verifies window-state persistence end to end:
#   phase 1: launch, resize the window via Win32, hard-kill the app
#   phase 2: relaunch, confirm the window came back at the saved size/position
# Usage: powershell -File scripts\winstate-verify.ps1 -Exe <electron.exe> -Dir <projectDir>

param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Dir
)

$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Win32W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  public static IntPtr FindMainWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid != pid || !IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(256);
      GetClassName(h, sb, 256);
      if (sb.ToString() == "Chrome_WidgetWin_1") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

[Win32W]::SetProcessDPIAware() | Out-Null

$testData = Join-Path $env:TEMP 'pc-test-profile'
Remove-Item $testData -Recurse -Force -ErrorAction SilentlyContinue
$env:PC_USER_DATA = $testData

function Wait-MainHwnd([int]$ProcId) {
  for ($i = 0; $i -lt 60; $i++) {
    $h = [Win32W]::FindMainWindow([uint32]$ProcId)
    if ($h -ne [IntPtr]::Zero) { return $h }
    Start-Sleep -Milliseconds 500
  }
  throw "main window for pid $ProcId never appeared"
}

# ---- phase 1: resize + hard kill ----
$p1 = Start-Process -FilePath $Exe -ArgumentList '.' -WorkingDirectory $Dir -PassThru
Start-Sleep -Seconds 8
$h1 = Wait-MainHwnd $p1.Id
[Win32W]::SetWindowPos($h1, [IntPtr]::Zero, 120, 90, 900, 600, 0x0010) | Out-Null  # SWP_NOACTIVATE
Start-Sleep -Milliseconds 1800  # > debounce
taskkill /PID $p1.Id /T /F | Out-Null
Write-Host "PHASE 1: resized to 900x600 @ (120,90), killed (no clean quit)"
Start-Sleep -Seconds 2

# ---- phase 2: relaunch + verify ----
$p2 = Start-Process -FilePath $Exe -ArgumentList '.' -WorkingDirectory $Dir -PassThru
Start-Sleep -Seconds 8
$h2 = Wait-MainHwnd $p2.Id
$rc = New-Object Win32W+RECT
[Win32W]::GetWindowRect($h2, [ref]$rc) | Out-Null
$w = $rc.Right - $rc.Left
$ht = $rc.Bottom - $rc.Top
Write-Host "PHASE 2: restored rect = ${w}x${ht} @ ($($rc.Left),$($rc.Top))"
taskkill /PID $p2.Id /T /F | Out-Null
Remove-Item Env:\PC_USER_DATA -ErrorAction SilentlyContinue

$ok = ([Math]::Abs($w - 900) -le 16) -and ([Math]::Abs($ht - 600) -le 16) -and
      ([Math]::Abs($rc.Left - 120) -le 16) -and ([Math]::Abs($rc.Top - 90) -le 16)
if ($ok) { Write-Host 'WINDOW STATE OK'; exit 0 }
else { Write-Host 'WINDOW STATE MISMATCH'; exit 1 }
