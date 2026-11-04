import { loadApiConfig } from '../src/config.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { createPgDb, createPgPool } from '../src/db/pg.js';
import { seed } from '../src/db/seed.js';

// `pnpm db:migrate` / `pnpm db:seed`. Needs DATABASE_URL (see .env.example and docker-compose.yml).

const command = process.argv[2];
if (command !== 'migrate' && command !== 'seed') {
  console.error('Usage: db.ts migrate|seed');
  process.exit(2);
}

const { databaseUrl } = loadApiConfig(process.env);
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const db = createPgDb(createPgPool(databaseUrl));
try {
  if (command === 'migrate') {
    const applied = await migrate(db, loadMigrations());
    console.log(applied.length > 0 ? `Applied: ${applied.join(', ')}` : 'Up to date');
  } else {
    await seed(db);
    console.log('Seeded demo data');
  }
} finally {
  await db.close();
}
