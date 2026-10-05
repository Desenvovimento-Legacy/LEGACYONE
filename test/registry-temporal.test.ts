import { describe, expect, it } from "vitest";
import {
  addContractedService,
  closeVigency,
  createClient,
  createEntity,
  profileAsOf,
  setEntityType,
  setTaxRegime,
} from "../src/modules/registry/registry.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { newId } from "../src/shared/ids.js";
import { appPool, newEntity, newTenant, SYSTEM } from "./helpers.js";

describe("cadastro temporal da entidade", () => {
  it("responde a configuração vigente em qualquer data", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t);

    await withTenant(appPool, t, async (tx) => {
      await setEntityType(tx, { entityId, entityType: "SOCIEDADE_EMPRESARIA", validFrom: "2020-03-10", source: "cnpj" }, SYSTEM);
      await setTaxRegime(tx, { entityId, regime: "SIMPLES_NACIONAL", validFrom: "2020-03-10", source: "integra-contador" }, SYSTEM);
      await addContractedService(tx, { entityId, service: "CONTABIL", validFrom: "2026-09-01", source: "contrato" }, SYSTEM);
      await addContractedService(tx, { entityId, service: "FOLHA", validFrom: "2026-09-01", source: "contrato" }, SYSTEM);
      // Exclusão do Simples: encerra vigência em 31/12/2025 e entra no Presumido.
      await closeVigency(tx, "tax_regime_history", { entityId, validTo: "2025-12-31" }, SYSTEM);
      await setTaxRegime(tx, { entityId, regime: "LUCRO_PRESUMIDO", validFrom: "2026-01-01", source: "opcao" }, SYSTEM);
    });

    await withTenant(appPool, t, async (tx) => {
      expect(await profileAsOf(tx, entityId, "2025-03-31")).toEqual({
        entity_type: "SOCIEDADE_EMPRESARIA",
        regime: "SIMPLES_NACIONAL",
        services: [],
      });
      expect(await profileAsOf(tx, entityId, "2026-10-05")).toEqual({
        entity_type: "SOCIEDADE_EMPRESARIA",
        regime: "LUCRO_PRESUMIDO",
        services: ["CONTABIL", "FOLHA"],
      });
      expect(await profileAsOf(tx, entityId, "2019-01-01")).toEqual({ entity_type: null, regime: null, services: [] });
    });
  });

  it("recusa duas vigências de regime sobrepostas", async () => {
    const t = await newTenant();
    const { entityId } = await newEntity(t);
    await withTenant(appPool, t, (tx) =>
      setTaxRegime(tx, { entityId, regime: "SIMPLES_NACIONAL", validFrom: "2024-01-01", source: "x" }, SYSTEM),
    );
    await expect(
      withTenant(appPool, t, (tx) =>
        setTaxRegime(tx, { entityId, regime: "LUCRO_PRESUMIDO", validFrom: "2025-01-01", source: "x" }, SYSTEM),
      ),
    ).rejects.toThrow(/conflicting key value violates exclusion constraint/);
  });

  it("banco recusa CNPJ inválido mesmo fora da aplicação", async () => {
    const t = await newTenant();
    await expect(
      withTenant(appPool, t, async (tx) => {
        const clientId = await createClient(tx, "c", SYSTEM);
        await tx.query(
          `INSERT INTO entity (id, tenant_id, client_id, person_kind, cnpj, legal_name)
           VALUES ($1, current_tenant(), $2, 'PJ', '12ABC34501DE36', 'X')`,
          [newId(), clientId],
        );
      }),
    ).rejects.toThrow(/entity_document_ck/);
  });

  it("aceita CNPJ alfanumérico pela aplicação e filial só com a mesma raiz", async () => {
    const t = await newTenant();
    await withTenant(appPool, t, async (tx) => {
      const clientId = await createClient(tx, "c", SYSTEM);
      const entityId = await createEntity(
        tx,
        { personKind: "PJ", clientId, cnpj: "12.abc.345/01de-35", legalName: "ALFA" },
        SYSTEM,
      );
      const { rows } = await tx.query("SELECT cnpj FROM entity WHERE id = $1", [entityId]);
      expect(rows[0].cnpj).toBe("12ABC34501DE35");

      await tx.query("SAVEPOINT s");
      await expect(
        tx.query(
          `INSERT INTO establishment (id, tenant_id, entity_id, kind, cnpj, uf, municipio_ibge, opened_at)
           VALUES ($1, current_tenant(), $2, 'FILIAL', '11222333000181', 'SP', '3550308', '2026-01-01')`,
          [newId(), entityId],
        ),
      ).rejects.toThrow(/não pertence à raiz/);
      await tx.query("ROLLBACK TO SAVEPOINT s");
    });
  });
});
