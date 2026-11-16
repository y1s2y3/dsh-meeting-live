<#
  Meeting-minutes desktop orb (Windows / WPF, STA).

  ONE window holding both the round orb and the speech bubble. A separate bubble
  window could not receive clicks while the orb ran inside a modal ShowDialog, so
  everything now lives in a single window: the ball is pinned to the bottom-right
  corner of the window and the bubble grows upward/leftward from it.

    ball   : 68 px circle, translucent, mic glyph that scales with the live audio
             level, red dot + expanding ripple ring (both centred on the ball)
    bubble : card above the ball with the meeting title, status, timer, live
             transcript, pause/resume + stop, and a close (x) button

  Cross-process protocol (file based, same idea as dsh-session-ball):
    - host -> orb : <StateDir>\state-<NNNNNN>.json (highest number wins)
    - orb -> host : <StateDir>\cmd-<ticks>-<rand>.json

  Keep this file pure ASCII: Chinese labels arrive inside the state JSON
  (BOM-less .ps1 files are decoded as ANSI by Windows PowerShell 5.1).

  Modes:
    -StateDir <dir>                    normal run (spawned by the plugin host)
    -StateDir <dir> -Preview <outDir>  render ball.png / bubble.png and exit
    -DemoBubble                        auto-open the bubble (screenshot checks)
#>
param(
  [Parameter(Mandatory = $true)][string]$StateDir,
  [string]$Preview = '',
  [string]$PidFile = '',
  [switch]$DemoBubble
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Windows.Forms

$script:State = $null
$script:LastStateTicks = 0
$script:LatestStateName = ''
$script:LastStateName = ''
$script:LastTranscript = ''
$script:Labels = @{}
$script:Collapsed = $true
$script:DragOrigin = $null
$script:Dragging = $false
$script:Phase = 0.0
$script:SmoothLevel = 0.0
$script:DemoTicks = 0
$script:StopPending = $false
$script:StopPendingUntil = 0
$script:InputSignature = ''
$script:InputIds = @()
$script:PopulatingInput = $false

$BALL_SIZE = 96
$BALL_CORE = 68
$CARD_WIDTH = 316

function Get-String($bag, $name, $fallback) {
  if ($null -eq $bag) { return $fallback }
  $value = $bag.$name
  if ($null -eq $value) { return $fallback }
  $text = [string]$value
  if ($text -eq '') { return $fallback }
  return $text
}

function Read-LatestState {
  try {
    $files = @(Get-ChildItem -LiteralPath $StateDir -Filter 'state-*.json' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending)
    if ($files.Count -eq 0) {
      $script:LatestStateName = ''
      return $null
    }
    $script:LatestStateName = $files[0].Name
    $raw = [System.IO.File]::ReadAllText($files[0].FullName, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Write-Command([string]$name, [string]$deviceId = '') {
  try {
    $stamp = [DateTime]::UtcNow.Ticks
    $rand = Get-Random -Minimum 1000 -Maximum 9999
    $file = Join-Path $StateDir ("cmd-{0}-{1}.json" -f $stamp, $rand)
    $payload = @{ command = $name; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    if ($deviceId -ne '') { $payload.deviceId = $deviceId }
    $json = $payload | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    # A dropped command is not fatal: the host keeps polling.
  }
}

function Brush([string]$hex) {
  $brush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.ColorConverter]::ConvertFromString($hex))
  $brush.Freeze()
  return $brush
}

function Format-Timer([int]$seconds) {
  if ($seconds -lt 0) { $seconds = 0 }
  $h = [math]::Floor($seconds / 3600)
  $m = [math]::Floor(($seconds % 3600) / 60)
  $s = $seconds % 60
  if ($h -gt 0) { return ('{0:00}:{1:00}:{2:00}' -f $h, $m, $s) }
  return ('{0:00}:{1:00}' -f $m, $s)
}

$buttonStyle = @'
    <Style x:Key="OrbButton" TargetType="Button">
      <Setter Property="Foreground" Value="#FF475569" />
      <Setter Property="Background" Value="#FFFFFFFF" />
      <Setter Property="BorderThickness" Value="1" />
      <Setter Property="BorderBrush" Value="#E1E7F1" />
      <Setter Property="Padding" Value="12,6" />
      <Setter Property="FontSize" Value="12" />
      <Setter Property="FontFamily" Value="Microsoft YaHei UI" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Chrome" CornerRadius="9" Background="{TemplateBinding Background}"
                    BorderBrush="{TemplateBinding BorderBrush}" BorderThickness="{TemplateBinding BorderThickness}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"
                                Margin="{TemplateBinding Padding}" />
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="#EEF3FB" />
                <Setter Property="Foreground" Value="#2563EB" />
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="#E2EBFF" />
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.45" />
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
    <Style x:Key="GhostButton" TargetType="Button">
      <Setter Property="Foreground" Value="#FF8A94A6" />
      <Setter Property="Background" Value="Transparent" />
      <Setter Property="BorderThickness" Value="0" />
      <Setter Property="FontSize" Value="14" />
      <Setter Property="Cursor" Value="Hand" />
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Chrome" CornerRadius="8" Background="{TemplateBinding Background}">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center" />
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="#EEF3FB" />
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>
'@

$shellXaml = @"
<Grid xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
      xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml" Background="Transparent">
  <Grid.Resources>
$buttonStyle
  </Grid.Resources>
  <Grid.RowDefinitions>
    <RowDefinition x:Name="CardRow" Height="0" />
    <RowDefinition Height="$BALL_SIZE" />
  </Grid.RowDefinitions>

  <!-- 气泡卡片（在球的上方；展开时行高 Auto，收起时 0） -->
  <Grid x:Name="CardHost" Grid.Row="0" Width="$CARD_WIDTH" HorizontalAlignment="Right" Margin="0,0,0,6"
        Visibility="Collapsed">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto" />
      <RowDefinition Height="10" />
    </Grid.RowDefinitions>
    <Border x:Name="Card" Grid.Row="0" CornerRadius="14" Background="#F5FFFFFF"
            BorderThickness="1" BorderBrush="#E3E9F2" Padding="13,10">
      <Border.Effect>
        <DropShadowEffect Color="#0F172A" BlurRadius="22" ShadowDepth="2" Opacity="0.18" />
      </Border.Effect>
      <Grid>
        <Grid.RowDefinitions>
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
          <RowDefinition Height="Auto" />
        </Grid.RowDefinitions>

        <Grid Grid.Row="0">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*" />
            <ColumnDefinition Width="Auto" />
          </Grid.ColumnDefinitions>
          <TextBlock x:Name="BubbleTitle" Grid.Column="0" Text="Meeting" FontSize="13.5" FontWeight="SemiBold"
                     FontFamily="Microsoft YaHei UI" Foreground="#FF0F172A" VerticalAlignment="Center"
                     TextTrimming="CharacterEllipsis" />
          <Button x:Name="BubbleClose" Grid.Column="1" Style="{StaticResource GhostButton}" Content="&#x00D7;"
                  Width="30" Height="26" ToolTip="Close" />
        </Grid>

        <StackPanel Grid.Row="1" Orientation="Horizontal" Margin="0,8,0,8">
          <Ellipse x:Name="BubbleDot" Width="8" Height="8" Fill="#FFE0574B" VerticalAlignment="Center" Margin="0,0,7,0" />
          <TextBlock x:Name="BubbleStatus" Text="REC" FontSize="12" FontFamily="Microsoft YaHei UI"
                     Foreground="#FF475569" VerticalAlignment="Center" />
          <TextBlock x:Name="BubbleTimer" Text="00:00" FontSize="12" FontFamily="Consolas"
                     Foreground="#FF334155" VerticalAlignment="Center" Margin="9,0,0,0" />
          <TextBlock x:Name="BubbleChars" Text="" FontSize="11" FontFamily="Microsoft YaHei UI"
                     Foreground="#FF8A94A6" VerticalAlignment="Center" Margin="10,0,0,0" />
        </StackPanel>

        <Border Grid.Row="2" Height="150" CornerRadius="10" Background="#F7F9FC"
                BorderThickness="1" BorderBrush="#E4E9F2" Padding="9,7">
          <TextBox x:Name="BubbleTranscript" Text="" IsReadOnly="True" BorderThickness="0"
                   Background="Transparent" Foreground="#FF334155" FontSize="12"
                   FontFamily="Microsoft YaHei UI" TextWrapping="Wrap"
                   VerticalScrollBarVisibility="Auto" IsTabStop="False" />
        </Border>

        <Grid Grid.Row="3" Margin="0,8,0,0">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="Auto" />
            <ColumnDefinition Width="*" />
          </Grid.ColumnDefinitions>
          <TextBlock x:Name="BubbleInputLabel" Grid.Column="0" Text="Mic" FontSize="11"
                     FontFamily="Microsoft YaHei UI" Foreground="#FF8A94A6" VerticalAlignment="Center"
                     Margin="0,0,8,0" />
          <ComboBox x:Name="BubbleInput" Grid.Column="1" Height="28" FontSize="11.5"
                    FontFamily="Microsoft YaHei UI" VerticalContentAlignment="Center"
                    ToolTip="Switch audio input" />
        </Grid>

        <Grid Grid.Row="4" Margin="0,10,0,0">
          <Grid.ColumnDefinitions>
            <ColumnDefinition Width="*" />
            <ColumnDefinition Width="Auto" />
          </Grid.ColumnDefinitions>
          <Button x:Name="BubblePause" Grid.Column="0" Style="{StaticResource OrbButton}" Content="Pause"
                  HorizontalAlignment="Left" />
          <Button x:Name="BubbleStop" Grid.Column="1" Style="{StaticResource OrbButton}" Content="Stop"
                  Foreground="#FFDC2626" BorderBrush="#F4C7C7" Background="#FFFEF2F2" />
        </Grid>
      </Grid>
    </Border>

    <!-- 指向下方球的小尖角 -->
    <Path Grid.Row="1" HorizontalAlignment="Right" Margin="0,0,41,0" Width="14" Height="10" Stretch="Fill"
          Fill="#F5FFFFFF" Stroke="#E3E9F2" StrokeThickness="1" Data="M1,0 L7,9 L13,0" />
  </Grid>

  <!-- 悬浮球（固定在窗口右下角） -->
  <Grid x:Name="BallHost" Grid.Row="1" Width="$BALL_SIZE" Height="$BALL_SIZE" HorizontalAlignment="Right">
    <Ellipse x:Name="Ripple" Width="$BALL_CORE" Height="$BALL_CORE" Stroke="#FF2F6BFF" StrokeThickness="1.6"
             Opacity="0" HorizontalAlignment="Center" VerticalAlignment="Center" IsHitTestVisible="False"
             RenderTransformOrigin="0.5,0.5">
      <Ellipse.RenderTransform>
        <ScaleTransform x:Name="RippleScale" ScaleX="1" ScaleY="1" />
      </Ellipse.RenderTransform>
    </Ellipse>
    <Ellipse x:Name="LevelRing" Width="$BALL_CORE" Height="$BALL_CORE" Stroke="#FF2F6BFF" StrokeThickness="2.6"
             Opacity="0" HorizontalAlignment="Center" VerticalAlignment="Center" IsHitTestVisible="False"
             RenderTransformOrigin="0.5,0.5">
      <Ellipse.RenderTransform>
        <ScaleTransform x:Name="LevelRingScale" ScaleX="1" ScaleY="1" />
      </Ellipse.RenderTransform>
    </Ellipse>
    <Border x:Name="BallCore" Width="$BALL_CORE" Height="$BALL_CORE" CornerRadius="34"
            BorderThickness="1" BorderBrush="#BFCFF0" Background="Transparent"
            HorizontalAlignment="Center" VerticalAlignment="Center">
      <Border.Effect>
        <DropShadowEffect x:Name="BallGlow" Color="#FF2F6BFF" BlurRadius="22" ShadowDepth="0" Opacity="0.26" />
      </Border.Effect>
      <Grid>
        <Ellipse x:Name="BallHighlight" Width="46" Height="46" HorizontalAlignment="Left" VerticalAlignment="Top"
                 Margin="8,7,0,0" IsHitTestVisible="False">
          <Ellipse.Fill>
            <RadialGradientBrush GradientOrigin="0.35,0.3" Center="0.4,0.35" RadiusX="0.8" RadiusY="0.8">
              <GradientStop Color="#40FFFFFF" Offset="0" />
              <GradientStop Color="#00FFFFFF" Offset="1" />
            </RadialGradientBrush>
          </Ellipse.Fill>
        </Ellipse>
        <Viewbox x:Name="MicGlyph" Width="32" Height="32" HorizontalAlignment="Center" VerticalAlignment="Center"
                 Margin="0,0,0,11" RenderTransformOrigin="0.5,0.5">
          <Viewbox.RenderTransform>
            <ScaleTransform x:Name="MicScale" ScaleX="1" ScaleY="1" />
          </Viewbox.RenderTransform>
          <Canvas Width="16" Height="16">
            <Path Stroke="#FF1F2937" StrokeThickness="1.5" StrokeStartLineCap="Round" StrokeEndLineCap="Round"
                  Data="M8,2.6 A2,2 0 0 1 10,4.6 L10,7.8 A2,2 0 0 1 6,7.8 L6,4.6 A2,2 0 0 1 8,2.6 Z M4.2,7.4 L4.2,8 A3.8,3.8 0 0 0 11.8,8 L11.8,7.4 M8,11.9 L8,13.8 M5.9,13.8 L10.1,13.8" />
          </Canvas>
        </Viewbox>
        <TextBlock x:Name="OrbTimer" Text="00:00" FontSize="11" FontFamily="Consolas"
                   Foreground="#FF475569" HorizontalAlignment="Center" VerticalAlignment="Bottom" Margin="0,0,0,6" />
        <Ellipse x:Name="OrbDot" Width="10" Height="10" Fill="#FFE0574B" Stroke="#FFFFFFFF" StrokeThickness="1.2"
                 HorizontalAlignment="Right" VerticalAlignment="Top" Margin="0,7,7,0" />
      </Grid>
    </Border>
  </Grid>
</Grid>
"@

function Set-BallGradient($root) {
  $core = $root.FindName('BallCore')
  $gradient = New-Object System.Windows.Media.RadialGradientBrush
  $gradient.GradientOrigin = [System.Windows.Point]::new(0.3, 0.26)
  $gradient.Center = [System.Windows.Point]::new(0.35, 0.3)
  $gradient.RadiusX = 0.9
  $gradient.RadiusY = 0.9
  foreach ($stop in @(
    @{ offset = 0.0; color = 'FC_FFFFFF' },
    @{ offset = 0.62; color = 'FA_F3F7FF' },
    @{ offset = 1.0; color = 'FC_E4EDFB' }
  )) {
    $parts = $stop.color.Split('_')
    $color = [System.Windows.Media.ColorConverter]::ConvertFromString('#' + $parts[1])
    $color.A = [byte][Convert]::ToInt32($parts[0], 16)
    $gradient.GradientStops.Add([System.Windows.Media.GradientStop]::new($color, [double]$stop.offset))
  }
  $core.Background = $gradient
}

function Get-SavedPosition([double]$fallbackLeft, [double]$fallbackTop) {
  $posFile = Join-Path $StateDir 'pos.json'
  if (Test-Path -LiteralPath $posFile) {
    try {
      $pos = ([System.IO.File]::ReadAllText($posFile, [System.Text.Encoding]::UTF8)) | ConvertFrom-Json
      return @{ left = [double]$pos.left; top = [double]$pos.top }
    } catch { }
  }
  return @{ left = $fallbackLeft; top = $fallbackTop }
}

function Save-Position($window) {
  # 记住的是「球」的位置：窗口展开时尺寸变大、左上角会往左上跑，必须按右下角反算。
  try {
    $ballLeft = [math]::Round([double]$window.Left + [double]$window.ActualWidth - $BALL_SIZE)
    $ballTop = [math]::Round([double]$window.Top + [double]$window.ActualHeight - $BALL_SIZE)
  } catch {
    return
  }
  if ($ballLeft -le 0 -and $ballTop -le 0) { return }
  try {
    $payload = '{"left":' + $ballLeft + ',"top":' + $ballTop + '}'
    [System.IO.File]::WriteAllText((Join-Path $StateDir 'pos.json'), $payload, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

# ─────────────────────────────── preview mode ───────────────────────────────
if ($Preview -ne '') {
  New-Item -ItemType Directory -Path $Preview -Force | Out-Null

  function Save-Preview($visual, [int]$width, [int]$height, [string]$file, [string]$background = '#FF242830') {
    $stage = New-Object System.Windows.Controls.Border
    $stage.Background = Brush $background
    $stage.Width = $width
    $stage.Height = $height
    $stage.Child = $visual
    $stage.Measure([System.Windows.Size]::new($width, $height))
    $stage.Arrange([System.Windows.Rect]::new(0, 0, $width, $height))
    $stage.UpdateLayout()
    $scale = 2.0
    $bitmap = [System.Windows.Media.Imaging.RenderTargetBitmap]::new(
      [int]($width * $scale), [int]($height * $scale), [double](96 * $scale), [double](96 * $scale),
      [System.Windows.Media.PixelFormats]::Pbgra32)
    $bitmap.Render($stage)
    $stage.Child = $null
    $encoder = [System.Windows.Media.Imaging.PngBitmapEncoder]::new()
    $encoder.Frames.Add([System.Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
    $stream = [System.IO.File]::Create($file)
    try { $encoder.Save($stream) } finally { $stream.Close() }
  }

  # ball
  $ballRoot = [Windows.Markup.XamlReader]::Parse($shellXaml)
  Set-BallGradient $ballRoot
  $ballRoot.FindName('OrbTimer').Text = '00:42'
  $ballRoot.FindName('OrbDot').Opacity = 1
  $ballRoot.FindName('Ripple').Opacity = 0.32
  $ballRoot.FindName('RippleScale').ScaleX = 1.3
  $ballRoot.FindName('RippleScale').ScaleY = 1.3
  $ballRoot.FindName('MicScale').ScaleX = 1.2
  $ballRoot.FindName('MicScale').ScaleY = 1.2
  $ballRoot.FindName('LevelRing').Opacity = 0.55
  $ballRoot.FindName('LevelRingScale').ScaleX = 1.12
  $ballRoot.FindName('LevelRingScale').ScaleY = 1.12
  Save-Preview $ballRoot $BALL_SIZE $BALL_SIZE (Join-Path $Preview 'ball.png') '#FFDDE4EF'

  $ballRoot.FindName('OrbTimer').Text = '01:23:45'
  $ballRoot.FindName('OrbDot').Fill = (Brush '#FFD97706')
  $ballRoot.FindName('OrbDot').Opacity = 0.85
  $ballRoot.FindName('Ripple').Opacity = 0
  $ballRoot.FindName('RippleScale').ScaleX = 1
  $ballRoot.FindName('RippleScale').ScaleY = 1
  $ballRoot.FindName('MicScale').ScaleX = 1
  $ballRoot.FindName('MicScale').ScaleY = 1
  Save-Preview $ballRoot $BALL_SIZE $BALL_SIZE (Join-Path $Preview 'ball-paused.png') '#FFDDE4EF'

  # bubble + ball
  $bubbleRoot = [Windows.Markup.XamlReader]::Parse($shellXaml)
  Set-BallGradient $bubbleRoot
  $bubbleRoot.FindName('CardRow').Height = [System.Windows.GridLength]::Auto
  $bubbleRoot.FindName('CardHost').Visibility = 'Visible'
  $bubbleRoot.FindName('BubbleTitle').Text = 'Q4 budget review'
  $bubbleRoot.FindName('BubbleStatus').Text = 'Recording'
  $bubbleRoot.FindName('BubbleTimer').Text = '00:42'
  $bubbleRoot.FindName('BubbleChars').Text = '186 chars'
  $bubbleRoot.FindName('BubbleTranscript').Text = "Let's go through the Q4 budget.`r`n- Marketing: keep the current spend, add 5% for the launch week.`r`n- Engineering: two extra contractors from November.`r`n- Procurement confirms the vendor list by Friday."
  $bubbleRoot.FindName('BubblePause').Content = 'Pause'
  $bubbleRoot.FindName('BubbleStop').Content = 'Stop'
  $bubbleRoot.FindName('OrbTimer').Text = '00:42'
  $bubbleRoot.FindName('MicScale').ScaleX = 1.12
  $bubbleRoot.FindName('MicScale').ScaleY = 1.12
  $bubbleRoot.Measure([System.Windows.Size]::new($CARD_WIDTH, 1000))
  $bubbleHeight = [int][math]::Ceiling($bubbleRoot.DesiredSize.Height)
  Save-Preview $bubbleRoot $CARD_WIDTH $bubbleHeight (Join-Path $Preview 'bubble.png') '#FFDDE4EF'

  $bubbleRoot.FindName('BubbleStatus').Text = 'Paused'
  $bubbleRoot.FindName('BubblePause').Content = 'Resume'
  $bubbleRoot.FindName('BubbleDot').Fill = (Brush '#FFE0A64B')
  $bubbleRoot.FindName('MicScale').ScaleX = 1
  $bubbleRoot.FindName('MicScale').ScaleY = 1
  Save-Preview $bubbleRoot $CARD_WIDTH $bubbleHeight (Join-Path $Preview 'bubble-paused.png') '#FFDDE4EF'

  Write-Output ('preview written to ' + $Preview)
  exit 0
}

# ──────────────────────────────── live mode ────────────────────────────────
$root = [Windows.Markup.XamlReader]::Parse($shellXaml)
Set-BallGradient $root

$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ShowActivated = $false
$window.ResizeMode = 'NoResize'
$window.WindowStartupLocation = 'Manual'
$window.SizeToContent = 'WidthAndHeight'
$window.Opacity = 0.95
$window.Content = $root

$accent = Brush '#FFE0574B'
$warn = Brush '#FFE0A64B'
$ok = Brush '#FF4CAF7D'
$idle = Brush '#FF7C8598'

$ballCore = $root.FindName('BallCore')
$orbDot = $root.FindName('OrbDot')
$ripple = $root.FindName('Ripple')
$rippleScale = $root.FindName('RippleScale')
$micScale = $root.FindName('MicScale')
$levelRing = $root.FindName('LevelRing')
$levelRingScale = $root.FindName('LevelRingScale')
$ballGlow = $root.FindName('BallGlow')
$cardRow = $root.FindName('CardRow')
$cardHost = $root.FindName('CardHost')
$bubbleRoot = $root

function Get-BallAnchor {
  $x = $window.Left + $window.ActualWidth - $BALL_SIZE
  $y = $window.Top + $window.ActualHeight - $BALL_SIZE
  if (-not [double]::IsNaN($x) -and -not [double]::IsNaN($y)) {
    $script:BallAnchor = @{ x = $x; y = $y }
  }
  return @{ x = $x; y = $y }
}

function Set-Collapsed([bool]$collapsed) {
  $anchor = Get-BallAnchor
  $script:Collapsed = $collapsed
  $cardHost.Visibility = if ($collapsed) { 'Collapsed' } else { 'Visible' }
  $cardRow.Height = if ($collapsed) { [System.Windows.GridLength]::new(0) } else { [System.Windows.GridLength]::Auto }
  $window.UpdateLayout()
  $width = $window.ActualWidth
  $height = $window.ActualHeight
  $window.Left = $anchor.x + $BALL_SIZE - $width
  $window.Top = $anchor.y + $BALL_SIZE - $height
  # keep the whole widget inside the work area
  $area = [System.Windows.SystemParameters]::WorkArea
  if ($window.Left -lt $area.Left) { $window.Left = $area.Left }
  if ($window.Top -lt $area.Top) { $window.Top = $area.Top }
  if (($window.Left + $width) -gt $area.Right) { $window.Left = $area.Right - $width }
  if (($window.Top + $height) -gt $area.Bottom) { $window.Top = $area.Bottom - $height }
}

function Toggle-Bubble {
  Set-Collapsed (-not $script:Collapsed)
}

function Apply-State {
  $state = Read-LatestState
  $nowTicks = [DateTime]::UtcNow.Ticks
  if ($script:LatestStateName -ne $script:LastStateName) {
    $script:LastStateName = $script:LatestStateName
    $script:LastStateTicks = $nowTicks
  } elseif ($script:LastStateTicks -ne 0) {
    $idleMs = $nowTicks - $script:LastStateTicks
    if ([TimeSpan]::FromTicks($idleMs).TotalSeconds -gt 25) {
      # 宿主没有新状态帧 = 插件已卸载 / 宿主已退出 / 页面已关闭：自己收掉。
      Save-Position $window
      $window.Close()
      return
    }
  }
  if ($null -eq $state) { return }
  $script:State = $state
  $script:Labels = $state.labels

  if ($state.close -eq $true) {
    try {
      $closeLeft = [math]::Round([double]$window.Left + [double]$window.ActualWidth - $BALL_SIZE)
      $closeTop = [math]::Round([double]$window.Top + [double]$window.ActualHeight - $BALL_SIZE)
      if ($closeLeft -gt 0 -or $closeTop -gt 0) {
        [System.IO.File]::WriteAllText((Join-Path $StateDir 'pos.json'), ('{"left":' + $closeLeft + ',"top":' + $closeTop + '}'), (New-Object System.Text.UTF8Encoding($false)))
      }
    } catch { }
    $window.Close()
    return
  }

  $status = [string]$state.status
  # After clicking Stop the command travels through the heartbeat (~1s); show the
  # loading state immediately, then hand over to the normal stop flow once the host
  # reports stopping / done / error.
  if ($script:StopPending -and ($status -eq 'stopping' -or $status -eq 'done' -or $status -eq 'error')) {
    $script:StopPending = $false
  }
  if ($script:StopPending -and $script:StopPendingUntil -gt 0 -and $nowTicks -gt $script:StopPendingUntil) {
    $script:StopPending = $false
  }
  $stopWaiting = $script:StopPending -and ($status -eq 'recording' -or $status -eq 'paused')
  $dotBrush = $idle
  if ($status -eq 'recording' -and -not $stopWaiting) { $dotBrush = $accent }
  elseif ($status -eq 'paused' -or $status -eq 'stopping' -or $stopWaiting) { $dotBrush = $warn }
  elseif ($status -eq 'done') { $dotBrush = $ok }
  $orbDot.Fill = $dotBrush
  $bubbleRoot.FindName('BubbleDot').Fill = $dotBrush

  $timer = Format-Timer ([int]$state.elapsedSeconds)
  $bubbleRoot.FindName('OrbTimer').Text = $timer
  $bubbleRoot.FindName('BubbleTimer').Text = $timer

  $statusLabel = switch ($status) {
    'recording' { Get-String $script:Labels 'recording' 'Recording' }
    'paused' { Get-String $script:Labels 'paused' 'Paused' }
    'preparing' { Get-String $script:Labels 'preparing' 'Preparing' }
    'stopping' { Get-String $script:Labels 'stopping' 'Finishing' }
    'done' { Get-String $script:Labels 'done' 'Stopped' }
    'error' { Get-String $script:Labels 'error' 'Error' }
    default { Get-String $script:Labels 'idle' 'Idle' }
  }
  if ($stopWaiting) { $statusLabel = Get-String $script:Labels 'stopping' 'Finishing' }
  $bubbleRoot.FindName('BubbleStatus').Text = $statusLabel
  $bubbleRoot.FindName('BubbleTitle').Text = (Get-String $state 'title' 'Meeting minutes')
  $charsTemplate = Get-String $script:Labels 'chars' '{0} chars'
  $bubbleRoot.FindName('BubbleChars').Text = ($charsTemplate -f [int]$state.chars)

  $pauseButton = $bubbleRoot.FindName('BubblePause')
  if ($status -eq 'paused') {
    $pauseButton.Content = Get-String $script:Labels 'resume' 'Resume'
    $pauseButton.IsEnabled = $true
  } else {
    $pauseButton.Content = Get-String $script:Labels 'pause' 'Pause'
    $pauseButton.IsEnabled = ($status -eq 'recording')
  }
  $pauseButton.IsEnabled = $pauseButton.IsEnabled -and -not $stopWaiting
  $stopButton = $bubbleRoot.FindName('BubbleStop')
  if ($stopWaiting -or $status -eq 'stopping') {
    $stopButton.Content = Get-String $script:Labels 'stoppingAction' 'Stopping...'
    $stopButton.IsEnabled = $false
  } else {
    $stopButton.Content = Get-String $script:Labels 'stop' 'Stop'
    $stopButton.IsEnabled = ($status -eq 'recording' -or $status -eq 'paused')
  }

  # 音频输入设备切换：只列设备、不做电平检测；选择后写一条 switch-input 命令。
  $devices = @()
  if ($null -ne $state.devices) { $devices = @($state.devices) }
  $signature = (($devices | ForEach-Object { [string]$_.id + '=' + [string]$_.label }) -join '|')
  $inputCombo = $bubbleRoot.FindName('BubbleInput')
  if ($signature -ne $script:InputSignature) {
    $script:PopulatingInput = $true
    try {
      $inputCombo.Items.Clear()
      $script:InputIds = @()
      foreach ($device in $devices) {
        [void]$inputCombo.Items.Add([string]$device.label)
        $script:InputIds += [string]$device.id
      }
      $script:InputSignature = $signature
    } finally {
      $script:PopulatingInput = $false
    }
  }
  $currentId = ''
  if ($null -ne $state.deviceId) { $currentId = [string]$state.deviceId }
  $selectedIndex = -1
  for ($i = 0; $i -lt $script:InputIds.Count; $i += 1) {
    if ([string]$script:InputIds[$i] -eq $currentId) { $selectedIndex = $i; break }
  }
  $inputCombo.SelectedIndex = $selectedIndex
  $inputCombo.IsEnabled = ($script:InputIds.Count -gt 1) -and ($status -eq 'recording' -or $status -eq 'paused')
  $inputCombo.ToolTip = Get-String $script:Labels 'inputDevice' 'Input device'
  $bubbleRoot.FindName('BubbleInputLabel').Text = Get-String $script:Labels 'inputDevice' 'Mic'

  $transcript = [string]$state.transcript
  if ($null -eq $transcript) { $transcript = '' }
  if ($transcript -ne $script:LastTranscript) {
    $box = $bubbleRoot.FindName('BubbleTranscript')
    $box.Text = $transcript
    if ($transcript -ne '') { $box.ScrollToEnd() }
    $script:LastTranscript = $transcript
  }
}

function Update-Animation {
  $status = 'idle'
  if ($null -ne $script:State) { $status = [string]$script:State.status }
  $level = 0.0
  if ($null -ne $script:State -and $null -ne $script:State.level) { $level = [double]$script:State.level }
  if ($level -lt 0) { $level = 0 }
  if ($level -gt 1) { $level = 1 }
  # 音量做一点平滑，避免球一跳一跳
  $script:SmoothLevel = ($script:SmoothLevel * 0.65) + ($level * 0.35)
  $smooth = $script:SmoothLevel

  if ($status -eq 'recording') {
    $script:Phase = ($script:Phase + 0.05) % 1.0
    # 红点呼吸 + 音量驱动的光晕/麦克风缩放（参考腾讯会议的说话反馈）
    $orbDot.Opacity = 0.45 + 0.55 * (0.5 + 0.5 * [math]::Cos(2 * [math]::PI * $script:Phase))
    $ripple.Opacity = (0.15 + 0.6 * $smooth) * (1 - $script:Phase)
    $rippleValue = 1.0 + 0.33 * $script:Phase + 0.12 * $smooth
    $rippleScale.ScaleX = $rippleValue
    $rippleScale.ScaleY = $rippleValue
    $micValue = 1.0 + 0.28 * $smooth
    $micScale.ScaleX = $micValue
    $micScale.ScaleY = $micValue
    # 音量环：说话越大，外圈越大越亮（没有声音时几乎不可见）
    $levelRing.Opacity = 0.08 + 0.62 * $smooth
    $levelRingValue = 1.02 + 0.16 * $smooth
    $levelRingScale.ScaleX = $levelRingValue
    $levelRingScale.ScaleY = $levelRingValue
    $ballGlow.Opacity = 0.2 + 0.62 * $smooth
    $ballGlow.BlurRadius = 20 + 16 * $smooth
    $window.Opacity = (0.96 + 0.03 * $smooth) - 0.02 * $script:Phase
  } elseif ($status -eq 'paused') {
    $orbDot.Opacity = 0.85
    $ripple.Opacity = 0
    $levelRing.Opacity = 0
    $levelRingScale.ScaleX = 1
    $levelRingScale.ScaleY = 1
    $rippleScale.ScaleX = 1
    $rippleScale.ScaleY = 1
    $micScale.ScaleX = 1
    $micScale.ScaleY = 1
    $ballGlow.Opacity = 0.1
    $ballGlow.BlurRadius = 16
    $window.Opacity = 0.94
  } else {
    $orbDot.Opacity = 1
    $ripple.Opacity = 0
    $levelRing.Opacity = 0
    $levelRingScale.ScaleX = 1
    $levelRingScale.ScaleY = 1
    $rippleScale.ScaleX = 1
    $rippleScale.ScaleY = 1
    $micScale.ScaleX = 1
    $micScale.ScaleY = 1
    $ballGlow.Opacity = 0.12
    $ballGlow.BlurRadius = 16
    $window.Opacity = 0.96
  }
}

function Invoke-DemoStep {
  if (-not $DemoBubble) { return }
  if (-not $script:Collapsed) { return }
  $script:DemoTicks += 1
  if ($script:DemoTicks -lt 3) { return }
  try {
    Set-Collapsed $false
    [System.IO.File]::WriteAllText((Join-Path $StateDir 'bubble-opened.txt'), 'ok', (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    [System.IO.File]::WriteAllText((Join-Path $StateDir 'bubble-error.txt'), ($_ | Out-String), (New-Object System.Text.UTF8Encoding($false)))
  }
}

# interactions
$ballCore.Add_MouseLeftButtonDown({
  param($sender, $event)
  $cursor = [System.Windows.Forms.Cursor]::Position
  $script:DragOrigin = @{ mx = $cursor.X; my = $cursor.Y; wx = $window.Left; wy = $window.Top }
  $script:Dragging = $true
  [void]$ballCore.CaptureMouse()
  $event.Handled = $true
})
$ballCore.Add_MouseMove({
  param($sender, $event)
  if (-not $script:Dragging) { return }
  $cursor = [System.Windows.Forms.Cursor]::Position
  $window.Left = $script:DragOrigin.wx + ($cursor.X - $script:DragOrigin.mx)
  $window.Top = $script:DragOrigin.wy + ($cursor.Y - $script:DragOrigin.my)
})
$ballCore.Add_MouseLeftButtonUp({
  param($sender, $event)
  if (-not $script:Dragging) { return }
  $script:Dragging = $false
  [void]$ballCore.ReleaseMouseCapture()
  $cursor = [System.Windows.Forms.Cursor]::Position
  $moved = [math]::Abs($cursor.X - $script:DragOrigin.mx) + [math]::Abs($cursor.Y - $script:DragOrigin.my)
  if ($moved -gt 4) { Save-Position $window } else { Toggle-Bubble }
})

$root.FindName('BubbleClose').Add_Click({ Toggle-Bubble })
$root.FindName('BubblePause').Add_Click({
  $state = $script:State
  if ($null -ne $state -and [string]$state.status -eq 'paused') { Write-Command 'resume' }
  else { Write-Command 'pause' }
})
$root.FindName('BubbleStop').Add_Click({
  if ($script:StopPending) { return }
  $state = $script:State
  $status = 'idle'
  if ($null -ne $state) { $status = [string]$state.status }
  if ($status -ne 'recording' -and $status -ne 'paused') { return }
  # Enter the loading state immediately instead of waiting for the command round-trip.
  $script:StopPending = $true
  $script:StopPendingUntil = [DateTime]::UtcNow.Ticks + [TimeSpan]::FromSeconds(20).Ticks
  Write-Command 'stop'
  Apply-State
})

$root.FindName('BubbleInput').Add_SelectionChanged({
  if ($script:PopulatingInput) { return }
  $combo = $root.FindName('BubbleInput')
  $index = $combo.SelectedIndex
  if ($index -lt 0 -or $index -ge $script:InputIds.Count) { return }
  $deviceId = [string]$script:InputIds[$index]
  if ($deviceId -eq '') { return }
  Write-Command 'switch-input' $deviceId
})

$stateTimer = New-Object System.Windows.Threading.DispatcherTimer
$stateTimer.Interval = [TimeSpan]::FromMilliseconds(250)
$stateTimer.Add_Tick({ try { Apply-State; Invoke-DemoStep } catch { } })
$animTimer = New-Object System.Windows.Threading.DispatcherTimer
$animTimer.Interval = [TimeSpan]::FromMilliseconds(45)
$animTimer.Add_Tick({ try { Update-Animation } catch { } })

$area = [System.Windows.SystemParameters]::WorkArea
$saved = Get-SavedPosition ($area.Right - $BALL_SIZE - 24) ($area.Bottom - $BALL_SIZE - 24)
$window.Left = $saved.left
$window.Top = $saved.top

$window.Add_Loaded({
  $stateTimer.Start()
  $animTimer.Start()
  Apply-State
})
$window.Add_Closed({
  # 位置已在关闭分支保存；此处窗口已销毁，ActualWidth/Left 会变成 0/NaN。

  try { $stateTimer.Stop(); $animTimer.Stop() } catch { }
  try { $window.Dispatcher.InvokeShutdown() } catch { }
})

if ($PidFile -ne '') {
  try {
    [System.IO.File]::WriteAllText($PidFile, [string]$PID, (New-Object System.Text.UTF8Encoding($false)))
  } catch { }
}

# Show() + Dispatcher.Run() instead of ShowDialog(): the modal loop disabled other
# windows of the same application, which is why the old separate bubble window
# never received clicks.
$window.Show()
[System.Windows.Threading.Dispatcher]::Run()
