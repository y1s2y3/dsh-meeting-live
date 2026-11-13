param(
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 1280,
  [int]$H = 800,
  [string]$Title = 'Recording screen',
  [string]$Hint = '',
  [int]$HoldMs = 2600,
  [string]$LogFile = ''
)

$ErrorActionPreference = 'Stop'

function Write-MarkerLog([string]$text) {
  if ($LogFile -eq '') { return }
  try {
    $line = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss.fff') + ' ' + $text
    Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
  } catch {
  }
}

Write-MarkerLog ("start x=" + $X + " y=" + $Y + " w=" + $W + " h=" + $H + " hold=" + $HoldMs)

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$hintBlock = ''
if ($Hint -ne '') {
  $hintBlock = '        <TextBlock Text="' + $Hint + '" Foreground="#FFD7E3F5" FontSize="15" FontFamily="Microsoft YaHei UI" HorizontalAlignment="Center" Margin="0,10,0,0"/>'
}

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ResizeMode="NoResize" ShowActivated="False"
        Left="$X" Top="$Y" Width="$W" Height="$H" Opacity="0">
  <Grid>
    <Border Background="#4D1E4FBF" BorderBrush="#FF2F6BFF" BorderThickness="8"/>
    <Border Background="#E60F172A" CornerRadius="18" Padding="46,28"
            HorizontalAlignment="Center" VerticalAlignment="Center">
      <StackPanel>
        <TextBlock Text="$Title" Foreground="#FFFFFFFF" FontSize="40" FontWeight="Bold"
                   FontFamily="Microsoft YaHei UI" HorizontalAlignment="Center"/>
$hintBlock
      </StackPanel>
    </Border>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$script:markerWindow = [Windows.Markup.XamlReader]::Load($reader)
if ($null -eq $script:markerWindow) {
  Write-MarkerLog 'xaml load failed'
  throw 'failed to create marker window'
}

$script:markerWindow.Add_Loaded({
  Write-MarkerLog 'loaded'
  try {
    $openDuration = New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds(160))
    $fadeIn = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, $openDuration)
    $script:markerWindow.BeginAnimation([System.Windows.Window]::OpacityProperty, $fadeIn)
  } catch {
    $script:markerWindow.Opacity = 1.0
  }
})

$script:markerWindow.Add_Closed({
  Write-MarkerLog 'closed'
})

$script:markerCloseTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:markerCloseTimer.Interval = [TimeSpan]::FromMilliseconds(300)
$script:markerCloseTimer.Add_Tick({
  $script:markerCloseTimer.Stop()
  $script:markerWindow.Close()
})

$script:markerOpenTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:markerOpenTimer.Interval = [TimeSpan]::FromMilliseconds($HoldMs)
$script:markerOpenTimer.Add_Tick({
  $script:markerOpenTimer.Stop()
  Write-MarkerLog 'hold expired, fading out'
  try {
    $closeDuration = New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds(240))
    $fadeOut = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0, $closeDuration)
    $script:markerWindow.BeginAnimation([System.Windows.Window]::OpacityProperty, $fadeOut)
  } catch {
  }
  $script:markerCloseTimer.Start()
})
$script:markerOpenTimer.Start()

Write-MarkerLog 'showing'
[void]$script:markerWindow.ShowDialog()
Write-MarkerLog 'exit'