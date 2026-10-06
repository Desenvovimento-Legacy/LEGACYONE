import { existsSync, readFileSync } from "node:fs";

/**
 * Credential Vault — backend de arquivo local (fase piloto).
 *
 * Lê um arquivo KEY=VALOR fora do repositório (ex.: C:\AIRES\cofre\segredos.env,
 * com ACL restrita ao usuário). Regras:
 *  - os valores nunca são impressos, logados, serializados nem enviados a LLM;
 *  - quem precisa de um segredo pede pelo nome e recebe só aquele valor;
 *  - `describe()` informa apenas QUAIS chaves estão preenchidas, nunca o conteúdo.
 * Em produção este backend é substituído por um cofre gerenciado (KMS/Secrets
 * Manager) com a mesma interface.
 */
export interface SecretStore {
  readonly location: string;
  has(name: string): boolean;
  /** Devolve o valor ou lança erro citando apenas o nome da chave. */
  require(name: string): string;
  /** Chaves e se estão preenchidas. Nunca os valores. */
  describe(): Record<string, boolean>;
}

export class MissingSecretError extends Error {
  constructor(name: string, location: string) {
    super(`Segredo ${name} não preenchido no cofre (${location})`);
    this.name = "MissingSecretError";
  }
}

/** Interpreta KEY=VALOR; ignora linhas vazias e comentários (#). Aspas externas são removidas. */
export function parseSecrets(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out.set(key, value);
  }
  return out;
}

class FileSecretStore implements SecretStore {
  constructor(
    readonly location: string,
    private readonly values: Map<string, string>,
  ) {}

  has(name: string): boolean {
    return Boolean(this.values.get(name));
  }

  require(name: string): string {
    const v = this.values.get(name);
    if (!v) throw new MissingSecretError(name, this.location);
    return v;
  }

  describe(): Record<string, boolean> {
    return Object.fromEntries([...this.values.keys()].map((k) => [k, Boolean(this.values.get(k))]));
  }

  // Impede vazamento acidental por console.log / JSON.stringify.
  toJSON() {
    return { location: this.location, keys: this.describe() };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return `SecretStore(${this.location})`;
  }
}

export function secretStoreFromText(text: string, location = "memória"): SecretStore {
  return new FileSecretStore(location, parseSecrets(text));
}

/**
 * Caminho padrão do cofre: AIRES_SECRETS_FILE, ou, no Windows, a pasta
 * centralizada C:\AIRES\cofre\segredos.env. Os locais antigos
 * (C:\AIRES-COFRE, C:\IARIS-COFRE) valem só se o novo não existir.
 */
export const WINDOWS_VAULT_CANDIDATES = [
  "C:\\AIRES\\cofre\\segredos.env",
  "C:\\AIRES-COFRE\\segredos.env",
  "C:\\IARIS-COFRE\\segredos.env",
];

export function defaultSecretsPath(): string | null {
  const env = process.env.AIRES_SECRETS_FILE ?? process.env.IARIS_SECRETS_FILE;
  if (env) return env;
  if (process.platform !== "win32") return null;
  return WINDOWS_VAULT_CANDIDATES.find((p) => existsSync(p)) ?? WINDOWS_VAULT_CANDIDATES[0]!;
}

/** Abre o cofre; devolve null se o arquivo não existir. */
export function openSecretsFile(path: string | null = defaultSecretsPath()): SecretStore | null {
  if (!path || !existsSync(path)) return null;
  return new FileSecretStore(path, parseSecrets(readFileSync(path, "utf8")));
}
