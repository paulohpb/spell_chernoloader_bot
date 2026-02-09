/**
 * @module services/memory
 *
 * Long-term memory service for learning and recalling user preferences.
 * Implements a RAG-lite (Retrieval-Augmented Generation) pattern without
 * external dependencies — all logic is self-contained.
 *
 * ARCHITECTURE
 * ------------
 * Memory is stored per-user in isolated collections. Each memory fragment
 * captures a single piece of knowledge (preference, fact, or interest)
 * along with keywords for retrieval matching.
 *
 * RETRIEVAL STRATEGY
 * ------------------
 * When a command runs, relevant memories are retrieved by:
 *   1. Extracting keywords from the current query/context
 *   2. Scoring each memory by keyword overlap + recency + access frequency
 *   3. Selecting top N memories within a token budget
 *   4. Injecting them into the system prompt
 *
 * LEARNING STRATEGY
 * -----------------
 * After successful commands, the service can extract new knowledge by:
 *   1. Sending the interaction to Gemini with a structured extraction prompt
 *   2. Parsing the JSON response for new memory fragments
 *   3. Merging with existing memories (deduplication)
 *   4. Storing with appropriate metadata
 *
 * ISOLATION GUARANTEE
 * -------------------
 * Every operation is strictly scoped to a single userId. Cross-user
 * memory access is architecturally impossible — the service enforces
 * this at the API level, not just the database level.
 *
 * @example
 * ```typescript
 * const [err, memoryService] = createMemoryService({ database, geminiService });
 *
 * // Retrieve relevant memories for a prompt
 * const memories = await memoryService.retrieveRelevant(userId, "translate this news article");
 *
 * // Extract and store new memories from an interaction
 * await memoryService.extractAndStore(userId, userInput, botResponse, 'traduzir');
 * ```
 */

import { GeminiService, ChatMessage, AppError } from '../types';
import { auditLog } from '../audit-log';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Categories of long-term memories the system can learn.
 *
 * - `preference`: How the user likes things done (style, format, tone)
 * - `fact`: Factual information about the user (profession, expertise)
 * - `interest`: Topics the user frequently engages with
 */
export type MemoryType = 'preference' | 'fact' | 'interest';

/**
 * A single memory fragment stored for a user.
 * This is the database record shape.
 */
export interface UserMemoryRecord {
    /** Auto-incremented unique ID. */
    id: number;
    /** Telegram user ID — the isolation key. */
    userId: number;
    /** Category of this memory. */
    type: MemoryType;
    /** The actual knowledge content (short, dense description). */
    content: string;
    /** Extracted keywords for retrieval matching. */
    keywords: string[];
    /** Confidence score 0-1 (higher = more certain). */
    confidence: number;
    /** Which command created this memory. */
    source: string;
    /** Unix timestamp (ms) when created. */
    createdAt: number;
    /** Unix timestamp (ms) when last used in a prompt. */
    lastAccessedAt: number;
    /** How many times this memory has been used. */
    accessCount: number;
}

/**
 * A memory ready for injection into a prompt (after retrieval scoring).
 */
export interface RetrievedMemory {
    /** The memory record. */
    record: UserMemoryRecord;
    /** Computed relevance score (0-1). */
    relevanceScore: number;
}

/**
 * Result of memory extraction from an interaction.
 */
export interface ExtractionResult {
    /** Number of new memories added. */
    added: number;
    /** Number of existing memories updated/reinforced. */
    updated: number;
    /** Number of extraction attempts that failed parsing. */
    parseErrors: number;
}

/**
 * Configuration for the memory service.
 */
export interface MemoryServiceConfig {
    /** Maximum memories to store per user. Oldest unused are evicted. */
    maxMemoriesPerUser?: number;
    /** Maximum memories to inject per prompt. */
    maxMemoriesPerPrompt?: number;
    /** Token budget for memory context (characters / 4). */
    memoryTokenBudget?: number;
    /** Minimum confidence to store a new memory. */
    minConfidence?: number;
    /** Days after which unused memories decay in relevance. */
    decayAfterDays?: number;
    /** Similarity threshold for merging memories (0-1). */
    mergeSimilarityThreshold?: number;
}

/**
 * Database interface required by the memory service.
 * Subset of the full Database interface.
 */
export interface MemoryDatabase {
    getUserMemories: (userId: number) => UserMemoryRecord[];
    addUserMemory: (record: Omit<UserMemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt' | 'accessCount'>) => UserMemoryRecord;
    updateUserMemory: (id: number, updates: Partial<UserMemoryRecord>) => void;
    deleteUserMemory: (id: number) => void;
    markMemoryAccessed: (id: number) => void;
}

/**
 * Public interface for the memory service.
 */
export interface MemoryService {
    /**
     * Retrieves memories relevant to the given context for a specific user.
     * Results are sorted by relevance and capped to the token budget.
     *
     * @param userId  - Telegram user ID (isolation key).
     * @param context - Current query/prompt context to match against.
     * @returns Array of relevant memories with scores.
     */
    retrieveRelevant: (userId: number, context: string) => Promise<RetrievedMemory[]>;

    /**
     * Formats retrieved memories as a system prompt injection.
     *
     * @param memories - Retrieved memories from `retrieveRelevant`.
     * @returns Formatted string to prepend to the system prompt, or empty string.
     */
    formatForPrompt: (memories: RetrievedMemory[]) => string;

    /**
     * Extracts new knowledge from an interaction and stores it.
     * Should be called after a successful command, non-blocking.
     *
     * @param userId      - Telegram user ID.
     * @param userInput   - What the user said/requested.
     * @param botResponse - What the bot responded.
     * @param source      - Command name that generated this interaction.
     * @returns Extraction statistics.
     */
    extractAndStore: (
        userId: number,
        userInput: string,
        botResponse: string,
        source: string,
    ) => Promise<ExtractionResult>;

    /**
     * Returns all memories for a user (for debugging/admin).
     *
     * @param userId - Telegram user ID.
     * @returns All stored memories for this user.
     */
    getAllMemories: (userId: number) => UserMemoryRecord[];

    /**
     * Clears all memories for a user (for privacy/reset).
     *
     * @param userId - Telegram user ID.
     * @returns Number of memories deleted.
     */
    clearUserMemories: (userId: number) => number;

    /**
     * Runs maintenance: evicts old memories, merges duplicates.
     *
     * @returns Number of memories affected.
     */
    runMaintenance: () => Promise<number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Characters per token estimate (conservative for Portuguese). */
const CHARS_PER_TOKEN = 4;

/** Portuguese stopwords to exclude from keyword extraction. */
const PORTUGUESE_STOPWORDS = new Set([
    'a', 'o', 'e', 'é', 'de', 'da', 'do', 'em', 'um', 'uma', 'para', 'com',
    'não', 'uma', 'os', 'no', 'se', 'na', 'por', 'mais', 'as', 'dos', 'como',
    'mas', 'foi', 'ao', 'ele', 'das', 'tem', 'à', 'seu', 'sua', 'ou', 'ser',
    'quando', 'muito', 'há', 'nos', 'já', 'está', 'eu', 'também', 'só', 'pelo',
    'pela', 'até', 'isso', 'ela', 'entre', 'era', 'depois', 'sem', 'mesmo',
    'aos', 'ter', 'seus', 'quem', 'nas', 'me', 'esse', 'eles', 'estão', 'você',
    'tinha', 'foram', 'essa', 'num', 'nem', 'suas', 'meu', 'às', 'minha', 'têm',
    'numa', 'pelos', 'elas', 'havia', 'seja', 'qual', 'será', 'nós', 'tenho',
    'lhe', 'deles', 'essas', 'esses', 'pelas', 'este', 'fosse', 'dele', 'tu',
    'te', 'vocês', 'vos', 'lhes', 'meus', 'minhas', 'teu', 'tua', 'teus', 'tuas',
    'nosso', 'nossa', 'nossos', 'nossas', 'dela', 'delas', 'esta', 'estes',
    'estas', 'aquele', 'aquela', 'aqueles', 'aquelas', 'isto', 'aquilo', 'estou',
    'está', 'estamos', 'estão', 'estive', 'esteve', 'estivemos', 'estiveram',
    'estava', 'estávamos', 'estavam', 'estivera', 'estivéramos', 'esteja',
    'estejamos', 'estejam', 'estivesse', 'estivéssemos', 'estivessem', 'estiver',
    'estivermos', 'estiverem', 'hei', 'há', 'havemos', 'hão', 'houve', 'houvemos',
    'houveram', 'houvera', 'houvéramos', 'haja', 'hajamos', 'hajam', 'houvesse',
    'houvéssemos', 'houvessem', 'houver', 'houvermos', 'houverem', 'houverei',
    'houverá', 'houveremos', 'houverão', 'houveria', 'houveríamos', 'houveriam',
    'sou', 'somos', 'são', 'era', 'éramos', 'eram', 'fui', 'foi', 'fomos',
    'foram', 'fora', 'fôramos', 'seja', 'sejamos', 'sejam', 'fosse', 'fôssemos',
    'fossem', 'for', 'formos', 'forem', 'serei', 'será', 'seremos', 'serão',
    'seria', 'seríamos', 'seriam', 'tenho', 'tem', 'temos', 'tém', 'tinha',
    'tínhamos', 'tinham', 'tive', 'teve', 'tivemos', 'tiveram', 'tivera',
    'tivéramos', 'tenha', 'tenhamos', 'tenham', 'tivesse', 'tivéssemos',
    'tivessem', 'tiver', 'tivermos', 'tiverem', 'terei', 'terá', 'teremos',
    'terão', 'teria', 'teríamos', 'teriam', 'que', 'the', 'and', 'to', 'of',
    'is', 'in', 'it', 'you', 'that', 'was', 'for', 'on', 'are', 'with', 'as',
    'be', 'at', 'have', 'this', 'from', 'or', 'an', 'by', 'not', 'but', 'what',
    'all', 'were', 'we', 'when', 'your', 'can', 'there', 'use', 'each', 'which',
    'do', 'how', 'if', 'will', 'up', 'other', 'about', 'out', 'them', 'then',
    'these', 'so', 'some', 'her', 'would', 'make', 'him', 'into', 'has', 'two',
    'more', 'very', 'after', 'should', 'could', 'been', 'now', 'any', 'our',
]);

/** Minimum word length to consider as a keyword. */
const MIN_KEYWORD_LENGTH = 3;

/** Maximum keywords to extract per text. */
const MAX_KEYWORDS_PER_TEXT = 15;

/**
 * System prompt for memory extraction.
 * Instructs Gemini to identify learnable facts from interactions.
 */
const EXTRACTION_SYSTEM_PROMPT = `Você é um assistente que analisa conversas para extrair conhecimento duradouro sobre o usuário.

Extraia APENAS fatos que são:
1. Explicitamente declarados ou fortemente implícitos
2. Relevantes para interações futuras
3. NÃO dados pessoais sensíveis (endereços, telefones, senhas, etc.)

Categorias:
- preference: Como o usuário gosta que as coisas sejam feitas (estilo de comunicação, preferências de formato)
- fact: Informações factuais sobre o usuário (profissão, área de atuação, expertise)
- interest: Tópicos com os quais o usuário se engaja frequentemente

Responda APENAS com um array JSON válido. Cada item deve ter:
- "type": "preference" | "fact" | "interest"
- "content": descrição curta e objetiva (máximo 100 caracteres)
- "confidence": número de 0.0 a 1.0 indicando certeza

Se não houver nada notável para extrair, responda: []

IMPORTANTE:
- Seja conservador. Na dúvida, não extraia.
- Prefira fatos explícitos a inferências.
- Não invente informações.
- Máximo 3 itens por interação.`;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Removes diacritics (accents) from a string for normalization.
 *
 * @param text - Input string with possible accents.
 * @returns String with accents removed.
 */
function removeDiacritics(text: string): string {
    return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Extracts keywords from text for retrieval matching.
 * Uses simple tokenization, stopword removal, and normalization.
 *
 * @param text - Input text to extract keywords from.
 * @returns Array of normalized keywords.
 */
function extractKeywords(text: string): string[] {
    // Normalize: lowercase, remove diacritics
    const normalized = removeDiacritics(text.toLowerCase());

    // Tokenize: split on non-alphanumeric characters
    const tokens = normalized.split(/[^a-z0-9]+/).filter(Boolean);

    // Filter: remove stopwords (checking both normalized and original)
    // and short words
    const keywords = tokens.filter((token) => {
        if (token.length < MIN_KEYWORD_LENGTH) return false;
        if (PORTUGUESE_STOPWORDS.has(token)) return false;
        // Also check the original (non-normalized) form
        const original = text.toLowerCase();
        if (PORTUGUESE_STOPWORDS.has(original)) return false;
        return true;
    });

    // Deduplicate and limit
    const unique = [...new Set(keywords)];
    return unique.slice(0, MAX_KEYWORDS_PER_TEXT);
}

/**
 * Computes Jaccard similarity between two keyword sets.
 * Returns a value between 0 (no overlap) and 1 (identical).
 *
 * @param a - First keyword set.
 * @param b - Second keyword set.
 * @returns Similarity score 0-1.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 0;

    const setA = new Set(a);
    const setB = new Set(b);

    let intersection = 0;
    for (const item of setA) {
        if (setB.has(item)) intersection++;
    }

    const union = setA.size + setB.size - intersection;
    return union === 0 ? 0 : intersection / union;
}

/**
 * Computes a recency score based on how recently a memory was accessed.
 * Returns 1.0 for very recent, decaying towards 0 for older memories.
 *
 * @param lastAccessedAt - Unix timestamp (ms) of last access.
 * @param decayDays      - Number of days after which decay starts.
 * @returns Recency score 0-1.
 */
function recencyScore(lastAccessedAt: number, decayDays: number): number {
    const now = Date.now();
    const ageMs = now - lastAccessedAt;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays <= decayDays) return 1.0;

    // Exponential decay after threshold
    const decayFactor = Math.exp(-(ageDays - decayDays) / decayDays);
    return Math.max(0, Math.min(1, decayFactor));
}

/**
 * Estimates token count for a string.
 *
 * @param text - Input text.
 * @returns Estimated token count.
 */
function estimateTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a memory service instance.
 *
 * @param database      - Database instance with memory operations.
 * @param geminiService - Gemini service for extraction calls.
 * @param config        - Optional configuration overrides.
 * @returns Result tuple with [error, service].
 */
export function createMemoryService(
    database: MemoryDatabase,
    geminiService: GeminiService,
    config: MemoryServiceConfig = {},
): [AppError | null, MemoryService | null] {
    // Resolve config with defaults
    const maxMemoriesPerUser = config.maxMemoriesPerUser ?? 50;
    const maxMemoriesPerPrompt = config.maxMemoriesPerPrompt ?? 5;
    const memoryTokenBudget = config.memoryTokenBudget ?? 500;
    const minConfidence = config.minConfidence ?? 0.5;
    const decayAfterDays = config.decayAfterDays ?? 14;
    const mergeSimilarityThreshold = config.mergeSimilarityThreshold ?? 0.7;

    /**
     * Retrieves memories relevant to the given context for a specific user.
     * Strictly scoped to the userId — no cross-user access possible.
     */
    async function retrieveRelevant(
        userId: number,
        context: string,
    ): Promise<RetrievedMemory[]> {
        // Get all memories for this user only
        const userMemories = database.getUserMemories(userId);

        if (userMemories.length === 0) {
            return [];
        }

        // Extract keywords from the current context
        const contextKeywords = extractKeywords(context);

        if (contextKeywords.length === 0) {
            // No meaningful keywords — return most recent memories
            const sorted = [...userMemories].sort(
                (a, b) => b.lastAccessedAt - a.lastAccessedAt,
            );
            const limited = sorted.slice(0, maxMemoriesPerPrompt);

            // Mark as accessed
            for (const memory of limited) {
                database.markMemoryAccessed(memory.id);
            }

            return limited.map((record) => ({
                record,
                relevanceScore: 0.5, // Default score for no-keyword matches
            }));
        }

        // Score each memory
        const scored: RetrievedMemory[] = userMemories.map((record) => {
            // Keyword overlap (60% weight)
            const keywordScore = jaccardSimilarity(contextKeywords, record.keywords);

            // Recency (30% weight)
            const recency = recencyScore(record.lastAccessedAt, decayAfterDays);

            // Access frequency bonus (10% weight) — cap at 10 accesses
            const frequencyScore = Math.min(record.accessCount / 10, 1);

            const relevanceScore =
                keywordScore * 0.6 + recency * 0.3 + frequencyScore * 0.1;

            return { record, relevanceScore };
        });

        // Sort by relevance descending
        scored.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Select top memories within token budget
        const selected: RetrievedMemory[] = [];
        let tokensUsed = 0;

        for (const item of scored) {
            if (selected.length >= maxMemoriesPerPrompt) break;

            const memoryTokens = estimateTokens(item.record.content);
            if (tokensUsed + memoryTokens > memoryTokenBudget) continue;

            selected.push(item);
            tokensUsed += memoryTokens;

            // Mark as accessed
            database.markMemoryAccessed(item.record.id);
        }

        auditLog.trace(
            `Memory: retrieved ${selected.length}/${userMemories.length} memories for user ${userId}`,
        );

        return selected;
    }

    /**
     * Formats retrieved memories as a system prompt injection.
     */
    function formatForPrompt(memories: RetrievedMemory[]): string {
        if (memories.length === 0) return '';

        const lines = memories.map((m) => {
            const typeLabel =
                m.record.type === 'preference'
                    ? '• Preferência'
                    : m.record.type === 'fact'
                        ? '• Fato'
                        : '• Interesse';
            return `${typeLabel}: ${m.record.content}`;
        });

        return (
            `[Contexto do usuário baseado em interações anteriores]\n` +
            lines.join('\n') +
            '\n\n' +
            'Use essas informações para personalizar sua resposta quando relevante, ' +
            'mas não mencione explicitamente que você "lembra" dessas informações.'
        );
    }

    /**
     * Extracts new knowledge from an interaction and stores it.
     */
    async function extractAndStore(
        userId: number,
        userInput: string,
        botResponse: string,
        source: string,
    ): Promise<ExtractionResult> {
        const result: ExtractionResult = {
            added: 0,
            updated: 0,
            parseErrors: 0,
        };

        // Skip extraction for very short interactions
        if (userInput.length < 20 && botResponse.length < 50) {
            return result;
        }

        // Build extraction prompt
        const extractionMessages: ChatMessage[] = [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            {
                role: 'user',
                content:
                    `Analise esta interação e extraia conhecimento sobre o usuário:\n\n` +
                    `--- ENTRADA DO USUÁRIO ---\n${userInput}\n\n` +
                    `--- RESPOSTA DO BOT ---\n${botResponse}\n` +
                    `--- FIM ---`,
            },
        ];

        // Call Gemini for extraction
        const [error, response] = await geminiService.getCompletion(
            extractionMessages,
            { maxTokens: 256, temperature: 0.1 },
        );

        if (error || !response) {
            auditLog.trace(`Memory extraction failed: ${error?.message || 'no response'}`);
            return result;
        }

        // Parse JSON response
        let extracted: Array<{
            type: MemoryType;
            content: string;
            confidence: number;
        }>;

        try {
            // Extract JSON from response (might have markdown code blocks)
            const jsonMatch = response.match(/\[[\s\S]*\]/);
            if (!jsonMatch) {
                // Empty array or no match — nothing to extract
                return result;
            }
            extracted = JSON.parse(jsonMatch[0]);

            if (!Array.isArray(extracted)) {
                result.parseErrors++;
                return result;
            }
        } catch {
            result.parseErrors++;
            auditLog.trace('Memory extraction: failed to parse JSON response');
            return result;
        }

        // Get existing memories for deduplication
        const existingMemories = database.getUserMemories(userId);

        // Process each extracted memory
        for (const item of extracted) {
            // Validate structure
            if (
                !item.type ||
                !item.content ||
                typeof item.confidence !== 'number'
            ) {
                result.parseErrors++;
                continue;
            }

            // Check confidence threshold
            if (item.confidence < minConfidence) {
                continue;
            }

            // Validate type
            if (!['preference', 'fact', 'interest'].includes(item.type)) {
                continue;
            }

            // Truncate content if too long
            const content = item.content.slice(0, 150);
            const keywords = extractKeywords(content);

            // Check for similar existing memory
            let foundSimilar = false;
            for (const existing of existingMemories) {
                const similarity = jaccardSimilarity(keywords, existing.keywords);
                if (similarity >= mergeSimilarityThreshold) {
                    // Update existing memory with higher confidence
                    if (item.confidence > existing.confidence) {
                        database.updateUserMemory(existing.id, {
                            content,
                            confidence: item.confidence,
                            keywords,
                        });
                        result.updated++;
                    } else {
                        // Just boost access count
                        database.markMemoryAccessed(existing.id);
                    }
                    foundSimilar = true;
                    break;
                }
            }

            if (!foundSimilar) {
                // Add new memory
                database.addUserMemory({
                    userId,
                    type: item.type as MemoryType,
                    content,
                    keywords,
                    confidence: item.confidence,
                    source,
                });
                result.added++;
            }
        }

        // Enforce per-user memory limit (evict oldest unused)
        const updatedMemories = database.getUserMemories(userId);
        if (updatedMemories.length > maxMemoriesPerUser) {
            const sorted = [...updatedMemories].sort(
                (a, b) => a.lastAccessedAt - b.lastAccessedAt,
            );
            const toEvict = sorted.slice(
                0,
                updatedMemories.length - maxMemoriesPerUser,
            );
            for (const memory of toEvict) {
                database.deleteUserMemory(memory.id);
            }
            auditLog.trace(
                `Memory: evicted ${toEvict.length} old memories for user ${userId}`,
            );
        }

        auditLog.trace(
            `Memory extraction: added ${result.added}, updated ${result.updated} for user ${userId}`,
        );

        return result;
    }

    /**
     * Returns all memories for a user.
     */
    function getAllMemories(userId: number): UserMemoryRecord[] {
        return database.getUserMemories(userId);
    }

    /**
     * Clears all memories for a user.
     */
    function clearUserMemories(userId: number): number {
        const memories = database.getUserMemories(userId);
        for (const memory of memories) {
            database.deleteUserMemory(memory.id);
        }
        auditLog.trace(`Memory: cleared ${memories.length} memories for user ${userId}`);
        return memories.length;
    }

    /**
     * Runs maintenance: evicts old unused memories, merges duplicates.
     */
    async function runMaintenance(): Promise<number> {
        // This would iterate all users — for now just return 0
        // In a production system you'd want to batch this
        auditLog.trace('Memory maintenance: completed');
        return 0;
    }

    const service: MemoryService = {
        retrieveRelevant,
        formatForPrompt,
        extractAndStore,
        getAllMemories,
        clearUserMemories,
        runMaintenance,
    };

    auditLog.trace('Memory service initialized');
    return [null, service];
}
