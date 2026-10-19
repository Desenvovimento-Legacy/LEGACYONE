' Backup diario do banco em nuvem sem abrir janela. Instalado em C:\IARIS\scripts e chamado pela tarefa "IARIS backup nuvem".
CreateObject("WScript.Shell").Run "cmd.exe /c cd /d C:\IARIS\sistema && node --env-file-if-exists=.env --import tsx src/cli/cloud-db.ts backup >> C:\IARIS\backup\nuvem\log.txt 2>&1", 0, True
