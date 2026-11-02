# Simulates a real mouse click at a window-relative point (e.g. the native
# caption buttons) using SendInput. Saves and restores the cursor position.
# The machine may be idle but we never move focus explicitly — a click on a
# caption button does not activate the window.
# Usage: powershell -File scripts\win-click.ps1 -RelX 1292 -RelY 17
param(
  [string]$ExeName = 'electron.exe',
  [string]$Match = 'portfolio-candles',
  [Parameter(Mandatory = $true)][int]$RelX,
  [Parameter(Mandatory = $true)][int]$RelY,
  [int]$SettleMs = 1500
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinClick {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
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
# mouse event injection structs
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public int type; public MOUSEINPUT mi; }
  [DllImport("user32.dll", SetLastError = true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public const int INPUT_MOUSE = 0;
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
"@
[WinClick]::SetProcessDPIAware() | Out-Null
$proc = Get-CimInstance Win32_Process -Filter "Name='$ExeName'" |
  Where-Object { $_.ExecutablePath -like "*$Match*" -and $_.CommandLine -notlike "*--type=*" } |
  Select-Object -First 1
if (-not $proc) { "process not found"; exit 1 }
$hwnd = [WinClick]::FindMain([uint32]$proc.ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { "main window not found"; exit 1 }
$r = New-Object WinClick+RECT
[WinClick]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$x = $r.Left + $RelX
$y = $r.Top + $RelY
"window: $($r.Right - $r.Left)x$($r.Bottom - $r.Top) @ $($r.Left),$($r.Top) -> click at $x,$y"

# save cursor, click, restore cursor
$cur = New-Object WinClick+POINT
[WinClick]::GetCursorPos([ref]$cur) | Out-Null
[WinClick]::SetCursorPos($x, $y) | Out-Null
Start-Sleep -Milliseconds 120
$down = New-Object WinInput+INPUT
$down.type = [WinInput]::INPUT_MOUSE
$down.mi.dwFlags = [WinInput]::LEFTDOWN
$up = New-Object WinInput+INPUT
$up.type = [WinInput]::INPUT_MOUSE
$up.mi.dwFlags = [WinInput]::LEFTUP
$inputs = New-Object 'WinInput+INPUT[]' 2
$inputs[0] = $down
$inputs[1] = $up
[WinInput]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf($down)) | Out-Null
Start-Sleep -Milliseconds $SettleMs
[WinClick]::SetCursorPos($cur.X, $cur.Y) | Out-Null

[WinClick]::GetWindowRect($hwnd, [ref]$r) | Out-Null
"after click: $($r.Right - $r.Left)x$($r.Bottom - $r.Top) @ $($r.Left),$($r.Top)"
