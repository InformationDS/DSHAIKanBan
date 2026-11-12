Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Get-DshWindow {
  [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]1708004)
}

function Find-UiaByName {
  param(
    [System.Windows.Automation.AutomationElement]$Root = (Get-DshWindow),
    [Parameter(Mandatory=$true)][string]$Name,
    [System.Windows.Automation.ControlType]$ControlType
  )
  $conds = New-Object System.Collections.Generic.List[System.Windows.Automation.Condition]
  $conds.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::NameProperty, $Name))
  if ($ControlType) {
    $conds.Add([System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ControlType))
  }
  $cond = if ($conds.Count -eq 1) { $conds[0] } else { New-Object System.Windows.Automation.AndCondition($conds.ToArray()) }
  $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
}

function Invoke-UiaElement {
  param([Parameter(Mandatory=$true)][System.Windows.Automation.AutomationElement]$Element)
  $p = $Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $p.Invoke()
}

function Click-UiaByName {
  param(
    [Parameter(Mandatory=$true)][string]$Name,
    [System.Windows.Automation.ControlType]$ControlType = [System.Windows.Automation.ControlType]::Button,
    [int]$WaitMs = 800
  )
  $e = Find-UiaByName -Name $Name -ControlType $ControlType
  if ($null -eq $e) { throw "UIA element not found: $Name" }
  Invoke-UiaElement -Element $e
  Start-Sleep -Milliseconds $WaitMs
  $e
}

function Set-UiaValue {
  param(
    [Parameter(Mandatory=$true)][System.Windows.Automation.AutomationElement]$Element,
    [Parameter(Mandatory=$true)][string]$Value
  )
  $p = $Element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $p.SetValue($Value)
}

function Get-UiaRows {
  param([System.Windows.Automation.AutomationElement]$Root = (Get-DshWindow))
  $all = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $i = 0
  foreach ($e in $all) {
    try {
      $r = $e.Current.BoundingRectangle
      [pscustomobject]@{
        idx = $i
        name = $e.Current.Name
        type = $e.Current.ControlType.ProgrammaticName
        aid = $e.Current.AutomationId
        cls = $e.Current.ClassName
        x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height
        enabled = $e.Current.IsEnabled
        offscreen = $e.Current.IsOffscreen
      }
    } catch {
      [pscustomobject]@{ idx = $i; name = '<error>'; type = ''; aid = ''; cls = ''; x = 0; y = 0; w = 0; h = 0; enabled = $false; offscreen = $true }
    }
    $i++
  }
}

function Save-UiaScreenshot {
  param([string]$Path = 'C:\Users\InformationDS\aikanban-evidence\shot.png')
  Add-Type -AssemblyName System.Drawing
  Add-Type -AssemblyName System.Windows.Forms
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $Path
}
