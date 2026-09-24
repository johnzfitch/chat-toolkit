# Render the project's simple chat/download symbol at Firefox's icon sizes.
# Uses only the Windows .NET drawing library; generated PNGs ship with source.
Add-Type -AssemblyName System.Drawing
$iconDirectory = Join-Path $PSScriptRoot '..\extension-src\icons'
foreach ($iconSize in @(16, 32, 48, 96, 128)) {
    $canvas = New-Object System.Drawing.Bitmap ($iconSize * 4), ($iconSize * 4)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform(($iconSize * 4 / 96.0), ($iconSize * 4 / 96.0))
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $background = New-Object System.Drawing.Drawing2D.GraphicsPath
    foreach ($arc in @(@(4,4,32,32,180,90), @(60,4,32,32,270,90), @(60,60,32,32,0,90), @(4,60,32,32,90,90))) {
        $background.AddArc($arc[0], $arc[1], $arc[2], $arc[3], $arc[4], $arc[5])
    }
    $background.CloseFigure()
    $ink = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#0d1117'))
    $sand = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#d4a574'))
    $light = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#f5e5ce')), 6
    $light.StartCap = $light.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $light.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.FillPath($ink, $background)
    $bubble = New-Object System.Drawing.Drawing2D.GraphicsPath
    $bubble.AddLines([System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF 21,24), (New-Object System.Drawing.PointF 75,24),
        (New-Object System.Drawing.PointF 75,55), (New-Object System.Drawing.PointF 42,55),
        (New-Object System.Drawing.PointF 23,70), (New-Object System.Drawing.PointF 23,55),
        (New-Object System.Drawing.PointF 21,55)))
    $bubble.CloseFigure()
    $graphics.FillPath($sand, $bubble)
    $graphics.DrawLine($light, 67, 64, 67, 80)
    $graphics.DrawLines($light, [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF 59,73), (New-Object System.Drawing.PointF 67,81),
        (New-Object System.Drawing.PointF 75,73)))
    $graphics.FillRectangle($ink, 30, 34, 35, 4)
    $graphics.FillRectangle($ink, 30, 43, 23, 4)
    $result = New-Object System.Drawing.Bitmap $iconSize, $iconSize
    $resizer = [System.Drawing.Graphics]::FromImage($result)
    $resizer.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $resizer.DrawImage($canvas, 0, 0, $iconSize, $iconSize)
    $iconPath = Join-Path $iconDirectory "icon$iconSize.png"
    $result.Save($iconPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $graphics.Dispose(); $resizer.Dispose(); $canvas.Dispose(); $result.Dispose()
    $background.Dispose(); $bubble.Dispose(); $ink.Dispose(); $sand.Dispose(); $light.Dispose()
    Write-Output "Rendered $iconSize x $iconSize : $iconPath"
}
