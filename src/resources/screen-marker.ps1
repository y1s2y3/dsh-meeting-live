param(
  [int]$X = 0,
  [int]$Y = 0,
  [int]$W = 1280,
  [int]$H = 800,
  [string]$Title = 'Recording screen',
  [string]$Hint = '',
  [int]$HoldMs = 2200
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$hintBlock = ''
if ($Hint -ne '') {
  $hintBlock = '        <TextBlock Text="' + $Hint + '" Foreground="#CBD5E1" FontSize="14" FontFamily="Microsoft YaHei UI" HorizontalAlignment="Center" Margin="0,10,0,0"/>'
}

$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ShowInTaskbar="False" Topmost="True" ResizeMode="NoResize"
        Left="$X" Top="$Y" Width="$W" Height="$H">
  <Grid>
    <Border BorderBrush="#2F6BFF" BorderThickness="6"/>
    <Border Background="#C20F172A" CornerRadius="16" Padding="40,24"
            HorizontalAlignment="Center" VerticalAlignment="Center">
      <StackPanel>
        <TextBlock Text="$Title" Foreground="#FFFFFF" FontSize="36" FontWeight="SemiBold"
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
  throw 'failed to create marker window'
}

$script:markerWindow.Add_Loaded({
  try {
    $openDuration = New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds(150))
    $fadeIn = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, $openDuration)
    $script:markerWindow.BeginAnimation([System.Windows.Window]::OpacityProperty, $fadeIn)
  } catch {
    $script:markerWindow.Opacity = 1.0
  }
})

$script:markerCloseTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:markerCloseTimer.Interval = [TimeSpan]::FromMilliseconds(260)
$script:markerCloseTimer.Add_Tick({
  $script:markerCloseTimer.Stop()
  $script:markerWindow.Close()
})

$script:markerOpenTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:markerOpenTimer.Interval = [TimeSpan]::FromMilliseconds($HoldMs)
$script:markerOpenTimer.Add_Tick({
  $script:markerOpenTimer.Stop()
  try {
    $closeDuration = New-Object System.Windows.Duration ([TimeSpan]::FromMilliseconds(220))
    $fadeOut = New-Object System.Windows.Media.Animation.DoubleAnimation(1.0, 0.0, $closeDuration)
    $script:markerWindow.BeginAnimation([System.Windows.Window]::OpacityProperty, $fadeOut)
  } catch {
  }
  $script:markerCloseTimer.Start()
})
$script:markerOpenTimer.Start()

[void]$script:markerWindow.ShowDialog()