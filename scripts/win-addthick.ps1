# Adds WS_THICKFRAME (0x00040000) to a window's style, then optionally sends
# SC_MAXIMIZE / SC_RESTORE. Used to verify that a transparent Electron window
# regains native maximize/restore/snap once the thickframe bit is set.
# Usage: powershell -File scripts\win-addthick.ps1 -Cmd maximize|restore|'' 
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
public class WinThick {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
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
$hwnd = [WinThick]::FindMain([uint32]$proc.ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { "main window not found"; exit 1 }

$style = [WinThick]::GetWindowLong($hwnd, -16)
"style before: 0x$($style.ToString('X8'))"
if (($style -band 0x00040000) -eq 0) {
  [WinThick]::SetWindowLong($hwnd, -16, $style -bor 0x00040000) | Out-Null
}
$style = [WinThick]::GetWindowLong($hwnd, -16)
"style after:  0x$($style.ToString('X8'))  THICKFRAME=$((($style -band 0x00040000) -ne 0))"

if ($Cmd) {
  $code = switch ($Cmd) { 'maximize' { 0xF030 } 'restore' { 0xF121 } default { throw "unknown cmd" } }
  [WinThick]::SendMessage($hwnd, 0x0112, [IntPtr]$code, [IntPtr]0) | Out-Null
  Start-Sleep -Milliseconds 1500
  $r = New-Object WinThick+RECT
  [WinThick]::GetWindowRect($hwnd, [ref]$r) | Out-Null
  "after SC_$Cmd : $($r.Right - $r.Left) x $($r.Bottom - $r.Top) @ $($r.Left),$($r.Top)"
}
