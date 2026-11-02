using System;
using System.Text;
using System.Runtime.InteropServices;

/* win-frame.exe <pid>
   Finds the given process's main app window (the visible Chrome_WidgetWin_1)
   and ORs WS_THICKFRAME into its style. A transparent Electron window is
   created without the thickframe bit, which leaves native maximize/restore,
   drag-resize and Aero Snap inert; this restores them. Never activates,
   raises or moves the window. */

class WinFrame {
  delegate bool EnumProc(IntPtr h, IntPtr l);

  const int GWL_STYLE = -16;
  const int WS_THICKFRAME = 0x00040000;

  static uint targetPid;
  static IntPtr found = IntPtr.Zero;

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);

  static bool Scan(IntPtr h, IntPtr l) {
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid != targetPid || !IsWindowVisible(h)) return true;
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, 256);
    if (sb.ToString() == "Chrome_WidgetWin_1") {
      found = h;
      return false;
    }
    return true;
  }

  static int Main(string[] args) {
    if (args.Length < 1) return 2;
    long v;
    if (!long.TryParse(args[0], out v) || v <= 0) return 3;
    targetPid = (uint)v;

    EnumWindows(Scan, IntPtr.Zero);
    if (found == IntPtr.Zero) return 4;

    int style = GetWindowLong(found, GWL_STYLE);
    if ((style & WS_THICKFRAME) == 0) SetWindowLong(found, GWL_STYLE, style | WS_THICKFRAME);
    return 0;
  }
}
