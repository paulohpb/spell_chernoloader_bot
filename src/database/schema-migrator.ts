/**
 * @module database/schema-migrator
 *
 * Owns every piece of logic that touches the raw {@link DatabaseSchema}
 * object at load time:
 *   - The canonical "empty" schema factory.
 *   - Forward-migration guards that seed fields introduced after the
 *     initial schema version so older `database.json` files are
 *     transparently upgraded on first load.
 *
 * Nothing here performs I/O — the migrator receives a parsed object
 * and returns the (possibly mutated) result.
 */

import { DatabaseSchema } from './types';

// ---------------------------------------------------------------------------
// Empty-schema factory
// ---------------------------------------------------------------------------

/**
 * Returns a brand-new, fully-populated schema with every collection
 * initialised to an empty array and every auto-increment counter set to 1.
 * Use this when no `database.json` exists on disk yet.
 */
export const createEmptySchema = (): DatabaseSchema => ({
  conversations: [],
  links: [],
  rateLimits: [],
  duylhouIncidents: [],
  duylhouLeaderboard: [],
  todos: [],
  summaries: [],
  chatMessages: [],
  userMemories: [],
  meta: {
    version: 1,
    lastSaved: Date.now(),
    conversationNextId: 1,
    linkNextId: 1,
    duylhouIncidentNextId: 1,
    todoNextId: 1,
    summaryNextId: 1,
    chatMessageNextId: 1,
    userMemoryNextId: 1,
  },
});

// ---------------------------------------------------------------------------
// Forward-migration guards
// ---------------------------------------------------------------------------

/**
 * Ensures that every collection and meta-field that the current code
 * expects is present on the schema object.  Fields that were introduced
 * after the initial version may be `undefined` on schemas loaded from
 * older JSON files; this function seeds them with safe defaults so the
 * rest of the codebase can assume they are always arrays / numbers.
 *
 * The function mutates `schema` in place and returns it for chaining.
 *
 * @param schema - The parsed schema loaded from disk.
 * @returns The same object, with any missing fields seeded.
 */
export const applyMigrations = (schema: DatabaseSchema): DatabaseSchema => {
  // --- todos (added after initial launch) ---
  if (!Array.isArray(schema.todos)) {
    schema.todos = [];
  }
  if (schema.meta.todoNextId === undefined || schema.meta.todoNextId === null) {
    schema.meta.todoNextId = 1;
  }

  // --- summaries (added after initial launch) ---
  if (!Array.isArray(schema.summaries)) {
    schema.summaries = [];
  }
  if (schema.meta.summaryNextId === undefined || schema.meta.summaryNextId === null) {
    schema.meta.summaryNextId = 1;
  }

  // --- chatMessages (persistent /summary buffer, added for restart-survival) ---
  if (!Array.isArray(schema.chatMessages)) {
    schema.chatMessages = [];
  }
  if (schema.meta.chatMessageNextId === undefined || schema.meta.chatMessageNextId === null) {
    schema.meta.chatMessageNextId = 1;
  }

  // --- userMemories (long-term memory, added in v3) ---
  if (!Array.isArray(schema.userMemories)) {
    schema.userMemories = [];
  }
  if (schema.meta.userMemoryNextId === undefined || schema.meta.userMemoryNextId === null) {
    schema.meta.userMemoryNextId = 1;
  }

  // duylhouIncidents already existed as an array at schema v1 — nothing to seed.

  return schema;
};
