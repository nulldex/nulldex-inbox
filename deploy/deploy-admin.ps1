# Uploads the inbox app to the server and restarts it.
# Usage:  powershell -File deploy\deploy-admin.ps1
# Needs deploy\server.local.ps1 (not committed) with:
#   $server = "root@<your-server-ip>"
#   $key    = "$env:USERPROFILE\.ssh\<your-key>"
# Optional: $assets = path to a folder with logo-full.png, logo-mark.png, favicon-64.png and fonts\

$ErrorActionPreference = "Stop"
$local = Join-Path $PSScriptRoot "server.local.ps1"
if (-not (Test-Path $local)) { throw "Missing $local (see comments at the top of this script)." }
. $local
$app = Join-Path $PSScriptRoot ".."
if (-not $assets) { $assets = Join-Path $PSScriptRoot "..\..\portfolio\assets" }

Write-Host "Uploading app..."
ssh -i $key -o BatchMode=yes $server 'rm -rf /tmp/nulldex-admin && mkdir -p /tmp/nulldex-admin/public/assets/fonts'
scp -i $key -o BatchMode=yes -q -r "$app\server.js" "$app\cli.js" "$app\package.json" "$app\.env.example" "$app\src" "$app\deploy" "${server}:/tmp/nulldex-admin/"
scp -i $key -o BatchMode=yes -q "$app\public\index.html" "$app\public\app.css" "$app\public\app.js" "${server}:/tmp/nulldex-admin/public/"
# brand assets (logo, icon, fonts)
scp -i $key -o BatchMode=yes -q "$assets\logo-full.png" "$assets\logo-mark.png" "$assets\favicon-64.png" "${server}:/tmp/nulldex-admin/public/assets/"
scp -i $key -o BatchMode=yes -q "$assets\fonts\inter.woff2" "$assets\fonts\inter-ext.woff2" "$assets\fonts\outfit.woff2" "$assets\fonts\jetbrains-mono.woff2" "${server}:/tmp/nulldex-admin/public/assets/fonts/"

# never ship local deploy settings to the server
ssh -i $key -o BatchMode=yes $server 'rm -f /tmp/nulldex-admin/deploy/server.local.ps1'
# keep node_modules between deploys, replace everything else
ssh -i $key -o BatchMode=yes $server 'mkdir -p /opt/nulldex-admin && find /opt/nulldex-admin -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} + && cp -r /tmp/nulldex-admin/. /opt/nulldex-admin/ && bash /opt/nulldex-admin/deploy/setup-server.sh'
Write-Host "Done."
