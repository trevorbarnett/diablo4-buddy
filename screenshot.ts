// Screenshot capture via PowerShell — works on Windows only.
// On WSL or macOS this will return a descriptive error so the client can fall back to paste/upload.

const POWERSHELL_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screen   = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$src      = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$g        = [System.Drawing.Graphics]::FromImage($src)
$g.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$g.Dispose()

# Scale down to max 1920px wide to stay under Claude's 5MB limit
$maxW = 1920
$scale = if ($src.Width -gt $maxW) { $maxW / $src.Width } else { 1.0 }
$dstW = [int]($src.Width  * $scale)
$dstH = [int]($src.Height * $scale)
$dst  = New-Object System.Drawing.Bitmap($dstW, $dstH)
$g2   = [System.Drawing.Graphics]::FromImage($dst)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.DrawImage($src, 0, 0, $dstW, $dstH)
$g2.Dispose(); $src.Dispose()

# Encode as JPEG quality 85
$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$encParams = New-Object System.Drawing.Imaging.EncoderParameters(1)
$encParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 85L)
$ms = New-Object System.IO.MemoryStream
$dst.Save($ms, $jpegCodec, $encParams)
$dst.Dispose()
[Convert]::ToBase64String($ms.ToArray())
`.trim();

export async function captureScreen(): Promise<{ imageBase64: string } | { error: string }> {
  try {
    // Detect if we're in WSL or Linux — PowerShell won't work there for screen capture
    const isWSL = process.platform === 'linux' && (
      (await Bun.file('/proc/version').text().catch(() => '')).toLowerCase().includes('microsoft')
    );

    const psExecutable = isWSL ? 'powershell.exe' : 'powershell';

    const proc = Bun.spawn(
      [psExecutable, '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT],
      { stdout: 'pipe', stderr: 'pipe' },
    );

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    await proc.exited;

    if (proc.exitCode !== 0) {
      const msg = stderr.trim() || 'PowerShell exited with non-zero code';
      console.error('[Screenshot] PowerShell error:', msg);
      const avBlocked = msg.toLowerCase().includes('malicious') || msg.toLowerCase().includes('antivirus');
      const hint = avBlocked
        ? 'Windows Defender blocked the screen capture. Use the hotkey listener (hotkey-listener.ps1) instead — it runs with user approval and bypasses this restriction.'
        : 'Try uploading or pasting an image directly.';
      return { error: `Screenshot failed: ${hint}` };
    }

    const imageBase64 = stdout.trim();
    if (!imageBase64 || imageBase64.length < 100) {
      return { error: 'Screenshot returned empty data. Check PowerShell permissions.' };
    }

    return { imageBase64 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Screenshot] Error:', msg);
    return {
      error: `Screenshot unavailable: ${msg}. Use the upload button to paste an image instead.`,
    };
  }
}
