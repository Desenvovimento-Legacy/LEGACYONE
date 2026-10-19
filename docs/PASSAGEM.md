# IARIS — Passagem do projeto

Documento para quem assume o desenvolvimento e a operação do IARIS. Situação em 19/10/2026.
Leia junto com o [CLAUDE.md](../CLAUDE.md) (regras invioláveis e convenções) e o [README](../README.md) (comandos).

Tudo o que existe salvo sobre o projeto está nesta pasta `docs/`:

| Arquivo | O que é |
| --- | --- |
| `PASSAGEM.md` | Este documento: estado atual, operação, pendências |
| `ESPECIFICACAO-MESTRE.md` | A especificação original que deu início ao projeto (o norte do produto) |
| `ARQUITETURA.md` | Arquitetura aprovada em 05/10/2026 (cópia do Claude Docs) |
| `DECISOES.md` | Decisões do dono do produto, por assunto |
| `paginas/acompanhamento/index.html` | Página de acompanhamento da evolução (abrir no navegador) |
| `paginas/telas/*.dc.html` | Primeiros protótipos de tela (out/2026, antes da tela atual em `src/web`) |
| `brand/iaris-logo.jpg` | Logo |

**Automação primeiro. Evidência sempre. Humano por exceção.**

---

## 1. O que é

Sistema operacional contábil multi-tenant e multiagente da Contabilidade Legacy. Executa a rotina
(buscar documentos, escriturar, calcular, conferir, revisar) e só chama uma pessoa por exceção.

- **Dono do produto e responsável técnico:** Luan Sanchez (contabilidade@grouplegacy.com.br).
  Segundo responsável técnico cadastrado: marcio.odor@grouplegacy.com.br.
- **Repositório:** github.com/Desenvovimento-Legacy/LEGACYONE, branch `main`.
- **Stack:** TypeScript (Node 24, `tsx`), PostgreSQL, `pg`, `zod` 4, `vitest`. Sem framework web:
  a tela é HTML gerado em `src/web/page.ts` e servida por `src/web/server.ts`.

## 2. Onde roda

| Peça | Onde |
| --- | --- |
| Aplicação | PC do escritório "avell" (Windows), pasta `C:\IARIS\sistema` (clone do repositório) |
| Banco de produção | Supabase, região São Paulo (`IARIS_DB_TARGET=cloud` no `.env` do PC) |
| Cofre de segredos | `C:\IARIS\cofre\segredos.env` (credenciais SERPRO, certificados A1, senhas, URLs `CLOUD_*` do banco) |
| Certificados dos clientes | `C:\IARIS\cofre\clientes` |
| Entrada de XML | `C:\IARIS\entrada` (varrida a cada 2 min; vai para `processados/` ou `recusados/`; nada é apagado) |
| Endereço público | túnel Cloudflare temporário, gravado em `C:\IARIS\endereco-publico.txt` (muda a cada reinício) |
| Logs | `C:\IARIS\log-iaris.txt`, `log-iaris-anterior.txt`, `log-reinicios.txt` |
| Testes | Postgres local (nunca o banco em nuvem) |

Tarefas agendadas no Windows (rodam via `wscript`, sem abrir janela):

- **IARIS no ar** — a cada 5 min e ao entrar no Windows, executa `C:\IARIS\scripts\garantir-iaris-oculto.vbs`,
  que reabre o lançador `src/cli/web-public.ts` (servidor + túnel) se ele tiver caído.
- **IARIS backup nuvem** — 20:00, `backup-nuvem-oculto.vbs` (`cloud:db backup`).

### O que está no GitHub e o que não está

| Item | No GitHub? | Onde fica |
| --- | --- | --- |
| Todo o código, migrações, testes, scripts do PC (`scripts/windows/*.ps1` e `*.vbs`) | Sim | repositório |
| Cofre (senhas, certificados A1, credenciais SERPRO, URLs do banco) | **Não, de propósito** | só no PC, `C:\IARIS\cofre` |
| Dados (empresas, notas, lançamentos, auditoria) | Não | Supabase; backup diário em `C:\IARIS\backup\nuvem` (`.sql.gz`, log em `log.txt`) |
| XML recebidos e consultas avulsas | Não | `C:\IARIS\entrada\processados`, `C:\IARIS\consultas` (originais também no banco) |
| `.env` do PC | Não | `C:\IARIS\sistema\.env` (só `IARIS_DB_TARGET=cloud` e caminhos; sem segredos) |
| Documento de arquitetura, especificação mestre, decisões, páginas | Sim (cópias) | `docs/` |
| `coleta_de_xml (2).py` | Não | `C:\IARIS\scripts` — script próprio do Luan, fora do IARIS |

### Montar o PC do zero

1. `git clone` do repositório em `C:\IARIS\sistema`, `npm install` (ou `pnpm install`), criar `.env` a partir do `.env.example` com `IARIS_DB_TARGET=cloud`.
2. Copiar o cofre (`C:\IARIS\cofre`) do PC antigo — só o Luan faz isso; não há outra cópia.
3. Copiar `scripts/windows/*` para `C:\IARIS\scripts` e criar as tarefas:
   ```
   schtasks /Create /TN "IARIS no ar" /TR "wscript.exe //B //Nologo C:\IARIS\scripts\garantir-iaris-oculto.vbs" /SC MINUTE /MO 5
   schtasks /Create /TN "IARIS backup nuvem" /TR "wscript.exe //B //Nologo C:\IARIS\scripts\backup-nuvem-oculto.vbs" /SC DAILY /ST 20:00
   ```
   (a "IARIS no ar" também tem gatilho ao entrar no Windows; acrescentar pelo Agendador de Tarefas).

## 3. Como publicar uma alteração

1. No repositório: `pnpm typecheck` e `pnpm test` passando (Postgres local; se parar: `service postgresql start`).
2. Commit e push em `origin/main` **na mesma hora**. Nunca deixar trabalho só local.
3. No PC (`C:\IARIS\sistema`): `git pull`.
4. Se houver migração nova:
   ```
   Start-Process cmd -ArgumentList '/c','set IARIS_DB_TARGET=cloud&& node --env-file-if-exists=.env --import tsx src/shared/db/migrate.ts > C:\IARIS\log-migracao.txt 2>&1' -WindowStyle Hidden -Wait
   ```
5. Reiniciar: encerrar o processo `node` cuja linha de comando contém `web\server.ts` (ou `web/server.ts`).
   O lançador o reabre sozinho.
6. Para renovar o endereço público: encerrar os `node` com `web-public` e o `cloudflared`, rodar
   `wscript.exe //B //Nologo "C:\IARIS\scripts\garantir-iaris-oculto.vbs"`, esperar ~40 s e ler
   `C:\IARIS\endereco-publico.txt`.

No PC o `pnpm.exe` pode ser barrado pelo Device Guard: usar `node --env-file-if-exists=.env --import tsx <arquivo>`.
Scripts temporários de manutenção ficam em `C:\IARIS\sistema\tmp-*.mts` e são apagados depois do uso.
Nada de pastas soltas no `C:` — tudo dentro de `C:\IARIS`.

## 4. Arquitetura em uma página

```
evento de negócio (outbox, mesma transação)  ──►  Orquestrador (src/modules/orchestration/links.ts)
                                                     │  vínculos evento → agente
                                                     ▼
agentes (Documentos, Fiscal, Contábil, Tributos, Guias, Revisão, Relacionamento…)
                                                     │  usam só motores determinísticos
                                                     ▼
fatos novos (linhas insert-only + evento + auditoria)  ──►  pendências (fila humana) só por exceção
```

- `src/platform/` — eventos (`events/registry.ts`, schemas zod versionados), auditoria com hash encadeado,
  Cases, pendências, tenancy, agentes (`agents/catalog.ts` é a lista mostrada na tela), autorização, medição de custo.
- `src/modules/` — domínios: `registry` (entidade, regime, detecção de regime), `onboarding`, `documents`
  (NF-e/CT-e/NFS-e e entrada de XML), `fiscal` (itens, CFOP, retenções), `federal` (SERPRO: PGDAS-D, pagamentos),
  `financial` (extratos), `ledger` (razão, plano, fechamento, relatórios), `tax` (`simples/`, `corporate/`, guias),
  `review` (revisão independente), `relationship` (pedido consolidado ao cliente), `regulatory` (calendário).
- `src/integrations/` — conectores, sempre atrás de interface com implementação simulada:
  `cnpj-public` (BrasilAPI/CNPJá), `integra-contador` (SERPRO), `sefaz` (DistDFe, consChNFe), `nfse` (ADN Nacional, ABRASF),
  `bank` (OFX, Excel, PDF), `fiscal-xml`.
- `src/web/` — `server.ts` (rotas e agendadores), `page.ts` (tela), `ops.ts` (painel de operação), `auth-page.ts`.
- `db/migrations/` — 49 migrações SQL (0001 a 0049), aplicadas em ordem.
- `test/` — 51 arquivos de teste de integração contra Postgres real (177 testes passando no último commit).

## 5. Estado por área

| Área | Situação |
| --- | --- |
| Implantação pelo CNPJ, regime (inclusive detectado pela Receita), procuração, certificados | Operando |
| Receita Federal (PGDAS-D, DAS, PagtoWeb) com teto de custo | Operando |
| Documentos: NFS-e Nacional, NF-e/CT-e SEFAZ por NSU, entrada de XML | Operando |
| Fiscal: tributos da NFS-e, retenções × DARF, itens de NF-e com CFOP/CST/créditos | Operando |
| Contábil: razão automático, plano, saldos de abertura, balancete, DRE, balanço, fechamento | Operando |
| Financeiro e conciliação: extratos OFX/Excel/PDF, DAS/DARF, NFS-e, pagamento parcial | Operando |
| Tributos: Simples (cálculo e PGDAS-D pronta, sem transmitir) | Operando |
| Tributos: Lucro Presumido e Lucro Real (e-LALUR, LC 224/2025) — motor `lucro-1` | Pronto; **regras aguardam aprovação** |
| Guias: vencimento, pagamento identificado, guia enviada registrada | Operando |
| Revisão independente (cobertura, materialidade, risco por mês) | Operando |
| Relacionamento: pedido consolidado ao cliente | Parcial (envio por e-mail/portal é a última etapa do roteiro) |
| Contas a pagar/receber (NF-e de compra, parcelas, conciliação) | **Pausado** — ver item 8 |
| Folha, SPED/ECD/ECF, transmissão, societário, regularização | Planejado |

## 6. Clientes no banco de produção

Tenant real: **Contabilidade Legacy**.

| CNPJ | Empresa | Observação |
| --- | --- | --- |
| 60.611.420/0001-36 | SAFE ON SERVICOS | Piloto, Simples, todos os serviços |
| 01.210.421/0001-00 | SABORES D'ALMA | Piloto, Simples, todos os serviços |
| 51.969.246/0001-07 | FURK TECH LTDA | Lucro Presumido (detectado), responsabilidade desde 08/2026 |
| 11.185.167/0001-90 | FURKINUX SISTEMAS DO BRASIL | Lucro Presumido (detectado), desde 08/2026 |
| 14.790.599/0001-19 | VOEARES (ARES) SOLUCOES EM TECNOLOGIA | Lucro Presumido (detectado), desde 08/2026 |

FURK TECH, FURKINUX e ARES: serviços contratados registrados como CONTABIL + FISCAL a partir de 01/08/2026
(suposição a confirmar com o Luan). Certificados A1 no cofre, válidos até 30/07/2027.

**Atenção:** o banco em nuvem também contém dezenas de tenants de teste ("escritorio 179…", "a …", "b …")
com entidades fictícias (ALPHA INDÚSTRIA, FICTICIA, ALFA). Foram criados por uma execução da suíte de
testes apontada para a nuvem. A RLS isola esses tenants do escritório real, mas a limpeza é uma decisão
do Luan (o sistema é insert-only). **Nunca rodar `pnpm test` com `IARIS_DB_TARGET=cloud`.**

## 7. Regras de operação que não podem ser quebradas

Além das 10 regras do CLAUDE.md:

- **Segredos:** senha, PIN, chave privada, token ou certificado nunca em prompt de IA, log, código ou conversa.
  Mostrar só ✓/✗. Não imprimir `SUPABASE_DB_PASSWORD` nem as URLs `CLOUD_*`. Nomes de arquivo de certificado
  podem conter a senha: ao listar `C:\IARIS\cofre\clientes`, não mostrar `.pfx/.p12/.key/.pem/.cer/.crt`
  nem nomes com "senha" ou "certific". Senha nova entra por janela PowerShell de digitação oculta que grava no cofre.
- **SERPRO é cobrado:** só por botão ou autorização; teto de 20 consultas/dia (`SERPRO_DAILY_LIMIT`).
  Autorizado automático: PagtoWeb 1 vez por empresa ~5 dias após vencimento com guia em aberto.
- **Nada é transmitido sem aprovação humana.** PGDAS-D fica pronta, não é transmitida.
- **IA não calcula tributo nem lança.** Motores determinísticos com regras aprovadas por pessoa.
  Regras novas (Simples, Presumido/Real, contabilização) entram como proposta e um USUÁRIO aprova.
- Decisão tomada por instrução do Luan na conversa vira auditoria citando as palavras dele,
  com ator contabilidade@grouplegacy.com.br.
- O escritório **não** dá ciência em NF-e (quem dá é o cliente) e **não** emite nota para o cliente.
- O escritório gera e envia ao cliente o DAS e os DARF de retenção.
- Não usar o pacote de 57 agentes (`C:\agentes`). Login gov.br não é feito pelo sistema.
- Convites, links de acesso e chaves TOTP nunca são exibidos.

## 8. Pendências abertas

**Aguardando o Luan (decisão humana):**
1. Aprovar as 8 regras de Lucro Presumido/Real em *Regras e legislação* (sem aprovação o motor `lucro-1` não calcula).
2. Aprovar as 3 implantações (FURK TECH, FURKINUX, ARES) e confirmar os serviços contratados.
3. Fila de exceções (57 pendências abertas em 19/10): guias não enviadas de SAFE ON/SABORES, ISS de São Paulo/Barbacena,
   lacunas de NSU, movimento de R$ 650 da SAFE ON, sublimite.

**Técnicas:**
1. **NF-e SEFAZ das empresas novas:** FURK TECH e ARES recebem `656 Consumo Indevido` na distribuição de DF-e;
   FURK TECH tem lacuna de NSU 1–197. Outro sistema (provavelmente o ERP do escritório, que gera os relatórios
   em `Y:\CLIENTES\ATIVOS\<cliente>`) está consultando com o mesmo certificado. Decidir: só a IARIS busca, ou
   a IARIS importa os XML que o outro sistema baixa (pasta Y: → `C:\IARIS\entrada`). Em 19/10, 83 XML de
   08–09/2026 da FURK TECH entraram pela pasta de entrada antes de o teste ser interrompido.
2. **Contas a pagar/receber (pausado):** recriar a migração `0050_nfe_purchases.sql` (tabela `nfe_purchase` e métodos
   `NFE_COMPRA`/`NFE_COMPRA_PARCIAL` no `bank_match`), contabilização de compra por NF-e com a regra `compras-nfe@1`,
   conciliação por parcela (duplicatas já lidas: commit `b2e2126`), visão AP/AR e cruzamento na revisão.
   Retomar só quando o Luan pedir.
3. Entrega ao cliente por e-mail/portal (Relacionamento): última etapa, por decisão do Luan.
4. Endereço fixo: hoje o túnel Cloudflare muda a cada reinício; domínio próprio ainda não definido.

## 9. Referência técnica rápida

- **Detecção de regime (`regime-1`):** códigos de DARF pagos por ano (IRPJ/CSLL decidem; PIS/COFINS confirmam) + `regime_tributario`
  da BrasilAPI (ECF, dados abertos). Anos seguidos viram um período; nunca sobrescreve; se o regime anterior termina no meio do ano,
  o novo começa no mês seguinte.
- **Lucro Presumido/Real (`lucro-1`):** presunção 8/12, 1,6, 16, 32 (grupos por CNAE, presunção automática pelo CNAE principal quando não
  confirmada); LC 224/2025 + IN RFB 2.306/2026 (×1,10 sobre a receita acima de R$ 1,25 mi no trimestre; IRPJ desde 01/01/2026, CSLL desde 01/04/2026);
  IRPJ 15% + 10% sobre o excedente de 20 mil × meses; CSLL 9%; PIS/COFINS 0,65/3 e 1,65/7,6 com créditos; quotas (mín. R$ 1.000, quota única
  abaixo de R$ 2.000, até 3); vencimentos PIS/COFINS dia 25 (antecipa), IRPJ/CSLL último dia útil do mês seguinte; DARF LP 2089/2372/8109/2172,
  LRT 3373/6012/6912/5856, LRA 5993/2484 (ajuste 2456/6773). Lucro Real: resultado do razão + Parte A − compensação limitada a 30% (Parte B).
- **Revisão independente:** por empresa e mês cruza fiscal × contábil, declarado × notas, Simples × declarado, DAS × pagamento, retenções,
  tributos do lucro × pagamento, CFOP/CST e documentos. Materialidade: 5% da receita do mês ou R$ 5.000; pendência crítica = risco ALTO.
- **Fila:** DAS/PGDAS só nos meses no Simples; retenções e guias só com responsabilidade `LEGACY`; tolerância de arredondamento
  da retenção 0,01 × máx(notas, 2). ISS: São Paulo dia 10; Curitiba dia 20 (Decreto 1.442/2007).
- **Consulta de NF-e por chave:** `consChNFe` no envelope NFeDistribuicaoDFe (sem custo; 640 se o CNPJ do certificado não é parte; 138 quando acha).

## 10. Como começar (primeiro dia)

1. Ler CLAUDE.md, este documento, DECISOES.md, ESPECIFICACAO-MESTRE.md e `src/platform/events/registry.ts`.
2. Subir o ambiente local (README, "Rodando no Windows") e rodar `pnpm typecheck && pnpm test`.
3. Pedir ao Luan: acesso ao repositório, um convite de usuário (`pnpm user:invite`) e, se for operar o PC, acesso remoto.
   O cofre não sai do PC e não é copiado para outra máquina.
4. Primeira tarefa sugerida: com o Luan, a decisão do item técnico 1 do bloco 8 (NF-e das empresas novas).
   PC e repositório estão no mesmo commit em 19/10/2026.
