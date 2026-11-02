# Diagnostic: reports IsZoomed / WINDOWPLACEMENT / restore-rect of the main
# window, then tries ShowWindow(SW_RESTORE) and reports bounds again.
param(
  [string]$ExeName = 'electron.exe',
  [string]$Match = 'portfolio-candles'
)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinDiag {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr hWnd, out WINDOWPLACEMENT lpwndpl);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct WINDOWPLACEMENT {
    public uint length;
    public uint flags;
    public int showCmd;
    public POINT ptMinPosition;
    public POINT ptMaxPosition;
    public RECT rcNormalPosition;
  }
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
$hwnd = [WinDiag]::FindMain([uint32]$proc.ProcessId)
if ($hwnd -eq [IntPtr]::Zero) { "main window not found"; exit 1 }

$r = New-Object WinDiag+RECT
[WinDiag]::GetWindowRect($hwnd, [ref]$r) | Out-Null
"IsZoomed:        $([WinDiag]::IsZoomed($hwnd))"
"rect:            $($r.Right - $r.Left) x $($r.Bottom - $r.Top) @ $($r.Left),$($r.Top)"
$wp = New-Object WinDiag+WINDOWPLACEMENT
$wp.length = [System.Runtime.InteropServices.Marshal]::SizeOf($wp)
[WinDiag]::GetWindowPlacement($hwnd, [ref]$wp) | Out-Null
"showCmd:         $($wp.showCmd)  (1=normal 2=minimized 3=maximized)"
"normalPosition:  $($wp.rcNormalPosition.Right - $wp.rcNormalPosition.Left) x $($wp.rcNormalPosition.Bottom - $($wp.rcNormalPosition.Top)) @ $($wp.rcNormalPosition.Left),$($wp.rcNormalPosition.Top)"

[WinDiag]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE
Start-Sleep -Milliseconds 1500
[WinDiag]::GetWindowRect($hwnd, [ref]$r) | Out-Null
"after SW_RESTORE: $($r.Right - $r.Left) x $($r.Bottom - $r.Top) @ $($r.Left),$($r.Top)  IsZoomed=$([WinDiag]::IsZoomed($hwnd))"
