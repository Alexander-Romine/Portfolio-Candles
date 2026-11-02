$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$dir = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$size = 256
$bmp = [System.Drawing.Bitmap]::new($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([int]$x, [int]$y, [int]$w, [int]$h, [int]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $p.AddArc($x, $y, 2 * $r, 2 * $r, 180, 90)
  $p.AddArc($x + $w - 2 * $r, $y, 2 * $r, 2 * $r, 270, 90)
  $p.AddArc($x + $w - 2 * $r, $y + $h - 2 * $r, 2 * $r, 2 * $r, 0, 90)
  $p.AddArc($x, $y + $h - 2 * $r, 2 * $r, 2 * $r, 90, 90)
  $p.CloseFigure()
  return $p
}

# background tile with a soft vertical gradient
$path = New-RoundedPath 8 8 240 240 56
$brush = [System.Drawing.Drawing2D.LinearGradientBrush]::new(
  [System.Drawing.Point]::new(0, 0),
  [System.Drawing.Point]::new(0, 256),
  [System.Drawing.Color]::FromArgb(255, 23, 29, 43),
  [System.Drawing.Color]::FromArgb(255, 11, 14, 21))
$g.FillPath($brush, $path)
$pen = [System.Drawing.Pen]::new([System.Drawing.Color]::FromArgb(255, 47, 58, 84), 4)
$g.DrawPath($pen, $path)

$green = [System.Drawing.Color]::FromArgb(255, 38, 166, 154)
$red = [System.Drawing.Color]::FromArgb(255, 239, 83, 80)

function Draw-Candle([float]$cx, [float]$top, [float]$bottom, [float]$bodyTop, [float]$bodyBottom, [System.Drawing.Color]$color, [float]$wickW, [float]$bodyW) {
  $script:g.FillRectangle([System.Drawing.SolidBrush]::new($color), $cx - $wickW / 2, $top, $wickW, $bottom - $top)
  $script:g.FillRectangle([System.Drawing.SolidBrush]::new($color), $cx - $bodyW / 2, $bodyTop, $bodyW, $bodyBottom - $bodyTop)
}

# three candles: up, down, up
Draw-Candle 74  52 206  82 176 $green 9 46
Draw-Candle 128 38 218  70 186 $red   9 46
Draw-Candle 182 66 232  96 204 $green 9 46

$g.Dispose()

$pngPath = Join-Path $dir 'icon.png'
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)

# wrap the PNG in a 256px ICO container (PNG-compressed entry, valid on Vista+)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$bmp.Dispose()

$icoPath = Join-Path $dir 'icon.ico'
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs
$bw.Write([uint16]0)          # reserved
$bw.Write([uint16]1)          # type: icon
$bw.Write([uint16]1)          # count: 1 entry
$bw.Write([byte]0)            # width 256 (0 = 256)
$bw.Write([byte]0)            # height 256
$bw.Write([byte]0)            # palette colors
$bw.Write([byte]0)            # reserved
$bw.Write([uint16]1)          # color planes
$bw.Write([uint16]32)         # bits per pixel
$bw.Write([uint32]$png.Length)
$bw.Write([uint32]22)         # offset: header(6) + entry(16)
$bw.Write($png)
$bw.Close()

Write-Output "WROTE $icoPath ($([math]::Round((Get-Item $icoPath).Length / 1KB, 1)) KB)"
Write-Output "WROTE $pngPath"
