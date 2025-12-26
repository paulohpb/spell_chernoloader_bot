/**
 * =============================================================================
 * ARQUIVO: src/services/todo.service.ts
 * =============================================================================
 */
import * as fs from 'fs/promises';
import * as path from 'path';

const DATA_DIR = path.join(__dirname, '../../data');
const FILE_PATH = path.join(DATA_DIR, 'todo_list.txt');

export class TodoService {
    
    constructor() {
        this.init();
    }

    private async init() {
        try {
            await fs.mkdir(DATA_DIR, { recursive: true });
        } catch (error) {
            console.error('[TodoService] Erro ao criar diretório:', error);
        }
    }

    async addTodo(text: string, user: string): Promise<void> {
        try {
            await this.init();
            const date = new Date().toLocaleString('pt-BR', { 
                timeZone: 'America/Sao_Paulo',
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
            const line = `[${date}] ${user}: ${text}\n`;
            await fs.appendFile(FILE_PATH, line, { encoding: 'utf-8', flag: 'a' });
        } catch (error) {
            console.error('[TodoService] Erro ao salvar tarefa:', error);
            throw error;
        }
    }

    async getTodos(): Promise<string> {
        try {
            await this.init();
            const content = await fs.readFile(FILE_PATH, 'utf-8');
            return content || 'A lista de tarefas está vazia.';
        } catch (error) {
            return 'Nenhuma lista de tarefas encontrada ainda.';
        }
    }
}

export const todoService = new TodoService();
