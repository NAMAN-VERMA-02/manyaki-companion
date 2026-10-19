# Manyaki's hands on Windows: a long-running helper that speaks JSON lines on stdin/stdout.
#
# It runs only the fixed operations below (no arbitrary commands): list/focus/close/move windows,
# read and operate an app's controls through UI Automation, send keys and mouse input, capture the
# screen and read its text with Windows' built-in on-device OCR. Coordinates are physical pixels.
# Screenshots live in memory (OCR needs one short-lived temp file, deleted at once).

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$cs = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Automation;

public static class MK {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int s);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);

  public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }

  public static void Init() { SetProcessDPIAware(); }

  // ---------- tiny JSON writer ----------
  public static string Q(string s) {
    if (s == null) return "null";
    var b = new StringBuilder("\"");
    foreach (char c in s) {
      if (c == '"') b.Append("\\\""); else if (c == '\\') b.Append("\\\\");
      else if (c == '\n') b.Append("\\n"); else if (c == '\r') b.Append("\\r"); else if (c == '\t') b.Append("\\t");
      else if (c < 0x20) b.AppendFormat("\\u{0:x4}", (int)c); else b.Append(c);
    }
    return b.Append('"').ToString();
  }

  // ---------- windows ----------
  static string ProcName(uint pid) { try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; } }

  public static string Windows() {
    var fg = GetForegroundWindow();
    var sb = new StringBuilder("[");
    bool first = true;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h) || GetWindowTextLength(h) == 0) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;                 // owned popups
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;              // tool windows
      int cloaked; if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true; // hidden UWP shells
      var t = new StringBuilder(512); GetWindowText(h, t, 512);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; GetWindowRect(h, out r);
      if (!first) sb.Append(',');
      first = false;
      sb.AppendFormat("{{\"hwnd\":{0},\"title\":{1},\"pid\":{2},\"app\":{3},\"x\":{4},\"y\":{5},\"w\":{6},\"h\":{7},\"min\":{8},\"max\":{9},\"active\":{10}}}",
        h.ToInt64(), Q(t.ToString()), pid, Q(ProcName(pid)), r.L, r.T, r.R - r.L, r.B - r.T,
        IsIconic(h) ? "true" : "false", IsZoomed(h) ? "true" : "false", h == fg ? "true" : "false");
      return true;
    }, IntPtr.Zero);
    return sb.Append(']').ToString();
  }

  public static long Foreground() { return GetForegroundWindow().ToInt64(); }

  public static bool Focus(long hwnd) {
    var h = new IntPtr(hwnd);
    if (IsIconic(h)) ShowWindow(h, 9);
    // Windows only lets the process that last had input steal focus; a tap of Alt counts as input.
    Key(0x12, false); Key(0x12, true);
    return SetForegroundWindow(h);
  }

  public static bool Show(long hwnd, int cmd) { return ShowWindow(new IntPtr(hwnd), cmd); }   // 6 min, 3 max, 9 restore
  public static bool Close(long hwnd) { return PostMessage(new IntPtr(hwnd), 0x0010, IntPtr.Zero, IntPtr.Zero); } // WM_CLOSE: the app may ask to save

  public static bool Move(long hwnd, int x, int y, int w, int h) {
    var hw = new IntPtr(hwnd);
    if (IsZoomed(hw) || IsIconic(hw)) ShowWindow(hw, 9);
    return SetWindowPos(hw, IntPtr.Zero, x, y, w, h, 0x0004 | 0x0040); // NOZORDER | SHOWWINDOW
  }

  /** Snap to the left/right half, top/bottom half or maximise, on the window's own monitor. */
  public static bool Snap(long hwnd, string side) {
    var hw = new IntPtr(hwnd);
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(MonitorFromWindow(hw, 2), ref mi);
    var w = mi.rcWork; int W = w.R - w.L, H = w.B - w.T;
    if (side == "max") return ShowWindow(hw, 3);
    if (side == "left") return Move(hwnd, w.L, w.T, W / 2, H);
    if (side == "right") return Move(hwnd, w.L + W / 2, w.T, W - W / 2, H);
    if (side == "top") return Move(hwnd, w.L, w.T, W, H / 2);
    if (side == "bottom") return Move(hwnd, w.L, w.T + H / 2, W, H - H / 2);
    if (side == "center") return Move(hwnd, w.L + W / 6, w.T + H / 8, W * 2 / 3, H * 3 / 4);
    return false;
  }

  // ---------- keyboard & mouse ----------
  static void Send(INPUT i) { SendInput(1, new[] { i }, Marshal.SizeOf(typeof(INPUT))); }
  static void Key(ushort vk, bool up) { var i = new INPUT { type = 1 }; i.u.ki.vk = vk; i.u.ki.flags = up ? 2u : 0u; Send(i); }

  /** Types any text (Unicode, so Hindi and emoji work too). Newlines press Enter. */
  public static void TypeText(string s) {
    foreach (char c in s) {
      if (c == '\n') { Key(0x0D, false); Key(0x0D, true); continue; }
      if (c == '\r') continue;
      var d = new INPUT { type = 1 }; d.u.ki.scan = c; d.u.ki.flags = 4; Send(d);
      var u = new INPUT { type = 1 }; u.u.ki.scan = c; u.u.ki.flags = 4 | 2; Send(u);
    }
  }

  static readonly Dictionary<string, ushort> VK = new Dictionary<string, ushort>(StringComparer.OrdinalIgnoreCase) {
    {"ctrl",0x11},{"control",0x11},{"shift",0x10},{"alt",0x12},{"win",0x5B},{"windows",0x5B},{"enter",0x0D},{"return",0x0D},
    {"tab",0x09},{"esc",0x1B},{"escape",0x1B},{"backspace",0x08},{"delete",0x2E},{"del",0x2E},{"insert",0x2D},{"space",0x20},
    {"up",0x26},{"down",0x28},{"left",0x25},{"right",0x27},{"home",0x24},{"end",0x23},{"pageup",0x21},{"pagedown",0x22},
    {"printscreen",0x2C},{"capslock",0x14},{"volumeup",0xAF},{"volumedown",0xAE},{"mute",0xAD},{"playpause",0xB3},
    {"nexttrack",0xB0},{"prevtrack",0xB1},{"plus",0xBB},{"minus",0xBD},{"comma",0xBC},{"period",0xBE}
  };

  /** "ctrl+shift+t", "alt+f4", "win+d", "f5", "enter". Modifiers are held while the key is tapped. */
  public static bool Combo(string combo) {
    var parts = combo.ToLowerInvariant().Replace(" ", "").Split('+');
    var keys = new List<ushort>();
    foreach (var p in parts) {
      ushort vk;
      if (VK.TryGetValue(p, out vk)) keys.Add(vk);
      else if (p.Length == 1 && char.IsLetterOrDigit(p[0])) keys.Add((ushort)char.ToUpperInvariant(p[0]));
      else if (p.Length >= 2 && p.Length <= 3 && p[0] == 'f') { int n; if (int.TryParse(p.Substring(1), out n) && n >= 1 && n <= 24) keys.Add((ushort)(0x6F + n)); else return false; }
      else return false;
    }
    foreach (var k in keys) Key(k, false);
    for (int i = keys.Count - 1; i >= 0; i--) Key(keys[i], true);
    return true;
  }

  public static void Click(int x, int y, string button, bool dbl) {
    SetCursorPos(x, y);
    uint down = button == "right" ? 0x0008u : 0x0002u, up = button == "right" ? 0x0010u : 0x0004u;
    for (int n = 0; n < (dbl ? 2 : 1); n++) {
      var d = new INPUT { type = 0 }; d.u.mi.dwFlags = down; Send(d);
      var u = new INPUT { type = 0 }; u.u.mi.dwFlags = up; Send(u);
    }
  }

  public static void Scroll(int x, int y, int clicks) {
    if (x >= 0) SetCursorPos(x, y);
    var i = new INPUT { type = 0 }; i.u.mi.dwFlags = 0x0800; i.u.mi.mouseData = (uint)(clicks * 120); Send(i);
  }

  // ---------- UI Automation: an app's controls, like a page's DOM ----------
  static List<AutomationElement> els = new List<AutomationElement>();

  static string Ct(ControlType t) { var n = t.ProgrammaticName; return n.StartsWith("ControlType.") ? n.Substring(12).ToLowerInvariant() : n.ToLowerInvariant(); }

  public static string Tree(long hwnd, int max) {
    var root = AutomationElement.FromHandle(new IntPtr(hwnd));
    var cr = new CacheRequest();
    cr.Add(AutomationElement.NameProperty); cr.Add(AutomationElement.ControlTypeProperty); cr.Add(AutomationElement.BoundingRectangleProperty);
    cr.Add(AutomationElement.IsEnabledProperty); cr.Add(AutomationElement.IsOffscreenProperty); cr.Add(AutomationElement.AutomationIdProperty);
    cr.Add(AutomationElement.IsPasswordProperty); cr.Add(AutomationElement.HasKeyboardFocusProperty); cr.Add(AutomationElement.HelpTextProperty);
    cr.Add(ValuePattern.ValueProperty); cr.Add(TogglePattern.ToggleStateProperty); cr.Add(AutomationElement.IsValuePatternAvailableProperty);
    cr.Add(AutomationElement.IsInvokePatternAvailableProperty); cr.Add(AutomationElement.IsTogglePatternAvailableProperty);
    cr.TreeScope = TreeScope.Element;
    AutomationElementCollection all;
    using (cr.Activate()) { all = root.FindAll(TreeScope.Descendants, Automation.ControlViewCondition); }
    els = new List<AutomationElement>();
    var sb = new StringBuilder("[");
    bool first = true;
    foreach (AutomationElement e in all) {
      if (els.Count >= max) break;
      try {
        var r = (System.Windows.Rect)e.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
        if (r.IsEmpty || r.Width < 2 || r.Height < 2) continue;
        if ((bool)e.GetCachedPropertyValue(AutomationElement.IsOffscreenProperty)) continue;
        var type = Ct((ControlType)e.GetCachedPropertyValue(AutomationElement.ControlTypeProperty));
        var name = (string)e.GetCachedPropertyValue(AutomationElement.NameProperty) ?? "";
        bool interactive = (bool)e.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty) ||
          (bool)e.GetCachedPropertyValue(AutomationElement.IsValuePatternAvailableProperty) ||
          (bool)e.GetCachedPropertyValue(AutomationElement.IsTogglePatternAvailableProperty);
        // Skip anonymous layout containers; keep anything you can act on or read.
        if (name.Length == 0 && !interactive && type != "edit" && type != "document") continue;
        bool pw = (bool)e.GetCachedPropertyValue(AutomationElement.IsPasswordProperty);
        string val = null;
        if ((bool)e.GetCachedPropertyValue(AutomationElement.IsValuePatternAvailableProperty) && !pw) {
          var v = e.GetCachedPropertyValue(ValuePattern.ValueProperty) as string; if (v != null && v.Length > 0) val = v.Length > 400 ? v.Substring(0, 400) : v;
        }
        string toggle = null;
        try { var ts = e.GetCachedPropertyValue(TogglePattern.ToggleStateProperty); if (ts is ToggleState) toggle = ((ToggleState)ts).ToString().ToLowerInvariant(); } catch { }
        int id = els.Count; els.Add(e);
        if (!first) sb.Append(','); first = false;
        sb.AppendFormat("{{\"id\":\"u{0}\",\"type\":{1},\"name\":{2},\"x\":{3},\"y\":{4},\"w\":{5},\"h\":{6},\"enabled\":{7},\"focus\":{8},\"password\":{9},\"value\":{10},\"toggle\":{11},\"act\":{12},\"aid\":{13}}}",
          id, Q(type), Q(name.Length > 200 ? name.Substring(0, 200) : name), (int)r.X, (int)r.Y, (int)r.Width, (int)r.Height,
          (bool)e.GetCachedPropertyValue(AutomationElement.IsEnabledProperty) ? "true" : "false",
          (bool)e.GetCachedPropertyValue(AutomationElement.HasKeyboardFocusProperty) ? "true" : "false",
          pw ? "true" : "false", Q(val), Q(toggle), interactive ? "true" : "false",
          Q((string)e.GetCachedPropertyValue(AutomationElement.AutomationIdProperty)));
      } catch { }
    }
    return sb.Append(']').ToString();
  }

  static AutomationElement El(string id) {
    int i; if (!id.StartsWith("u") || !int.TryParse(id.Substring(1), out i) || i < 0 || i >= els.Count) throw new Exception("unknown control " + id + " (read the window again)");
    return els[i];
  }

  static void ClickCenter(AutomationElement e) {
    var r = e.Current.BoundingRectangle;
    Click((int)(r.X + r.Width / 2), (int)(r.Y + r.Height / 2), "left", false);
  }

  /** Press a control the way its app expects: invoke, toggle, select or expand; a real click otherwise. */
  public static string Invoke(string id) {
    var e = El(id);
    object p;
    if (e.TryGetCurrentPattern(InvokePattern.Pattern, out p)) { ((InvokePattern)p).Invoke(); return "invoked"; }
    if (e.TryGetCurrentPattern(TogglePattern.Pattern, out p)) { ((TogglePattern)p).Toggle(); return "toggled"; }
    if (e.TryGetCurrentPattern(SelectionItemPattern.Pattern, out p)) { ((SelectionItemPattern)p).Select(); return "selected"; }
    if (e.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out p)) { ((ExpandCollapsePattern)p).Expand(); return "expanded"; }
    ClickCenter(e); return "clicked";
  }

  public static string SetValue(string id, string text) {
    var e = El(id);
    object p;
    if (e.TryGetCurrentPattern(ValuePattern.Pattern, out p) && !((ValuePattern)p).Current.IsReadOnly) {
      try { ((ValuePattern)p).SetValue(text); return "set"; } catch { }
    }
    try { e.SetFocus(); } catch { ClickCenter(e); }
    Combo("ctrl+a"); TypeText(text); return "typed";
  }

  public static string FocusEl(string id) { var e = El(id); try { e.SetFocus(); } catch { ClickCenter(e); } return "focused"; }

  // ---------- screen ----------
  static Bitmap shot; static int shotX, shotY;

  public static string Capture(int x, int y, int w, int h, string tmp) {
    if (shot != null) shot.Dispose();
    shot = new Bitmap(w, h, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(shot)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h));
    shotX = x; shotY = y;
    shot.Save(tmp, ImageFormat.Png);
    return tmp;
  }

  /** The last capture with black boxes (screen coordinates) over private parts, as JPEG base64. */
  public static string Redacted(int[] boxes, int maxW, long quality) {
    if (shot == null) throw new Exception("no capture");
    double s = Math.Min(1.0, (double)maxW / shot.Width);
    using (var outBmp = new Bitmap((int)(shot.Width * s), (int)(shot.Height * s)))
    using (var g = Graphics.FromImage(outBmp)) {
      g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBilinear;
      g.DrawImage(shot, 0, 0, outBmp.Width, outBmp.Height);
      using (var black = new SolidBrush(Color.FromArgb(255, 11, 11, 15)))
        for (int i = 0; i + 3 < boxes.Length; i += 4)
          g.FillRectangle(black, (float)((boxes[i] - shotX) * s) - 1, (float)((boxes[i + 1] - shotY) * s) - 1, (float)(boxes[i + 2] * s) + 2, (float)(boxes[i + 3] * s) + 2);
      var enc = Array.Find(ImageCodecInfo.GetImageEncoders(), c => c.FormatID == ImageFormat.Jpeg.Guid);
      var ps = new EncoderParameters(1); ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);
      using (var ms = new MemoryStream()) { outBmp.Save(ms, enc, ps); return Convert.ToBase64String(ms.ToArray()); }
    }
  }

  public static void Forget() { if (shot != null) { shot.Dispose(); shot = null; } }
}
'@

Add-Type -TypeDefinition $cs -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing
[MK]::Init()

# ---------- on-device OCR (Windows.Media.Ocr) ----------
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $null = $t.Wait(-1); $t.Result }
$ocr = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()

function Read-Screen($x, $y, $w, $h) {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("manyaki-" + [Guid]::NewGuid().ToString('N') + '.png')
  try {
    [MK]::Capture($x, $y, $w, $h, $tmp) | Out-Null
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
      $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
      $bmp = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
      $res = Await ($ocr.RecognizeAsync($bmp)) ([Windows.Media.Ocr.OcrResult])
    } finally { $stream.Dispose() }
    $lines = foreach ($l in $res.Lines) {
      $ws = @($l.Words)
      if (-not $ws.Count) { continue }
      $minX = ($ws | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
      $minY = ($ws | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
      $maxX = ($ws | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
      $maxY = ($ws | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
      [ordered]@{
        text  = $l.Text
        x     = [int]($x + $minX); y = [int]($y + $minY); w = [int]($maxX - $minX); h = [int]($maxY - $minY)
        words = @($ws | ForEach-Object { [ordered]@{ t = $_.Text; x = [int]($x + $_.BoundingRect.X); w = [int]$_.BoundingRect.Width } })
      }
    }
    @{ lines = @($lines); lang = $ocr.RecognizerLanguage.LanguageTag }
  } finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
}

function Out-Json($id, $ok, $raw) { [Console]::Out.WriteLine("{""id"":$id,""ok"":$ok,""result"":$raw}"); [Console]::Out.Flush() }

[Console]::Out.WriteLine('{"id":0,"ok":true,"result":"ready"}'); [Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = 0
  try {
    $r = $line | ConvertFrom-Json
    $id = [int]$r.id
    $a = $r.args
    $raw = switch ($r.op) {
      'windows'    { [MK]::Windows() }
      'foreground' { [string][MK]::Foreground() }
      'focus'      { if ([MK]::Focus([long]$a.hwnd)) { 'true' } else { 'false' } }
      'show'       { if ([MK]::Show([long]$a.hwnd, [int]$a.cmd)) { 'true' } else { 'false' } }
      'close'      { if ([MK]::Close([long]$a.hwnd)) { 'true' } else { 'false' } }
      'move'       { if ([MK]::Move([long]$a.hwnd, [int]$a.x, [int]$a.y, [int]$a.w, [int]$a.h)) { 'true' } else { 'false' } }
      'snap'       { if ([MK]::Snap([long]$a.hwnd, [string]$a.side)) { 'true' } else { 'false' } }
      'tree'       { [MK]::Tree([long]$a.hwnd, [int]$a.max) }
      'invoke'     { [MK]::Q([MK]::Invoke([string]$a.id)) }
      'setvalue'   { [MK]::Q([MK]::SetValue([string]$a.id, [string]$a.text)) }
      'focusel'    { [MK]::Q([MK]::FocusEl([string]$a.id)) }
      'type'       { [MK]::TypeText([string]$a.text); 'true' }
      'keys'       { if ([MK]::Combo([string]$a.combo)) { 'true' } else { throw "unknown keys: $($a.combo)" } }
      'click'      { [MK]::Click([int]$a.x, [int]$a.y, [string]$a.button, [bool]$a.double); 'true' }
      'scroll'     { [MK]::Scroll([int]$a.x, [int]$a.y, [int]$a.clicks); 'true' }
      'ocr'        { Read-Screen ([int]$a.x) ([int]$a.y) ([int]$a.w) ([int]$a.h) | ConvertTo-Json -Depth 6 -Compress }
      'redacted'   { [MK]::Q([MK]::Redacted([int[]]@($a.boxes), [int]$a.maxW, [long]$a.quality)) }
      'forget'     { [MK]::Forget(); 'true' }
      'ping'       { '"pong"' }
      default      { throw "unknown op $($r.op)" }
    }
    Out-Json $id 'true' $raw
  } catch {
    $msg = [MK]::Q($_.Exception.Message)
    [Console]::Out.WriteLine("{""id"":$id,""ok"":false,""error"":$msg}"); [Console]::Out.Flush()
  }
}
