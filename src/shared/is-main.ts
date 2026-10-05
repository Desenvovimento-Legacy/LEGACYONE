import { pathToFileURL } from "node:url";

/** true quando o módulo foi executado diretamente (funciona em Windows e Linux). */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  return entry !== undefined && moduleUrl === pathToFileURL(entry).href;
}
