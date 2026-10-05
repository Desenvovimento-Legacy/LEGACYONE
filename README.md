<p align="center"><img src="docs/brand/iaris-logo.jpg" alt="IARIS" width="480"></p>

# IARIS — Inteligência Artificial para Resultados, Integração e Soluções

Sistema operacional contábil autônomo, multi-tenant e multiagente.

> Os identificadores técnicos (banco `legacy_one`, papéis `legacy_*`, subjects `legacy.t.*`) mantêm o nome original para não quebrar ambientes já criados.

**Automação primeiro. Evidência sempre. Humano por exceção.**

## Status: Fase 0 — Fundação

| Entregue | O que garante |
| --- | --- |
| Banco multi-tenant com RLS forçada e FKs compostas | Um escritório não lê, não grava e não referencia dados de outro |
| Cadastro de entidade com CNPJ alfanumérico | Validação idêntica na aplicação e no banco (IN RFB 2.229/2024) |
| Histórico temporal (tipo, regime, serviços) | "Qual era a configuração em 31/03/2025?" em uma consulta |
| Event Bus: outbox transacional, relay, inbox | Evento só existe se o dado foi gravado; consumidor processa uma vez |
| Case Engine com máquina de estados | Todo Case passa por revisão antes de concluir; encerrado não muda |
| Audit log com hash encadeado | Imutável no banco; adulteração direta é detectada |

Critérios de saída da Fase 0, cobertos por testes:
isolamento entre tenants testado e Case percorrendo o ciclo completo com evento e auditoria.

## Rodando no Windows

Pré-requisitos: [Docker Desktop](https://www.docker.com/products/docker-desktop/) e Node 22.

```powershell
git clone https://github.com/Desenvovimento-Legacy/LEGACYONE.git
cd LEGACYONE
corepack enable
pnpm install
copy .env.example .env
docker compose up -d
pnpm db:migrate
pnpm db:dev-roles
pnpm test
```

Serviços locais:

| Serviço | Endereço |
| --- | --- |
| PostgreSQL | localhost:5432 |
| NATS JetStream | localhost:4222 (monitor: http://localhost:8222) |
| Temporal (perfil `workflow`) | localhost:7233 (UI: http://localhost:8080) |

## Arquitetura

Documento de arquitetura aprovado: IARIS — Arquitetura para Aprovação (Claude Docs).
Convenções para quem escreve código neste repositório: [CLAUDE.md](CLAUDE.md).

## Fase 1 — Onboarding pelo CNPJ (em andamento)

```powershell
pnpm tenant:create "Contabilidade Legacy" contabilidade-legacy
pnpm onboard 12.ABC.345/01DE-35
```

Integra Contador: as credenciais do SERPRO e o certificado A1 do escritório ficam no cofre local
(`C:\IARIS-COFRE\segredos.env`, fora do repositório). Para conferir sem exibir segredos:

```powershell
pnpm integra:check                 # cofre, certificado e autenticação (não bilhetado)
pnpm integra:check 01210421000100  # + consulta de procuração (bilhetada pelo SERPRO)
```

O `onboard` abre o Case `CLIENT_ONBOARDING`, busca os dados públicos do CNPJ, monta a
entidade (tipo, regime, matriz, CNAEs, sócios) com a resposta guardada como evidência,
verifica a procuração e-CAC e transforma em pendência só o que não pode ser inferido.

| Entregue | Pendente na Fase 1 |
| --- | --- |
| Onboarding pela base pública de CNPJ | Credential Vault gerenciado (hoje: arquivo local com ACL) |
| Conector real do SERPRO Integra Contador (procuração e-CAC) | Termo de autorização para procuração dada ao CPF do contador |
| Pending Engine | |
| Authorization Service (uso único, por procuração) | Workflow durável do onboarding no Temporal |
| Metadados de certificados e procurações | Cadastro do responsável técnico e suas capacidades |

## Receita Federal: busca mensal (Integra Contador)

Toda consulta ao SERPRO é cobrada. Regras do IARIS:

- **Abrir a tela não consulta nada.** Só o botão **Buscar** consulta, depois de confirmação.
- **Busca da competência = 2 consultas por empresa**: PGDAS-D do período e pagamentos
  arrecadados no mês da competência e no seguinte.
- **Teto diário** de consultas cobradas por escritório: `SERPRO_DAILY_LIMIT` no cofre (padrão 20).
  Se a busca não cabe no teto, nenhuma consulta sai.
- **Carga histórica** (implantação, uma vez por cliente): `pnpm federal:sync <cnpj>` mostra
  quantas consultas fará; só executa com `--confirmar`.
- Procuração já verificada e vigente não é consultada de novo.

```powershell
pnpm web                            # tela local em http://127.0.0.1:3100
pnpm federal:report 01210421000100  # relatório do que já foi buscado (sem consulta)
```
