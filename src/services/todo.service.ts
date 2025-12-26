/**
 * =============================================================================
 * ARQUIVO: src/services/todo.service.ts
 * =============================================================================
 */
import * as fs from 'fs/promises';
import * as path from 'path';

// Salva na mesma pasta 'data' que usamos para o jogo (ou cria uma nova na raiz se nÃ£o existir)
// Ajustado para navegar corretamente a partir de src/services/
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
            await this.init(); // Garante que a pasta existe antes de salvar

            // Formata a data para o padrão brasileiro
            const date = new Date().toLocaleString('pt-BR', { 
                timeZone: 'America/Sao_Paulo',
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });

            // Formato: [Data Hora] Usuário: Tarefa
            const line = `[${date}] ${user}: ${text}\n`;

            // 'a' flag significa 'append' (adicionar ao final sem apagar o resto)
            await fs.appendFile(FILE_PATH, line, { encoding: 'utf-8', flag: 'a' });
            
            console.log(`[TodoService] Nova tarefa adicionada por ${user}`);
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
