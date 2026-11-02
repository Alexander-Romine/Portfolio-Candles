# Checks whether the main window has the native resize/maximize styles and
# sends SC_MAXIMIZE / SC_RESTORE like the titlebar buttons do.
# Usage: powershell -File scripts\win-style-check.ps1 -ExeName electron.exe -Match portfolio-candles
param(
  [string]$ExeName = 'electron.exe',
  [string]$Match = 'portfolio-candles',
  [string]$Cmd = ''
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class StyleWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
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
$proc = Get-CimInstance Win32_Process -Filter "Name='$ExeName'" |
  Where-Object { $_.ExecutablePath -like "*$Match*" -and $_.CommandLine -notlike "*--type=*" } |
  Select-Object -First 1
if (-not $proc) { "process not found"; exit 1 }
$hwnd = [StyleWin]::FindMain([uint32]$proc.ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { "main window not found"; exit 1 }
$style = [StyleWin]::GetWindowLong($hwnd, -16)
"style: 0x$($style.ToString('X8'))"
"WS_THICKFRAME: $(([StyleWin]::GetWindowLong($hwnd, -16) -band 0x00040000) -ne 0)"
"WS_MAXIMIZEBOX: $(([StyleWin]::GetWindowLong($hwnd, -16) -band 0x00010000) -ne 0)"
if ($Cmd) {
  $code = switch ($Cmd) { 'maximize' { 0xF030 } 'restore' { 0xF121 } default { throw "unknown cmd" } }
  [StyleWin]::SendMessage($hwnd, 0x0112, [IntPtr]$code, [IntPtr]0) | Out-Null
  Start-Sleep -Milliseconds 1500
  $r = New-Object StyleWin+RECT
  [StyleWin]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  "after ${Cmd}: $($r.Right - $r.Left) x $($r.Bottom - $r.Top) @ $($r.Left),$($r.Top)"
}
