import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectPfx, PfxError, syncClientCertificates } from "../src/platform/identity/client-certificates.js";
import { openPendingItem } from "../src/platform/pending/pending.js";
import { withTenant } from "../src/shared/db/tenant-tx.js";
import { openSecretsFile } from "../src/shared/secrets/secrets-file.js";
import { CNPJ_FILIAL, CNPJ_MATRIZ, CNPJ_PRESUMIDO } from "./fixtures/cnpj.js";
import { appPool, newEntity, newTenant, SYSTEM } from "./helpers.js";

/** Gera um .pfx de teste (autoassinado, AES-256) com o CN no padrão ICP-Brasil. */
function makePfx(dir: string, name: string, cn: string, password: string): Buffer {
  const key = join(dir, `${name}.key`);
  const crt = join(dir, `${name}.crt`);
  const pfx = join(dir, `${name}.pfx`);
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", crt, "-days", "365", "-subj", `/C=BR/O=ICP-Brasil/CN=${cn}`], { stdio: "ignore" });
  execFileSync("openssl", ["pkcs12", "-export", "-inkey", key, "-in", crt, "-out", pfx, "-passout", `pass:${password}`], { stdio: "ignore" });
  return readFileSync(pfx);
}

function vaultWith(files: Record<string, Buffer>, secrets: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "aires-cofre-"));
  mkdirSync(join(dir, "clientes"));
  for (const [cnpj, pfx] of Object.entries(files)) writeFileSync(join(dir, "clientes", `${cnpj}.pfx`), pfx);
  writeFileSync(join(dir, "segredos.env"), Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join("\n"));
  return openSecretsFile(join(dir, "segredos.env"))!;
}

describe("certificados A1 dos clientes no cofre local", () => {
  const work = mkdtempSync(join(tmpdir(), "aires-pfx-"));
  const good = makePfx(work, "matriz", `ALPHA INDUSTRIA LTDA:${CNPJ_MATRIZ}`, "senha-certa");

  it("lê só dados públicos: titular (CNPJ do CN), série e validade", () => {
    const info = inspectPfx(good, "senha-certa");
    expect(info.holderDocument).toBe(CNPJ_MATRIZ);
    expect(info.serialNumber).toMatch(/^[0-9A-F]+$/);
    expect(info.validTo.getTime()).toBeGreaterThan(Date.now());
    expect(() => inspectPfx(good, "errada")).toThrow(PfxError);
    try {
      inspectPfx(good, "errada");
    } catch (e) {
      expect((e as PfxError).status).toBe("SENHA_INCORRETA");
    }
  });

  it("confere cada empresa, registra o válido, resolve a pendência e não duplica", async () => {
    const t = await newTenant();
    const a = await newEntity(t, CNPJ_MATRIZ);
    await newEntity(t, CNPJ_PRESUMIDO);
    await newEntity(t, CNPJ_FILIAL);
    await withTenant(appPool, t, (tx) =>
      openPendingItem(
        tx,
        { type: "CLIENT_CERTIFICATE", entityId: a.entityId, requiredInformation: "Enviar o certificado A1", responsibleSource: "CLIENT", impact: "x" },
        SYSTEM,
      ),
    );
    const other = makePfx(work, "outro", `OUTRA EMPRESA LTDA:${CNPJ_FILIAL.replace(/^12ABC345/, "55555555")}`, "x");
    const vault = vaultWith(
      { [CNPJ_MATRIZ]: good, [CNPJ_PRESUMIDO]: other },
      { [`CERT_${CNPJ_MATRIZ}_PASSWORD`]: "senha-certa", [`CERT_${CNPJ_PRESUMIDO}_PASSWORD`]: "x" },
    );

    const r1 = await syncClientCertificates(appPool, t, vault, SYSTEM);
    const by = Object.fromEntries(r1.map((r) => [r.cnpj, r]));
    expect(by[CNPJ_MATRIZ]).toMatchObject({ status: "OK", registered: true });
    expect(by[CNPJ_PRESUMIDO]).toMatchObject({ status: "CNPJ_DIFERENTE" });
    expect(r1.filter((r) => r.status === "NAO_ENCONTRADO")).toHaveLength(1);

    await withTenant(appPool, t, async (tx) => {
      const certs = await tx.query("SELECT entity_id, holder_document, status, vault_ref FROM digital_certificate");
      expect(certs.rows).toEqual([{ entity_id: a.entityId, holder_document: CNPJ_MATRIZ, status: "ACTIVE", vault_ref: `cofre-local:clientes/${CNPJ_MATRIZ}.pfx` }]);
      const p = await tx.query("SELECT status, resolution FROM pending_item WHERE type = 'CLIENT_CERTIFICATE'");
      expect(p.rows[0].status).toBe("RESOLVED");
      const ev = await tx.query("SELECT type FROM outbox WHERE type = 'DIGITAL_CERTIFICATE_REGISTERED'");
      expect(ev.rowCount).toBe(1);
      // Nada de senha ou conteúdo do certificado na auditoria.
      const au = await tx.query("SELECT data::text AS d FROM audit_log WHERE action = 'identity.certificate_registered'");
      expect(au.rows[0].d).not.toContain("senha-certa");
      expect(au.rows[0].d).not.toContain("PRIVATE");
    });

    const r2 = await syncClientCertificates(appPool, t, vault, SYSTEM);
    expect(r2.find((r) => r.cnpj === CNPJ_MATRIZ)).toMatchObject({ status: "OK", registered: false });
    await withTenant(appPool, t, async (tx) => {
      expect((await tx.query("SELECT 1 FROM digital_certificate")).rowCount).toBe(1);
    });
  });

  it("sem senha, senha errada e vencido não registram", async () => {
    const t = await newTenant();
    await newEntity(t, CNPJ_MATRIZ);
    const semSenha = vaultWith({ [CNPJ_MATRIZ]: good }, {});
    expect((await syncClientCertificates(appPool, t, semSenha, SYSTEM))[0]).toMatchObject({ status: "SEM_SENHA" });
    const errada = vaultWith({ [CNPJ_MATRIZ]: good }, { [`CERT_${CNPJ_MATRIZ}_PASSWORD`]: "errada" });
    expect((await syncClientCertificates(appPool, t, errada, SYSTEM))[0]).toMatchObject({ status: "SENHA_INCORRETA" });
    const certa = vaultWith({ [CNPJ_MATRIZ]: good }, { [`CERT_${CNPJ_MATRIZ}_PASSWORD`]: "senha-certa" });
    const future = new Date(Date.now() + 400 * 86_400_000);
    expect((await syncClientCertificates(appPool, t, certa, SYSTEM, future))[0]).toMatchObject({ status: "VENCIDO" });
    await withTenant(appPool, t, async (tx) => {
      expect((await tx.query("SELECT 1 FROM digital_certificate")).rowCount).toBe(0);
    });
  });
});
