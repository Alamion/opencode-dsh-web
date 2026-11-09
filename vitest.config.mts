import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// The extension modules import `vscode`, which only exists inside the editor.
// Tests map it to a small stub so the pure logic can be exercised headlessly.
export default defineConfig({
  resolve: {
    alias: {
      vscode: fileURLToPath(new URL('./tests/vscode-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
