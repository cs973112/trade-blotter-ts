import { defineConfig } from 'drizzle-kit'

// drizzle-kit generates and checks migrations from the schema. Migrations are applied by the
// application's own migrator (`npm run db:migrate`, and at startup), not by drizzle-kit.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/infrastructure/database/schema.ts',
  out: './drizzle',
})
