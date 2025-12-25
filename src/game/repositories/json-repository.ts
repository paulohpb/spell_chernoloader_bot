/**
 * =============================================================================
 * ARQUIVO: src/game/repositories/json-repository.ts
 * (Novo Arquivo - Implementação que salva em arquivo JSON)
 * =============================================================================
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { PlayerSession } from '../types';
import { SessionRepository } from '../repository';

// Caminho para salvar os dados. No Railway, o ideal é montar um volume em /app/data
const DATA_DIR = path.join(__dirname, '../../../data');
const FILE_PATH = path.join(DATA_DIR, 'sessions.json');

export class JsonSessionRepository implements SessionRepository {
    private cache: Map<number, PlayerSession> = new Map();
    private loaded = false;

    constructor() {
        this.init();
    }

    private async init() {
        try {
            await fs.mkdir(DATA_DIR, { recursive: true });
            try {
                const data = await fs.readFile(FILE_PATH, 'utf-8');
                const json = JSON.parse(data);
                // Reconstrói o Map a partir do array salvo
                this.cache = new Map(json.map((s: PlayerSession) => [s.userId, s]));
                console.log(`[JsonRepository] Carregado com sucesso: ${this.cache.size} sessões.`);
            } catch (err) {
                // Arquivo não existe ou está vazio, inicia zerado
                console.log('[JsonRepository] Nenhum arquivo de save encontrado. Criando novo banco.');
                this.cache = new Map();
            }
            this.loaded = true;
        } catch (error) {
            console.error('[JsonRepository] Erro Crítico ao iniciar:', error);
        }
    }

    // Persiste o estado atual da memória para o arquivo
    private async persist() {
        if (!this.loaded) return;
        try {
            // Transforma o Map em Array para salvar como JSON
            const data = JSON.stringify(Array.from(this.cache.values()), null, 2);
            await fs.writeFile(FILE_PATH, data, 'utf-8');
        } catch (error) {
            console.error('[JsonRepository] Falha ao salvar no disco:', error);
        }
    }

    async getSession(userId: number): Promise<PlayerSession | null> {
        if (!this.loaded) await this.init();
        return this.cache.get(userId) || null;
    }

    async saveSession(session: PlayerSession): Promise<void> {
        this.cache.set(session.userId, session);
        await this.persist(); // Salva a cada alteração
    }

    async deleteSession(userId: number): Promise<void> {
        this.cache.delete(userId);
        await this.persist();
    }
}
