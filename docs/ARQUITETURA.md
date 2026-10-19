# IARIS — Arquitetura para Aprovação

> Cópia do documento aprovado em 05/10/2026 (Claude Docs "Legacy One — Arquitetura para Aprovação"). O que foi construído depois está em PASSAGEM.md e DECISOES.md.

Oct 5, 2026 · @Luan Sanchez

## Resumo executivo e decisões fundamentais

Proposta: o IARIS nasce como **monólito modular orientado a eventos**, em TypeScript sobre PostgreSQL, com execução durável de workflows e motores determinísticos isolados da IA. Microsserviços só quando um motor provar necessidade de escala própria.

Três princípios técnicos sustentam a filosofia "automação primeiro, evidência sempre, humano por exceção":

1. **IA classifica, extrai, propõe e explica. Motor determinístico calcula, valida e grava.** Nenhuma fórmula tributária, saldo ou lançamento sai de um LLM sem passar por um motor com regra versionada.
2. **Todo estado relevante é um Case com eventos.** O Case é a unidade de trabalho, de SLA, de evidência e de auditoria.
3. **Toda informação é temporal e todo registro crítico é imutável.** Correção é estorno ou nova versão, nunca sobrescrita.

### Stack proposta

| Camada | Escolha proposta | Motivo |
| --- | --- | --- |
| Linguagem core | TypeScript (Node 22, NestJS ou Fastify) | Um idioma do front ao motor; tipagem forte em contratos de eventos |
| Banco transacional | PostgreSQL 16 com Row-Level Security | Isolamento por tenant no banco, `numeric` exato para valores, particionamento por tenant/competência |
| Workflow durável | Temporal (self-hosted ou Cloud) | Cases que esperam dias por cliente, órgão ou assinatura, com retry, timer e retomada automática |
| Event Bus | Outbox transacional no Postgres + NATS JetStream | Evento só publica se a transação gravou; replay e consumidores idempotentes |
| Documentos e evidências | Object storage S3 com Object Lock (WORM) | Original preservado, hash SHA-256, retenção legal |
| Busca | PostgreSQL full-text + pgvector | Busca semântica de documentos e memória do cliente sem infraestrutura extra no início |
| Segredos e certificados | HashiCorp Vault + KMS/HSM | A1 nunca sai do cofre em claro; assinatura feita dentro do serviço de assinatura |
| IA | AI Gateway próprio (multiprovider) | Roteamento por custo, risco e privacidade; LLM nunca recebe credencial |
| Front | React + TanStack, portal cliente e console do gestor | Mesmo idioma do core; componentes compartilhados entre portal e console |

### Independência

O IARIS é projeto novo, sem vínculo com sistemas, repositórios ou bases de dados anteriores. ERPs de mercado aparecem apenas como origem de arquivos quando um cliente chega de outro escritório.

### Restrições do mundo real que moldam a arquitetura

- **Não existe API oficial para tudo.** eSocial, EFD-Reinf e NF-e têm webservices; SERPRO Integra Contador cobre PGDAS-D, DCTFWeb, DEFIS, caixa postal e procurações. ECD e ECF dependem do PVA (Java desktop) para validar e transmitir. Isso é tratado no Transmission Engine como conector de risco alto (seção 27).
- **Certificado A3 é físico.** Exige um Signer Agent instalado em máquina do escritório ou do cliente. A1 fica no cofre.
- **Reforma tributária em curso.** CBS e IBS em fase de teste em 2026, CBS plena a partir de 2027, transição de ICMS/ISS até 2033. Regras temporais são obrigatórias desde a Fase 0.
- **CNPJ alfanumérico** já vigente para novas inscrições a partir de julho/2026. Armazenado como `char(14)` com validação do novo dígito verificador.

## 1. Arquitetura macro e fluxo end-to-end

Cada etapa é disparada por evento, não por pessoa. O ciclo só termina quando a competência seguinte já está aberta, e qualquer item sem evidência sai do fluxo como exceção sem parar o restante.

&#91;embedded content: fluxo end-to-end · 12 etapas, ciclo contínuo\]

O One Review é o único portão entre o que foi calculado e o que sai para órgãos e cliente; tudo acima da faixa amarela roda sem toque humano.

### Camadas

| Camada | Componentes | Regra de fronteira |
| --- | --- | --- |
| Canais | Portal do cliente, e-mail, WhatsApp, API, captura automática (SEFAZ, bancos, Integra Contador) | Toda entrada vira `DOCUMENT_RECEIVED` ou `CLIENT_REQUEST_RECEIVED` |
| Orquestração | Case Engine, One Orchestrator, Workflow Engine (Temporal), Event Bus, Pending, Deadline/SLA, Impact Engine | Decide o próximo passo; não calcula nada |
| Agentes | 30 agentes especializados com manifesto e autonomia L0–L4 | Propõem e acionam motores; nunca gravam direto em domínio alheio |
| Motores determinísticos | Accounting, Fiscal, Tax, Payroll, Reconciliation, LALUR, SPED Compiler, Rules/Validation/Calculation | Única camada que grava resultado contábil, fiscal e tributário |
| Controle | One Review, Exception Engine, Compliance, Audit | Libera, bloqueia, registra; não executa |
| Saída | Obligation Engine, Guides, Transmission, Relationship | Só age com autorização de uso único |
| Plataforma | Tenant & Identity, Credential Vault, Authorization, AI Gateway, Storage WORM, Observabilidade | Compartilhada, isolada por tenant |

## 2. Mapa de módulos

São 29 módulos agrupados em 7 contextos. Cada módulo é dono exclusivo das suas tabelas; outro módulo só lê via API interna ou reage a evento. Nenhum módulo escreve na tabela de outro.

| Contexto | Módulo | Responsabilidade | Determinístico? |
| --- | --- | --- | --- |
| Plataforma | Tenant & Identity | Escritórios, usuários, RBAC, MFA | Sim |
| Plataforma | Event Bus | Outbox, publicação, replay, DLQ | Sim |
| Plataforma | Workflow Engine | Execução durável de tarefas e sagas | Sim |
| Plataforma | Case Engine | Ciclo de vida de Cases, dependências, SLA | Sim |
| Plataforma | Deadline & SLA Engine | Prazos legais, prazos internos, alertas | Sim |
| Plataforma | Audit Engine | Log imutável encadeado por hash | Sim |
| Plataforma | Authorization Service | Decide se agente/usuário pode executar ação | Sim |
| Plataforma | Credential Vault | Certificados, senhas, procurações | Sim |
| Plataforma | AI Gateway | Roteamento multiprovider, custo, redaction | Não (IA) |
| Cadastro | Entity Registry | Entidade, tipo, estrutura, estabelecimentos, sócios, temporal | Sim |
| Cadastro | Digital Identity | Certificados e procurações por entidade e validade | Sim |
| Cadastro | Pending Engine | Pendências com origem, prazo, tentativas, impacto | Sim |
| Documentos | Document Intelligence | Receber, classificar, extrair, normalizar | Misto |
| Documentos | Contract & Document Engine | Templates versionados e geração | Sim |
| Documentos | Electronic Signature | Envio, monitoramento, validação de assinatura | Sim |
| Documentos | Search & Memory | Busca híbrida e memória operacional por cliente | Misto |
| Operação | Financial & Banking | Extratos, OFX, contas a pagar/receber | Sim |
| Operação | Reconciliation Engine | Matching determinístico + sugerido | Misto |
| Operação | Fiscal Engine | Escrituração de documentos fiscais | Sim |
| Operação | Payroll Engine | Folha, eventos, encargos, provisões | Sim |
| Contábil | Accounting Engine (One Ledger) | Partidas dobradas, períodos, dimensões | Sim |
| Contábil | Tax Engine | Apuração por regime e tributo | Sim |
| Contábil | e-LALUR/e-LACS Engine | Parte A, Parte B, saldos controlados | Sim |
| Compliance | Regulatory Engine | Base normativa versionada, layouts | Sim |
| Compliance | Obligation Engine | Catálogo, mapa por entidade, estados | Sim |
| Compliance | SPED Compiler (EFD, ECD, ECF) | Montagem e validação de arquivos | Sim |
| Compliance | Transmission & Guides | Assinatura, envio, recibo, guias, pagamento | Sim |
| Controle | Rules / Validation / Calculation | Regras declarativas reutilizáveis por todos | Sim |
| Controle | Review, Exception, Cross-Department Impact | Cruzamentos, exceções, propagação de impacto | Misto |

Os engines de nicho do prompt (Nonprofit, SCP, Construção, Agro, Comex, Societário, Regularização) não são módulos novos. São **pacotes de regras, dimensões e workflows** plugados sobre Entity Registry, Ledger, Tax e Obligation. Isso permite compor uma entidade Lucro Real + indústria + filial + SCP + importadora sem código especial.

## 3. Mapa de agentes

Agente é um executor com contrato fixo: consome eventos, chama ferramentas autorizadas, aciona motores determinísticos e publica eventos. Agente não grava direto em tabela de outro domínio e não conversa com outro agente por texto livre.

### Contrato comum de todo agente

- **Manifesto versionado:** responsabilidade, eventos consumidos, eventos publicados, ferramentas, limites, nível de autonomia, thresholds de confiança, critérios de escalonamento.
- **Níveis de autonomia:** L0 observa · L1 propõe, humano aprova · L2 executa, outro agente revisa · L3 executa sozinho · L4 executa e transmite a órgão externo.
- **Saída sempre estruturada:** resultado + `confidence` + evidências referenciadas + regra aplicada.
- **Escalonamento:** gera `EXCEPTION_RAISED` com hipóteses, nunca bloqueia o Case inteiro.

### Agentes

| Agente | Responsabilidade | Consome | Publica | Autonomia inicial |
| --- | --- | --- | --- | --- |
| One Orchestrator | Abre Cases, resolve dependências, distribui tarefas | `CLIENT_REQUEST_RECEIVED`, `*_COMPLETED`, timers | `CASE_CREATED`, `TASK_DISPATCHED` | L3 |
| One Onboarding | Perfil da entidade, checklist, plano de implantação | `CLIENT_ONBOARDING_CASE_CREATED` | `ENTITY_PROFILE_CREATED`, `IMPLEMENTATION_PLAN_READY` | L2 |
| One Registration | Cadastro temporal: CNPJ, IE, IM, CNAE, sócios | `ENTITY_PROFILE_CREATED`, `COMPANY_CHANGE_*` | `ENTITY_UPDATED` | L2 |
| One Digital Identity | Certificados, procurações, validade | `ENTITY_UPDATED`, timer de vencimento | `CERTIFICATE_EXPIRING`, `PROXY_MISSING` | L3 |
| One Docs | Pipeline de documentos | `DOCUMENT_RECEIVED` | `DOCUMENT_CLASSIFIED`, `DOCUMENT_MISSING` | L3 |
| One Search | Busca e memória do cliente | consultas de outros agentes | respostas com evidência | L3 |
| One Implementation | Migração da contabilidade anterior, de/para | `ACCOUNTING_FIRM_MIGRATION` | `ACCOUNT_MAPPING_PROPOSED`, `OPENING_BALANCE_LOADED` | L1 |
| One Fiscal | Escrituração fiscal, CFOP/CST, retenções | `DOCUMENT_CLASSIFIED` (fiscais) | `FISCAL_CLOSING_COMPLETED` | L2 |
| One Financial | Extratos, contas a pagar e receber | `BANK_STATEMENT_RECEIVED` | `FINANCIAL_ENTRY_CREATED` | L3 |
| One Reconciliation | Conciliações cruzadas | `FINANCIAL_ENTRY_CREATED`, `ACCOUNTING_POSTING_CREATED` | `BANK_RECONCILIATION_COMPLETED` | L2 |
| One Payroll | Folha e eventos trabalhistas | `EMPLOYEE_*`, `PAYROLL_CLOSING` | `PAYROLL_COMPLETED` | L2 |
| One Ledger | Lançamentos via Accounting Engine | eventos de fiscal, folha, financeiro | `ACCOUNTING_POSTING_CREATED`, `ACCOUNTING_CLOSING_COMPLETED` | L3 |
| One Tax | Apuração via Tax Engine | `*_CLOSING_COMPLETED` | `TAX_CALCULATION_COMPLETED` | L2 |
| One Obligations | Mapa e estado das obrigações | `TAX_CALCULATION_COMPLETED`, calendário | `OBLIGATION_READY` | L2 |
| One SPED | EFD ICMS/IPI, EFD-Contribuições | `OBLIGATION_READY` (SPED) | `SPED_FILE_VALIDATED` | L2 |
| One ECD | ECD a partir do Ledger | `ACCOUNTING_CLOSING_COMPLETED` (anual) | `ECD_FILE_VALIDATED` | L1 |
| One ECF | ECF contínua no exercício | `ECD_FILE_VALIDATED`, LALUR | `ECF_FILE_VALIDATED` | L1 |
| One LALUR | Parte A/B, saldos controlados | `ACCOUNTING_POSTING_CREATED` com marcação fiscal | `LALUR_ADJUSTMENT_CREATED` | L2 |
| One Guides | Geração e ciclo de guias | `TAX_CALCULATION_COMPLETED` | `TAX_GUIDE_READY` | L3 |
| One Transmission | Assinatura, envio, recibo | `OBLIGATION_VALIDATED` + autorização | `OBLIGATION_TRANSMITTED`, `RECEIPT_RECEIVED` | L4 (por obrigação) |
| One Relationship | Único canal com o cliente | `CLIENT_APPROVAL_REQUIRED`, `PENDING_*`, `CASE_COMPLETED` | `CLIENT_MESSAGE_SENT` | L3 |
| One Collection | Cobra documentos e respostas pendentes | `PENDING_ITEM_OVERDUE` | `PENDING_ITEM_RESOLVED` | L3 |
| One Post-Due-Date | Acompanha vencimentos e pagamentos | `TAX_GUIDE_SENT`, timer de vencimento | `PAYMENT_IDENTIFIED`, `PAYMENT_NOT_FOUND` | L3 |
| One Review | Revisor independente, cruzamentos | `*_CLOSING_COMPLETED`, `*_FILE_VALIDATED` | `REVIEW_APPROVED`, `REVIEW_BLOCKED` | L3 (não executa, só bloqueia ou libera) |
| One Compliance | Segregação de funções, política interna | ações sensíveis | `POLICY_VIOLATION` | L3 |
| One Regulatory | Monitora normas e layouts | fontes oficiais | `REGULATORY_CHANGE_DETECTED` | L1 |
| One Manager | Painel, KPIs, fila de decisões | todos os eventos | `HUMAN_DECISION_REQUESTED` | L0 |
| One Corporate | Societário: abertura, alteração, baixa | `COMPANY_*` | `CORPORATE_ACT_REGISTERED` | L1 |
| One Regularization | PER/DCOMP, parcelamentos, certidões | `TAX_NOTICE`, `DEBT_DETECTED` | `REGULARIZATION_PLAN_READY` | L1 |
| One Contracts | Contratos e documentos padronizados | `DOCUMENT_GENERATION_REQUESTED` | `DOCUMENT_GENERATED` | L2 |

A autonomia sobe por agente e por cliente conforme os critérios da seção 32. Um agente pode estar em L3 para um cliente Simples Nacional estável e em L1 para um Lucro Real recém-migrado.

## 4. Catálogo de Cases

Case só encerra quando a **condição objetiva de encerramento** é verdadeira, não quando um arquivo foi gerado. Cases recorrentes (fechamentos) geram automaticamente o Case da próxima competência ao encerrar.

| Case | Gatilho | Agente dono | Condição objetiva de encerramento |
| --- | --- | --- | --- |
| `CLIENT_ONBOARDING` | Pedido do cliente ou contrato assinado | One Onboarding | Perfil, mapa de obrigações, acessos e procurações validados; primeiro fechamento agendado |
| `ACCOUNTING_FIRM_MIGRATION` | Onboarding com contabilidade anterior | One Implementation | Saldos de abertura carregados, cada saldo com status, de/para aprovado, responsabilidade registrada |
| `ACCOUNTING_CLOSING` | Timer de competência | One Ledger | Review aprovado, período bloqueado, demonstrações entregues |
| `TAX_CLOSING` | `FISCAL_CLOSING_COMPLETED` | One Tax | Tributos calculados, guias enviadas, pagamento identificado ou exceção aberta |
| `PAYROLL_CLOSING` | Timer de competência | One Payroll | Folha fechada, eSocial e DCTFWeb aceitos, FGTS Digital gerado, contabilização feita |
| `EMPLOYEE_ADMISSION` | Mensagem do cliente ou formulário | One Payroll | S-2200 aceito, contrato assinado e arquivado, folha e provisões atualizadas |
| `EMPLOYEE_TERMINATION` | Mensagem do cliente | One Payroll | S-2299 aceito, TRCT assinado, guias de FGTS e rescisão pagas |
| `VACATION` | Programação ou pedido | One Payroll | Aviso assinado, recibo gerado, evento enviado |
| `COMPANY_OPENING` / `COMPANY_CHANGE` / `COMPANY_CLOSURE` | Pedido do cliente | One Corporate | Ato registrado nos órgãos, cadastro temporal atualizado, impacto propagado |
| `NEW_BRANCH` | Ato societário | One Corporate | Estabelecimento ativo, IE/IM, obrigações locais mapeadas |
| `TAX_REGIME_CHANGE` | Opção ou exclusão de regime | One Tax | Novo regime vigente com `valid_from`, regras e obrigações recalculadas |
| `SCP_CREATION` | Contrato de SCP | One Corporate | SCP cadastrada, ledger próprio aberto, obrigações vinculadas |
| `BANK_RECONCILIATION` | Extrato recebido | One Reconciliation | 100% dos itens conciliados ou com exceção aberta |
| `SPED_SUBMISSION` / `ECD_SUBMISSION` / `ECF_SUBMISSION` | Calendário de obrigações | One SPED / ECD / ECF | Recibo de entrega armazenado e vinculado |
| `TAX_NOTICE` | Intimação, caixa postal e-CAC | One Regularization | Resposta protocolada e prazo cumprido |
| `DOCUMENT_REQUEST` | Pendência aberta | One Collection | Documento recebido e classificado, ou dispensa registrada |
| `NONPROFIT_ACCOUNTABILITY` | Fim de período de convênio | One Ledger | Prestação de contas gerada, evidências correlacionadas, protocolo |
| `REGULARIZATION` | Débito ou omissão detectada | One Regularization | Débito quitado, parcelado ou contestado; certidão emitida |
| `TAX_REFUND` / `TAX_COMPENSATION` | Crédito identificado | One Regularization | PER/DCOMP transmitido e despacho acompanhado até decisão |
| `EXCEPTION` | Qualquer agente | Agente de origem | Decisão humana registrada e workflow de origem retomado |

### Estrutura do Case

`case_id`, `tenant_id`, `entity_id`, `establishment_id`, `type`, `competence`, `origin`, `requester`, `status`, `priority`, `owner_agent`, `deadline_legal`, `deadline_internal`, `parent_case_id`, `depends_on[]`, e coleções vinculadas: `tasks`, `events`, `documents`, `pending_items`, `communications`, `approvals`, `evidence`, `audit`.

Estados: `OPEN` → `IN_PROGRESS` → `WAITING_CLIENT` | `WAITING_EXTERNAL` | `WAITING_HUMAN` → `IN_REVIEW` → `COMPLETED` | `CANCELLED`. Subcases filhos (ex.: um `BANK_RECONCILIATION` por banco) permitem que exceções em um não travem os demais.

## 5. Catálogo de eventos

Evento é fato consumado, no passado, imutável e com esquema versionado. Comandos ("faça X") e eventos ("X aconteceu") são tipos distintos; agentes recebem comandos do Orchestrator e publicam eventos.

### Envelope padrão

```json
{
  "event_id": "uuid-v7",
  "type": "TAX_CALCULATION_COMPLETED",
  "schema_version": 3,
  "tenant_id": "...",
  "entity_id": "...",
  "establishment_id": "...",
  "case_id": "...",
  "competence": "2026-09",
  "occurred_at": "2026-10-05T10:14:02-03:00",
  "producer": { "kind": "agent", "name": "one-tax", "version": "1.4.0" },
  "causation_id": "evento que causou este",
  "correlation_id": "cadeia completa do Case",
  "idempotency_key": "tenant:entity:competence:tax:irpj",
  "payload": { },
  "evidence_refs": ["ev_..."],
  "confidence": 1.0
}
```

### Taxonomia

| Família | Eventos principais | Produtor | Consumidores típicos |
| --- | --- | --- | --- |
| Cliente | `CLIENT_REQUEST_RECEIVED`, `CLIENT_APPROVAL_REQUIRED`, `CLIENT_APPROVED`, `CLIENT_MESSAGE_SENT` | Relationship, Orchestrator | Orchestrator, Manager |
| Case | `CASE_CREATED`, `CASE_BLOCKED`, `CASE_RESUMED`, `CASE_COMPLETED` | Case Engine | Orchestrator, Manager, Relationship |
| Cadastro | `ENTITY_UPDATED`, `TAX_REGIME_CHANGED`, `ESTABLISHMENT_OPENED`, `PARTNER_CHANGED` | Registration, Corporate | Impact Engine, Obligations, Tax |
| Identidade | `CERTIFICATE_EXPIRING`, `CERTIFICATE_EXPIRED`, `PROXY_MISSING`, `AUTHORIZATION_FAILED` | Digital Identity, Transmission | Relationship, Manager |
| Documento | `DOCUMENT_RECEIVED`, `DOCUMENT_CLASSIFIED`, `DOCUMENT_EXTRACTED`, `DOCUMENT_MISSING`, `DOCUMENT_DUPLICATED` | Docs | Fiscal, Financial, Payroll, Pending |
| Pendência | `PENDING_ITEM_CREATED`, `PENDING_ITEM_OVERDUE`, `PENDING_ITEM_RESOLVED` | Pending Engine | Relationship, Collection, workflow de origem |
| Financeiro | `BANK_STATEMENT_RECEIVED`, `FINANCIAL_ENTRY_CREATED`, `BANK_RECONCILIATION_COMPLETED` | Financial, Reconciliation | Ledger, Review |
| Fiscal | `FISCAL_DOCUMENT_BOOKED`, `FISCAL_CLOSING_COMPLETED` | Fiscal | Tax, Ledger, SPED |
| Folha | `EMPLOYEE_ADMITTED`, `EMPLOYEE_TERMINATED`, `PAYROLL_COMPLETED`, `ESOCIAL_EVENT_ACCEPTED` | Payroll, Transmission | Ledger, Tax, Obligations |
| Contábil | `ACCOUNTING_POSTING_CREATED`, `ACCOUNTING_POSTING_REVERSED`, `PERIOD_LOCKED`, `ACCOUNTING_CLOSING_COMPLETED` | Ledger | Review, LALUR, ECD |
| Tributário | `TAX_CALCULATION_COMPLETED`, `LALUR_ADJUSTMENT_CREATED` | Tax, LALUR | Guides, Obligations, ECF |
| Obrigação | `OBLIGATION_READY`, `OBLIGATION_VALIDATED`, `OBLIGATION_SIGNED`, `OBLIGATION_TRANSMITTED`, `RECEIPT_RECEIVED`, `OBLIGATION_REJECTED` | Obligations, SPED, Transmission | Review, Relationship, Manager |
| Guia | `TAX_GUIDE_READY`, `TAX_GUIDE_SENT`, `PAYMENT_IDENTIFIED`, `PAYMENT_NOT_FOUND` | Guides, Post-Due-Date | Relationship, Ledger |
| Controle | `REVIEW_APPROVED`, `REVIEW_BLOCKED`, `EXCEPTION_RAISED`, `HUMAN_DECISION_RECORDED`, `POLICY_VIOLATION` | Review, todos, Manager | Orchestrator, workflow de origem |
| Normativo | `REGULATORY_CHANGE_DETECTED`, `RULE_VERSION_RELEASED` | Regulatory | Tax, Obligations, SPED, Manager |

Regra de nomenclatura: `ENTIDADE_VERBO_NO_PASSADO`. Todo esquema fica em um **registry de contratos** com testes de compatibilidade; quebrar um esquema exige nova versão e período de convivência.

## 6. Modelo de dados

O modelo separa **o que a entidade é** (tipo, estrutura jurídica), **como é tributada** (regime, no tempo) e **o que o escritório faz por ela** (serviços contratados). Regras e obrigações são derivadas da composição dessas três dimensões, nunca de uma categoria única.

### Hierarquia

```
TENANT (escritório)
 └─ USER / ROLE
 └─ CLIENT (relação comercial)
     └─ ENTITY (CNPJ raiz ou CPF)
         ├─ ENTITY_TYPE_HISTORY        (sociedade, associação, produtor rural...)
         ├─ LEGAL_STRUCTURE_HISTORY    (LTDA, SA, EIRELI legado, fundação...)
         ├─ TAX_REGIME_HISTORY         (Simples, Presumido, Real anual/trimestral...)
         ├─ SPECIAL_REGIME_HISTORY     (RET, benefícios, regimes estaduais)
         ├─ CONTRACTED_SERVICE_HISTORY (contábil, fiscal, folha, societário)
         ├─ PARTNER_HISTORY / ADMINISTRATOR_HISTORY
         ├─ ESTABLISHMENT (matriz, filiais, CNO, CAEPF)
         │   ├─ ACTIVITY_HISTORY (CNAE principal/secundários)
         │   └─ REGISTRATION_HISTORY (IE, IM, UF, município)
         ├─ SCP (domínio próprio, N por sócia ostensiva)
         ├─ DIGITAL_IDENTITY (certificados, procurações)
         └─ OPERATIONAL_MEMORY
```

### Domínios e tabelas principais

| Domínio | Tabelas | Observação |
| --- | --- | --- |
| Cadastro | `entity`, `establishment`, `*_history`, `scp`, `scp_participant` | Tudo que muda no tempo tem `valid_from` / `valid_to` |
| Case/Workflow | `case`, `case_dependency`, `task`, `pending_item`, `approval` | Estado do Temporal espelhado para consulta |
| Eventos | `outbox`, `event_store`, `inbox_dedup` | `event_store` particionado por mês |
| Documentos | `document`, `document_version`, `extraction`, `document_link` | Original no S3, hash SHA-256 no banco |
| Evidência | `evidence`, `evidence_link` | Liga qualquer registro a documento, extrato, recibo ou decisão |
| Contábil | `chart_of_accounts`, `account`, `account_mapping`, `journal_batch`, `journal_entry`, `journal_line`, `dimension`, `period` | Linhas com `debit`/`credit` em `numeric(18,2)` |
| Fiscal | `fiscal_document`, `fiscal_item`, `fiscal_tax_line`, `fiscal_book_entry` | Um item com N linhas de tributo |
| Tributário | `tax_calculation`, `tax_base_item`, `tax_rule_version`, `lalur_part_a`, `lalur_part_b_account`, `lalur_part_b_movement` | Cálculo guarda a versão da regra usada |
| Folha | `employee`, `employment_contract_history`, `payroll_run`, `payroll_item`, `esocial_event` | Salário e cargo temporais |
| Financeiro | `bank_account`, `bank_transaction`, `receivable`, `payable`, `reconciliation_match` | Match guarda método e score |
| Compliance | `regulatory_rule`, `layout_version`, `obligation_catalog`, `obligation_instance`, `submission`, `receipt`, `tax_guide` | Instância ligada à competência e ao estabelecimento |
| Auditoria | `audit_log` | Apenas INSERT; hash encadeado |

### Regras de modelagem obrigatórias

- **Toda tabela de negócio tem `tenant_id`** como primeira coluna de índices e política RLS.
- **CNPJ em `char(14)`**, aceita `[0-9A-Z]` nas 12 primeiras posições e valida o DV pelo algoritmo novo. CPF e CNPJ em colunas distintas, nunca no mesmo campo numérico.
- **Valores monetários em `numeric(18,2)`**; alíquotas e fatores em `numeric(12,6)`. Nunca `float`.
- **Competência como `date` (primeiro dia do mês)**, não string.
- **Consulta temporal padrão:** `as_of(entity, date)` devolve a configuração vigente. Responde "qual era a configuração em 31/03/2025?" com uma única função.
- **Correção nunca é UPDATE em registro fechado.** Lançamento recebe estorno; cadastro recebe nova linha de histórico; regra recebe nova versão.

## 7, 8, 18, 19. Multi-tenant, segurança, Credential Vault e Authorization Service

Isolamento entre escritórios é garantido em três camadas independentes: banco (RLS), aplicação (contexto de tenant obrigatório) e criptografia (chave por tenant). Uma falha em uma camada não vaza dados.

### Multi-tenancy

| Camada | Mecanismo |
| --- | --- |
| Banco | Banco compartilhado, `tenant_id` em toda tabela, RLS com `current_setting('app.tenant_id')`; conexão sem tenant definido não lê nada |
| Aplicação | Middleware injeta tenant do token; repositórios não aceitam query sem tenant |
| Eventos | Subject do NATS prefixado por tenant (`t.<tenant>.tax.*`); consumidor valida tenant do envelope |
| Armazenamento | Prefixo S3 por tenant + chave KMS por tenant (envelope encryption) |
| IA | Contexto do prompt montado só com dados do tenant da tarefa; cache de IA nunca compartilhado entre tenants |
| Escala | Particionamento de `journal_line`, `event_store`, `fiscal_item` por tenant + competência. Tenant grande pode migrar para banco dedicado sem mudança de código |

### Segurança

- **Identidade:** OIDC, MFA obrigatório para usuário do escritório, passkey opcional para cliente no portal.
- **RBAC + ABAC:** papel (contador, analista, gestor, cliente) mais atributos (carteira de clientes, departamento). Segregação de funções: quem prepara não aprova transmissão crítica.
- **Criptografia:** TLS 1.3 em trânsito; AES-256 em repouso; colunas sensíveis (CPF de empregado, dados bancários) com criptografia de coluna.
- **LGPD:** inventário de dados pessoais por tabela, base legal registrada, retenção configurável respeitando prazos fiscais e trabalhistas, anonimização em ambiente de teste.
- **Backup e DR:** PITR do Postgres, réplica em outra região, RPO 15 min, RTO 4 h. Teste de restauração mensal.

### Credential Vault

| Credencial | Onde fica | Como é usada |
| --- | --- | --- |
| Certificado A1 (e-CNPJ, e-CPF) | Vault, chave privada não exportável | Signing Service assina dentro do cofre e devolve o artefato assinado |
| Certificado A3 (token/cartão) | Fisicamente com o titular | **Signer Agent** local recebe hash, pede PIN ao titular, devolve assinatura |
| Senhas de portais | Vault, versionadas | Conector recebe a credencial em memória, nunca em log |
| Tokens de API (SERPRO, bancos) | Vault com rotação automática | Lidos pelo conector no momento da chamada |

Procuração eletrônica (e-CAC) é cadastro temporal com escopo de serviços e validade; o Digital Identity Agent alerta 30 dias antes do vencimento.

### Authorization Service

Todo acesso a sistema externo passa pelo fluxo:

1. Agente pede ação: `TRANSMIT ECD entity=X competence=2025`.
2. Authorization Service avalia política: agente tem autonomia L4 para esta obrigação neste cliente? Existe aprovação humana exigida? Certificado e procuração válidos? Review aprovado?
3. Se sim, emite **autorização de uso único** com escopo e expiração curta.
4. Conector troca a autorização pela credencial no Vault e executa.
5. Resposta volta **sanitizada** (sem tokens, sem dados de sessão) para o agente.

**Regra absoluta:** senha, PIN, chave privada, token ou certificado nunca entram em prompt de LLM nem em log. Há teste automatizado que varre prompts e logs procurando padrões de segredo.

## 9, 10. Event Bus e Workflow Engine

Event Bus transporta fatos; Workflow Engine garante que um processo longo chegue ao fim mesmo com falhas, esperas de dias e reinícios de servidor. São peças separadas e complementares.

### Event Bus

- **Outbox transacional:** o módulo grava o dado e o evento na mesma transação. Um relay publica do `outbox` para o NATS JetStream. Sem gravação, sem evento; sem evento perdido.
- **Entrega pelo menos uma vez + consumidor idempotente:** cada consumidor registra `event_id` em `inbox_dedup` antes de processar.
- **Ordem por chave:** eventos da mesma entidade e competência são ordenados (subject por `tenant.entity`).
- **Retry com backoff e DLQ:** após N falhas o evento vai para a fila morta e abre `EXCEPTION_RAISED` técnico para o Manager.
- **Replay:** `event_store` permite reprocessar uma competência inteira após correção de regra, gerando estornos e novos lançamentos, nunca duplicatas.

### Workflow Engine

Cada Case de longa duração é um workflow no Temporal. O código do workflow descreve o caminho; o Temporal persiste cada passo.

| Recurso | Uso no Legacy One |
| --- | --- |
| Atividades com retry | Chamadas a motor, IA, conectores externos |
| Sinais | Chegada de documento, aprovação humana, resposta do cliente: retomam o workflow parado |
| Timers duráveis | Prazo legal, lembrete de assinatura, verificação de pagamento D+2 |
| Sagas com compensação | Transmissão rejeitada desfaz o estado "transmitida" e reabre validação |
| Child workflows | Um subcase por banco, por estabelecimento, por empregado |
| Versionamento | Mudança de fluxo não quebra Cases em andamento |

Estados de tarefa expostos ao usuário: `QUEUED`, `RUNNING`, `WAITING_DATA`, `WAITING_EXTERNAL`, `WAITING_HUMAN`, `FAILED`, `COMPLETED`, `CANCELLED`.

### Pending Engine integrado

Quando um workflow precisa de dado ausente, ele cria um `pending_item` e espera o sinal. Ao chegar `DOCUMENT_RECEIVED` que satisfaz o item, o Pending Engine resolve o item e sinaliza o workflow, que **retoma sozinho**. One Relationship agrupa todos os `pending_item` abertos de um cliente em uma única solicitação por janela de tempo.

### Cross-Department Impact Engine

Tabela declarativa `event_type → [workflows a abrir, condições]`. Exemplo: `TAX_REGIME_CHANGED` abre tarefas em Fiscal, Tax, Obligations, Accounting, Payroll, ECD, ECF e Relationship com a data de vigência do novo regime. Adicionar um impacto é configuração, não código.

## 11. Accounting Engine (One Ledger)

O Ledger é a única fonte da verdade contábil: ECD, balancete, DRE, balanço e parte do LALUR nascem dele. Nenhum lançamento entra sem regra de origem, documento ou evidência e soma de débitos igual à soma de créditos, validada por constraint no banco.

### Como um lançamento nasce

1. Um evento de negócio chega (`FISCAL_DOCUMENT_BOOKED`, `PAYROLL_COMPLETED`, `BANK_RECONCILIATION_COMPLETED`).
2. O **Posting Rules Engine** escolhe a regra de contabilização vigente para aquela entidade, tipo de documento, natureza e estabelecimento.
3. A regra produz linhas com contas, valores, histórico padrão e dimensões. IA só entra para escolher natureza quando a regra pede classificação (ex.: "energia de qual centro de custo?"), e devolve confiança.
4. Validação: débito = crédito, conta analítica ativa na data, período aberto, dimensões obrigatórias preenchidas.
5. Gravação com `idempotency_key` derivada do documento de origem. Reprocessar o mesmo documento não duplica.

### Exemplo do prompt, como o motor registra

| Momento | Débito | Crédito | Valor | Origem / evidência |
| --- | --- | --- | --- | --- |
| Conta de energia recebida | Energia Elétrica / Custo Industrial (CC Produção) | Fornecedores - Concessionária | 12.450,00 | Documento PDF, hash, extração |
| Pagamento identificado no banco | Fornecedores - Concessionária | Banco B | 12.450,00 | Linha do extrato OFX + match de conciliação |

### Capacidades

- **Estrutura:** lançamento simples, composto e em lote; partida em `journal_entry` com N `journal_line`.
- **Dimensões:** centro de custo, estabelecimento, projeto, obra, SCP, fundo e convênio (terceiro setor), restrição de recurso. Dimensões são configuráveis por entidade e obrigatórias conforme regra.
- **Operações:** estorno (nunca exclusão), reclassificação, rateio por driver, provisões, apropriações, depreciação, amortização e exaustão calculadas por motor a partir do cadastro de ativos.
- **Períodos:** abertura, fechamento, bloqueio e reabertura controlada (reabertura exige aprovação, motivo e gera evento auditado).
- **Plano de contas:** plano do escritório como padrão, plano próprio por entidade quando necessário, vínculo temporal com o plano referencial da RFB.
- **Responsabilidade:** cada saldo de abertura carrega status (`CONFIRMED`, `RECONCILED`, `INHERITED_NOT_VALIDATED`, `DIVERGENT`, `NO_COMPOSITION`, `UNDER_INVESTIGATION`) e a data de início da responsabilidade do escritório.

### Migração da contabilidade anterior

Importadores para balancete, razão, diário, plano, ECD (registros I050, I150/I155, I200/I250), planilhas e exportações de ERPs contábeis de mercado. A IA propõe `SOURCE_CHART → TARGET_CHART`; o Rules Engine valida natureza (devedora/credora), grupo e nível. Saldo que não fecha **não** recebe contrapartida fictícia: fica identificado como diferença de implantação, visível no balancete, com status `DIVERGENT`, abre exceção e impede o encerramento do Case de migração até decisão humana.

## 12, 13, 14. Fiscal, Tax e Payroll Engines

Os três motores seguem o mesmo padrão: dado normalizado + regra versionada vigente na data do fato = resultado reproduzível. Rodar de novo a mesma competência com as mesmas regras devolve o mesmo centavo.

### Fiscal Engine

- **Entrada:** XML de NF-e, NFC-e, CT-e, NFS-e (padrão nacional e municipais), serviços tomados e prestados, devoluções, cancelamentos, inutilizações.
- **Interpretação:** CFOP, CST/CSOSN, NCM, CEST, ICMS próprio, ST, DIFAL, IPI, ISS, PIS/COFINS, retenções (IRRF, CSRF, INSS, ISS), benefícios e créditos.
- **Perfil fiscal do item:** cada produto/serviço da entidade tem perfil temporal (NCM, tributação de entrada e saída por UF). Documento que diverge do perfil vira exceção, não lançamento.
- **Saída:** livro fiscal por estabelecimento, base para apuração, EFD ICMS/IPI, EFD-Contribuições, Reinf, e evento para o Ledger.
- **Reforma tributária:** campos IBS/CBS (CST, cClassTrib, alíquotas) já no modelo do item; regras de transição como versões com `valid_from`. Convivência ICMS/ISS + IBS/CBS é tratada como dois conjuntos de regras ativos ao mesmo tempo.

### Tax Engine

Motor de cálculo declarativo: cada tributo é uma **tabela de regras versionada + função pura** que recebe bases e devolve memória de cálculo.

| Regime | Cálculos cobertos |
| --- | --- |
| Simples Nacional / MEI | RBT12, anexo, fator R, segregação de receitas (ST, monofásico, exportação), sublimite, PGDAS-D |
| Lucro Presumido | IRPJ/CSLL trimestral por percentual de presunção, adicional, PIS/COFINS cumulativos |
| Lucro Real anual (estimativa) e trimestral | IRPJ/CSLL sobre lucro ajustado do LALUR, balancete de suspensão/redução, PIS/COFINS não cumulativos com créditos |
| Lucro Arbitrado, RET, imunes e isentas | Regras próprias como pacotes |
| Todos | ICMS, IPI, ISS, retenções, previdenciário, CBS/IBS conforme vigência |

Toda apuração grava: bases, regra e versão aplicadas, memória de cálculo linha a linha, evidências de origem. **IA não calcula tributo.** IA pode sugerir enquadramento (ex.: anexo do Simples para um CNAE novo) que sempre passa por regra ou aprovação.

### Payroll Engine

- **Ciclo:** admissão, alteração contratual, férias, afastamentos, benefícios, pró-labore, autônomos, folha mensal, 13º, rescisão, provisões de férias e 13º com encargos.
- **Tabelas versionadas:** INSS, IRRF, salário mínimo, FGTS, RAT/FAP, terceiros, convenções coletivas por sindicato e data-base.
- **eSocial:** geração dos eventos S-1000 a S-3000, envio por webservice com certificado, leitura de retorno, totalizadores S-5001/S-5011 conferidos contra o cálculo interno.
- **Integrações:** DCTFWeb (via Integra Contador), FGTS Digital, contabilização automática por evento de folha.

Fluxo do exemplo "Contratei Maria, R$ 4.800, começa segunda": Relationship cria `EMPLOYEE_ADMISSION` → Payroll verifica dados e pede só o que falta (CPF, endereço, cargo, jornada) em uma mensagem → Contracts gera contrato pelo template aprovado → Signature envia e monitora → assinado, Payroll cadastra com `valid_from` → Transmission envia S-2200 **antes do início das atividades** (prazo legal) → retorno aceito → folha e provisões atualizadas → Ledger recebe evento → Relationship confirma ao cliente → Case encerra.

## 15, 16. Regulatory e Obligation Engines

O Regulatory Engine mantém a norma como dado versionado; o Obligation Engine deriva, para cada entidade e competência, quais obrigações existem, com qual layout, prazo e responsável. Mudança normativa nunca entra em produção sem teste e aprovação.

### Regulatory Engine

Registro: `rule_id`, `jurisdiction` (federal, UF, município), `obligation`, `layout_version`, `record`, `field`, `data_type`, `required`, `validation`, `effective_from`, `effective_to`, `official_source` (URL + hash do documento oficial), `version`.

Fluxo de mudança:

1. **Detect:** One Regulatory monitora fontes oficiais (Portal SPED, eSocial, Receita, SEFAZ, CONFAZ, NFS-e nacional) e publica `REGULATORY_CHANGE_DETECTED` com o documento original.
2. **Compare:** diff estruturado contra a versão vigente (campos, validações, prazos).
3. **Impact analysis:** quais entidades, obrigações e Cases em andamento são afetados.
4. **Test:** a nova versão roda contra a massa de testes e contra competências reais em modo sombra.
5. **Approval:** responsável técnico do escritório aprova.
6. **Version e release:** publica com `effective_from`; versões anteriores continuam válidas para fatos anteriores.

IA ajuda a ler e estruturar a norma. **Quem libera para produção é humano**, sempre.

### Obligation Engine

`ObligationCatalog` declara cada obrigação com regras de aplicabilidade compostas: tipo de entidade, regime, atividade, estabelecimento, UF, município, regimes especiais, serviços contratados e período.

Para cada entidade, o motor gera o **Obligation Map** e, a cada competência, as `obligation_instance` com prazo legal, prazo interno (D-n configurável) e dependências (ex.: ECF depende de ECD transmitida).

Estados: `PENDENTE` → `AGUARDANDO_DADOS` → `PROCESSANDO` → `INCONSISTENTE` | `PRONTA` → `REVISADA` → `ASSINADA` → `TRANSMITIDA` → `ACEITA` | `RETIFICADA` | `DISPENSADA`.

Cobertura planejada (conforme aplicabilidade): ECD, ECF, EFD ICMS/IPI, EFD-Contribuições, EFD-Reinf, eSocial, DCTFWeb, MIT, PGDAS-D, DEFIS, DMED, DIMOB, DOI, DIRBI, DITR, LCDPR, obrigações estaduais (GIA, DeSTDA e equivalentes), municipais (declarações de ISS) e setoriais. **Dispensa é estado explícito com fundamento**, não ausência de registro: o Review cobra justificativa quando a obrigação some do mapa.

## 17. Document Intelligence

O cliente manda o que tiver, do jeito que tiver; o pipeline organiza. Documento estruturado (XML, OFX, SPED) segue por parser determinístico; documento não estruturado (PDF, imagem, planilha particular) passa por IA com confiança medida e validação cruzada.

### Pipeline

| Etapa | O que faz | Motor |
| --- | --- | --- |
| Receive | Portal, e-mail dedicado por cliente, WhatsApp, API, captura automática (SEFAZ, prefeitura, bancos) | Conectores |
| Integrity | Hash SHA-256, antivírus, deduplicação por hash e por chave de acesso, descompactação de ZIP | Determinístico |
| Detect | Empresa (CNPJ no conteúdo, remetente, chave), estabelecimento, competência | Determinístico primeiro, IA se ausente |
| Classify | Tipo: NF-e, boleto, extrato, contrato, holerite, guia, recibo, planilha de estoque... | Parser por assinatura; IA para não estruturado |
| Extract | Campos do tipo: valores, datas, partes, itens, tributos | Parser ou IA com esquema fixo de saída |
| Normalize | Converte para o modelo canônico do domínio | Determinístico |
| Validate | Soma de itens = total, CNPJ válido, data dentro da competência, cruzamento com SEFAZ quando houver chave | Validation Engine |
| Correlate | Liga ao pedido, ao pagamento, ao contrato, ao empregado | Search + regras |
| Store | Original no S3 com Object Lock, extração versionada, `evidence` | Determinístico |
| Route | Publica `DOCUMENT_CLASSIFIED` para o domínio dono | Event Bus |

### Regras de confiança

- Cada campo extraído tem `confidence` próprio. Campo crítico (valor, CNPJ, data) abaixo do threshold vai para validação cruzada (segundo modelo ou regra); se persistir, vira pendência ou exceção.
- Planilhas particulares do cliente: o sistema aprende o **layout por cliente** após a primeira aprovação humana e passa a ler sozinho as próximas no mesmo formato.
- Documento duplicado não entra duas vezes: `DOCUMENT_DUPLICATED` com link para o original.
- O original nunca é alterado. Reextração gera nova versão de `extraction`.

### Search & Memory

Busca híbrida (texto + vetorial) sobre documentos, lançamentos e decisões. A memória operacional do cliente guarda tratamentos aprovados ("tarifa do Banco X vai para Despesas Bancárias / CC Administrativo") como **regras aprendidas com origem e aprovação**. Regra aprendida nunca sobrescreve regra legal; em conflito, a legal vence e o conflito vira exceção.

## 20, 21, 22, 23. SPED, ECD, ECF e e-LALUR/e-LACS

Os arquivos SPED são **compilados**, não digitados: dado normalizado + layout versionado do Regulatory Engine → registros → validação própria → arquivo. A validação própria replica as regras do PVA para que o arquivo chegue ao validador oficial já limpo.

### SPED Compiler

```
NormalizedData (Ledger, Fiscal, Payroll, LALUR)
   + LayoutVersion (Regulatory Engine, vigente na competência)
   → RecordBuilder (um builder por registro: 0000, C100, I155, M300...)
   → ValidationEngine (estrutura, campos, totalizadores, regras cruzadas)
   → File (encoding e delimitação oficiais) + hash
   → PVA (validação oficial) → assinatura → transmissão → recibo
```

Cada registro gerado guarda ponteiro para os dados de origem. Um erro do PVA em uma linha leva direto ao lançamento, documento ou cadastro que a originou.

### ECD

- Nasce do One Ledger: plano (I050), mapeamento referencial (I051), saldos periódicos (I150/I155), lançamentos (I200/I250), demonstrações (J100/J150), termos e signatários.
- Pré-condições automáticas: todos os períodos do exercício bloqueados, Review aprovado, contador e responsáveis com certificado válido.
- Substituição de ECD é Case próprio com motivo e trilha.

### ECF

Construída **continuamente** durante o exercício, não em julho:

- Recupera ECD (saldos e plano referencial), ECF anterior (saldos de Parte B, prejuízos), Ledger e LALUR.
- Blocos L/P/T/U conforme regime, M (e-LALUR/e-LACS), N (cálculo), X e Y (informações econômicas e gerais) a partir do cadastro.
- Simulação mensal da ECF para entidades do Lucro Real: o gestor vê o IRPJ/CSLL anual projetado a cada fechamento.

### e-LALUR / e-LACS

Ledger fiscal próprio, separado do contábil, mas ligado a ele:

| Elemento | Controle |
| --- | --- |
| Parte A | Adições, exclusões e compensações por período, cada uma com lançamento contábil de origem e fundamento legal |
| Parte B | Contas de controle com saldo inicial, constituição, movimentação, utilização e reversão, atravessando exercícios |
| Prejuízo fiscal e base negativa | Saldo por exercício de origem, limite de 30% na compensação aplicado pelo motor |
| Diferenças temporárias | Vínculo com ativo/passivo fiscal diferido quando aplicável |

Rastreabilidade exigida: `journal_line → lalur_adjustment → fundamento → período → documento → Parte A/B → registro M da ECF`. Contas contábeis podem ser marcadas com natureza fiscal padrão (ex.: multas indedutíveis), e o LALUR Agent propõe o ajuste a cada lançamento; ajuste novo sem precedente pede aprovação.

### Restrição sobre o PVA

Validação final e transmissão de ECD, ECF e EFDs dependem do PVA da RFB (aplicação Java desktop). Arquitetura proposta: **Validation Runner** em VM isolada que executa o PVA de forma automatizada, importa o arquivo, coleta o relatório de erros e devolve estruturado. É o ponto de maior risco técnico (seção 31) e fica atrás de uma interface, para trocar por API oficial se um dia existir.

## 24, 25, 26. One Review, Exception Engine e Auditoria

O Review não confia nos executores: recalcula e cruza a partir das fontes. A exceção isola o problema sem parar o resto. A auditoria prova, depois, quem fez o quê com qual regra.

### One Review

Roda em processo separado, com leitura somente, e nunca corrige: aprova, bloqueia ou abre exceção.

| Cruzamento | Regra exemplo |
| --- | --- |
| Banco × Ledger | Saldo contábil da conta banco = saldo do extrato no último dia |
| Fiscal × Contábil | Total de saídas do livro fiscal = receita bruta contabilizada (por estabelecimento) |
| Folha × Contábil | Proventos, descontos e encargos da folha = lançamentos de folha |
| Tributos × Receita | Base do PGDAS-D ou do PIS/COFINS = receita do Ledger, diferenças explicadas |
| Estoque × Fiscal | Movimento do inventário compatível com entradas e saídas |
| Guias × Cálculo | Valor da guia = memória de cálculo do Tax Engine |
| ECD × Ledger | Saldos I155 = balancete do Ledger |
| ECF × ECD / ECF anterior | Saldos iniciais e Parte B batem com o exercício anterior |
| LALUR × Contábil | Todo ajuste da Parte A tem lançamento de origem |

Scores por competência e entidade: **Coverage** (o que deveria ter sido processado e foi), **Confidence** (média ponderada das decisões automáticas), **Anomaly** (desvio contra histórico do próprio cliente) e **Materiality** (impacto em R$ e em tributo). Bloqueio só ocorre quando materialidade ou risco legal passam do limite configurado.

### Exception Engine

Exceção é um Case filho com tudo que o humano precisa para decidir em um olhar: valor, data, histórico bancário, correspondências possíveis com score, documentos relacionados, hipóteses, impacto em tributo e demonstrações, recomendação e confiança.

Exemplo do prompt: crédito bancário de R$ 8.430,00 sem documento. O sistema não lança como receita nem como empréstimo. Abre exceção com as hipóteses, notifica o cliente via Relationship pedindo a origem, e **segue o fechamento** dos demais itens. Quando a resposta chega, o lançamento é feito e a conciliação daquele banco fecha sozinha.

Toda decisão humana vira candidata a **regra aprendida** para o mesmo cliente, com aprovação explícita ("sempre que ocorrer, tratar assim").

### Auditoria

- **Log imutável:** tabela `audit_log` apenas com INSERT, cada linha com hash da anterior (cadeia), âncora diária do hash em armazenamento WORM.
- **Campos:** quem (usuário ou agente), modelo de IA e versão, tenant, entidade, estabelecimento, competência, timestamp, ação, input e output (ou referência), regra e versão, confiança, evidências, alteração antes/depois, aprovação humana.
- **Reprodutibilidade:** a partir do log é possível reconstruir por que um valor foi lançado ou calculado.
- **Idempotência:** toda operação crítica (lançamento, guia, transmissão, mensagem, pagamento, evento) exige `idempotency_key` e é rejeitada em duplicidade pelo banco.

## 27. Arquitetura de integração

Toda integração externa é um **conector** atrás de uma interface única (`prepare`, `submit`, `poll`, `fetchReceipt`), chamado só via Authorization Service. Trocar o meio de acesso (API, webservice, automação) não muda o agente.

| Destino | Meio previsto | Maturidade | Observação |
| --- | --- | --- | --- |
| SEFAZ (NF-e, CT-e, distribuição DF-e) | Webservice SOAP com certificado | Alta | Captura automática de notas emitidas contra o CNPJ |
| NFS-e padrão nacional | API REST do ambiente nacional | Média-alta | Municípios não aderentes exigem conector específico |
| eSocial | Webservice com certificado | Alta | Lotes, consulta de retorno, totalizadores |
| EFD-Reinf | Webservice REST com certificado | Alta | Eventos R-1000 a R-4099 |
| SERPRO Integra Contador | API REST (contratada) | Alta | PGDAS-D, DCTFWeb, DEFIS, caixa postal, procurações, parcelamentos, DAS/DARF |
| ECD, ECF, EFD ICMS/IPI, EFD-Contribuições | PVA + ReceitaNet automatizados em VM | Baixa | Ponto de risco; isolado em Validation/Transmission Runner |
| Portais estaduais e municipais sem API | Automação de navegador em VM isolada | Baixa | Por portal, com monitoramento de quebra |
| Bancos | Open Finance, APIs bancárias, OFX/CNAB | Média | Extratos e conciliação; nunca movimentar dinheiro |
| Assinatura eletrônica | Provedor externo (ex.: ICP-Brasil e assinatura avançada) | Alta | Webhook de status alimenta o workflow |
| Canais do cliente | E-mail, WhatsApp Business API, portal, push | Alta | Saída centralizada no Relationship |
| ERPs de outros escritórios | Importação de arquivos e exportações | Média | Só na migração |

### AI Gateway (multiprovider)

- **Interface única** por tarefa (`classify_document`, `extract_fields`, `propose_mapping`, `explain_exception`), não por modelo.
- **Roteamento por política:** complexidade, custo, latência, privacidade do dado e risco. Ex.: extração de holerite com CPF → provedor com acordo de não retenção ou modelo local.
- **Redaction:** dados pessoais desnecessários à tarefa são mascarados antes do envio.
- **Fallback automático** só para tarefas de baixo risco; tarefas de risco alto falham para fila humana em vez de trocar de modelo em silêncio.
- **Avaliação contínua:** conjunto de documentos rotulados por tarefa mede acurácia de cada provedor antes de ser promovido.
- **Custo por CNPJ** medido por tarefa e por provedor (KPI do Manager).

## 28, 29. Testes e observabilidade

Motor contábil e tributário só vai para produção quando reproduz, centavo a centavo, um conjunto de casos reais já validados por contador. Agente de IA só sobe de autonomia quando a métrica de acerto medida em produção sustenta.

### Estratégia de testes

| Tipo | Alvo | Critério |
| --- | --- | --- |
| Unitário de regra | Cada versão de regra tributária, previdenciária e de contabilização | Cobertura 100% das regras; casos de borda (fator R, sublimite, teto INSS) |
| Golden files | Competências reais anonimizadas dos clientes piloto | Resultado idêntico ao fechamento validado; diferença = falha |
| Property-based | Ledger | Débito = crédito em qualquer sequência de operações, estorno anula exatamente |
| Contrato de eventos | Registry de esquemas | Produtor e consumidor compatíveis antes do merge |
| Validação SPED | Arquivos gerados | Zero erro no PVA para a massa de teste |
| Isolamento | RLS e APIs | Teste automático tenta ler dados de outro tenant em todo endpoint |
| Idempotência | Workflows | Reexecução forçada não duplica lançamento, guia ou mensagem |
| Avaliação de IA | Extração e classificação | Precisão e recall por tipo de documento, por provedor |
| Modo sombra | Novas regras e novos agentes | Rodam em paralelo à produção sem efeito; divergências revisadas |
| Caos | Conectores externos | Queda de SEFAZ/eSocial não perde Case; retoma no retorno |

### Observabilidade

- **Tracing distribuído (OpenTelemetry)** com `correlation_id` do Case: do documento recebido até o recibo da obrigação, em uma única linha do tempo.
- **Métricas técnicas:** latência por motor, fila por consumidor, DLQ, falhas por conector externo, custo de IA por tarefa.
- **Métricas de negócio:** os KPIs do One Manager (seção 32) calculados a partir de eventos, não de planilha.
- **Alertas:** conector externo fora, certificado vencendo, obrigação em risco de prazo, DLQ crescendo, queda de confiança média de um agente.
- **Timeline visual:** o mesmo dado alimenta a tela "IA trabalhando" (09:04 One Docs 1.842 documentos ✓ ...), que é leitura dos eventos do Case em tempo real.

## 30. Roadmap

Mantida a ordem das fases do Master Build Spec, com uma mudança: as Fases 0 a 5 são executadas **restritas ao nicho piloto** (Simples Nacional, comércio e serviços) até o primeiro fechamento ponta a ponta. Só depois o escopo abre para Presumido e Real.

&#91;embedded content: roadmap · 13 fases, 3 marcos\]

Cada fase só termina com o critério de saída verificado em dados reais do piloto. Até a Fase 11, a transmissão é assistida: o sistema prepara, valida e entrega o arquivo pronto; o humano transmite e o recibo volta para o Case.

## 31. Riscos

Os três maiores riscos não são de IA: são transmissão sem API oficial, escopo grande demais para a equipe e responsabilidade técnica do contador sobre o que a máquina entrega.

| # | Risco | Impacto | Mitigação |
| --- | --- | --- | --- |
| 1 | ECD/ECF/EFD dependem do PVA desktop, sem API | Alto | Runner isolado em VM atrás de interface; transmissão manual assistida como plano B; acompanhar evolução oficial |
| 2 | Escopo de 29 módulos para equipe pequena | Alto | Fase 1 vertical em um nicho (Simples Nacional, serviços e comércio) até fechar ponta a ponta; resto em pacotes |
| 3 | Responsabilidade técnica e ética do contador (CRC) | Alto | Aprovação humana obrigatória para transmissão e demonstrações até critérios da seção 32; trilha de auditoria completa |
| 4 | Erro de IA em extração vira lançamento errado | Alto | IA nunca grava direto; confiança por campo; validação cruzada; Review independente |
| 5 | Reforma tributária com regras ainda em regulamentação | Médio-alto | Regras temporais, modo sombra, Regulatory Engine com aprovação humana |
| 6 | Vazamento entre escritórios | Crítico | RLS + contexto de aplicação + chave por tenant; teste automático de isolamento |
| 7 | Uso indevido de certificado | Crítico | Chave não exportável, autorização de uso único, log de cada assinatura, alerta ao titular |
| 8 | Portais estaduais e municipais mudam sem aviso | Médio | Monitoramento de quebra, fallback para tarefa humana, priorizar municípios do NFS-e nacional |
| 9 | Custo de IA por CNPJ inviabiliza preço | Médio | Parser determinístico primeiro; modelo pequeno para tarefa simples; cache por layout de cliente |
| 10 | Dependência de provedor de IA | Médio | AI Gateway multiprovider, avaliação contínua, modelo local como reserva |
| 11 | Migração de dados ruins da contabilidade anterior | Médio | Status por saldo, responsabilidade separada por data, nada fecha com contrapartida fictícia |
| 12 | Cliente não envia documentos | Médio | Pending Engine, solicitação consolidada, captura automática (SEFAZ, bancos) reduz dependência |
| 13 | LGPD sobre dados de empregados e sócios | Médio | Inventário, minimização, redaction no AI Gateway, retenção configurada |

## 32. Critérios objetivos de autonomia

Autonomia é concedida por par **agente × tipo de tarefa × cliente**, com base em histórico medido, e retirada automaticamente quando a qualidade cai. Os números abaixo são propostas iniciais para calibrar.

### Faixas de confiança por decisão

| Faixa | Condição | Ação |
| --- | --- | --- |
| HIGH | confiança ≥ 0,95 e regra determinística aplicada | Executa automaticamente, quando legalmente permitido |
| MEDIUM | 0,80 a 0,95 | Segunda validação (regra ou outro modelo); se confirmar, executa |
| LOW | < 0,80 ou sem evidência | Exceção com hipóteses |
| CRITICAL / LEGAL | Transmissão, demonstração assinada, reabertura de período, cláusula contratual | Aprovação humana obrigatória até promoção explícita |

### Promoção de nível (L1 → L2 → L3 → L4)

| De → Para | Exige |
| --- | --- |
| L1 → L2 | 3 competências seguidas com aprovação humana sem alteração em ≥ 98% das propostas |
| L2 → L3 | 6 competências com Review sem bloqueio e zero divergência material |
| L3 → L4 (transmissão) | 12 meses sem retificação causada pelo sistema; aprovação formal do contador responsável |
| Rebaixamento automático | Qualquer retificação causada pelo sistema, divergência material no Review ou queda de acerto abaixo do limite |

### KPIs do One Manager

Auto Processing Rate · Auto Reconciliation Rate · Exception Rate · First Pass Validation Rate · Closing Lead Time · **Human Touches per Client** (meta principal, em queda contínua) · Obligation On-Time Rate · Cost per CNPJ · AI Cost per CNPJ · Hours Saved.

### Critério final aplicado: fechamento contábil mensal

| Pergunta | Resposta |
| --- | --- |
| 1. Quem inicia? | Timer do Deadline Engine no 1º dia útil |
| 2. Qual Case? | `ACCOUNTING_CLOSING` com subcases por departamento e por banco |
| 3. Qual agente assume? | One Orchestrator, depois One Ledger como dono |
| 4. Quais dados? | Documentos fiscais, extratos, folha, cadastro vigente, regras de contabilização |
| 5. Onde obtém? | Captura SEFAZ/DF-e, bancos, Payroll Engine, portal do cliente |
| 6. Qual motor determinístico? | Fiscal, Reconciliation, Payroll, Accounting, Tax |
| 7. Qual evento emite? | `ACCOUNTING_CLOSING_COMPLETED` |
| 8. Quem recebe depois? | One Review, depois One Tax, One Obligations, One Relationship |
| 9. Qual evidência? | Documentos originais, matches de conciliação, memórias de cálculo, scores do Review |
| 10. Humano precisa participar? | Só nas exceções abertas e, até L3, na aprovação das demonstrações |
| 11. Por quê? | Falta de evidência para itens específicos e responsabilidade técnica sobre demonstrações |
| 12. Retoma sozinho após decisão? | Sim: `HUMAN_DECISION_RECORDED` sinaliza o workflow |
| 13. Condição de encerramento? | Review aprovado, período bloqueado, pacote entregue ao cliente e Case da próxima competência aberto |

## Decisões para aprovação

Estas decisões travam o início da Fase 0. As demais podem ser ajustadas durante a construção.

- [x] **Stack:** TypeScript + PostgreSQL + Temporal + NATS, ou manter Supabase como plataforma principal (mais rápido no início, mais limitado para workflows longos e isolamento por tenant).
- [x] **Nicho da Fase 1 vertical:** Simples Nacional, comércio e serviços. Define só a ordem de entrega e de teste; o modelo de dados, o Tax Engine e o Obligation Engine nascem multirregime desde a Fase 0.
- [x] **Clientes piloto:** SABORES D'ALMA LTDA (comércio com produção própria, ST, monofásico, folha) e SAFE ON SERVICOS LTDA (serviços com fator R, início de atividade). Ambas com procuração e-CAC ativa.
- [x] **SERPRO Integra Contador:** já contratado. O conector entra na Fase 1 (PGDAS-D, DCTFWeb, caixa postal, procurações), com as credenciais no Vault.
- [x] **Hospedagem:** AWS São Paulo (sa-east-1), padrão adotado por LGPD e latência com órgãos.
- [x] **Responsável técnico:** o dono da Contabilidade Legacy aprova releases de regras normativas e promoções para L4.
- [x] **Thresholds iniciais** da seção 32: valores propostos (95% e 80%), revisão após 2 a 3 competências reais.
