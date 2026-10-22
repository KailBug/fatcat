param(
    [int] $PickerProcessId,
    [int] $ParentProcessId,
    [ValidateSet('inspect', 'select', 'cancel', 'absent', 'restored')][string] $Action = 'inspect',
    [long] $OwnerHandle,
    [string] $ScreenshotPath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Native-only verification helper. Operates exclusively on the supplied child PID.
Add-Type -ReferencedAssemblies 'System', 'System.Drawing' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class FatcatPickerProbe
{
    [StructLayout(LayoutKind.Sequential)] private struct Rectangle { public int Left, Top, Right, Bottom; }
    private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] private static extern bool AreDpiAwarenessContextsEqual(IntPtr first, IntPtr second);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetDlgItem(IntPtr window, int item);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rectangle bounds);
    [DllImport("user32.dll")] private static extern bool PrintWindow(IntPtr window, IntPtr device, uint flags);

    public sealed class Window
    {
        public long Handle, Owner;
        public uint ProcessId;
        public string Title, ClassName;
        public bool Visible, OwnerVisible, OwnerEnabled, OwnerToolWindow, AboveOwner, PerMonitorV2, TaskbarEligible, CanSelect;
        public uint Dpi;
    }

    public static Window[] Inspect(int targetProcessId)
    {
        List<Window> windows = new List<Window>();
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint processId;
            GetWindowThreadProcessId(window, out processId);
            if (processId != targetProcessId) return true;
            StringBuilder title = new StringBuilder(256), className = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            GetClassName(window, className, className.Capacity);
            IntPtr owner = GetWindow(window, 4); // GW_OWNER.
            // Trying to activate the browser must not put it above its modal picker.
            if (IsWindowVisible(owner)) SetForegroundWindow(owner);
            bool aboveOwner = false;
            for (IntPtr previous = GetWindow(owner, 3); previous != IntPtr.Zero; previous = GetWindow(previous, 3))
                if (previous == window) { aboveOwner = true; break; }
            bool visible = IsWindowVisible(window);
            int style = GetWindowLong(window, -20); // GWL_EXSTYLE.
            windows.Add(new Window {
                Handle = window.ToInt64(), Owner = owner.ToInt64(), ProcessId = processId, Title = title.ToString(), ClassName = className.ToString(),
                Visible = visible, OwnerVisible = IsWindowVisible(owner), OwnerEnabled = IsWindowEnabled(owner), AboveOwner = aboveOwner, OwnerToolWindow = (GetWindowLong(owner, -20) & 0x80) != 0,
                PerMonitorV2 = AreDpiAwarenessContextsEqual(GetWindowDpiAwarenessContext(window), new IntPtr(-4)),
                Dpi = GetDpiForWindow(window), CanSelect = IsWindowEnabled(GetDlgItem(window, 1)),
                TaskbarEligible = visible && (style & 0x80) == 0 && (owner == IntPtr.Zero || (style & 0x40000) != 0)
            });
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }

    public static void Close(long handle, bool select)
    {
        if (!PostMessage(new IntPtr(handle), select ? 0x111u : 0x10u, select ? new IntPtr(1) : IntPtr.Zero, IntPtr.Zero))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    public static bool OwnerEnabled(long handle) { return IsWindowEnabled(new IntPtr(handle)); }
    public static bool OwnerExists(long handle) { return IsWindow(new IntPtr(handle)); }

    public static void Capture(long handle, string path)
    {
        IntPtr previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        try
        {
            Rectangle bounds;
            if (!GetWindowRect(new IntPtr(handle), out bounds)) throw new InvalidOperationException("Cannot measure picker window.");
            using (System.Drawing.Bitmap image = new System.Drawing.Bitmap(bounds.Right - bounds.Left, bounds.Bottom - bounds.Top))
            using (System.Drawing.Graphics graphics = System.Drawing.Graphics.FromImage(image))
            {
                IntPtr device = graphics.GetHdc();
                try { if (!PrintWindow(new IntPtr(handle), device, 0)) throw new InvalidOperationException("Cannot capture picker window."); }
                finally { graphics.ReleaseHdc(device); }
                image.Save(path, System.Drawing.Imaging.ImageFormat.Png);
            }
        }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
}
'@

if ($Action -eq 'restored') {
    @{ windows = @(); ownerEnabled = [FatcatPickerProbe]::OwnerEnabled($OwnerHandle); ownerExists = [FatcatPickerProbe]::OwnerExists($OwnerHandle) } | ConvertTo-Json -Compress
    exit 0
}

$deadline = [DateTime]::UtcNow.AddSeconds(20)
do {
    if ($ParentProcessId -and !$PickerProcessId) {
        $hostProcess = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ParentProcessId" | Where-Object { $_.CommandLine -like '*native-folder-host.js*' } | Select-Object -First 1
        $picker = if ($hostProcess) { Get-CimInstance Win32_Process -Filter "ParentProcessId = $($hostProcess.ProcessId)" | Where-Object { $_.CommandLine -like '*-File*native-folder-dialog.ps1*' } | Select-Object -First 1 }
        if ($picker) { $PickerProcessId = $picker.ProcessId }
    }
    $windows = @([FatcatPickerProbe]::Inspect($PickerProcessId))
    $dialog = $windows | Where-Object { $_.Visible -and $_.ClassName -eq '#32770' -and $_.Title -eq 'Choose workspace' } | Select-Object -First 1
    if ($Action -eq 'absent') {
        if ($windows.Count -eq 0 -and !(Get-Process -Id $PickerProcessId -ErrorAction SilentlyContinue)) {
            @{ windows = @() } | ConvertTo-Json -Compress; exit 0
        }
    } elseif ($null -ne $dialog -and ($Action -ne 'select' -or $dialog.CanSelect)) {
        if ($ScreenshotPath) { [FatcatPickerProbe]::Capture($dialog.Handle, $ScreenshotPath) }
        @{ windows = $windows; dialog = $dialog; hostProcessId = $hostProcess.ProcessId } | ConvertTo-Json -Depth 4 -Compress
        if ($Action -eq 'cancel' -or $Action -eq 'select') { [FatcatPickerProbe]::Close($dialog.Handle, $Action -eq 'select') }
        exit 0
    }
    Start-Sleep -Milliseconds 50
} while ([DateTime]::UtcNow -lt $deadline)
throw 'The native folder picker did not reach the expected window state.'
