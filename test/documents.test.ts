import { describe, expect, it } from "vitest";
import {
  cnpjCheckDigits,
  cnpjRoot,
  formatCnpj,
  isValidCnpj,
  isValidCpf,
  normalizeCnpj,
} from "../src/shared/br/documents.js";
import { adminPool } from "./helpers.js";

describe("CNPJ alfanumérico (IN RFB 2.229/2024)", () => {
  it("valida o exemplo oficial da Receita: 12.ABC.345/01DE-35", () => {
    expect(cnpjCheckDigits("12ABC34501DE")).toBe("35");
    expect(isValidCnpj("12.ABC.345/01DE-35")).toBe(true);
    expect(isValidCnpj("12.ABC.345/01DE-36")).toBe(false);
  });

  it("continua validando CNPJ numérico", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCnpj("11.222.333/0001-80")).toBe(false);
  });

  it("aceita minúsculas e máscara, recusa formato e sequência repetida", () => {
    expect(normalizeCnpj("12.abc.345/01de-35")).toBe("12ABC34501DE35");
    expect(isValidCnpj("12.abc.345/01de-35")).toBe(true);
    expect(isValidCnpj("12ABC34501DE3X")).toBe(false); // DV é sempre numérico
    expect(isValidCnpj("00000000000000")).toBe(false);
    expect(isValidCnpj("123")).toBe(false);
  });

  it("formata e extrai a raiz", () => {
    expect(formatCnpj("12ABC34501DE35")).toBe("12.ABC.345/01DE-35");
    expect(cnpjRoot("12.ABC.345/01DE-35")).toBe("12ABC345");
  });

  it("banco e aplicação aplicam a mesma regra", async () => {
    const samples = ["12ABC34501DE35", "12ABC34501DE36", "11222333000181", "11222333000180", "AAAAAAAAAAAAAA"];
    for (const s of samples) {
      const { rows } = await adminPool.query<{ ok: boolean }>("SELECT cnpj_is_valid($1) AS ok", [s]);
      expect(rows[0]!.ok, s).toBe(isValidCnpj(s));
    }
  });
});

describe("CPF", () => {
  it("valida dígitos e recusa sequência repetida", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
    expect(isValidCpf("529.982.247-26")).toBe(false);
    expect(isValidCpf("111.111.111-11")).toBe(false);
  });
});
