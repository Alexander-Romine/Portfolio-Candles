using System;
using System.Text;
using System.Runtime.InteropServices;

/* send-behind.exe <hwnd>
   Places the given window directly ABOVE the Windows desktop layer
   (Progman / WorkerW cluster) so every application window stays above it —
   a "background app" window. Never raises the window; never activates it.

   SetWindowPos(hWndInsertAfter) semantics (verified empirically): the named
   window ends up ABOVE the moved window, so we name the last non-desktop
   window in z-order (the one that sits directly above the desktop cluster). */

class SendBehind {
  delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  static bool seenDesktop = false;
  static IntPtr firstDesktop = IntPtr.Zero;
  static IntPtr lastAboveCluster = IntPtr.Zero;

  static bool Scan(IntPtr h, IntPtr l) {
    if (!IsWindowVisible(h)) return true;
    StringBuilder sb = new StringBuilder(256);
    GetClassName(h, sb, 256);
    string c = sb.ToString();
    if (c == "Progman" || c == "WorkerW") {
      if (!seenDesktop) {
        seenDesktop = true;
        firstDesktop = h;
      }
      return false; // cluster found; everything above it has been recorded
    }
    lastAboveCluster = h; // keep the deepest non-desktop window above the cluster
    return true;
  }

  static int Main(string[] args) {
    if (args.Length < 1) return 2;
    long v;
    if (!long.TryParse(args[0], out v) || v == 0) return 3;
    IntPtr hwnd = new IntPtr(v);
    SetProcessDPIAware();
    EnumWindows(Scan, IntPtr.Zero);

    IntPtr insert;
    if (seenDesktop && lastAboveCluster != IntPtr.Zero) insert = lastAboveCluster; // above desktop, below apps
    else if (seenDesktop) insert = firstDesktop; // degenerate: cluster at top
    else insert = new IntPtr(1); // no desktop window found: HWND_BOTTOM

    const uint flags = 0x0001 | 0x0002 | 0x0010; // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
    return SetWindowPos(hwnd, insert, 0, 0, 0, 0, flags) ? 0 : 4;
  }
}
