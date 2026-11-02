# Scans the window's top-right strip with WM_NCHITTEST to locate the native
# caption buttons (HTMINBUTTON=8, HTMAXBUTTON=9, HTCLOSE=20). Hit-testing is
# a passive query — no activation, no input, focus-safe.
# Usage: powershell -File scripts\win-hittest.ps1
param(
  [string]$ExeName = 'electron.exe',
  [string]$Match = 'portfolio-candles'
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinHT {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
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
[WinHT]::SetProcessDPIAware() | Out-Null
$proc = Get-CimInstance Win32_Process -Filter "Name='$ExeName'" |
  Where-Object { $_.ExecutablePath -like "*$Match*" -and $_.CommandLine -notlike "*--type=*" } |
  Select-Object -First 1
if (-not $proc) { "process not found"; exit 1 }
$hwnd = [WinHT]::FindMain([uint32]$proc.ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { "main window not found"; exit 1 }
if ([WinHT]::IsIconic($hwnd)) { [WinHT]::ShowWindow($hwnd, 4) | Out-Null; Start-Sleep -Milliseconds 600 }

$r = New-Object WinHT+RECT
[WinHT]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
"window: ${w}x$($r.Bottom - $r.Top) @ $($r.Left),$($r.Top)"

$names = @{ 1 = 'CLIENT'; 2 = 'CAPTION'; 8 = 'MINBTN'; 9 = 'MAXBTN'; 20 = 'CLOSE'; 10 = 'HELPBTN'; 12 = 'SYSMENU' }
$hits = @()
# scan the top 44 rows, rightmost 160 columns, step 4px
for ($y = 2; $y -le 44; $y += 4) {
  $row = ''
  for ($x = $w - 160; $x -lt ($w - 2); $x += 4) {
    $sx = $r.Left + $x
    $sy = $r.Top + $y
    $lp = [IntPtr]((([uint32]($sy -band 0xFFFF)) -shl 16) -bor ([uint32]($sx -band 0xFFFF)))
    $code = [WinHT]::SendMessage($hwnd, 0x0084, [IntPtr]0, $lp).ToInt64() -band 0xFFFF  # WM_NCHITTEST
    $ch = '.'
    if ($names.ContainsKey([int]$code)) {
      $ch = switch ([int]$code) { 1 {'C'} 2 {'T'} 8 {'m'} 9 {'M'} 20 {'X'} 10 {'h'} 12 {'s'} default {'?'} }
      $hits += "$($names[[int]$code]) @ rel($x,$y)"
    }
    $row += $ch
  }
  "y=$y $row"
}
"--- distinct hits ---"
$hits | Sort-Object -Unique
