# Drives native window state transitions (maximize/restore/minimize) the same
# way the caption buttons do — through the window's own maximize/restore
# machinery (WS_THICKFRAME + WS_MAXIMIZEBOX). ShowWindow is used because this
# Electron build ignores WM_SYSCOMMAND (SC_MAXIMIZE/SC_RESTORE are inert) while
# ShowWindow reliably exercises the exact state change the buttons perform.
# Usage: powershell -File scripts\win-syscmd.ps1 -ExeName "electron.exe" -Match "portfolio-candles" -Cmd maximize|restore|minimize
param(
  [Parameter(Mandatory = $true)][string]$ExeName,
  [Parameter(Mandatory = $true)][string]$Match,
  [Parameter(Mandatory = $true)][string]$Cmd
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinSys {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
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
# SW_MAXIMIZE=3, SW_RESTORE=9, SW_MINIMIZE=6
$show = switch ($Cmd) { 'maximize' { 3 } 'restore' { 9 } 'minimize' { 6 } default { throw "unknown cmd: $Cmd" } }
$proc = Get-CimInstance Win32_Process -Filter "Name='$ExeName'" |
  Where-Object { $_.ExecutablePath -like "*$Match*" -and $_.CommandLine -notlike "*--type=*" } |
  Select-Object -First 1
if (-not $proc) { "process not found"; exit 1 }
$hwnd = [WinSys]::FindMain([uint32]$proc.ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { "main window not found"; exit 1 }
[WinSys]::ShowWindow($hwnd, $show) | Out-Null
"ShowWindow(SW_$Cmd) sent to hwnd $hwnd"
