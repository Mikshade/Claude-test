# flowy-host.ps1 - persistent PowerShell worker for Flowy (see README.md next to this file).
#
# Started by src/main/system/powershell.ts as
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -OutputFormat Text -File flowy-host.ps1
# Protocol (one JSON object per line, ASCII only):
#   stdin  : {"id":"<uuid>","script":"<base64 of UTF-8 script>","timeoutMs":30000}
#   stdout : "##FLOWY-READY##" once after setup, then per request
#            "##FLOWY## " + {"id","stdout","stderr","exitCode","timedOut","fatal","durationMs"}
# Every other stdout line is diagnostics (ignored by Node). EOF on stdin ends the host.
# Compatible with Windows PowerShell 5.1 (C# 5 syntax only inside Add-Type) and PowerShell 7.
# This file is intentionally pure ASCII (PowerShell 5.1 reads BOM-less files as ANSI).

Set-StrictMode -Off
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'

$script:Utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $script:Utf8 } catch { }
try { [Console]::InputEncoding = $script:Utf8 } catch { }
$OutputEncoding = $script:Utf8

# Raw byte streams: replies are written as UTF-8 bytes regardless of the console code page.
$script:StdOut = [Console]::OpenStandardOutput()
$script:StdIn = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $script:Utf8)
$script:ReplyPrefix = '##FLOWY## '
$script:ReadyMarker = '##FLOWY-READY##'
$script:DefaultTimeoutMs = 30000
$script:StopGraceMs = 3000

function Send-Line([string]$Text) {
  $bytes = $script:Utf8.GetBytes($Text + "`n")
  $script:StdOut.Write($bytes, 0, $bytes.Length)
  $script:StdOut.Flush()
}

function Send-Reply($Reply) {
  $json = ConvertTo-Json -InputObject $Reply -Compress -Depth 3
  Send-Line ($script:ReplyPrefix + $json)
}

function Write-HostLog([string]$Text) {
  try { [Console]::Error.WriteLine('flowy-host: ' + $Text) } catch { }
}

# ---------------------------------------------------------------------------------------------
# Win32 interop (compiled lazily in the worker runspace by Initialize-FlowyWin32)
# ---------------------------------------------------------------------------------------------
$script:FlowyWin32Source = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class FlowyWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWndParent, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr hWndParent, IntPtr hWndChildAfter, string lpszClass, string lpszWindow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessageW(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT lpPoint);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool LockWorkStation();
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out int pvAttribute, int cbAttribute);
  [DllImport("powrprof.dll", SetLastError = true)] public static extern bool SetSuspendState(bool hibernate, bool forceCritical, bool disableWakeEvent);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  public static string GetTitle(IntPtr h) {
    int n = GetWindowTextLengthW(h);
    if (n <= 0) return "";
    StringBuilder sb = new StringBuilder(n + 1);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }
  public static string GetClass(IntPtr h) { StringBuilder sb = new StringBuilder(256); GetClassNameW(h, sb, 256); return sb.ToString(); }
  public static uint GetPid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static bool IsCloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }

  // Visible, titled, non-cloaked top-level windows in z-order (topmost first).
  public static List<IntPtr> TopWindows() {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && GetWindowTextLengthW(h) > 0 && !IsCloaked(h)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }

  // UWP apps are hosted by ApplicationFrameHost.exe; the real app owns a child window of class
  // Windows.UI.Core.CoreWindow. Returns 0 when there is no such child from another process.
  public static uint CoreWindowPid(IntPtr top) {
    uint topPid = GetPid(top);
    IntPtr core = FindWindowExW(top, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
    if (core != IntPtr.Zero) { uint p = GetPid(core); if (p != topPid) return p; }
    uint found = 0;
    EnumChildWindows(top, delegate(IntPtr c, IntPtr l) {
      if (GetClass(c) == "Windows.UI.Core.CoreWindow") { uint p = GetPid(c); if (p != topPid) { found = p; return false; } }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    // A synthetic Alt tap grants the calling process foreground rights (classic workaround).
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(h);
  }
  public static void KeyDown(byte vk, bool extended) { keybd_event(vk, 0, extended ? 1u : 0u, UIntPtr.Zero); }
  public static void KeyUp(byte vk, bool extended) { keybd_event(vk, 0, (extended ? 1u : 0u) | 2u, UIntPtr.Zero); }
  public static void Key(byte vk) { KeyDown(vk, false); KeyUp(vk, false); }
  public static void Click(int x, int y, string button) {
    SetCursorPos(x, y);
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; } else if (button == "middle") { down = 0x0020; up = 0x0040; }
    mouse_event(down, 0, 0, 0, UIntPtr.Zero); mouse_event(up, 0, 0, 0, UIntPtr.Zero);
  }
  // Types arbitrary text (umlauts, emoji) via SendInput + KEYEVENTF_UNICODE, independent of the keyboard layout.
  public static void TypeUnicode(string text) {
    List<INPUT> inputs = new List<INPUT>();
    foreach (char ch in text) {
      INPUT d = new INPUT(); d.type = 1; d.u.ki = new KEYBDINPUT(); d.u.ki.wScan = ch; d.u.ki.dwFlags = 0x0004;
      INPUT u = d; u.u.ki.dwFlags = 0x0004 | 0x0002;
      inputs.Add(d); inputs.Add(u);
    }
    if (inputs.Count == 0) return;
    INPUT[] arr = inputs.ToArray();
    if (SendInput((uint)arr.Length, arr, Marshal.SizeOf(typeof(INPUT))) != arr.Length) {
      throw new Exception("SendInput failed, error " + Marshal.GetLastWin32Error());
    }
  }
}
'@

# ---------------------------------------------------------------------------------------------
# CoreAudio IAudioEndpointVolume (master volume + mute of the default render device)
# ---------------------------------------------------------------------------------------------
$script:FlowyAudioSource = @'
using System;
using System.Runtime.InteropServices;

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, IntPtr activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }

public static class FlowyAudio {
  static IAudioEndpointVolume Vol() {
    IMMDeviceEnumerator en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev; Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv; Guid iid = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out epv));
    return epv;
  }
  public static float Volume {
    get { float v; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(value, Guid.Empty)); }
  }
  public static bool Mute {
    get { bool m; Marshal.ThrowExceptionForHR(Vol().GetMute(out m)); return m; }
    set { Marshal.ThrowExceptionForHR(Vol().SetMute(value, Guid.Empty)); }
  }
}
'@

# Runs once inside the worker runspace: preferences + lazy type initializers.
$script:WorkerInit = @'
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$ConfirmPreference = 'None'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
function Initialize-FlowyWin32 {
  if (-not ('FlowyWin32' -as [type])) {
    Add-Type -TypeDefinition $global:FlowyWin32Source -ErrorAction Stop
    [void][FlowyWin32]::SetProcessDPIAware()
  }
}
function Initialize-FlowyAudio {
  if (-not ('FlowyAudio' -as [type])) {
    Add-Type -TypeDefinition $global:FlowyAudioSource -ErrorAction Stop
  }
}
'@

# ---------------------------------------------------------------------------------------------
# Request execution
# ---------------------------------------------------------------------------------------------
function Invoke-FlowyScript([string]$Id, [string]$ScriptText, [int]$TimeoutMs) {
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $ps = [System.Management.Automation.PowerShell]::Create()
  $ps.Runspace = $script:Runspace
  [void]$ps.AddScript($ScriptText)
  $timedOut = $false
  $fatal = $false
  $terminating = $null
  $out = ''
  try { $script:Runspace.SessionStateProxy.SetVariable('LASTEXITCODE', $null) } catch { }
  try {
    $async = $ps.BeginInvoke()
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) {
      $timedOut = $true
      try {
        $stopAsync = $ps.BeginStop($null, $null)
        if (-not $stopAsync.AsyncWaitHandle.WaitOne($script:StopGraceMs)) { $fatal = $true }
      } catch { $fatal = $true }
    } else {
      try {
        $result = $ps.EndInvoke($async)
        $out = [string]($result | Out-String -Width 4096)
      } catch {
        $e = $_.Exception
        if ($e.InnerException) { $e = $e.InnerException }
        $terminating = [string]$e.Message
      }
    }
  } catch {
    $terminating = [string]$_.Exception.Message
  }

  $lines = New-Object System.Collections.Generic.List[string]
  try { foreach ($i in $ps.Streams.Information) { $lines.Add([string]$i.MessageData) } } catch { }
  $errLines = New-Object System.Collections.Generic.List[string]
  try {
    foreach ($er in $ps.Streams.Error) {
      $msg = [string]$er
      if ($er.InvocationInfo -and $er.InvocationInfo.PositionMessage) { $msg = $msg + "`n" + [string]$er.InvocationInfo.PositionMessage }
      $errLines.Add($msg)
    }
  } catch { }
  if ($terminating -and -not ($errLines -contains $terminating)) { $errLines.Add($terminating) }
  try { foreach ($w in $ps.Streams.Warning) { $errLines.Add('WARNING: ' + [string]$w.Message) } } catch { }

  $lastExit = $null
  if (-not $fatal) { try { $lastExit = $script:Runspace.SessionStateProxy.PSVariable.GetValue('LASTEXITCODE') } catch { } }
  $exitCode = 0
  if ($terminating -or $ps.HadErrors) { $exitCode = 1 }
  elseif (($lastExit -is [int]) -and ($lastExit -ne 0)) { $exitCode = [int]$lastExit }
  if ($timedOut) { $exitCode = -1 }
  if ($timedOut) { $errLines.Add('Zeitueberschreitung nach ' + $TimeoutMs + ' ms.') }

  if (-not $fatal) { try { $ps.Dispose() } catch { } }
  $stdout = $out
  if ($lines.Count -gt 0) { $stdout = $stdout + ($lines -join "`n") + "`n" }
  return [ordered]@{
    id = $Id
    stdout = $stdout
    stderr = ($errLines -join "`n")
    exitCode = $exitCode
    timedOut = $timedOut
    fatal = $fatal
    durationMs = [int]$sw.ElapsedMilliseconds
  }
}

# ---------------------------------------------------------------------------------------------
# Setup: one STA worker runspace (COM, WinForms, CoreAudio need STA), state persists across requests.
# ---------------------------------------------------------------------------------------------
try {
  $script:Runspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
  $script:Runspace.ApartmentState = [System.Threading.ApartmentState]::STA
  $script:Runspace.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
  $script:Runspace.Open()
  $script:Runspace.SessionStateProxy.SetVariable('FlowyWin32Source', $script:FlowyWin32Source)
  $script:Runspace.SessionStateProxy.SetVariable('FlowyAudioSource', $script:FlowyAudioSource)
  $init = Invoke-FlowyScript -Id 'init' -ScriptText $script:WorkerInit -TimeoutMs 20000
  if ($init.exitCode -ne 0) { Write-HostLog ('worker init failed: ' + $init.stderr) }
} catch {
  Write-HostLog ('cannot open runspace: ' + $_.Exception.Message)
  exit 2
}
Send-Line $script:ReadyMarker

# ---------------------------------------------------------------------------------------------
# Request loop (stdin EOF = parent stopped us or died)
# ---------------------------------------------------------------------------------------------
while ($true) {
  $line = $null
  try { $line = $script:StdIn.ReadLine() } catch { break }
  if ($null -eq $line) { break }
  if ([string]::IsNullOrWhiteSpace($line)) { continue }
  $id = ''
  try {
    $req = ConvertFrom-Json -InputObject $line
    $id = [string]$req.id
    $scriptText = $script:Utf8.GetString([Convert]::FromBase64String([string]$req.script))
    $timeoutMs = $script:DefaultTimeoutMs
    if ($req.timeoutMs) { $timeoutMs = [int]$req.timeoutMs }
    if ($timeoutMs -lt 100) { $timeoutMs = 100 }
    $r = Invoke-FlowyScript -Id $id -ScriptText $scriptText -TimeoutMs $timeoutMs
    Send-Reply $r
    if ($r.fatal) { exit 3 }
  } catch {
    Send-Reply ([ordered]@{ id = $id; stdout = ''; stderr = ('flowy-host: ' + $_.Exception.Message); exitCode = 1; timedOut = $false; fatal = $false; durationMs = 0 })
  }
}
try { $script:Runspace.Close() } catch { }
exit 0
