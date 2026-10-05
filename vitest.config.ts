import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Os testes de integração compartilham o mesmo banco: execução sequencial.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
