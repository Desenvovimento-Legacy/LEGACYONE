# IARIS — Decisões do dono do produto

Decisões tomadas por Luan Sanchez (responsável técnico) ao longo da construção, até 19/10/2026.
Valem como regra até ele mudar. Em caso de dúvida, pergunte a ele antes de contrariar uma delas.

## Produto e arquitetura

- O nome definitivo é **IARIS** (Inteligência Artificial para Resultados, Integração e Soluções). "Legacy One", "AIRES" e "IARES" são nomes antigos. Agentes sem o prefixo "One".
- Projeto totalmente novo, sem vínculo com Domínio, Questor ou outros sistemas anteriores do escritório.
- Stack própria: TypeScript + PostgreSQL (Temporal e NATS previstos). Banco de produção no Supabase (plano gratuito, São Paulo) para começar.
- O IARIS não pode depender da máquina local: o destino é a nuvem. Hoje roda no PC do escritório por etapa.
- Tudo do IARIS no PC fica em `C:\IARIS`, sem pastas soltas no `C:`.
- Endereço fixo com domínio próprio fica para depois (domínios "iaris" já têm dono; pode mudar o nome do produto).

## Acesso e segurança

- Login próprio com senha + autenticador; usuários e perfis administrados por painel dentro do IARIS.
- Entra só quem o Luan convidar pelo link.
- Certificados A1 dos clientes ficam no cofre local do PC (nuvem depois). O escritório usa e-CNPJ A1.
- Responsáveis técnicos: contabilidade@grouplegacy.com.br e marcio.odor@grouplegacy.com.br.

## Receita Federal (SERPRO Integra Contador — contratado, cobrado por consulta)

- Depois da carga inicial, só consulta mensal por competência, disparada pelo botão "Buscar". Nunca consultar ao abrir a tela.
- Teto de 20 consultas cobradas por dia.
- Autorizado sozinho: PagtoWeb 1 vez por empresa ~5 dias após cada vencimento com guia em aberto.
- PGDAS-D e declarações: deixar prontas para transmitir; **não transmitir** por enquanto.

## Documentos fiscais

- O IARIS deve buscar sozinho XML de NF-e, NFS-e e CT-e, com o máximo de integração automática, e servir como coletor de XML.
- Busca automática no início e no fim do dia; no meio do dia só quando alguém pedir.
- Nos pilotos, a IARIS é a única coletora de NF-e (nenhum outro sistema busca com o certificado).
- O escritório **não** dá ciência da operação nas NF-e (quem dá é o cliente) e **não** emite nota para o cliente.
- SAFE ON acessa a prefeitura via gov.br (sem procuração municipal).

## Fiscal, contábil e tributos

- Fiscal começou pelas empresas do Simples Nacional de serviços; comércio e indústria depois.
- A contabilidade se monta sozinha conforme os agentes trabalham; extrato aceito em PDF, OFX ou Excel, mesmo sem Open Finance; testes acompanham o comportamento.
- Regras de classificação do extrato (preferir regra automática à fila humana):
  - o que for do sócio vai em Adiantamento aos Sócios;
  - pessoa/MEI/PJ com conta própria no plano vai nessa conta;
  - pagamento maior que a nota: a diferença vai em juros e multas;
  - entrada mínima sem documento (PIX de teste) vai em Outras Receitas.
- O escritório gera e envia ao cliente o DAS e os DARF das retenções (IRRF e PIS/COFINS/CSLL das notas tomadas).
- Tributos: fechar Lucro Presumido e Lucro Real (feito; regras aguardam aprovação).
- Regime tributário: o IARIS busca sozinho (não pedir ao Luan o que dá para buscar).
- Centros de custo: deixados de lado por ora.

## Clientes

- Pilotos (todos os serviços contratados): SABORES D'ALMA (01.210.421/0001-00) e SAFE ON SERVICOS (60.611.420/0001-36).
- Incluídos depois: FURKINUX DO BRASIL (11.185.167/0001-90), FURK TECH (51.969.246/0001-07) e ARES SOLUÇÕES EM TECNOLOGIA (14.790.599/0001-19), que vieram para o escritório na base 08/2026 (antes é período do escritório anterior).

## Ordem de construção

- Entrega ao cliente (e-mail/portal) fica por último.
- Contas a pagar/receber: pausado em 19/10/2026; retomar quando o Luan pedir.
- Não usar o pacote de 57 agentes (`C:\agentes`).
- Forma de trabalho: quando houver sugestão técnica, seguir a própria sugestão; chamar o Luan só quando a decisão for dele.
