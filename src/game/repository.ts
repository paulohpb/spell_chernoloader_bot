/**
 * =============================================================================
 * ARQUIVO: src/game/repository.ts
 * (Novo Arquivo - Interface para definir como salvamos os dados)
 * =============================================================================
 */
import { PlayerSession } from './types';

export interface SessionRepository {
    getSession(userId: number): Promise<PlayerSession | null>;
    saveSession(session: PlayerSession): Promise<void>;
    deleteSession(userId: number): Promise<void>;
}
