# firewall-config.ps1 — Opens required firewall ports for mail-spam-toolkit.
# Run as Administrator.

param(
    [switch]$Remove
)

$rules = @(
    @{ Name = "Mail Spam Toolkit - Portal";     Port = 8080 },
    @{ Name = "Mail Spam Toolkit - SQLite Web"; Port = 8081 }
)

if ($Remove) {
    Write-Host "`n[*] Removing firewall rules..." -ForegroundColor Cyan
    foreach ($rule in $rules) {
        Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
        Write-Host "  [removed] $($rule.Name) (port $($rule.Port))"
    }
    Write-Host "`n[ok] All firewall rules removed.`n" -ForegroundColor Green
} else {
    Write-Host "`n[*] Adding firewall rules..." -ForegroundColor Cyan
    foreach ($rule in $rules) {
        Remove-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
        New-NetFirewallRule `
            -DisplayName $rule.Name `
            -Direction   Inbound `
            -Action      Allow `
            -Protocol    TCP `
            -LocalPort   $rule.Port | Out-Null
        Write-Host "  [added] $($rule.Name) (port $($rule.Port))"
    }
    Write-Host "`n[ok] All firewall rules added.`n" -ForegroundColor Green

    Write-Host "Current rules:" -ForegroundColor Cyan
    Get-NetFirewallRule -DisplayName "Mail Spam Toolkit*" |
        Select-Object DisplayName, Enabled, Action |
        Format-Table -AutoSize
}
