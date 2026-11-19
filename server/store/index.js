// Accounts, sessions and reading history. MongoDB in production (MONGODB_URI), SQLite file for local dev.
import { createSqliteStore } from './sqlite.js';

export async function openStore() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    const { createMongoStore } = await import('./mongo.js');
    return createMongoStore(uri);
  }
  return createSqliteStore();
}
