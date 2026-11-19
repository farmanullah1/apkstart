# ApkStart window agent (ASCII only).
# A single long-lived helper that owns every Win32 trick we need:
#   * re-parents the Android emulator Qt window into an ApkStart BrowserWindow (one clean window,
#     no emulator sidebar, no emulator title bar);
#   * hides the floating emulator toolbar window that shows the volume/camera/back rail;
#   * rotates the device with Ctrl+Left / Ctrl+Right and reports the new window size;
#   * runs an opt-in WH_MOUSE_LL hook so right click becomes Android BACK, wheel
#     becomes a coalesced swipe, and (optionally) side buttons become BACK / FORWARD.
#     Left click is deliberately left alone: Qt already maps it to a finger tap.
# Everything is P/Invoke from the .NET Framework that ships with Windows 10/11,
# so there is no native binary to compile, sign or ship.
# Protocol: TCP on 127.0.0.1, one JSON object per line. First stdout line is "PORT=<n>".
param([int]$Port = 0)

$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public class ApkAgent
{
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct MSLLHOOKSTRUCT { public POINT Pt; public int MouseData; public int Flags; public int Time; public IntPtr Extra; }
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr Hwnd; public uint Message; public IntPtr WParam; public IntPtr LParam; public uint Time; public int X; public int Y; }
    // Minimal PROCESS_BASIC_INFORMATION: enough to read InheritedFromUniqueProcessId.
    [StructLayout(LayoutKind.Sequential)] public struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr ParentPid; }

    public delegate bool EnumProc(IntPtr h, IntPtr p);
    public delegate IntPtr HookProc(int code, IntPtr wp, IntPtr lp);

    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool SetWindowTextW(IntPtr h, string s);
    // Set the icon on the emulator's native window (in standalone-window mode, the taskbar / Alt+Tab shows the current app icon)
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadImageW(IntPtr inst, string file, uint type, int w, int h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr SendMessageW(IntPtr h, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr c, IntPtr p);
    // High DPI: appwin.js passes physical pixels. Without declaring DPI awareness, Windows treats them as logical pixels and scales them once more,
    // so the embedded emulator window is larger than the host (1.5x at 150% scaling) → right/bottom cropped, click offset (issue #40).
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr c);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint f);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
    // Clip the visible area of the embedded window: remove the frame that presses onto the title bar
    [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, HookProc p, IntPtr mod, uint thread);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
    [DllImport("user32.dll")] static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach, uint attachTo, bool fAttach);
    [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern bool ScreenToClient(IntPtr h, ref POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);

    const int GWL_STYLE = -16;
    const int GWL_EXSTYLE = -20;
    const uint WS_CHILD = 0x40000000;
    const uint WS_POPUP = 0x80000000;
    const int WS_CAPTION = 0x00C00000;
    const int WS_THICKFRAME = 0x00040000;
    const int WS_MINIMIZEBOX = 0x00020000;
    const int WS_MAXIMIZEBOX = 0x00010000;
    const int WS_SYSMENU = 0x00080000;
    const int WS_BORDER = 0x00800000;
    const int WS_CLIPCHILDREN = 0x02000000;
    const int WS_CLIPSIBLINGS = 0x04000000;
    const int WS_EX_APPWINDOW = 0x00040000;
    const int WS_EX_TOOLWINDOW = 0x00000080;
    const int WS_EX_CLIENTEDGE = 0x00000200;
    const int WS_EX_WINDOWEDGE = 0x00000100;
    const uint SWP_NOZORDER = 0x0004;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;
    const uint SWP_FRAMECHANGED = 0x0020;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOSIZE = 0x0001;

    static IntPtr _host = IntPtr.Zero;
    static IntPtr _emu = IntPtr.Zero;
    static IntPtr _chromeRender = IntPtr.Zero;
    static IntPtr _hook = IntPtr.Zero;
    static HookProc _hookProc = null;
    static Thread _hookThread = null;
    static volatile bool _hookRun = false;
    static uint _hookTid = 0;
    static readonly ManualResetEvent _hookReady = new ManualResetEvent(false);
    static readonly ConcurrentQueue<string> _events = new ConcurrentQueue<string>();
    static long _lastToolSweep = 0;
    static long _embedAt = 0;
    // Resident suppression: on by default from boot, suppressing the emulator main window + toolbar + console black window.
    // Unlike the old logic that turned off "when embed completes", this is **resident** — the sweep skips the one window already embedded
    // into our window, and hides everything else (including the black window that returns to the desktop after ApkStart exits).
    static volatile bool _quiet = true;
    static volatile bool _perfMode = false;
    static volatile bool _detachedMode = false;
    static long _bootHideSweep = 0;
    // Scan timestamp specialized for the console black window. When the emulator lifts qemu, Windows gives this console
    // a new window (Windows Terminal on Win11), which only lives 200~300ms; the main patrol
    // at 250ms per round is not stable enough, so for the first 15 seconds a denser rhythm is used to separately scan console-class windows once more.
    static long _consoleSweep = 0;
    // Fallback timeout: in case embed never comes (the user only opened ApkStart and did not click an app),
    // the 120ms-per-round scan must not run forever burning CPU. Each time a window is truly hidden, the deadline is extended.
    static long _bootHideUntil = 0;
    static long _bootHideStart = Environment.TickCount;
    // "Guard" deadline after disconnect (TickCount). See the sock == null branch in Serve().
    static long _lingerUntil = 0;

    // Which windows count as "ours": only those created by a process whose exe lives
    // inside one of these directories (the runtime root / bundled engine dir).
    // This is the whole fix for "ApkStart conflicts with WeChat": WeChat 4.x is Qt 6
    // too (its windows are QWindowIcon / QWindowToolSaveBits), so any matching that
    // relied on window class names alone could hide or even re-parent WeChat's own
    // windows. Class names are never unique; the owning process's path is.
    static readonly System.Collections.Generic.List<string> _scopeDirs = new System.Collections.Generic.List<string>();
    static readonly System.Collections.Generic.Dictionary<uint, bool> _oursCache = new System.Collections.Generic.Dictionary<uint, bool>();
    // PID of the ApkStart main process. The only window we are ever allowed to embed
    // into / swallow clicks for. Guard against a recycled HWND: if _host later belongs
    // to somebody else, the mouse hook must pass events through instead of eating them.
    static uint _appPid = 0;
    static uint _hostPid = 0;

    // Hook options. All three default to OFF: an "hook on" without options must
    // never swallow anybody's clicks. JS sends the real config on every enable.
    static volatile int _optRight = 0;
    static volatile int _optWheel = 0;
    static volatile int _optSide = 0;

    // Wheel coalescing: Qt would turn every single notch into a separate touch
    // gesture (visible stutter). We accumulate deltas for a short window and
    // hand one normalized position to the JS side, which injects a single swipe.
    static readonly object _wheelLock = new object();
    static int _wheelDx = 0, _wheelDy = 0;
    static double _wheelNx = 0.5, _wheelNy = 0.5;
    static long _wheelFirst = 0, _wheelLast = 0;

    // ------------------------------------------------------------------ ownership
    // Scope is set by the JS side before anything is hidden ("scope" command).
    // With no scope the agent refuses to touch any window: leaving one black console
    // around is a cosmetic bug, hiding a user's WeChat window is not.
    static void SetScope(string raw)
    {
        _scopeDirs.Clear();
        string[] pieces = (raw == null ? "" : raw).Split(new char[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
        foreach (string piece in pieces)
        {
            string d = piece.Trim();
            if (d.Length == 0) continue;
            try { d = System.IO.Path.GetFullPath(d); } catch { }
            if (!d.EndsWith("\\")) d += "\\";
            _scopeDirs.Add(d.ToLowerInvariant());
        }
        lock (_oursCache) { _oursCache.Clear(); }
    }

    static bool IsOurs(uint pid)
    {
        if (pid == 0 || _scopeDirs.Count == 0) return false;
        lock (_oursCache)
        {
            bool hit;
            if (_oursCache.TryGetValue(pid, out hit)) return hit;
        }
        bool ours = false;
        try
        {
            using (Process p = Process.GetProcessById((int)pid))
            {
                string file = null;
                try { file = p.MainModule.FileName; } catch { file = null; }
                if (!string.IsNullOrEmpty(file))
                {
                    string low = file.ToLowerInvariant();
                    for (int i = 0; i < _scopeDirs.Count; i++)
                        if (low.StartsWith(_scopeDirs[i], StringComparison.Ordinal)) { ours = true; break; }
                }
            }
        }
        catch { ours = false; }
        lock (_oursCache)
        {
            // PIDs get recycled; a bounded cache is enough (one entry per live process).
            if (_oursCache.Count > 400) _oursCache.Clear();
            _oursCache[pid] = ours;
        }
        return ours;
    }

    static uint ParentOf(uint pid)
    {
        IntPtr h = IntPtr.Zero;
        try
        {
            h = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
            if (h == IntPtr.Zero) return 0;
            PBI pbi = new PBI();
            int len;
            if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PBI)), out len) != 0) return 0;
            return (uint)pbi.ParentPid.ToInt64();
        }
        catch { return 0; }
        finally { if (h != IntPtr.Zero) CloseHandle(h); }
    }

    // Console windows belong to conhost.exe, not to the program that owns the console,
    // so the window pid is never the emulator's. Walk conhost's parents instead.
    static bool ConsoleOwnedByUs(uint pid)
    {
        uint p = ParentOf(pid);
        for (int i = 0; i < 3 && p != 0; i++)
        {
            if (IsOurs(p)) return true;
            p = ParentOf(p);
        }
        return false;
    }

    static bool IsOurConsole(IntPtr h)
    {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (IsOurs(pid) || ConsoleOwnedByUs(pid)) return true;
        if (_scopeDirs.Count == 0) return false;
        // Windows titles a console with the image path it launched, so the runtime
        // directory shows up verbatim. Precise enough to never match a stray terminal.
        string title = TitleOf(h).ToLowerInvariant();
        for (int i = 0; i < _scopeDirs.Count; i++)
            if (title.IndexOf(_scopeDirs[i], StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    // ------------------------------------------------------------------ window discovery
    static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(h, sb, 256);
        return sb.ToString();
    }
    static string TitleOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(h, sb, 512);
        return sb.ToString();
    }

    // The emulator draws its framebuffer in a "QWindowIcon" top level window titled
    // "Android Emulator - <avd>:<port>"; the volume/rotate rail lives in a separate
    // small "QWindowTool*" window we hide.
    //
    // Note: during emulator boot (and once the resident suppressor has hidden it) this window is **invisible**,
    // so do not filter on IsWindowVisible here -- otherwise we never find a window to embed,
    // and the user just sees an all-black app window. Instead: accept any window titled
    // Android Emulator, and prefer large visible ones. Toolbar / tooltip windows (QWindowTool) are too small and get filtered out by the area threshold.
    //
    // ApkStart renames this window to the app name (see the "title" command), so detection
    // must also accept the renamed title. A volatile field remembers the title we set.
    public static string _ourTitle = "";
    // App icon file path: Qt reverts the icon to the default green robot whenever it rebuilds the window, so the sweep keeps re-applying it.
    public static string _ourIconFile = "";
    public static IntPtr _ourIconSmall = IntPtr.Zero;
    public static IntPtr _ourIconBig = IntPtr.Zero;
    static bool LooksLikeEmulator(string title)
    {
        if (title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        if (_ourTitle.Length > 0 && String.Equals(title, _ourTitle, StringComparison.Ordinal)) return true;
        return false;
    }
    static IntPtr FindEmulator()
    {
        IntPtr best = IntPtr.Zero;
        long bestScore = long.MinValue;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            // Ownership comes first. "QWindowIcon" is the class of EVERY Qt top level
            // window, and WeChat 4.x / MuMu / music players are Qt too -- matching on
            // the class alone is how the wrong window ended up hidden or re-parented.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowIcon", StringComparison.Ordinal) < 0) return true;
            string title = TitleOf(h);
            bool named = LooksLikeEmulator(title);
            if (!named && !IsWindowVisible(h)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            long area = (long)(r.R - r.L) * (r.B - r.T);
            if (area < 200 * 200) return true;   // toolbar / tooltip, not the picture window
            // prefer large visible windows, hidden ones come second
            long score = area + (IsWindowVisible(h) ? 1000000000L : 0);
            if (score > bestScore) { bestScore = score; best = h; }
            return true;
        }, IntPtr.Zero);
        return best;
    }

    // Diagnostics: list top-level windows (class / title / pid / size / visibility).
    // Used to verify that launching the app only shows the app UI -- neither the emulator main window nor the netsim console may be among them.
    static string ListWindows(bool includeHidden)
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            bool vis = IsWindowVisible(h);
            if (!vis && !includeHidden) return true;
            string cls = ClassOf(h);
            string title = TitleOf(h);
            // There are hundreds of hidden windows on a real system; only look at ones related to emulator / Qt
            if (!vis && cls.IndexOf("QWindow", StringComparison.Ordinal) < 0
                && title.IndexOf("Android Emulator", StringComparison.OrdinalIgnoreCase) < 0) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            int w = r.R - r.L, hh = r.B - r.T;
            if (vis && (w < 40 || hh < 40)) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append(",\"pid\":").Append(pid)
              .Append(",\"w\":").Append(w)
              .Append(",\"h\":").Append(hh)
              .Append(",\"vis\":").Append(vis ? "true" : "false")
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static void HideToolWindows()
    {
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("QWindowTool", StringComparison.Ordinal) < 0) return true;
            // QWindowToolSaveBits is what Qt uses for menus, tooltips and popup panels --
            // WeChat's emoji panel / right-click menu included. Only hide our own.
            uint owner;
            GetWindowThreadProcessId(h, out owner);
            if (!IsOurs(owner)) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) > 200) return true;   // the framebuffer window also uses this class
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // Boot phase: hide the black qemu / emulator console windows so no "command prompt" flashes up.
    // They are console-subsystem processes, and Node's windowsHide cannot reach grandchildren, so Win32 has to keep suppressing them.
    //
    // Key trap: since Windows 10 the console window really belongs to conhost.exe, so GetWindowThreadProcessId
    // returns conhost's pid, not the emulator's -- the old implementation matched a pid allowlist,
    // so not one of these black windows could be hidden (that is where "clicked and nothing happened, a cmd box flashed first" came from).
    // Now: hide when the pid matches OR the window title matches (the title is the path of the launched exe); either hit is enough.
    static void HideConsoleWindows()
    {
        if (_scopeDirs.Count == 0) return;   // no scope: never touch anybody's terminal

        // Scan for console windows first; if there are none, skip process enumeration (GetProcessesByName is not cheap)
        var consoles = new System.Collections.Generic.List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                consoles.Add(h);
            return true;
        }, IntPtr.Zero);
        if (consoles.Count == 0) return;

        // The old implementation also treated any title containing emulator / qemu / netsim as ours,
        // which would also hide the user's own terminal (titled with a path such as D://Android//emulator).
        // Only two kinds of evidence count now: conhost's parent chain reaches our runtime directory,
        // or the title contains the absolute path of our runtime directory (Windows uses the image path as the console title).
        long now = Environment.TickCount;
        foreach (IntPtr h in consoles)
        {
            if (IsOurConsole(h)) { ShowWindow(h, 0); continue; }
            // Third piece of evidence (Windows 11 only): once Windows Terminal became the default console host,
            // the console window the emulator opens for qemu belongs to WindowsTerminal.exe --
            // the pid is not ours, the parent chain does not reach us, and the title is often just "Terminal",
            // so neither earlier rule matches and a black box flashes for 200-300ms on every boot.
            // Here all three conditions must hold: absent before boot + appeared within 20s of boot + empty or Terminal title.
            // Terminals the user opened themselves usually have a title already (PowerShell, some path) and are left alone;
            // and even if one were caught, it is only hidden, never killed.
            if (_bootHideStart != 0 && now - _bootHideStart < 20000
                && !_consolesBeforeBoot.Contains(h.ToInt64()))
            {
                string t = TitleOf(h);
                string tl = t.ToLowerInvariant();
                // The title changes in practice: empty, "Terminal", or "Windows Terminal"
                // (it depends on the Windows Terminal version and whether it picked up a shell title). Only require that
                // it looks like a console host -- an empty title, or one containing terminal.
                // Terminals the user already had are recorded in _consolesBeforeBoot and are safe;
                // and even if one were caught, it is only hidden, never killed.
                bool plain = t.Length == 0 || tl.IndexOf("terminal", StringComparison.Ordinal) >= 0;
                if (plain)
                {
                    ShowWindow(h, 0);
                }
            }
        }
    }

    // Record the console windows that existed at the moment boot hiding starts (boothide).
    // Windows Terminal puts our qemu console into a brand new window that cannot be attributed by pid /
    // parent / title; "did not exist before boot, appeared after" is the most reliable rule we have.
    static System.Collections.Generic.HashSet<long> _consolesBeforeBoot =
        new System.Collections.Generic.HashSet<long>();

    static void SnapshotConsoles()
    {
        _consolesBeforeBoot.Clear();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            if (cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0)
                _consolesBeforeBoot.Add(h.ToInt64());
            return true;
        }, IntPtr.Zero);
    }

    // Diagnostics: list the currently visible console (black) windows and their ownership, for the verification scripts in tools/.
    // ours=true means this is the emulator/qemu console window.
    static string ListConsoles()
    {
        var sb = new StringBuilder();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string cls = ClassOf(h);
            bool isConsole = cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0;
            if (!isConsole) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            string title = TitleOf(h);
            bool ours = IsOurConsole(h);
            if (sb.Length > 0) sb.Append(",");
            sb.Append("{\"ours\":").Append(ours ? "true" : "false")
              .Append(",\"pid\":").Append(pid)
              .Append(",\"cls\":").Append(JsonStr(cls))
              .Append(",\"title\":").Append(JsonStr(title))
              .Append("}");
            return true;
        }, IntPtr.Zero);
        return sb.ToString();
    }

    static string JsonStr(string s)
    {
        var b = new StringBuilder("\"");
        foreach (char c in s == null ? "" : s)
        {
            if (c == '"' || c == '\\') b.Append('\\').Append(c);
            else if (c >= ' ') b.Append(c);
        }
        b.Append("\"");
        return b.ToString();
    }

    // Safety net: hide any *extra* top-level visible window created by one of our runtime processes.
    // Besides the emulator main window (which gets embedded into the host), emulator / qemu / netsimd / adb can
    // pop up transient things (Qt tooltips, crash dialogs, volume bars, log windows...).
    // Previously each class name was listed by hand and a single miss caused a flash; now windows are judged by
    // "the owning process lives in our runtime directory", which covers more. The host window and the emulator window itself are out of scope and never touched.
    static void HideStrayWindows()
    {
        if (_scopeDirs.Count == 0) return;
        IntPtr embeddedRoot = _emu;
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            if (h == embeddedRoot) return true;
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (!IsOurs(pid)) return true;
            string cls = ClassOf(h);
            // Only hide clear popup classes: Qt tooltips / dialogs / consoles.
            // Never touch QWindowIcon / subWin -- that is the LCD being embedded, hiding it gives a black screen with dead clicks.
            bool safe = cls.IndexOf("QWindowTool", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("ConsoleWindowClass", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("CASCADIA_HOSTING_WINDOW_CLASS", StringComparison.Ordinal) >= 0
                     || cls.IndexOf("Qt", StringComparison.Ordinal) < 0 && cls.IndexOf("Chrome", StringComparison.Ordinal) < 0;
            if (!safe) return true;
            RECT r;
            if (!GetWindowRect(h, out r)) return true;
            if ((r.R - r.L) < 8 && (r.B - r.T) < 8) return true;
            ShowWindow(h, 0);
            return true;
        }, IntPtr.Zero);
    }

    // Resident suppression sweep: hide the emulator window whenever it is not a child of one of our windows.
    // That way, whether the emulator is booting, prewarming, or ApkStart has already exited (the window was re-parented
    // to the desktop and is a top-level window again), the user never sees the black "Android Emulator - apkstart5554" window.
    // The toolbar (QWindowTool) and all console windows (qemu / netsimd / emulator) are suppressed as well.

    // At embed time Electron's web render child may not exist yet and FindChromeRender returns 0,
    // so the simulator is attached as a direct child of the host (a sibling of the web layer) -- the web layer then
    // keeps covering the picture and eating the mouse. The resident sweep re-parents it as soon as the web layer appears.
    static void EnsureReparent()
    {
        if (_emu == IntPtr.Zero || _host == IntPtr.Zero) return;
        if (_chromeRender == IntPtr.Zero || !IsWindow(_chromeRender))
            _chromeRender = FindChromeRender(_host);
        if (_chromeRender == IntPtr.Zero) return;
        IntPtr ep = GetParent(_emu);
        if (ep == _chromeRender) return;
        if (ep != _host && ep != IntPtr.Zero) return;   // another host, leave it alone
        RECT r;
        if (!GetWindowRect(_emu, out r)) return;
        RECT hr;
        if (!GetWindowRect(_host, out hr)) return;
        SetParent(_emu, _chromeRender);
        // Coordinates are relative to the web layer client area (identical to the host's); keep the original screen position
        SetWindowPos(_emu, IntPtr.Zero, r.L - hr.L, r.T - hr.T,
                     r.R - r.L, r.B - r.T, 0x0004 | 0x0010 | 0x0040);
    }

    static void QuietSweep()
    {
        // Detached-window mode: the emulator window is the one the user is actually looking at, so it must never be suppressed
        // nor Fit to the host client area. Skip every suppression step here.
        if (_detachedMode)
        {
            // Qt resets the title to "Android Emulator - ..." on resolution change / window rebuild.
            // Re-apply once per sweep so the taskbar always shows ApkStart (or the app name).
            if (_ourTitle.Length > 0 && _emu != IntPtr.Zero
                && !String.Equals(TitleOf(_emu), _ourTitle, StringComparison.Ordinal))
                SetWindowTextW(_emu, _ourTitle);
            // Qt reverts to the default green robot icon after a resolution change / rebuild; re-apply once per sweep.
            // A non-zero WM_GETICON means our icon is already set, so skip; otherwise resend the cached handle.
            if (_emu != IntPtr.Zero && (_ourIconSmall != IntPtr.Zero || _ourIconBig != IntPtr.Zero)
                && SendMessageW(_emu, 0x007F, new IntPtr(1), IntPtr.Zero) == IntPtr.Zero)
            {
                if (_ourIconSmall != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(0), _ourIconSmall);
                if (_ourIconBig != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(1), _ourIconBig);
            }
            HideConsoleWindows();
            HideStrayWindows();
            return;
        }
        EnsureReparent();
        // Size self-healing: after the host is maximized/resized Electron's chrome layer often fails to grow with it,
        // leaving only a strip in the top-left corner. Re-fit every sweep (Fit recomputes from the host client area;
        // while the size is unchanged SetWindowPos costs essentially nothing).
        if (_emu != IntPtr.Zero && _host != IntPtr.Zero) Fit(-8, 30, 640, 480, false, 0);
        IntPtr ep = _emu != IntPtr.Zero ? GetParent(_emu) : IntPtr.Zero;
        bool embedded = _emu != IntPtr.Zero && ep != IntPtr.Zero
                     && (ep == _host || ep == _chromeRender);
        IntPtr e = embedded ? _emu : FindEmulator();
        if (!embedded && e != IntPtr.Zero && IsWindowVisible(e)) ShowWindow(e, 0);
        HideToolWindows();
        HideConsoleWindows();
        HideStrayWindows();
        if (!embedded && e != IntPtr.Zero) _bootHideUntil = Environment.TickCount + 5000;
    }

    // Only our own runtime counts. The old version returned true for ANY process named
    // "emulator" -- other emulators (MuMu / LDPlayer ship their own) kept the guard alive.
    static bool AnyEmulatorProcess()
    {
        if (_scopeDirs.Count == 0) return false;
        try
        {
            string[] names = { "qemu-system-x86_64", "qemu-system-x86_64-headless", "emulator", "emulator-headless", "netsimd" };
            for (int i = 0; i < names.Length; i++)
            {
                Process[] all = Process.GetProcessesByName(names[i]);
                for (int j = 0; j < all.Length; j++)
                    if (IsOurs((uint)all[j].Id)) return true;
            }
        }
        catch { }
        return false;
    }

    // ------------------------------------------------------------------ embed / detach

    // Find the Chromium render child window inside the host window.
    // If Electron's web layer (Chrome_RenderWidgetHostHWND) and the emulator window are both direct
    // children of the host they are siblings, and Electron keeps raising the web layer to the front --
    // so the web layer's black background covers the Android picture and eats all mouse input ("black bars /
    // not filling / clicks dead / cannot press Allow" are all this one cause).
    // Attaching the emulator as a **child of the web layer** gives it Z-order and hit-testing priority for free.
    static IntPtr FindChromeRender(IntPtr host)
    {
        IntPtr found = IntPtr.Zero;
        EnumChildWindows(host, delegate(IntPtr c, IntPtr p)
        {
            if (ClassOf(c).IndexOf("Chrome_RenderWidgetHostHWND", StringComparison.Ordinal) >= 0)
            {
                found = c;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static bool Embed(IntPtr host, IntPtr emu)
    {
        if (host == IntPtr.Zero || emu == IntPtr.Zero) return false;
        HideToolWindows();
        // The web layer child fills the host client area and shares its coordinate system, so the rect passed to Fit needs no adjustment.
        IntPtr parent = FindChromeRender(host);
        if (parent == IntPtr.Zero) parent = host;   // fall back to the old behaviour rather than failing to start
        SetParent(emu, parent);
        uint style = (uint)GetWindowLong(emu, GWL_STYLE);
        style &= ~WS_POPUP;
        style &= ~(uint)(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_BORDER);
        style |= WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS;
        SetWindowLong(emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(emu, GWL_EXSTYLE);
        ex &= ~(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE);
        SetWindowLong(emu, GWL_EXSTYLE, ex);
        // Older versions set a window region on this window; clear it on reuse or hit-testing stays offset
        SetWindowRgn(emu, IntPtr.Zero, false);
        return true;
    }

    // HWND_TOP: Chromium's render child and the emulator are sibling child windows,
    // so without raising it Chromium's black layer covers it (the user sees a black screen).
    static readonly IntPtr HWND_TOP = new IntPtr(1);
    static void Fit(int x, int y, int w, int h, bool frame, int clipTop)
    {
        if (_emu == IntPtr.Zero) return;
        // Fit is called by JS on every resize, so the web layer is guaranteed to exist by now.
        // Make sure the emulator is attached beneath the web layer (as a sibling it would be covered and lose the mouse).
        if (_host != IntPtr.Zero)
        {
            IntPtr cr = FindChromeRender(_host);
            if (cr != IntPtr.Zero)
            {
                _chromeRender = cr;
                IntPtr cur = GetParent(_emu);
                if (cur != cr && (cur == _host || cur == IntPtr.Zero))
                {
                    SetParent(_emu, cr);
                    // Coordinates are relative to the web layer client area, same as the host, so keep the incoming x/y
                }
            }
        }
        // Self-correct the size from the **host window client area** instead of trusting the w/h from JS
        // or the Chrome render layer's own size.
        //
        // Why: after Electron maximizes, the host window becomes 1936x1048 while the inner
        // Chrome_RenderWidgetHostHWND stays at its old size (measured 532x984) -- and the emulator
        // window, being a child of the chrome layer, is clipped by its parent, so the picture takes only a strip
        // in the top-left with empty space on the right (the "not filling after maximize/fullscreen" in user screenshots).
        // So stretch the chrome layer to the host client area first, then size the emu to that client area.
        if (_host != IntPtr.Zero)
        {
            RECT hc;
            if (GetClientRect(_host, out hc))
            {
                int cw = hc.R - hc.L;
                int chh = hc.B - hc.T;
                if (cw > 200 && chh > 200)
                {
                    if (_chromeRender != IntPtr.Zero)
                    {
                        RECT crc;
                        if (GetWindowRect(_chromeRender, out crc))
                        {
                            if ((crc.R - crc.L) != cw || (crc.B - crc.T) != chh)
                            {
                                SetWindowPos(_chromeRender, IntPtr.Zero, 0, 0, cw, chh,
                                    SWP_NOZORDER | SWP_NOACTIVATE);
                            }
                        }
                    }
                    // Keep the -8 overflow on x/y (pushes Qt's 8px grey border out of view),
                    // width/height = client area + 2*8; the 38px title bar is covered by the host-drawn bar.
                    x = -8;
                    y = 38 - 8;
                    w = cw + 16;
                    h = (chh - 38) + 16;
                }
            }
        }
        if (w < 16) w = 16;
        if (h < 16) h = 16;
        // Only allow showing a window that is genuinely embedded in one of ours.
        // If embed failed (window not ready / handle changed), Fit must never treat it as a detached window
        // and push it onto the desktop -- that is exactly the black "Android Emulator - apkstart5554" window users saw.
        IntPtr ep = GetParent(_emu);
        bool embedded = ep != IntPtr.Zero
                     && (ep == _host || ep == _chromeRender);
        if (!embedded)
        {
            ShowWindow(_emu, 0);
            return;
        }
        // SWP_FRAMECHANGED forces Windows to recompute the whole non-client area and
        // repaint it. It is needed exactly once (right after SetParent); repeating it
        // on every periodic sweep caused visible stutter and wasted GPU/CPU.
        uint flags = SWP_NOACTIVATE | SWP_SHOWWINDOW | (frame ? SWP_FRAMECHANGED : 0u);
        SetWindowPos(_emu, HWND_TOP, x, y, w, h, flags);
        // Never set a window region on the embedded window: once a Qt/GL child window has a region, hit-testing and
        // input coordinate mapping go wrong (dead clicks / buttons that cannot be pressed), and after a rotate or resize
        // the stale region leaves black edges on all four sides. The 8px overflow is covered by the host-drawn title bar instead.
    }

    static void Raise()
    {
        if (_emu == IntPtr.Zero) return;
        SetWindowPos(_emu, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    static void Detach()
    {
        if (_emu == IntPtr.Zero) return;
        SetParent(_emu, IntPtr.Zero);
        uint style = (uint)GetWindowLong(_emu, GWL_STYLE);
        style &= ~WS_CHILD;
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
        SetWindowLong(_emu, GWL_STYLE, (int)style);
        int ex = GetWindowLong(_emu, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(_emu, GWL_EXSTYLE, ex);
        SetWindowPos(_emu, IntPtr.Zero, 60, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        // Detached-window mode keeps the handle: show / layout use it to locate the real window.
        // Embedded mode (the default) still clears it, preserving the original semantics.
        if (!_detachedMode) _emu = IntPtr.Zero;
    }

    // Same as Detach, but **without showing** the window: called just before the host window is destroyed.
    // Without detaching first, Windows re-parents the child to the desktop and makes it visible when the host dies,
    // conjuring an extra black "Android Emulator - apkstart5554" window out of nowhere.
    static void ParkEmulator()
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        IntPtr e = _emu;
        if (e == IntPtr.Zero) { _host = IntPtr.Zero; return; }
        ShowWindow(e, 0);
        SetParent(e, IntPtr.Zero);
        uint style = (uint)GetWindowLong(e, GWL_STYLE);
        style &= ~WS_CHILD;
        // Add WS_VISIBLE (0x10000000) back as well: it may have been cleared implicitly by the "SetParent to a hidden host" call, and
        // third-party backends (MuMu) never show the window again themselves, so the emulator would be gone once the app window closes.
        style |= (uint)(WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | 0x10000000);
        SetWindowLong(e, GWL_STYLE, (int)style);
        int ex = GetWindowLong(e, GWL_EXSTYLE);
        ex |= WS_EX_APPWINDOW;
        SetWindowLong(e, GWL_EXSTYLE, ex);
        SetWindowPos(e, IntPtr.Zero, 40, 40, 480, 853, SWP_NOZORDER | SWP_FRAMECHANGED | SWP_NOACTIVATE);
        _emu = IntPtr.Zero;
        _host = IntPtr.Zero;
    }

    // ------------------------------------------------------------------ rotation
    // The emulator rotates by changing the **panel orientation**, which only its own Qt shortcut Ctrl+Left/Right triggers;
    // the console command adb emu rotate merely turns the picture 90 degrees while the system stays portrait (a sideways image).
    // The catch is that the shortcut must arrive at the emulator window as a keystroke, but that window is now our child and
    // focus sits in the web layer. So attach both threads' input queues, give the emulator focus temporarily,
    // press the key and hand focus back.
    static void Rotate(string dir)
    {
        if (_emu == IntPtr.Zero) _emu = FindEmulator();
        if (_emu == IntPtr.Zero) return;
        // keybd_event feeds the SYSTEM input queue, so if we are not the foreground
        // window the Ctrl+Left lands in whatever the user is typing in (WeChat's input
        // box, a browser, ...). Rotate is a user action in our own window; if we are
        // not foreground, do nothing instead of typing into someone else's app.
        IntPtr fg = GetForegroundWindow();
        if (_host == IntPtr.Zero || (fg != IntPtr.Zero && GetAncestor(fg, 2) != _host)) return;
        IntPtr host = _host != IntPtr.Zero ? _host : GetParent(_emu);

        uint emuTid, hostTid, dummy;
        emuTid = GetWindowThreadProcessId(_emu, out dummy);
        hostTid = host != IntPtr.Zero ? GetWindowThreadProcessId(host, out dummy) : 0;
        uint myTid = GetCurrentThreadId();

        bool a1 = AttachThreadInput(myTid, emuTid, true);
        bool a2 = hostTid != 0 && AttachThreadInput(myTid, hostTid, true);
        try
        {
            if (host != IntPtr.Zero) SetForegroundWindow(host);
            IntPtr prev = SetFocus(_emu);
            Thread.Sleep(150);
            byte vk = dir == "right" ? (byte)0x27 : (byte)0x25;
            keybd_event(0x11, 0, 0, IntPtr.Zero);
            Thread.Sleep(50);
            keybd_event(vk, 0, 0, IntPtr.Zero);
            Thread.Sleep(80);
            keybd_event(vk, 0, 2, IntPtr.Zero);
            keybd_event(0x11, 0, 2, IntPtr.Zero);
            Thread.Sleep(120);
            SetFocus(prev);
        }
        finally
        {
            if (a2) AttachThreadInput(myTid, hostTid, false);
            if (a1) AttachThreadInput(myTid, emuTid, false);
        }
    }

    // ------------------------------------------------------------------ mouse mapping
    const int WM_RBUTTONDOWN = 0x0204;
    const int WM_RBUTTONUP = 0x0205;
    const int WM_RBUTTONDBLCLK = 0x0206;
    const int WM_MOUSEWHEEL = 0x020A;
    const int WM_XBUTTONDOWN = 0x020B;
    const int WM_XBUTTONUP = 0x020C;
    const int WM_MOUSEHWHEEL = 0x020E;

    static readonly Stopwatch _clock = Stopwatch.StartNew();
    static long NowMs() { return _clock.ElapsedMilliseconds; }

    // Only react inside the embedded LCD while OUR window is the foreground root.
    // GetAncestor(GA_ROOT) covers Chromium child windows and the Qt framebuffer.
    static bool InOurLcd(POINT pt, out RECT r)
    {
        r = new RECT();
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || _host == IntPtr.Zero) return false;
        // HWNDs get recycled. If "our" host is gone (or now belongs to another process)
        // the hook must not swallow anything -- otherwise right click / wheel silently
        // stop working in whichever app inherited the handle.
        if (!IsWindow(_host)) return false;
        if (_appPid != 0 && _hostPid != 0 && _hostPid != _appPid) return false;
        if (GetAncestor(fg, 2) != _host) return false;   // 2 = GA_ROOT
        IntPtr e = _emu;
        if (e != IntPtr.Zero && GetWindowRect(e, out r))
        {
            // Qt keeps an 8px grey pad around the real LCD; embed() pushes it out.
            return pt.X >= r.L + 8 && pt.X <= r.R - 8 && pt.Y >= r.T + 8 && pt.Y <= r.B - 8;
        }
        // Before embed (or if FindEmulator failed) fall back to the host window
        // minus its 38px title bar. Approximate on HiDPI, but only a fallback.
        if (!GetWindowRect(_host, out r)) return false;
        return pt.X >= r.L + 4 && pt.X <= r.R - 4 && pt.Y >= r.T + 40 && pt.Y <= r.B - 4;
    }

    static string Num(double v) { return v.ToString("0.####", CultureInfo.InvariantCulture); }

    static void PushWheel(int dx, int dy, POINT pt, RECT r)
    {
        int w = r.R - r.L - 16, h = r.B - r.T - 16;
        double nx = w > 0 ? (pt.X - r.L - 8.0) / w : 0.5;
        double ny = h > 0 ? (pt.Y - r.T - 8.0) / h : 0.5;
        if (nx < 0) nx = 0; if (nx > 1) nx = 1;
        if (ny < 0) ny = 0; if (ny > 1) ny = 1;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) _wheelFirst = now;
            _wheelDx += dx;
            _wheelDy += dy;
            _wheelNx = nx;
            _wheelNy = ny;
            _wheelLast = now;
        }
    }

    // Drained from the socket loop. Emit after 60ms of quiet, but never let a
    // continuous spin starve the queue (hard cap 90ms from the first notch).
    static void FlushWheel(bool force)
    {
        int dx = 0, dy = 0;
        double nx = 0.5, ny = 0.5;
        long now = NowMs();
        lock (_wheelLock)
        {
            if (_wheelDx == 0 && _wheelDy == 0) return;
            if (!force && now - _wheelLast < 60 && now - _wheelFirst < 90) return;
            dx = _wheelDx; dy = _wheelDy; nx = _wheelNx; ny = _wheelNy;
            _wheelDx = 0; _wheelDy = 0;
        }
        _events.Enqueue("{\"ev\":\"wheel\",\"dx\":" + dx + ",\"dy\":" + dy
            + ",\"nx\":" + Num(nx) + ",\"ny\":" + Num(ny) + "}");
    }

    static void ResetWheel()
    {
        lock (_wheelLock) { _wheelDx = 0; _wheelDy = 0; }
    }

    // The callback must stay microscopic: Windows synchronously waits for it on
    // EVERY mouse event of EVERY process. Anything not one of our 7 messages
    // (including all left-button events) is a single CallNextHookEx.
    static IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            int msg = (int)wParam;
            bool right = msg == WM_RBUTTONDOWN || msg == WM_RBUTTONUP || msg == WM_RBUTTONDBLCLK;
            bool wheel = msg == WM_MOUSEWHEEL || msg == WM_MOUSEHWHEEL;
            bool xbut = msg == WM_XBUTTONDOWN || msg == WM_XBUTTONUP;
            if (!right && !wheel && !xbut) return CallNextHookEx(_hook, nCode, wParam, lParam);
            if ((right && _optRight == 0) || (wheel && _optWheel == 0) || (xbut && _optSide == 0))
                return CallNextHookEx(_hook, nCode, wParam, lParam);

            MSLLHOOKSTRUCT d = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            RECT r;
            if (!InOurLcd(d.Pt, out r)) return CallNextHookEx(_hook, nCode, wParam, lParam);

            if (right)
            {
                // Qt maps a right click to a plain finger tap: swallow it, emit BACK.
                if (msg == WM_RBUTTONDOWN) _events.Enqueue("{\"ev\":\"back\"}");
                return (IntPtr)1;
            }
            if (wheel)
            {
                int delta = (short)((d.MouseData >> 16) & 0xFFFF);
                if (msg == WM_MOUSEWHEEL) PushWheel(0, delta, d.Pt, r);
                else PushWheel(delta, 0, d.Pt, r);
                return (IntPtr)1;
            }
            if (msg == WM_XBUTTONDOWN)
            {
                int button = (d.MouseData >> 16) & 0xFFFF;
                _events.Enqueue(button == 1 ? "{\"ev\":\"back\"}" : "{\"ev\":\"forward\"}");
            }
            return (IntPtr)1;
        }
        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    // A WH_MOUSE_LL hook is global: Windows synchronously waits for this callback on
    // EVERY mouse event of EVERY application. It must therefore live on a thread whose
    // only job is pumping messages. Installing it on the socket-serving thread (which
    // used to block up to 4s in Poll) made the whole desktop pointer lag and drift.
    // It is scoped now: JS installs it only while an app window is foreground, and
    // the callback ignores events outside the embedded LCD.
    static void HookThreadProc()
    {
        _hookTid = GetCurrentThreadId();
        _hookProc = HookCallback;
        _hook = SetWindowsHookEx(14, _hookProc, IntPtr.Zero, 0);
        _hookReady.Set();
        MSG m;
        while (_hookRun && GetMessage(out m, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        _hookTid = 0;
    }

    static void HookOn()
    {
        if (_hookThread != null && _hookThread.IsAlive) return;
        _hookRun = true;
        _hookReady.Reset();
        _hookThread = new Thread(HookThreadProc);
        _hookThread.IsBackground = true;
        _hookThread.Start();
        // Reply must reflect the real hook state; otherwise the JS side sees
        // hooked:false and thinks enabling failed.
        _hookReady.WaitOne(1000);
    }
    static void HookOff()
    {
        _hookRun = false;
        _optRight = 0; _optWheel = 0; _optSide = 0;
        ResetWheel();
        if (_hook != IntPtr.Zero) { UnhookWindowsHookEx(_hook); _hook = IntPtr.Zero; }
        if (_hookTid != 0) PostThreadMessage(_hookTid, 0x0012, IntPtr.Zero, IntPtr.Zero); // WM_QUIT
        _hookThread = null;
        // _hookProc is deliberately kept referenced: the hook thread may still be running the callback, and nulling it
        // early would let the delegate be collected. It is released naturally when the thread exits.
    }

    // ------------------------------------------------------------------ plumbing
    static void Pump()
    {
        MSG m;
        while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1))
        {
            TranslateMessage(ref m);
            DispatchMessage(ref m);
        }
    }

    static long L(string line, string key)
    {
        string pat = "\"" + key + "\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return 0;
        i = line.IndexOf(':', i + pat.Length);
        if (i < 0) return 0;
        i++;
        while (i < line.Length && (line[i] == ' ' || line[i] == '\"')) i++;
        int j = i;
        while (j < line.Length && (char.IsDigit(line[j]) || line[j] == '-')) j++;
        long v;
        return long.TryParse(line.Substring(i, j - i), out v) ? v : 0;
    }

    static string S(string line, string key)
    {
        string pat = "\"" + key + "\":\"";
        int i = line.IndexOf(pat, StringComparison.Ordinal);
        if (i < 0) return "";
        i += pat.Length;
        int j = line.IndexOf('"', i);
        return j < 0 ? "" : line.Substring(i, j - i);
    }

    // Parse "0x1A2B3C" / "17158972" into an HWND. Third-party backends (MuMu) report hex strings,
    // and our own callers may pass decimal; both must be accepted.
    static IntPtr ParseHwnd(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return IntPtr.Zero;
        string s = raw.Trim();
        long v = 0;
        try
        {
            if (s.StartsWith("0x", StringComparison.OrdinalIgnoreCase))
            {
                v = Convert.ToInt64(s.Substring(2), 16);
            }
            else if (long.TryParse(s, out v))
            {
                // decimal means decimal
            }
            else
            {
                v = Convert.ToInt64(s, 16);
            }
        }
        catch { return IntPtr.Zero; }
        if (v <= 0) return IntPtr.Zero;
        return new IntPtr(v);
    }

    static void Reply(Socket s, string json)
    {
        try
        {
            byte[] b = Encoding.UTF8.GetBytes(json + "\n");
            s.Send(b);
        }
        catch { }
    }

    public static void Serve(int port)
    {
            // per-monitor v2 (Win10 1703+), fall back to system-aware on failure
        try { if (!SetProcessDpiAwarenessContext(new IntPtr(-4))) SetProcessDPIAware(); } catch { try { SetProcessDPIAware(); } catch { } }
        TcpListener l = new TcpListener(IPAddress.Loopback, port);
        l.Start();
        int actual = ((IPEndPoint)l.LocalEndpoint).Port;
        Console.WriteLine("PORT=" + actual);
        Console.Out.Flush();
        Socket sock;
        try { sock = l.AcceptSocket(); }
        catch { return; }
        l.Stop();

        StringBuilder rx = new StringBuilder();
        byte[] buf = new byte[8192];
        bool run = true;
        while (run)
        {
            Pump();
            FlushWheel(false);

            string ev;
            while (_events.TryDequeue(out ev))
                Reply(sock, "{\"ev\":\"" + ev + "\"}");

            // The Qt tool rail can re-appear right after embedding. Sweep only for the
            // first few seconds after an embed, then stop: a permanent 2s EnumWindows +
            // SetWindowPos loop is pure overhead and competes with the foreground app.
            long now = Environment.TickCount;
            if (_embedAt != 0 && now - _embedAt < 8000 && now - _lastToolSweep > 1500)
            {
                _lastToolSweep = now;
                HideToolWindows();
                Raise();
            }
            if (_embedAt != 0 && now - _embedAt >= 8000) _embedAt = 0;

            // Resident suppression: emulator main window / toolbar / qemu-netsimd console black windows.
            // Every round enumerates all desktop windows several times, which is expensive -- 120ms rounds for 90 seconds
            // visibly bogged whole machines down (users reported "the entire system stutters"). Once the window is embedded
            // that frequency is pointless: 250ms for the first 10 seconds to catch flashing windows, then 1500ms is plenty.
            // In game mode (_perfMode) drop further to 3000ms and leave the CPU to Android rendering.
            long sweepGap;
            if (_perfMode) sweepGap = (now - _bootHideStart < 10000) ? 300 : 3000;
            else sweepGap = (now - _bootHideStart < 10000) ? 250 : 1500;
            if (_quiet && now - _bootHideSweep > sweepGap)
            {
                _bootHideSweep = now;
                QuietSweep();
            }

            // Dedicated high-frequency channel for console black windows (first 15 seconds only, console-class windows only).
            // Why it is needed: when the emulator starts qemu, Windows creates a console window owned by
            // conhost / WindowsTerminal, so IsOurs is false and only IsOurConsole's "title = our runtime path" rule
            // can recognise it. Such windows stay visible for only 200-300ms, so the 250ms main sweep can miss them --
                        // all the user sees is a black box flashing at boot. A 100ms round always catches it before it vanishes.

            if (_quiet && now - _bootHideStart < 15000
                && now - _consoleSweep > (_perfMode ? 200 : 100))
            {
                _consoleSweep = now;
                HideConsoleWindows();
            }

            try
            {
                // The connection is already gone (ApkStart exited / crashed): do not stop immediately.
                // The emulator may still be booting and Qt may show the window tens of seconds later -- if nothing
                // is watching by then, an Android Emulator black window is left sitting on the desktop.
                // So keep watching for a while after the disconnect, until no emulator process remains for a stretch.
                if (sock == null)
                {
                    if (Environment.TickCount > _lingerUntil) break;
                    // Every emulator process is gone, nothing left to watch
                    if (!AnyEmulatorProcess() && FindEmulator() == IntPtr.Zero) break;
                    Thread.Sleep(120);
                    continue;
                }
                // Short poll: keep the message pump responsive even when no command
                // arrives. Never block for seconds while owning window hooks.
                if (!sock.Poll(50, SelectMode.SelectRead)) continue;
                int n = sock.Receive(buf);
                if (n <= 0)
                {
                    try { sock.Close(); } catch { }
                    sock = null;
                    if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                    break;
                }
                rx.Append(Encoding.UTF8.GetString(buf, 0, n));
                while (true)
                {
                    string all = rx.ToString();
                    int nl = all.IndexOf('\n');
                    if (nl < 0) break;
                    string line = all.Substring(0, nl).Trim();
                    rx.Remove(0, nl + 1);
                    if (line.Length == 0) continue;

                    string cmd = S(line, "cmd");
                    if (cmd == "scope")
                    {
                        // Whitelist of "our" directories. Must arrive before boothide /
                        // embed; the sweeps refuse to touch anything outside it.
                        SetScope(S(line, "dirs"));
                        long appPid = L(line, "pid");
                        _appPid = appPid > 0 ? (uint)appPid : 0;
                        _hostPid = 0;
                        Reply(sock, "{\"ok\":true,\"n\":" + _scopeDirs.Count + "}");
                    }
                    else if (cmd == "embed")
                    {
                        // Switching from detached back to embedded: clear the detached flag first and restore resident suppression,
                        // otherwise the emulator window keeps being treated as "the one the user is watching" and never joins Fit.
                        _detachedMode = false;
                        // Embedding means "the user wants to see the picture". Suppression stays on (it only hides non-embedded
                        // windows and console black boxes), but the window must be handed to SetParent out of its hidden state
                        // first and then shown by Fit's SWP_SHOWWINDOW.
                        IntPtr want = new IntPtr(L(line, "host"));
                        uint wantPid = 0;
                        if (want != IntPtr.Zero) GetWindowThreadProcessId(want, out wantPid);
                        // Never re-parent into a foreign window: a stale handle could
                        // point at another app (the exact way "ApkStart ate WeChat's
                        // window" can happen).
                        if (want == IntPtr.Zero || (_appPid != 0 && wantPid != _appPid))
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"host-not-ours\"}");
                            Thread.Sleep(1);
                        }
                        else
                        {
                            _host = want;
                            _hostPid = wantPid;
                            _chromeRender = FindChromeRender(want);
                            // Third-party backends (MuMu etc.) report the picture window handle directly;
                            // "target" is a comma-separated candidate list -- SetParent each until one really becomes our child.
                            string targets = S(line, "target");
                            _emu = IntPtr.Zero;
                            if (_quiet) { _quiet = false; _bootHideUntil = 0; }   // stop hiding the window we are about to embed
                            if (!string.IsNullOrEmpty(targets))
                            {
                                string[] pieces = targets.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                                for (int i = 0; i < pieces.Length; i++)
                                {
                                    IntPtr cand = ParseHwnd(pieces[i]);
                                    if (cand == IntPtr.Zero || !IsWindow(cand)) continue;
                                    // Already attached to our host (repeat embed / size change): use it directly
                                    if (GetParent(cand) == want || GetParent(cand) == _chromeRender)
                                    {
                                        _emu = cand;
                                        break;
                                    }
                                    Embed(_host, cand);
                                    if (GetParent(cand) == _host || GetParent(cand) == _chromeRender)
                                    {
                                        _emu = cand;
                                        break;
                                    }
                                }
                            }
                            else
                            {
                                _emu = FindEmulator();
                                Embed(_host, _emu);
                            }
                            bool ok = _emu != IntPtr.Zero
                                && (GetParent(_emu) == _host || GetParent(_emu) == _chromeRender);
                            _embedAt = Environment.TickCount;
                            _lastToolSweep = 0;
                            Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), true, (int)L(line, "clipTop"));
                            Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + ",\"emu\":" + _emu.ToInt64() + "}");
                            // Third-party backend windows are not created by us and never restore themselves:
                            // add WS_VISIBLE to every candidate, otherwise it stays hidden after SetParent.
                            if (ok && !string.IsNullOrEmpty(targets)) ShowWindow(_emu, 5);
                        }
                    }
                    else if (cmd == "fit")
                    {
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        Fit((int)L(line, "x"), (int)L(line, "y"), (int)L(line, "w"), (int)L(line, "h"), false, (int)L(line, "clipTop"));
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "rotate")
                    {
                        Rotate(S(line, "dir"));
                        Thread.Sleep(350);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "hide")
                    {
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 0);
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "perf")
                    {
                        // JS notifies through priorityMode: game mode slows the window scan down
                        _perfMode = L(line, "on") != 0;
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "show")
                    {
                        // In detached-window mode Detach() clears _emu (it treats this as "embedding ended"),
                        // so look it up again here, otherwise show/layout act on a null handle and it looks like
                        // "the emulator window disappeared after switching to a detached window".
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        if (_emu != IntPtr.Zero) ShowWindow(_emu, 5);
                        Reply(sock, "{\"ok\":" + (_emu != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "detach")
                    {
                        // keep=1 means "switch to detached-window mode": do not treat this as
                        // "embedding ended, hide the emulator", or QuietSweep will hide the window
                        // the user is looking at on the next round.
                        _detachedMode = L(line, "keep") == 1;
                        // Detached mode may never have embedded (_emu is still 0), so look once first,
                        // otherwise Detach returns immediately and every later show/layout hits a null handle.
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        Detach();
                        Reply(sock, "{\"ok\":true,\"emu\":" + _emu.ToInt64() + "}");
                    }
                    else if (cmd == "title")
                    {
                        // Rename the emulator's native window from "Android Emulator - apkstart:5554"
                        // to a name the user understands (default "ApkStart"). Qt resets the title when it
                        // rebuilds the window, so QuietSweep re-applies it every round (see below).
                        string t = S(line, "text");
                        if (t.Length == 0) t = "ApkStart";
                        _ourTitle = t;
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        bool ok = _emu != IntPtr.Zero && SetWindowTextW(_emu, t);
                        Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + "}");
                    }
                    else if (cmd == "icon")
                    {
                        // Set the emulator's native window icon (detached-window mode then shows the current app's icon
                        // in the taskbar/Alt+Tab instead of the Google emulator's default green robot). Pass an absolute ICO/PNG path.
                        string f = S(line, "file");
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        bool ok = false;
                        if (f.Length > 0 && System.IO.File.Exists(f))
                        {
                            // Cache the icon handle: free the old one and load the new one on app switch; the sweep
                            // reuses the cache instead of calling LoadImage every round (that is disk IO plus GDI object leaks).
                            if (!String.Equals(f, _ourIconFile, StringComparison.OrdinalIgnoreCase))
                            {
                                if (_ourIconSmall != IntPtr.Zero) DestroyIcon(_ourIconSmall);
                                if (_ourIconBig != IntPtr.Zero) DestroyIcon(_ourIconBig);
                                _ourIconSmall = LoadImageW(IntPtr.Zero, f, 1, 32, 32, 0x10);
                                _ourIconBig = LoadImageW(IntPtr.Zero, f, 1, 64, 64, 0x10);
                                if (_ourIconSmall == IntPtr.Zero) _ourIconSmall = _ourIconBig;
                                if (_ourIconBig == IntPtr.Zero) _ourIconBig = _ourIconSmall;
                                _ourIconFile = f;
                            }
                            if (_emu != IntPtr.Zero && (_ourIconSmall != IntPtr.Zero || _ourIconBig != IntPtr.Zero))
                            {
                                if (_ourIconSmall != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(0), _ourIconSmall);
                                if (_ourIconBig != IntPtr.Zero) SendMessageW(_emu, 0x0080, new IntPtr(1), _ourIconBig);
                                ok = true;
                            }
                        }
                        Reply(sock, "{\"ok\":" + (ok ? "true" : "false") + "}");
                    }
                    else if (cmd == "layout")
                    {
                        // Detached-window mode: the emulator window is a native window, so just place it at
                        // the given screen rect (no SetParent). Orientation, scaling and input are its own business,
                        // so none of the embedding black bars, coordinate offsets or fill problems apply.
                        if (_emu == IntPtr.Zero) _emu = FindEmulator();
                        if (_emu == IntPtr.Zero)
                        {
                            Reply(sock, "{\"ok\":false,\"error\":\"no-emu\"}");
                        }
                        else
                        {
                            // Make sure it is a visible top-level window first (WS_CHILD was removed by Detach)
                            ShowWindow(_emu, 5);
                            SetWindowPos(_emu, HWND_TOP,
                                (int)L(line, "x"), (int)L(line, "y"),
                                (int)L(line, "w"), (int)L(line, "h"),
                                SWP_SHOWWINDOW);
                            Reply(sock, "{\"ok\":true}");
                        }
                    }
                    else if (cmd == "hook")
                    {
                        // Options are re-sent on every enable, so changing settings
                        // while the hook is live needs no reinstall / no thread churn.
                        _optRight = L(line, "right") == 1 ? 1 : 0;
                        _optWheel = L(line, "wheel") == 1 ? 1 : 0;
                        _optSide = L(line, "side") == 1 ? 1 : 0;
                        if (L(line, "on") == 1) HookOn(); else HookOff();
                        Reply(sock, "{\"ok\":true,\"hooked\":" + (_hook != IntPtr.Zero ? "true" : "false") + "}");
                    }
                    else if (cmd == "probe")
                    {
                        IntPtr e = FindEmulator();
                        RECT r = new RECT();
                        if (e != IntPtr.Zero) GetWindowRect(e, out r);
                        Reply(sock, "{\"ok\":true,\"emu\":" + e.ToInt64()
                            + ",\"x\":" + r.L + ",\"y\":" + r.T
                            + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) + "}");
                    }
                    else if (cmd == "winready")
                    {
                        // Third-party backend readiness gate: a candidate handle exists + state is "present".
                        // The hidden check happens on the JS side (see backends/mumu.js windowReady).
                        string list = S(line, "target");
                        int alive = 0;
                        string first = "";
                        if (!string.IsNullOrEmpty(list))
                        {
                            string[] pieces = list.Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries);
                            for (int i = 0; i < pieces.Length; i++)
                            {
                                IntPtr h = ParseHwnd(pieces[i]);
                                if (h == IntPtr.Zero || !IsWindow(h)) continue;
                                alive++;
                                if (first.Length == 0) first = pieces[i];
                            }
                        }
                        Reply(sock, "{\"ok\":true,\"alive\":" + alive + ",\"first\":\"" + first + "\"}");
                    }
                    else if (cmd == "consoles")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListConsoles() + "]}");
                    }
                    else if (cmd == "windows")
                    {
                        Reply(sock, "{\"ok\":true,\"list\":[" + ListWindows(L(line, "all") == 1) + "]}");
                    }
                    else if (cmd == "boothide")
                    {
                        if (L(line, "on") == 1)
                        {
                            _quiet = true;
                            _bootHideSweep = 0;
                            _consoleSweep = 0;
                            _bootHideStart = Environment.TickCount;
                            SnapshotConsoles();
                            QuietSweep();
                        }
                        else
                        {
                            // Leave the window alone and just suppress the console black boxes again (quiet is normally
                            // turned off because the user wants to look at the emulator window themselves; see the startVisible setting).
                            _quiet = false;
                            HideConsoleWindows();
                        }
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "park")
                    {
                        // The app window is closing: detach the emulator window and hide it first, so Windows
                        // does not re-parent it to the desktop and make it a visible top-level window when the host is destroyed
                        // (that is where the out-of-nowhere "Android Emulator black window" came from).
                        _quiet = true;
                        _bootHideStart = Environment.TickCount;
                        _bootHideSweep = 0;
                        ParkEmulator();
                        Reply(sock, "{\"ok\":true}");
                    }
                    else if (cmd == "quit")
                    {
                        Reply(sock, "{\"ok\":true}");
                        run = false;
                        break;
                    }
                    else
                    {
                        Reply(sock, "{\"ok\":false,\"error\":\"unknown\"}");
                    }
                }
            }
            catch (SocketException)
            {
                try { sock.Close(); } catch { }
                sock = null;
                if (_quiet) { _lingerUntil = Environment.TickCount + 180000; continue; }
                break;
            }
            catch (Exception) { }
        }
        HookOff();
        try { sock.Close(); } catch { }
    }
}
'@

Add-Type -TypeDefinition $src
[ApkAgent]::Serve($Port)
