param([string]$ProcName = "Portfolio Candles")

# Lab: (1) show the app's main window if it's in the tray, (2) determine
# SetWindowPos(hWndInsertAfter) semantics empirically, (3) dump the bottom
# of the z-order. Run while the app is running.
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class ZLab {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

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

  public static bool Place(IntPtr h, IntPtr after) {
    return SetWindowPos(h, after, 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
  }

  public static void Show(IntPtr h) {
    ShowWindow(h, 9); // SW_RESTORE
  }
}
"@
[ZLab]::SetProcessDPIAware() | Out-Null

$procs = Get-Process -Name $ProcName -ErrorAction SilentlyContinue
if (-not $procs) { Write-Host "app not running ($ProcName)"; exit 1 }
$pids = @($procs | ForEach-Object { [uint32]$_.Id })

$all = [ZLab]::List()
$app = @($all | Where-Object { $pids -contains $_.Pid })
$main = $app | Where-Object { $_.Title -like "*Portfolio Candles*" } | Select-Object -First 1
$widget = $app | Where-Object { $_.Title -eq "Widget" } | Select-Object -First 1

Write-Host ("app windows: " + (($app | ForEach-Object { "'{0}'(vis={1})" -f $_.Title, $_.Vis }) -join " "))
if (-not $main) { Write-Host "main window not found at all"; exit 1 }
if (-not $main.Vis) {
  Write-Host "main window hidden (tray) -> showing"
  [ZLab]::Show($main.Hwnd) | Out-Null
  Start-Sleep -Milliseconds 900
  $all = [ZLab]::List()
  $main = $all | Where-Object { $_.Hwnd -eq $main.Hwnd } | Select-Object -First 1
}
if (-not $widget) { Write-Host "widget not found (enable it first)"; exit 1 }

Write-Host ("main   hwnd={0} vis={1}" -f $main.Hwnd, $main.Vis)
Write-Host ("widget hwnd={0} vis={1}" -f $widget.Hwnd, $widget.Vis)

function Get-Order {
  $l = [ZLab]::List()
  $mi = -1; $wi = -1
  for ($i = 0; $i -lt $l.Count; $i++) {
    if ($l[$i].Hwnd -eq $main.Hwnd) { $mi = $i }
    if ($l[$i].Hwnd -eq $widget.Hwnd) { $wi = $i }
  }
  return @{ m = $mi; w = $wi }
}

$o0 = Get-Order
Write-Host ("BEFORE: mainIdx={0} widgetIdx={1} (lower idx = higher in z / more in front)" -f $o0.m, $o0.w)

# --- experiment: Place(widget, main) ---
[ZLab]::Place($widget.Hwnd, $main.Hwnd) | Out-Null
Start-Sleep -Milliseconds 400
$o = Get-Order
Write-Host ("AFTER Place(widget, main): mainIdx={0} widgetIdx={1}" -f $o.m, $o.w)
if ($o.w -lt $o.m) { Write-Host "SEMANTICS: widget went ABOVE the named window (named ends up below ours)" }
elseif ($o.w -gt $o.m) { Write-Host "SEMANTICS: widget went BELOW the named window (named ends up above ours)" }
else { Write-Host "SEMANTICS: no change" }

Write-Host "=== bottom 14 visible windows of z-order ==="
$z = [ZLab]::List()
$vis = @($z | Where-Object { $_.Vis })
$start = [Math]::Max(0, $vis.Count - 14)
for ($i = $start; $i -lt $vis.Count; $i++) {
  $e = $vis[$i]
  $t = $e.Title.Substring(0, [Math]::Min(40, $e.Title.Length))
  Write-Host ("  #{0} class={1} title={2}" -f $i, $e.Cls, $t)
}
