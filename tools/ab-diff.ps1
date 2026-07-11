# Pixel-diff two same-size PNGs. Reports % of pixels differing beyond a
# per-channel tolerance and writes a visual diff (red = differing).
param(
  [Parameter(Mandatory)] [string]$Ref,
  [Parameter(Mandatory)] [string]$Ours,
  [string]$DiffOut,
  [int]$Tolerance = 12
)
Add-Type -AssemblyName System.Drawing
$a = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Ref))
$b = [System.Drawing.Bitmap]::FromFile((Resolve-Path $Ours))
if ($a.Width -ne $b.Width -or $a.Height -ne $b.Height) { throw "size mismatch: $($a.Width)x$($a.Height) vs $($b.Width)x$($b.Height)" }

$rect = New-Object System.Drawing.Rectangle(0, 0, $a.Width, $a.Height)
$fmt = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
$da = $a.LockBits($rect, 'ReadOnly', $fmt); $db = $b.LockBits($rect, 'ReadOnly', $fmt)
$len = $da.Stride * $a.Height
$ba = New-Object byte[] $len; $bb = New-Object byte[] $len
[System.Runtime.InteropServices.Marshal]::Copy($da.Scan0, $ba, 0, $len)
[System.Runtime.InteropServices.Marshal]::Copy($db.Scan0, $bb, 0, $len)
$a.UnlockBits($da); $b.UnlockBits($db)

$diffMask = New-Object byte[] $len
$diff = 0; $total = $a.Width * $a.Height
for ($i = 0; $i -lt $len; $i += 4) {
  $d = [Math]::Abs($ba[$i] - $bb[$i])
  $d1 = [Math]::Abs($ba[$i+1] - $bb[$i+1]); if ($d1 -gt $d) { $d = $d1 }
  $d2 = [Math]::Abs($ba[$i+2] - $bb[$i+2]); if ($d2 -gt $d) { $d = $d2 }
  if ($d -gt $Tolerance) {
    $diff++
    $diffMask[$i+2] = 255; $diffMask[$i+3] = 255   # red
  } else {
    $diffMask[$i] = $ba[$i]; $diffMask[$i+1] = $ba[$i+1]; $diffMask[$i+2] = $ba[$i+2]; $diffMask[$i+3] = 60
  }
}
$pct = [Math]::Round(100.0 * $diff / $total, 3)
"pixels differing (tol $Tolerance): $diff / $total = $pct%"
if ($DiffOut) {
  $out = New-Object System.Drawing.Bitmap($a.Width, $a.Height, $fmt)
  $do = $out.LockBits($rect, 'WriteOnly', $fmt)
  [System.Runtime.InteropServices.Marshal]::Copy($diffMask, 0, $do.Scan0, $len)
  $out.UnlockBits($do)
  $out.Save($DiffOut, [System.Drawing.Imaging.ImageFormat]::Png)
  "diff image: $DiffOut"
  $out.Dispose()
}
$a.Dispose(); $b.Dispose()
