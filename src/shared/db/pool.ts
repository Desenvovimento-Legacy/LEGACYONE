import pg from "pg";

// DATE chega como string "YYYY-MM-DD", sem conversão de fuso: competência e
// vigência são datas civis, nunca instantes.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString, max });
}
