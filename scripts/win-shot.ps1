# Captures a specific app window (by exe-name substring) including its native
# frame. Uses PrintWindow(PW_RENDERFULLCONTENT) so it never steals focus
# (the machine may be in active use).
# Usage: powershell -File scripts\win-shot.ps1 -ExeName "electron.exe" -Match "portfolio-candles" -Out <file.png>
param(
  [Parameter(Mandatory = $true)][string]$ExeName,
  [Parameter(Mandatory = $true)][string]$Match,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$WaitMs = 1200
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinShot {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint nFlags);
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
[WinShot]::SetProcessDPIAware() | Out-Null
$proc = Get-CimInstance Win32_Process -Filter "Name='$ExeName'" |
  Where-Object { $_.ExecutablePath -like "*$Match*" -and $_.CommandLine -notlike "*--type=*" } |
  Select-Object -First 1
if (-not $proc) { "process not found: $ExeName *$Match*"; exit 1 }
$hwnd = [WinShot]::FindMain([uint32]$proc.ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { "main window not found for PID $($proc.ProcessId)"; exit 1 }
Start-Sleep -Milliseconds $WaitMs
$r = New-Object WinShot+RECT
[WinShot]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
if ($w -le 0 -or $h -le 0) { "bad rect"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
# 2 = PW_RENDERFULLCONTENT: renders GPU/Chromium windows too
$ok = [WinShot]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $ok) { "PrintWindow failed"; exit 1 }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
"saved $Out ($w x $h @ $($r.Left),$($r.Top))"
