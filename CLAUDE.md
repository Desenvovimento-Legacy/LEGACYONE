# IARIS — instruções para agentes de código

Plataforma contábil autônoma, multi-tenant, orientada a eventos. Nome do produto: IARIS
(Inteligência Artificial para Resultados, Integração e Soluções). Identificadores técnicos
antigos (`legacy_one`, `legacy_*`, `legacy.t.*`) ficam como estão. Filosofia:
**automação primeiro, evidência sempre, humano por exceção.**

## Regras invioláveis

1. **Multi-tenant em tudo.** Toda tabela de negócio tem `tenant_id`, RLS habilitada e
   forçada (`SELECT apply_tenant_rls('tabela')`) e FKs compostas `(tenant_id, id)`.
   O teste `tenant-isolation.test.ts` falha se uma tabela nova esquecer a RLS.
2. **A aplicação só acessa dados via `withTenant(pool, tenantId, fn)`.** Nunca use o
   pool administrativo em código de negócio.
3. **Fato gera evento na mesma transação** (`appendEvent`) e **ação crítica gera
   auditoria** (`audit`). Todo tipo de evento é registrado em
   `src/platform/events/registry.ts` com schema versionado.
4. **Nada é apagado nem sobrescrito.** Correção é estorno, nova versão ou nova linha
   de histórico. `audit_log` e o conteúdo do `outbox` são imutáveis no banco.
5. **Informação que muda no tempo é temporal** (`valid_from`/`valid_to` inclusivo,
   sem sobreposição por constraint de exclusão).
6. **Toda operação crítica é idempotente** (chave de idempotência por tenant).
7. **IA não calcula tributo nem grava lançamento.** IA classifica, extrai e propõe;
   motores determinísticos calculam e gravam.
8. **Segredos nunca em prompt, log ou código.** Certificados e senhas só no Vault.
9. **CNPJ é texto `char(14)` alfanumérico** (IN RFB 2.229/2024). Nunca tipo numérico.
10. **Valores monetários em `numeric`**, nunca `float`. Competência é `date` no dia 1.

## Estrutura

- `db/migrations/` — SQL versionado, aplicado em ordem por `pnpm db:migrate`.
- `src/platform/` — plataforma: eventos, auditoria, Cases, tenancy.
- `src/modules/` — domínios de negócio (registry; depois ledger, fiscal, tax...).
- `src/integrations/` — conectores externos (base pública de CNPJ, Integra Contador). Sempre atrás de interface, com implementação simulada para testes.
- `src/cli/` — comandos de operação (`pnpm tenant:create`, `pnpm onboard`).
- `src/shared/` — utilidades sem regra de negócio de domínio.
- `test/` — testes de integração contra Postgres real.

## Papéis do banco

- `legacy_owner` (dono): migrações. Nunca usado em runtime.
- `legacy_app`: aplicação, sujeita a RLS, sem DELETE.
- `legacy_relay`: lê e marca publicação do outbox; nada mais.

## Comandos

```
pnpm db:migrate     # aplica migrações (ADMIN_DATABASE_URL)
pnpm db:dev-roles   # cria logins de dev/teste
pnpm typecheck
pnpm test           # exige Postgres com as variáveis do .env
```

Idioma do código: identificadores em inglês; comentários, mensagens de erro e
documentação em português.
