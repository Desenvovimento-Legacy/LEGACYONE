' Abre a conferencia "IARIS no ar" sem nenhuma janela (o PowerShell com -WindowStyle Hidden ainda pisca).
' Instalado em C:\IARIS\scripts e chamado pela tarefa agendada "IARIS no ar".
CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\IARIS\scripts\garantir-iaris.ps1""", 0, False
