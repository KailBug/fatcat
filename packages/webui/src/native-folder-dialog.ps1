$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

# Use the Explorer-style folder dialog on Windows PowerShell 5.1 without an extra runtime.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class FatcatFolderDialog
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rectangle { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetWindowRect(IntPtr window, out Rectangle bounds);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowEx(uint extendedStyle, string className, string title, uint style,
        int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyWindow(IntPtr window);

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

    public static string Choose(string initialPath)
    {
        // PowerShell's process manifest does not make this native dialog DPI aware.
        // Set the STA thread before creating either HWND, then restore it on exit.
        IntPtr previousDpi = SetThreadDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2.
        if (previousDpi == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr owner = IntPtr.Zero;
        IFileDialog dialog = null;
        IShellItem initial = null;
        IShellItem selected = null;
        IntPtr name = IntPtr.Zero;
        try
        {
            Rectangle bounds;
            GetWindowRect(GetForegroundWindow(), out bounds);
            // An invisible TOOLWINDOW owner prevents a PowerShell taskbar button.
            // Its bounds center the dialog near the requesting foreground window.
            owner = CreateWindowEx(0x80u, "STATIC", "Fatcat workspace picker owner", 0x80000000u,
                bounds.Left, bounds.Top, Math.Max(1, bounds.Right - bounds.Left), Math.Max(1, bounds.Bottom - bounds.Top),
                IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
            if (owner == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
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
            int result = dialog.Show(owner);
            if (result == unchecked((int)0x800704C7)) return null;
            Marshal.ThrowExceptionForHR(result);
            dialog.GetResult(out selected);
            selected.GetDisplayName(0x80058000u, out name); // SIGDN_FILESYSPATH.
            return Marshal.PtrToStringUni(name);
        }
        finally
        {
            if (name != IntPtr.Zero) Marshal.FreeCoTaskMem(name);
            if (selected != null) Marshal.ReleaseComObject(selected);
            if (initial != null) Marshal.ReleaseComObject(initial);
            if (dialog != null) Marshal.ReleaseComObject(dialog);
            if (owner != IntPtr.Zero) DestroyWindow(owner);
            SetThreadDpiAwarenessContext(previousDpi);
        }
    }
}
'@

$selectedPath = [FatcatFolderDialog]::Choose($env:FATCAT_WORKSPACE_DIRECTORY)
@{ path = $selectedPath } | ConvertTo-Json -Compress
