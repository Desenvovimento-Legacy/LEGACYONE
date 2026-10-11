# Mantém o IARIS no ar no PC do escritório: se o lançador (web-public) não estiver
# rodando, abre de novo, oculto. Instalado em C:\IARIS\scripts e rodado pela tarefa
# agendada "IARIS no ar" (ao entrar no Windows e a cada 5 minutos).
$rodando = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'web-public' }
if ($rodando) { exit 0 }
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
$log = 'C:\IARIS\log-iaris.txt'
if (Test-Path $log) { Copy-Item $log 'C:\IARIS\log-iaris-anterior.txt' -Force }
Add-Content 'C:\IARIS\log-reinicios.txt' ("{0:yyyy-MM-dd HH:mm:ss} IARIS reaberto" -f (Get-Date))
# node direto (o pnpm.exe pode ser bloqueado pela política Device Guard do Windows)
Start-Process -FilePath cmd.exe -ArgumentList '/c', "cd /d C:\IARIS\sistema && node --env-file-if-exists=.env --import tsx src/cli/web-public.ts > $log 2>&1" -WindowStyle Hidden
