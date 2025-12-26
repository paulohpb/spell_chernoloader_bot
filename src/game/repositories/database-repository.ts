/**
 * =============================================================================
 * Database Session Repository - Uses centralized database for game sessions
 * =============================================================================
 */

import { PlayerSession } from '../types';
import { SessionRepository } from '../repository';
import { Database } from '../../database';
import { auditLog } from '../../assistant/audit-log';

/**
 * Creates a session repository that uses the centralized database.
 * 
 * Factory function pattern - returns the repository interface.
 * 
 * @param database - The centralized database instance
 * @returns SessionRepository implementation
 */
export function createDatabaseSessionRepository(database: Database): SessionRepository {
  
  async function getSession(userId: number): Promise<PlayerSession | null> {
    const session = database.getGameSession(userId);
    auditLog.trace(`Game session lookup for user ${userId}: ${session ? 'found' : 'not found'}`);
    return session;
  }

  async function saveSession(session: PlayerSession): Promise<void> {
    database.saveGameSession(session);
    auditLog.trace(`Game session saved for user ${session.userId}`);
  }

  async function deleteSession(userId: number): Promise<void> {
    database.deleteGameSession(userId);
    auditLog.trace(`Game session deleted for user ${userId}`);
  }

  return {
    getSession,
    saveSession,
    deleteSession,
  };
}
