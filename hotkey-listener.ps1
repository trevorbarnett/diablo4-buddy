# D4 Item Advisor - Global Hotkey Listener
# Registers F9 system-wide. Press F9 while hovering an item in Diablo 4.
# Takes the screenshot itself and sends it to the server - no alt-tab needed.
#
# If Windows Defender blocks this script, add an exclusion for this file in
# Windows Security > Virus & threat protection > Exclusions.

param(
    [string]$ApiUrl   = "http://localhost:4002",
    [int]$HotkeyId    = 1,
    [uint32]$VK       = 0x78   # F9
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class Win32 {
    public const int WM_HOTKEY = 0x0312;

    [StructLayout(LayoutKind.Sequential)]
    public struct MSG {
        public IntPtr   hwnd;
        public uint     message;
        public UIntPtr  wParam;
        public IntPtr   lParam;
        public uint     time;
        public int      x, y;
    }

    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern int  GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
}
"@

# Tray icon
$tray         = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon    = [System.Drawing.SystemIcons]::Shield
$tray.Text    = "D4 Item Advisor"
$tray.Visible = $true

$exitItem = New-Object System.Windows.Forms.MenuItem "Exit"
$exitItem.Add_Click({ $script:running = $false })
$menu = New-Object System.Windows.Forms.ContextMenu
$menu.MenuItems.Add($exitItem) | Out-Null
$tray.ContextMenu = $menu

function Notify($title, $body, $type = "Info") {
    $tray.ShowBalloonTip(6000, $title, $body, [System.Windows.Forms.ToolTipIcon]::$type)
}

function Get-Screenshot {
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $src    = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
    $g      = [System.Drawing.Graphics]::FromImage($src)
    $g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
    $g.Dispose()

    # Scale to max 1920px wide to stay under the 5MB API limit
    $maxW  = 1920
    $scale = if ($src.Width -gt $maxW) { $maxW / $src.Width } else { 1.0 }
    $dstW  = [int]($src.Width  * $scale)
    $dstH  = [int]($src.Height * $scale)
    $dst   = New-Object System.Drawing.Bitmap($dstW, $dstH)
    $g2    = [System.Drawing.Graphics]::FromImage($dst)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($src, 0, 0, $dstW, $dstH)
    $g2.Dispose(); $src.Dispose()

    # JPEG at quality 85
    $codec  = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
        [System.Drawing.Imaging.Encoder]::Quality, 85L)
    $ms = New-Object System.IO.MemoryStream
    $dst.Save($ms, $codec, $params)
    $dst.Dispose()

    return [Convert]::ToBase64String($ms.ToArray())
}

# Register F9 globally
if (-not [Win32]::RegisterHotKey([IntPtr]::Zero, $HotkeyId, 0, $VK)) {
    Notify "D4 Advisor" "Failed to register F9 - another app may be using it." "Error"
    Start-Sleep 4; exit 1
}

Notify "D4 Advisor" "Running. Press F9 in Diablo 4 to analyze the hovered item." "Info"
Write-Host "D4 Advisor running. Press F9 in-game. Right-click tray icon to exit."

$script:running = $true

try {
    while ($script:running) {
        [System.Windows.Forms.Application]::DoEvents()

        $msg    = New-Object Win32+MSG
        $result = [Win32]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0)
        if ($result -le 0) { break }
        if ($msg.message -ne [Win32]::WM_HOTKEY) { continue }

        try {
            # Capture screen here (on Windows side) and POST image to server
            $imgBase64 = Get-Screenshot
            $body      = @{ imageBase64 = $imgBase64 } | ConvertTo-Json -Compress -Depth 2

            $resp = Invoke-RestMethod `
                -Uri         "$ApiUrl/analyze" `
                -Method      POST `
                -ContentType "application/json" `
                -Body        $body

            if (-not $resp.item_found) {
                Notify "D4 Advisor" "No tooltip visible - hover over an item first." "Warning"
                continue
            }

            $verdict = if ($resp.verdict)         { $resp.verdict }   else { "?" }
            $name    = if ($resp.item_name)        { $resp.item_name } else { "Unknown" }
            $score   = if ($resp.score -ne $null)  { $resp.score }     else { 0 }
            $reason  = if ($resp.reasoning)        { $resp.reasoning -replace "`n", " " } else { "" }
            if ($reason.Length -gt 220) { $reason = $reason.Substring(0, 220) + "..." }

            $notifType = switch ($verdict) {
                "KEEP"   { "Info" }
                "TEMPER" { "Warning" }
                default  { "Error" }
            }

            $upgradeTag = if ($resp.upgrade_verdict)  { " | $($resp.upgrade_verdict)" } else { "" }
            $critTag    = if ($resp.is_critical_item) { " | BUILD ENABLER" }            else { "" }

            Notify "$verdict$upgradeTag -- $name ($score/10)$critTag" $reason $notifType

        } catch {
            $err = $_.Exception.Message
            Notify "D4 Advisor Error" $err "Error"
            Write-Warning "Error: $err"
        }
    }
} finally {
    [Win32]::UnregisterHotKey([IntPtr]::Zero, $HotkeyId)
    $tray.Visible = $false
    $tray.Dispose()
    Write-Host "D4 Advisor stopped."
}
