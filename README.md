# Legacy One — Autonomous Accounting OS

Sistema operacional contábil autônomo, multi-tenant e multiagente.
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

Documento de arquitetura aprovado: Legacy One — Arquitetura para Aprovação (Claude Docs).
Convenções para quem escreve código neste repositório: [CLAUDE.md](CLAUDE.md).

## Próximo passo: Fase 1

Entidade e onboarding: Case `CLIENT_ONBOARDING` buscando dados pelo CNPJ,
conector SERPRO Integra Contador, Digital Identity (certificados e procurações),
Authorization Service e o primeiro workflow durável no Temporal.
