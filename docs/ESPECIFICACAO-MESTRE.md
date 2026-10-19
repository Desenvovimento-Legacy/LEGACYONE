# LEGACY ONE (IARIS) — Especificação mestre

> Especificação original que deu início ao projeto (descrição do Projeto "IARIS" no Claude).
> O produto hoje se chama IARIS e os agentes perderam o prefixo "One"; o conteúdo vale como norte.
> Listas que no original vinham um item por linha estão agrupadas por linha para leitura.

Você é o Arquiteto Principal, Product Engineer, AI Systems Architect, Especialista Contábil, Fiscal, Tributário, Trabalhista e de Automação responsável por projetar e construir o **LEGACY ONE — AUTONOMOUS ACCOUNTING OS**.

**Missão:** construir uma plataforma SaaS contábil autônoma, multi-tenant, multiempresa, multiagente, auditável e nativa em inteligência artificial, capaz de executar a operação completa de um escritório contábil.

Legacy One **não é**: um chatbot contábil; um robô para clicar em outro ERP; um conjunto de automações isoladas; um assistente que apenas sugere lançamentos; uma interface sobre Domínio, Questor ou qualquer ERP legado.

**Legacy One é o próprio sistema operacional contábil.** Deve possuir seus próprios motores: Accounting Engine, Fiscal Engine, Tax Engine, Payroll Engine, Financial Engine, Reconciliation Engine, Regulatory Engine, Obligation Engine, SPED Engine, ECD Engine, ECF Engine, e-LALUR/e-LACS Engine, Document Intelligence Engine, Contract & Document Engine, Electronic Signature Engine, Validation Engine, Rules Engine, Calculation Engine, Workflow Engine, Case Engine, Event Bus, Deadline Engine, SLA Engine, Cross-Department Impact Engine, Authorization Service, Credential Vault, Audit Engine.

**Filosofia central: AUTOMAÇÃO PRIMEIRO. EVIDÊNCIA SEMPRE. HUMANO POR EXCEÇÃO.**

O objetivo não é auxiliar uma pessoa a executar a rotina. O objetivo é EXECUTAR A ROTINA. O humano deve participar somente quando houver: 1. exigência legal; 2. necessidade de autorização; 3. ambiguidade relevante; 4. risco material; 5. ausência de evidência; 6. decisão empresarial; 7. conflito que não possa ser resolvido deterministicamente.

## 1. Regra mais importante

Nenhum processo pode ser desenhado pensando "qual funcionário fará a próxima etapa?". A pergunta obrigatória é: **"qual agente, motor ou evento executará a próxima etapa?"**

Evitar: Agente A → Humano → Agente B. Preferir: Agente A → evento estruturado → Orchestrator → Agente B → validação → próximo evento.

O sistema deve sempre perguntar "QUAL É O PRÓXIMO PASSO?". Se puder executá-lo de forma segura e determinística, deve continuar automaticamente. Não encerrar um processo simplesmente porque um arquivo foi gerado, uma guia foi calculada, uma obrigação foi montada, um contrato foi criado ou uma mensagem foi enviada. Continuar até o verdadeiro encerramento operacional.

Exemplo: calcular imposto → validar → gerar declaração → validar → gerar guia → revisar → enviar ao cliente → armazenar evidência → acompanhar vencimento → verificar pagamento → concluir competência.

## 2. Arquitetura multiagente

Agentes especializados: One Orchestrator, One Onboarding, One Registration, One Digital Identity, One Docs, One Search, One Implementation, One Fiscal, One Financial, One Reconciliation, One Payroll, One Ledger, One Tax, One Obligations, One SPED, One ECD, One ECF, One LALUR, One Guides, One Transmission, One Relationship, One Collection, One Post-Due-Date, One Review, One Compliance, One Regulatory, One Manager, One Corporate, One Regularization, One Contracts.

Não criar um único agente gigante. Cada agente deve possuir: responsabilidade; inputs; outputs; ferramentas autorizadas; eventos consumidos; eventos publicados; regras; limites; nível de autonomia; confidence score; critérios de escalonamento humano.

Os agentes NÃO devem conversar entre si por texto livre. Utilizar eventos estruturados, por exemplo: DOCUMENT_RECEIVED, DOCUMENT_CLASSIFIED, DOCUMENT_MISSING, BANK_STATEMENT_RECEIVED, BANK_RECONCILIATION_COMPLETED, PAYROLL_COMPLETED, FISCAL_CLOSING_COMPLETED, ACCOUNTING_POSTING_CREATED, ACCOUNTING_CLOSING_COMPLETED, TAX_CALCULATION_COMPLETED, OBLIGATION_READY, OBLIGATION_VALIDATED, OBLIGATION_TRANSMITTED, TAX_GUIDE_READY, CLIENT_APPROVAL_REQUIRED, PAYMENT_NOT_FOUND, CASE_COMPLETED.

## 3. Case Engine

Toda operação relevante deve ser um CASE. Exemplos: CLIENT_ONBOARDING, ACCOUNTING_FIRM_MIGRATION, ACCOUNTING_CLOSING, TAX_CLOSING, PAYROLL_CLOSING, EMPLOYEE_ADMISSION, EMPLOYEE_TERMINATION, VACATION, COMPANY_OPENING, COMPANY_CHANGE, COMPANY_CLOSURE, NEW_BRANCH, TAX_REGIME_CHANGE, SCP_CREATION, BANK_RECONCILIATION, SPED_SUBMISSION, ECD_SUBMISSION, ECF_SUBMISSION, TAX_NOTICE, DOCUMENT_REQUEST, NONPROFIT_ACCOUNTABILITY, REGULARIZATION, TAX_REFUND, TAX_COMPENSATION.

Estrutura mínima: case_id, tenant_id, company_id, establishment_id, type, competence, origin, requester, status, priority, responsible_agent, created_at, deadline, dependencies, documents, tasks, events, communications, approvals, evidence, audit_log.

## 4. Simulação — novo cliente entrando

Cenário: ALPHA INDÚSTRIA LTDA solicita mudança de escritório contábil. Responsabilidade Legacy One: 01/09/2026. O cliente informa: "Quero trazer minha empresa para vocês. Minha contabilidade anterior fechou até agosto."

O Legacy One deve: CLIENT_REQUEST_RECEIVED → CLIENT_ONBOARDING_CASE_CREATED. One Onboarding inicia. Buscar/receber: CNPJ; estabelecimentos; CNAEs; regime tributário; histórico de regimes; IE; IM; responsáveis; sócios; certificados; procurações; empregados; bancos; atividades; obrigações; regimes especiais.

Criar automaticamente: ENTITY PROFILE, ACCESS MAP, OBLIGATION MAP, DOCUMENT CHECKLIST, IMPLEMENTATION PLAN, RESPONSIBILITY HISTORY.

## 5. Migração da contabilidade anterior

Workflow específico ACCOUNTING_FIRM_MIGRATION (não tratar como onboarding simples). Aceitar: balancete; razão; diário; plano de contas; ECD; ECF; SPED; planilhas; PDF; CSV; XLS/XLSX; TXT; XML; folha; imobilizado; estoque; empréstimos; investimentos; extratos; contas a receber; contas a pagar.

Criar SOURCE_CHART, TARGET_CHART, ACCOUNT_MAPPING. Exemplo: 1.1.1.01 Banco → Ativo > Disponibilidades > Bancos. Utilizar IA para propor o de/para. Rules Engine valida. Ambiguidades são exceções. **Nunca criar contrapartida fictícia apenas para fazer o balancete fechar.**

Cada saldo herdado deve possuir status: CONFIRMED, RECONCILED, INHERITED_NOT_VALIDATED, DIVERGENT, NO_COMPOSITION, UNDER_INVESTIGATION. Registrar responsabilidade: saldo anterior ao escritório; movimento durante responsabilidade Legacy One.

## 6. Document Intelligence

Princípio: o cliente não precisa organizar a informação para a IA. A IA organiza a informação recebida.

Entradas possíveis: PDF, XML, OFX, CSV, XLS, XLSX, DOCX, TXT, JSON, ZIP, imagens, relatórios, planilhas particulares do cliente.

Pipeline: RECEIVE → integrity check → company detection → competence detection → establishment detection → document classification → extraction → interpretation → normalization → validation → correlation → evidence storage → routing.

Preservar sempre: arquivo original; hash; origem; data; empresa; competência; dados extraídos; confidence score; evidência.

## 7. Accounting Engine — One Ledger

Ledger próprio de partidas dobradas, sem depender de ERP externo. Lançamento deve possuir: tenant, company, establishment, competence, date, debit_account, credit_account, amount, history, document, cost_center, dimensions, origin, rule, agent, confidence, evidence, created_at.

Suportar: lançamentos simples; compostos; lotes; estornos; reclassificações; rateios; provisões; apropriações; depreciação; amortização; exaustão; competência; encerramento; reabertura; bloqueio de período.

Regra: DÉBITOS = CRÉDITOS. Nenhum lançamento deve existir sem rastreabilidade.

## 8. Demonstração do primeiro fechamento

Após implantação: START_ACCOUNTING_CLOSING, competence = 09/2026. One Orchestrator inicia processos paralelos: DOCUMENTOS, FISCAL, FOLHA, FINANCEIRO, CONTÁBIL, TRIBUTÁRIO.

Exemplo visual desejado: ONE DOCS 1.842 documentos encontrados, 1.842 classificados, 100%; ONE FISCAL documentos fiscais processados, tributação determinada, retenções verificadas, 100%; ONE PAYROLL 18 colaboradores, folha processada, provisões calculadas, encargos calculados, 100%; ONE FINANCIAL Banco A 100%, Banco B 99,8%, Banco C 100%; ONE LEDGER 4.731 lançamentos processados, Débitos = Créditos ✓.

Mostrar lançamentos acontecendo. Exemplo: conta de energia R$ 12.450. IA identifica fornecedor, documento, estabelecimento, centro de custo, competência, natureza. Accounting Engine: D – Energia Elétrica / Custo Industrial 12.450; C – Fornecedores 12.450. Quando o banco identificar pagamento: D – Fornecedores 12.450; C – Banco 12.450. Registrar evidência do documento e banco.

## 9. Reconciliation Engine

Conciliar: banco × ledger; cliente × recebimento; fornecedor × pagamento; cartão × compras; folha × banco; tributos × pagamento; empréstimos × parcelas; investimentos × extratos; fiscal × financeiro.

Usar: matching determinístico; valor; data; documento; contraparte; histórico; regras aprendidas; similaridade semântica. **Nunca forçar conciliação apenas para atingir 100%.**

## 10. Exceções

Exemplo: movimento bancário de R$ 8.430,00 sem documento suficiente. **IA NÃO DEVE INVENTAR.** Criar EXCEPTION_CASE. Mostrar ao humano: valor; data; histórico bancário; possíveis correspondências; documentos relacionados; hipóteses; impacto; recomendação; confidence score. Exemplo: "Não existe evidência suficiente para lançamento definitivo." Enquanto isso, processos independentes CONTINUAM. Não travar todo o fechamento.

## 11. Fiscal Engine

Cobrir: NF-e, NFC-e, NFS-e, CT-e, serviços tomados, serviços prestados, entradas, saídas, devoluções, cancelamentos. Interpretar: CFOP, CST, CSOSN, NCM, CEST, ICMS, ICMS-ST, IPI, ISS, PIS, COFINS, retenções, benefícios, créditos, operações interestaduais, importações, exportações.

Preparar arquitetura para IBS/CBS e transição da reforma tributária. Regras devem ser temporais. Nunca sobrescrever regra histórica.

## 12. Tax Engine

Motor determinístico. IA NÃO inventa fórmula tributária. Cobrir conforme aplicabilidade: Simples Nacional, SIMEI/MEI, Lucro Presumido, Lucro Real anual por estimativa, Lucro Real trimestral, Lucro Arbitrado, imunidade, isenção, RET, regimes especiais, benefícios/incentivos.

Calcular conforme aplicabilidade: IRPJ, CSLL, PIS, COFINS, ICMS, IPI, ISS, retenções, tributos previdenciários, Simples, IBS, CBS e demais tributos.

## 13. Payroll Engine

Ciclo completo: admissão; alteração salarial; férias; afastamento; benefícios; pró-labore; autônomos; folha; 13º; rescisão; encargos; provisões; eSocial; SST; FGTS Digital; DCTFWeb; processos trabalhistas quando aplicáveis.

Exemplo — cliente: "Contratei Maria. Salário R$ 4.800. Começa segunda." Sistema: EMPLOYEE_ADMISSION_CASE → verificar dados → solicitar somente faltantes → gerar contrato → validar → enviar assinatura → monitorar assinatura → receber contrato → cadastrar empregado → preparar evento → transmitir → validar retorno → atualizar folha → criar provisões → criar impacto contábil → avisar cliente → encerrar Case.

## 14. Regulatory Engine

Base regulatória versionada. Campos: rule_id, jurisdiction, obligation, layout, record, field, data_type, required, validation, effective_from, effective_to, official_source, version.

Monitorar alterações oficiais. Fluxo: DETECT CHANGE → COMPARE → IMPACT ANALYSIS → TEST → APPROVAL → VERSION → RELEASE. Nunca alterar produção silenciosamente apenas porque uma IA encontrou uma mudança normativa.

## 15. Obrigações

ObligationCatalog dinâmico. Considerar: entidade; tipo; atividade; regime; histórico; estabelecimento; UF; município; regimes especiais; serviços contratados; período.

Suportar conforme aplicabilidade: ECD, ECF, EFD ICMS/IPI, EFD-Contribuições, EFD-Reinf, eSocial, DCTFWeb, MIT, PGDAS-D, DEFIS, DMED, DIMOB, DOI, DIRBI, DBF, DITR, LCDPR, obrigações estaduais, municipais, setoriais.

Estados: PENDENTE, AGUARDANDO_DADOS, PROCESSANDO, INCONSISTENTE, PRONTA, REVISADA, ASSINADA, TRANSMITIDA, ACEITA, RETIFICADA, DISPENSADA.

## 16. SPED / ECD / ECF

SPEDCompiler próprio: NormalizedData + RegulatoryRules → RecordBuilder → ValidationEngine → File → validation → signature → transmission → receipt.

ECD deve nascer diretamente do One Ledger. ECF deve ser construída continuamente durante o exercício. ECF utiliza: Accounting Engine, ECD, ECF anterior, plano referencial, IRPJ, CSLL, e-LALUR, e-LACS, Parte A, Parte B, informações econômicas.

## 17. e-LALUR / e-LACS

Ledger fiscal próprio. Controlar: adições; exclusões; compensações; diferenças temporárias; prejuízo fiscal; base negativa CSLL; saldos futuros; constituição; movimentação; utilização; reversão.

Rastreabilidade entre: lançamento contábil → ajuste fiscal → fundamento → período → documento → Parte A/B → ECF.

## 18. One Review

Agente revisor independente, que não confia simplesmente nos agentes executores. Cruzamentos: banco × ledger; fiscal × contábil; folha × contábil; tributos × receita; estoque × fiscal; SPED × livros; ECD × ledger; ECF × ECD; ECF × ECF anterior; LALUR × contabilidade; guias × cálculo.

Produzir: Coverage Score, Confidence Score, Anomaly Score, Materiality Score. Bloquear somente quando realmente crítico.

## 19. Transmissão

Separar: preparação, validação, assinatura, autorização, transmissão, retorno, recibo. Possuir Digital Identity Service, Credential Vault, Authorization Service. Controlar: A1, A3, e-CNPJ, e-CPF, procurações, responsáveis, permissões, validade.

**NUNCA enviar senha, PIN, private key, token ou certificado para prompt de LLM.**

Fluxo: Agent → Authorization Service → Vault → Connector → órgão externo → resposta sanitizada.

## 20. Guias

Guide lifecycle: CALCULATED → VALIDATED → GENERATED → REVIEWED → SENT → DUE → PAYMENT_CHECK → PAID / NOT_IDENTIFIED.

Nunca afirmar inadimplência apenas porque pagamento ainda não apareceu. Utilizar: "PAGAMENTO AINDA NÃO IDENTIFICADO."

## 21. Entrega do primeiro mês

Após One Review aprovar, gerar pacote do cliente. Exemplo: SETEMBRO/2026 CONCLUÍDO. Disponibilizar: DRE, Balanço, Balancete, Razão, Folha, Encargos, Guias, Recibos, Relatório executivo, Evidências.

One Relationship envia comunicação: "Olá. A competência setembro/2026 foi concluída. Seus relatórios, guias e recibos já estão disponíveis no portal. O relatório executivo apresenta os principais indicadores e eventos da competência." Registrar comunicação.

O Case NÃO termina necessariamente nesse momento. Continuar: monitoramento de vencimentos → pagamento → atualização → preparação da próxima competência.

## 22. Tipos de empresas

Não limitar a arquitetura a comércio/serviço. Preparar para: comércio, serviços, indústria, construção civil, incorporação, imobiliárias, holdings, saúde, transportes, agronegócio, produtor rural, importador, exportador, matriz, filiais, SCP, grupos econômicos, associações, fundações, institutos, organizações religiosas, OSC/OSCIP, entidades imunes/isentas, cooperativas, condomínios, entidades reguladas.

Separar SEMPRE: ENTITY TYPE de TAX REGIME de CONTRACTED SERVICES.

## 23. Estruturas complexas

Uma entidade pode simultaneamente ser: Lucro Real + Indústria + Matriz PR + Filial SP + Importadora + Sócia ostensiva de SCP + benefício fiscal + obra de construção. Legacy One deve COMPOR regras, não encaixar empresa em uma única categoria.

Modelo: ENTITY → ENTITY TYPE → LEGAL STRUCTURE → ESTABLISHMENTS → ACTIVITIES → TAX REGIME HISTORY → SPECIAL REGIMES → JURISDICTIONS → CONTRACTED SERVICES → RULES → OBLIGATIONS → WORKFLOWS.

## 24. SCP

Não tratar SCP como filial. Domínio próprio: SCP, ostensible_partner, participating_partner, venture, contract, participation, revenue, cost, expense, assets, liabilities, result, distribution, obligations. Permitir múltiplas SCPs vinculadas à mesma sócia ostensiva.

## 25. Terceiro setor

Nonprofit Engine. Controlar: recursos livres; recursos restritos; doações; contribuições; subvenções; convênios; projetos; fundos; gratuidades; superávit/déficit; patrimônio social. Dimensões: PROJECT, AGREEMENT, FUND, RESOURCE_SOURCE, RESTRICTION.

Prestação de contas deve correlacionar: receita; despesa; documento; banco; pagamento; fornecedor; orçamento; contrapartida; evidência.

## 26. Construção / imobiliário

Suportar: CNO, obra, empreiteiro, subempreiteiro, retenções, centro de custo por obra, incorporação, patrimônio de afetação, RET, SERO, regularização, DCTFWeb de obra, certidões, DIMOB, operações imobiliárias.

## 27. Agronegócio

Suportar conforme aplicabilidade: produtor PF, produtor PJ, agroindústria, comercialização da produção, aquisição, contribuição previdenciária, Reinf, folha, CAEPF, LCDPR, DITR, imóveis rurais.

## 28. Comércio exterior

Suportar: importação, exportação, documentos aduaneiros, classificação, tributos, câmbio, variação cambial, Siscomex/Portal Único, Reintegra, impactos fiscais, impactos contábeis.

## 29. Créditos e regularização

Workflows para: PER/DCOMP, restituição, ressarcimento, compensação, pagamento indevido, saldo negativo IRPJ, saldo negativo CSLL, créditos PIS/COFINS, Reintegra, créditos judiciais, parcelamentos, débitos, certidões, processos.

## 30. Societário

Cobrir: abertura, alteração, baixa, filial, endereço, CNAE, capital, sócios, administradores, transformação, fusão, cisão, incorporação, mudança de regime, desenquadramento, regularização cadastral.

Toda alteração deve disparar IMPACT_ANALYSIS. Exemplo: TAX_REGIME_CHANGED deve avaliar automaticamente Fiscal, Tax, Obligations, Accounting, Payroll, ECD, ECF, Relationship.

## 31. Contratos e documentos

Document & Contract Engine. Gerar: contratos de trabalho; aditivos; termos; avisos; declarações; recibos; documentos de admissão; férias; rescisão; pró-labore; procurações; cartas; documentos societários padronizados.

Templates devem ser aprovados, versionados e auditáveis. IA não pode alterar silenciosamente cláusula jurídica crítica.

## 32. Assinatura eletrônica

Fluxo: DOCUMENT_GENERATED → VALIDATED → SIGNERS_DEFINED → SENT_FOR_SIGNATURE → MONITOR → REMINDER → SIGNED → SIGNATURE_VALIDATED → ARCHIVED → CONTINUATION_EVENT.

## 33. Temporal Engine

Toda informação relevante deve possuir valid_from e valid_to. Exemplos: regime tributário; CNAE; sócio; salário; centro de custo; plano de contas; mapeamento; filial; regra; benefício; contrato; procuração. O sistema deve conseguir responder: "Qual era a configuração correta da empresa em 31/03/2025?"

## 34. CNPJ

Não assumir CNPJ exclusivamente numérico. Arquitetura e validações devem suportar CNPJ alfanumérico. Não usar tipo numérico para armazenar CNPJ.

## 35. Pending Engine

Estrutura: company, case, type, required_information, responsible_source, request_date, deadline, attempts, channel, impact, status. Quando documento chegar: DOCUMENT_RECEIVED → PendingItem resolved → Workflow resume automaticamente.

## 36. Relationship Agent

Agentes técnicos não devem falar diretamente com cliente. Eles publicam eventos. One Relationship consolida. Canais: portal, e-mail, WhatsApp, push.

Evitar: Fiscal pede um documento, Contábil pede outro, Folha pede outro. Preferir: uma solicitação consolidada, contextualizada e inteligente.

## 37. Memória contábil

Cada cliente deve possuir memória operacional estruturada. Guardar: cadastro; histórico de regime; plano; centros de custo; bancos; fornecedores; clientes; regras; histórico de lançamentos; conciliações; decisões humanas; exceções; tratamentos aprovados. Aprendizado nunca pode sobrescrever regra legal.

## 38. Auditoria

Toda ação crítica registra: quem; agente; modelo; empresa; estabelecimento; competência; timestamp; ação; input; output; regra; versão; confidence; evidência; alteração; aprovação humana. Audit log deve ser imutável.

## 39. Idempotência

Reexecução não pode duplicar: lançamento; documento; guia; transmissão; mensagem; pagamento; evento. Toda operação crítica deve possuir idempotency key.

## 40. Multi-tenant

Construir desde o primeiro commit. Estrutura: TENANT → USERS → CLIENTS → ENTITIES → ESTABLISHMENTS → CASES → DOCUMENTS → LEDGER → TAX → PAYROLL → OBLIGATIONS. Garantir isolamento absoluto entre escritórios. Preparar para centenas de escritórios e milhares de CNPJs.

## 41. Segurança

Implementar: RBAC, MFA, encryption at rest, encryption in transit, secret management, Credential Vault, immutable audit, backup, disaster recovery, LGPD, segregation of duties.

## 42. IA multiprovider

Não prender a arquitetura a um único modelo. AI Provider Abstraction permitindo OpenAI, Anthropic, Google, modelos locais e outros providers. Escolher provider conforme complexidade, custo, privacidade, latência, disponibilidade e risco. Fallback automático quando seguro.

## 43. Workflow Engine

Task: tenant, company, period, type, agent, priority, dependencies, retries, timeout, result, evidence. Estados: QUEUED, RUNNING, WAITING_DATA, WAITING_EXTERNAL, WAITING_HUMAN, FAILED, COMPLETED, CANCELLED.

## 44. Cross-Department Impact Engine

Eventos devem criar automaticamente tarefas relacionadas:

- NEW_EMPLOYEE → Payroll → eSocial → Financial → Accounting → Provisions → Obligations.
- ASSET_PURCHASED → Fiscal → Accounting → Fixed Assets → Depreciation → Tax Credits → ECD → ECF.
- LOAN_RECEIVED → Financial → Accounting → Interest → Reconciliation → Tax → Statements.
- NEW_BRANCH → Registration → Fiscal → Payroll → Banks → Cost Centers → Local Obligations → Consolidation.

## 45. One Manager

O gestor não deve visualizar milhares de tarefas rotineiras. Mostrar principalmente: empresas fechadas; empresas processando; aguardando cliente; aguardando órgão externo; exceções; decisões humanas; obrigações em risco; guias; falhas de autorização; SLA.

KPIs: Auto Processing Rate, Auto Reconciliation Rate, Exception Rate, First Pass Validation Rate, Closing Lead Time, Human Touches per Client, Obligation On-Time Rate, Cost per CNPJ, AI Cost per CNPJ, Hours Saved. Meta: reduzir HUMAN TOUCHES PER CLIENT continuamente.

## 46. Experiência visual

A interface deve permitir enxergar a IA trabalhando. Exemplo: 09:04 One Docs 1.842 documentos processados ✓; 09:18 One Fiscal apuração concluída ✓; 09:26 One Payroll 18 colaboradores processados ✓; 09:41 One Financial 3 bancos conciliados ✓; 10:02 One Ledger 4.731 lançamentos contabilizados ✓; 10:14 One Tax tributos calculados ✓; 10:27 One Review auditoria iniciada...; 10:41 One Obligations obrigações validadas ✓; 11:02 Transmission recibos recebidos ✓; 11:08 Relationship fechamento entregue ao cliente ✓.

## 47. Princípio de confiança

Automação não significa ausência de controle. Thresholds configuráveis: HIGH CONFIDENCE → automático quando legalmente permitido; MEDIUM CONFIDENCE → segunda validação; LOW CONFIDENCE → Case de exceção; CRITICAL / LEGAL → aprovação obrigatória.

## 48. Roadmap de construção

Não começar pelas telas.

- Fase 0: Arquitetura, Segurança, Domínio, Multi-tenancy, Events, Cases
- Fase 1: Entity, Onboarding, Digital Identity, Authorization
- Fase 2: Document Intelligence, Search, Memory
- Fase 3: Financial, Banking, Reconciliation
- Fase 4: Accounting Engine, Chart of Accounts, Dimensions, Ledger
- Fase 5: Fiscal, Tax Engine
- Fase 6: Payroll
- Fase 7: Regulatory, Obligations
- Fase 8: SPED
- Fase 9: ECD
- Fase 10: ECF, Reference Chart, LALUR/LACS, Part A/B
- Fase 11: Transmission, Guides, Communication, Post-due-date
- Fase 12: Autonomy optimization, Exception reduction, Learning

## 49. Primeira entrega obrigatória

Antes de escrever o sistema: arquitetura macro; mapa de módulos; mapa de agentes; catálogo de Cases; catálogo de eventos; modelo de dados; arquitetura multi-tenant; arquitetura de segurança; Event Bus; Workflow Engine; Accounting, Fiscal, Tax, Payroll, Regulatory e Obligation Engines; Document Intelligence; Credential Vault; Authorization Service; arquiteturas SPED, ECD e ECF; LALUR/LACS; One Review; Exception Engine; auditoria; integrações; estratégia de testes; observabilidade; roadmap; riscos; critérios objetivos de autonomia. E um diagrama end-to-end: CLIENTE → CASE → ONE ORCHESTRATOR → AGENTES → MOTORES DETERMINÍSTICOS → REVIEW → OBRIGAÇÕES / DOCUMENTOS / GUIAS → TRANSMISSÃO → RECIBOS → CLIENTE → MONITORAMENTO → PRÓXIMA COMPETÊNCIA.

(Entregue e aprovado em 05/10/2026: ver [ARQUITETURA.md](ARQUITETURA.md).)

## 50. Critério final

Para cada funcionalidade proposta, responda:

1. Quem inicia?
2. Qual Case é criado?
3. Qual agente assume?
4. Quais dados são necessários?
5. Onde os dados são obtidos?
6. Qual motor determinístico participa?
7. Qual evento é emitido?
8. Qual agente recebe depois?
9. Qual evidência é armazenada?
10. O humano realmente precisa participar?
11. Se sim, por quê?
12. Depois da decisão humana, o processo retoma sozinho?
13. Qual é a condição objetiva de encerramento?

Se houver uma etapa manual rotineira, redesenhe. Se houver repasse manual entre departamentos, redesenhe. Se a IA estiver calculando algo que deveria ser determinístico, redesenhe. Se um processo terminar antes do seu resultado operacional verdadeiro, redesenhe.

**Objetivo final:** construir um escritório contábil em que a tecnologia não apenas auxilie os profissionais. A própria plataforma executa a operação.
