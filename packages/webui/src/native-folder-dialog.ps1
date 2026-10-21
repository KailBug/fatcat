$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Use the Explorer-style folder dialog on Windows PowerShell 5.1 without an extra runtime.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class FatcatFolderDialog
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    private delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumThreadWindows(uint thread, EnumWindow callback, IntPtr parameter);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] private static extern bool EnableWindow(IntPtr window, bool enabled);
    [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    private static IntPtr FindBrowser(string ownerId)
    {
        Guid id;
        if (!Guid.TryParse(ownerId, out id)) throw new InvalidOperationException("A browser picker identity is required.");
        string prefix = "Fatcat workspace " + ownerId;
        IntPtr owner = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            StringBuilder title = new StringBuilder(512), kind = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            GetClassName(window, kind, kind.Capacity);
            if (IsWindowVisible(window) && IsWindowEnabled(window)
                && (kind.ToString() == "Chrome_WidgetWin_1" || kind.ToString() == "MozillaWindowClass")
                && title.ToString().StartsWith(prefix, StringComparison.Ordinal)) owner = window;
            return true;
        }, IntPtr.Zero);
        if (owner == IntPtr.Zero) throw new InvalidOperationException("The requesting browser window is no longer available.");
        return owner;
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    private class FileOpenDialog { }

    [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileDialog
    {
        [PreserveSig] int Show(IntPtr owner);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(uint options);
        void GetOptions(out uint options);
        void SetDefaultFolder(IShellItem item);
        void SetFolder(IShellItem item);
        void GetFolder(out IShellItem item);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName(out IntPtr name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int alignment);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem
    {
        void BindToHandler(IntPtr context, ref Guid handler, ref Guid iid, out IntPtr result);
        void GetParent(out IShellItem parent);
        void GetDisplayName(uint nameType, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem item, uint hint, out int order);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    private static extern void SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);

    private static bool SameOwner(IntPtr owner, uint thread, uint process)
    {
        uint currentProcess;
        return owner != IntPtr.Zero && thread != 0 && process != 0
            && GetWindowThreadProcessId(owner, out currentProcess) == thread && currentProcess == process;
    }

    public static string Choose(string initialPath, string ownerId)
    {
        // PowerShell's process manifest does not make this native dialog DPI aware.
        // Set the STA thread before creating the dialog, then restore it on exit.
        IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2.
        if (previousDpi == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr owner = IntPtr.Zero;
        uint ownerThread = 0, ownerProcess = 0;
        Timer cancellation = null;
        int cancelled = 0;
        IFileDialog dialog = null;
        IShellItem initial = null;
        IShellItem selected = null;
        IntPtr name = IntPtr.Zero;
        try
        {
            owner = FindBrowser(ownerId);
            ownerThread = GetWindowThreadProcessId(owner, out ownerProcess);
            if (!SameOwner(owner, ownerThread, ownerProcess)) throw new InvalidOperationException("The browser owner closed before selection.");
            uint thread = GetCurrentThreadId();
            // EOF also closes the dialog if the server exits. Keep the STA modal loop alive
            // until Show returns and restores the browser, rather than terminating it.
            ThreadPool.QueueUserWorkItem(delegate(object state) {
                try { Console.In.ReadLine(); } catch { }
                Interlocked.Exchange(ref cancelled, 1);
            });
            cancellation = new Timer(delegate(object state) {
                if (Volatile.Read(ref cancelled) == 0 && SameOwner(owner, ownerThread, ownerProcess)) return;
                EnumThreadWindows(thread, delegate(IntPtr window, IntPtr parameter) {
                    StringBuilder kind = new StringBuilder(256);
                    GetClassName(window, kind, kind.Capacity);
                    if (kind.ToString() == "#32770") PostMessage(window, 0x10u, IntPtr.Zero, IntPtr.Zero);
                    return true;
                }, IntPtr.Zero);
            }, null, 0, 50);
            dialog = (IFileDialog)new FileOpenDialog();
            uint options;
            dialog.GetOptions(out options);
            // PICKFOLDERS | FORCEFILESYSTEM | PATHMUSTEXIST | NOCHANGEDIR | DONTADDTORECENT.
            dialog.SetOptions(options | 0x20u | 0x40u | 0x800u | 0x8u | 0x2000000u);
            dialog.SetTitle("Choose workspace");
            dialog.SetOkButtonLabel("Select folder");
            if (System.IO.Directory.Exists(initialPath))
            {
                Guid iid = typeof(IShellItem).GUID;
                SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref iid, out initial);
                dialog.SetFolder(initial);
            }
            if (Volatile.Read(ref cancelled) != 0) return null;
            int result = dialog.Show(owner);
            if (result == unchecked((int)0x800704C7)) return null;
            Marshal.ThrowExceptionForHR(result);
            dialog.GetResult(out selected);
            selected.GetDisplayName(0x80058000u, out name); // SIGDN_FILESYSPATH.
            return Marshal.PtrToStringUni(name);
        }
        finally
        {
            try
            {
                if (cancellation != null) cancellation.Dispose();
                if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name);
                if (selected != null) Marshal.ReleaseComObject(selected);
                if (initial != null) Marshal.ReleaseComObject(initial);
                if (dialog != null) Marshal.ReleaseComObject(dialog);
            }
            finally
            {
                // COM cleanup must never skip restoring a surviving browser window.
                try { if (SameOwner(owner, ownerThread, ownerProcess)) EnableWindow(owner, true); }
                finally { SetThreadDpiAwarenessContext(previousDpi); }
            }
        }
    }
}
'@

$selectedPath = [FatcatFolderDialog]::Choose($env:FATCAT_WORKSPACE_DIRECTORY, $env:FATCAT_PICKER_OWNER)
@{ path = $selectedPath } | ConvertTo-Json -Compress
