import { normalize } from "../../../shared/text.js";

/**
 * Atividades do PGDAS-D (tabela de domínio "idAtividade" do serviço
 * TRANSDECLARACAO11 do Integra Contador). As descrições são as mesmas que saem
 * no PDF da declaração: é por elas que a IARIS sabe o id de cada atividade
 * já declarada pela empresa.
 */
export const PGDAS_ACTIVITIES: Record<number, string> = {
  1: "Revenda de mercadorias, exceto para o exterior - Sem substituição tributária/tributação monofásica/antecipação com encerramento de tributação (o substituto tributário do ICMS deve utilizar essa opção)",
  2: "Revenda de mercadorias, exceto para o exterior - Com substituição tributária/tributação monofásica/antecipação com encerramento de tributação (o substituído tributário do ICMS deve utilizar essa opção)",
  3: "Revenda de mercadorias para o exterior",
  4: "Venda de mercadorias industrializadas pelo contribuinte, exceto para o exterior - Sem substituição tributária/tributação monofásica/antecipação com encerramento de tributação (o substituto tributário do ICMS deve utilizar essa opção)",
  5: "Venda de mercadorias industrializadas pelo contribuinte, exceto para o exterior - Com substituição tributária/tributação monofásica/antecipação com encerramento de tributação (o substituído tributário do ICMS deve utilizar essa opção)",
  6: "Venda de mercadorias industrializadas pelo contribuinte para o exterior",
  7: "Locação de bens móveis, exceto para o exterior",
  8: "Locação de bens móveis para o exterior",
  9: "Prestação de serviços, exceto para o exterior - Escritórios de serviços contábeis autorizados pela legislação municipal a pagar o ISS em valor fixo em guia do Município",
  10: "Prestação de serviços, exceto para o exterior - Sujeitos ao fator \"r\", sem retenção/substituição tributária de ISS, com ISS devido a outro(s) Município(s)",
  11: "Prestação de serviços, exceto para o exterior - Sujeitos ao fator \"r\", sem retenção/substituição tributária de ISS, com ISS devido ao próprio Município do estabelecimento",
  12: "Prestação de serviços, exceto para o exterior - Sujeitos ao fator \"r\", com retenção/substituição tributária de ISS",
  13: "Prestação de serviços, exceto para o exterior - Não sujeitos ao fator \"r\" e tributados pelo Anexo III, sem retenção/substituição tributária de ISS, com ISS devido a outro(s) Município(s)",
  14: "Prestação de serviços, exceto para o exterior - Não sujeitos ao fator \"r\" e tributados pelo Anexo III, sem retenção/substituição tributária de ISS, com ISS devido ao próprio Município do estabelecimento",
  15: "Prestação de serviços, exceto para o exterior - Não sujeitos ao fator \"r\" e tributados pelo Anexo III, com retenção/substituição tributária de ISS",
  16: "Prestação de serviços, exceto para o exterior - Sujeitos ao Anexo IV, sem retenção/substituição tributária de ISS, com ISS devido a outro(s) Município(s)",
  17: "Prestação de serviços, exceto para o exterior - Sujeitos ao Anexo IV, sem retenção/substituição tributária de ISS, com ISS devido ao próprio Município do estabelecimento",
  18: "Prestação de serviços, exceto para o exterior - Sujeitos ao Anexo IV, com retenção/substituição tributária de ISS",
  19: "Prestação de Serviços relacionados nos subitens 7.02, 7.05 e 16.1 da lista anexa à LC 116/2003, exceto para o exterior - Serviços da área da construção civil relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003 e tributados pelo Anexo III, sem retenção/substituição tributária de ISS, com ISS devido a outro(s) Município(s)",
  20: "Prestação de Serviços relacionados nos subitens 7.02, 7.05 e 16.1 da lista anexa à LC 116/2003, exceto para o exterior - Serviços da área da construção civil relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003 e tributados pelo Anexo III, sem retenção/substituição tributária de ISS, com ISS devido ao próprio Município do estabelecimento",
  21: "Prestação de Serviços relacionados nos subitens 7.02, 7.05 e 16.1 da lista anexa à LC 116/2003, exceto para o exterior - Serviços da área da construção civil relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003 e tributados pelo Anexo III, com retenção/substituição tributária de ISS",
  22: "Prestação de Serviços relacionados nos subitens 7.02, 7.05 e 16.1 da lista anexa à LC 116/2003, exceto para o exterior - Serviços da área da construção civil relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003 e tributados pelo Anexo IV, sem retenção/substituição tributária de ISS, com ISS devido a outro(s) Município(s)",
  23: "Prestação de Serviços relacionados nos subitens 7.02, 7.05 e 16.1 da lista anexa à LC 116/2003, exceto para o exterior - Serviços da área da construção civil relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003 e tributados pelo Anexo IV, sem retenção/substituição tributária de ISS, com ISS devido ao próprio Município do estabelecimento",
  24: "Prestação de Serviços relacionados nos subitens 7.02, 7.05 e 16.1 da lista anexa à LC 116/2003, exceto para o exterior - Serviços da área da construção civil relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003 e tributados pelo Anexo IV, com retenção/substituição tributária de ISS",
  25: "Prestação de Serviços relacionados nos subitens 7.02, 7.05 e 16.1 da lista anexa à LC 116/2003, exceto para o exterior - Serviços de transporte coletivo municipal rodoviário, metroviário, ferroviário e aquaviário de passageiros, sem retenção/substituição tributária de ISS, com ISS devido a outro(s) Município(s)",
  26: "Prestação de Serviços relacionados nos subitens 7.02, 7.05 e 16.1 da lista anexa à LC 116/2003, exceto para o exterior - Serviços de transporte coletivo municipal rodoviário, metroviário, ferroviário e aquaviário de passageiros, sem retenção/substituição tributária de ISS, com ISS devido ao próprio Município do estabelecimento",
  27: "Prestação de Serviços relacionados nos subitens 7.02, 7.05 e 16.1 da lista anexa à LC 116/2003, exceto para o exterior - Serviços de transporte coletivo municipal rodoviário, metroviário, ferroviário e aquaviário de passageiros, com retenção/substituição tributária de ISS",
  28: "Prestação de serviços para o exterior - Escritórios de serviços contábeis autorizados pela legislação municipal a pagar o ISS em valor fixo em guia do Município",
  29: "Prestação de serviços para o exterior - Sujeitos ao fator \"r\"",
  30: "Prestação de serviços para o exterior - Não sujeitos ao fator \"r\" e tributados pelo Anexo III",
  31: "Prestação de serviços para o exterior - Sujeitos ao Anexo IV",
  32: "Prestação de Serviços relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003, para o exterior - Serviços da área da construção civil relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003 e tributados pelo Anexo III",
  33: "Prestação de Serviços relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003, para o exterior - Serviços da área da construção civil relacionados nos subitens 7.02 e 7.05 da lista anexa à LC 116/2003 e tributados pelo Anexo IV",
  34: "Serviços de comunicação; de transporte intermunicipal e interestadual de carga; e de transporte intermunicipal e interestadual de passageiros autorizados no inciso VI do art. 17 da LC 123, exceto para o exterior - Transporte sem substituição tributária de ICMS (o substituto tributário deve utilizar essa opção)",
  35: "Serviços de comunicação; de transporte intermunicipal e interestadual de carga; e de transporte intermunicipal e interestadual de passageiros autorizados no inciso VI do art. 17 da LC 123, exceto para o exterior - Transporte com substituição tributária de ICMS (o substituído tributário deve utilizar essa opção)",
  36: "Serviços de comunicação; de transporte intermunicipal e interestadual de carga; e de transporte intermunicipal e interestadual de passageiros autorizados no inciso VI do art. 17 da LC 123, exceto para o exterior - Comunicação sem substituição tributária de ICMS (o substituto tributário deve utilizar essa opção)",
  37: "Serviços de comunicação; de transporte intermunicipal e interestadual de carga; e de transporte intermunicipal e interestadual de passageiros autorizados no inciso VI do art. 17 da LC 123, exceto para o exterior - Comunicação com substituição tributária de ICMS (o substituído tributário deve utilizar essa opção)",
  38: "Serviços de comunicação; de transporte intermunicipal e interestadual de carga; e de transporte intermunicipal e interestadual de passageiros autorizados no inciso VI do art. 17 da LC 123, para o exterior - Transporte",
  39: "Serviços de comunicação; de transporte intermunicipal e interestadual de carga; e de transporte intermunicipal e interestadual de passageiros autorizados no inciso VI do art. 17 da LC 123, para o exterior - Comunicação",
  40: "Atividades com incidência simultânea de IPI e de ISS, exceto para o exterior - Sem retenção/substituição tributária de ISS, com ISS devido a outro(s) Município(s)",
  41: "Atividades com incidência simultânea de IPI e de ISS, exceto para o exterior - Sem retenção/substituição tributária de ISS, com ISS devido ao próprio Município do estabelecimento",
  42: "Atividades com incidência simultânea de IPI e de ISS, exceto para o exterior - Com retenção/substituição tributária de ISS",
  43: "Atividades com incidência simultânea de IPI e de ISS para o exterior",
};

const key = (s: string) => normalize(s).replace(/[^A-Z0-9]+/g, " ").trim();
const BY_KEY = new Map(Object.entries(PGDAS_ACTIVITIES).map(([id, d]) => [key(d), Number(id)]));

/** Id da atividade pela descrição da declaração (nulo se não reconhecida). */
export function activityIdOf(description: string | null | undefined): number | null {
  if (!description) return null;
  const k = key(description);
  const exact = BY_KEY.get(k);
  if (exact) return exact;
  // PDF às vezes corta ou junta linhas: a descrição mais longa contida no texto
  let best: [number, number] | null = null;
  for (const [d, id] of BY_KEY) if (k.includes(d) || d.includes(k)) if (!best || d.length > best[1]) best = [id, d.length];
  return best ? best[0] : null;
}

/**
 * Serviços em trio: [ISS para outro município, ISS para o próprio município,
 * com retenção/substituição de ISS]. A receita de cada nota vai para a variante
 * certa do trio da atividade declarada.
 */
const SERVICE_TRIOS: [number, number, number][] = [[10, 11, 12], [13, 14, 15], [16, 17, 18], [19, 20, 21], [22, 23, 24], [25, 26, 27], [40, 41, 42]];

export function serviceVariant(id: number, v: { withheld: boolean; otherCity: boolean }): number {
  const trio = SERVICE_TRIOS.find((t) => t.includes(id));
  if (!trio) return id;
  return v.withheld ? trio[2] : v.otherCity ? trio[0] : trio[1];
}

export const isServiceActivity = (id: number) => SERVICE_TRIOS.some((t) => t.includes(id)) || id === 9;
export const isGoodsActivity = (id: number) => id >= 1 && id <= 6;
export const isFactorR = (id: number) => id >= 10 && id <= 12;
/** Revenda/venda com substituição tributária ou monofásico (ids 2 e 5). */
export const isStActivity = (id: number) => id === 2 || id === 5;

/** Códigos de tributo do PGDAS-D. */
export const TAX_CODE = { IRPJ: 1001, CSLL: 1002, COFINS: 1004, PIS: 1005, CPP: 1006, ICMS: 1007, IPI: 1008, ISS: 1010 } as const;
