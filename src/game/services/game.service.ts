/**
 * @fileoverview Game service handling all game logic and state transitions.
 * @SpellyBot.venv\Lib\site-packages\trio\_tests\__pycache__\module_with_deprecations.cpython-313.pyc game/services/game.service
 */

import { PlayerSession, AdventureEvent, Pokemon } from '../types';
import { pokemonService } from './pokemon.service';
import { SessionRepository } from '../repository';
import { JsonSessionRepository } from '../repositories/json-repository';

export class GameService {
  private repository: SessionRepository;

  /** Starter Pokémon by generation */
  private starters: Record<number, { id: number; name: string }[]> = {
    1: [{ id: 1, name: 'Bulbasaur' }, { id: 4, name: 'Charmander' }, { id: 7, name: 'Squirtle' }, { id: 25, name: 'Pikachu' }],
    2: [{ id: 152, name: 'Chikorita' }, { id: 155, name: 'Cyndaquil' }, { id: 158, name: 'Totodile' }],
    3: [{ id: 252, name: 'Treecko' }, { id: 255, name: 'Torchic' }, { id: 258, name: 'Mudkip' }],
    4: [{ id: 387, name: 'Turtwig' }, { id: 390, name: 'Chimchar' }, { id: 393, name: 'Piplup' }],
    5: [{ id: 495, name: 'Snivy' }, { id: 498, name: 'Tepig' }, { id: 501, name: 'Oshawott' }],
    6: [{ id: 650, name: 'Chespin' }, { id: 653, name: 'Fennekin' }, { id: 656, name: 'Froakie' }],
    7: [{ id: 722, name: 'Rowlet' }, { id: 725, name: 'Litten' }, { id: 728, name: 'Popplio' }],
    8: [{ id: 810, name: 'Grookey' }, { id: 813, name: 'Scorbunny' }, { id: 816, name: 'Sobble' }]
  };

  /** Weighted events for initial adventure phase */
  private startAdventureWeights: { item: AdventureEvent; weight: number }[] = [
    { item: 'CATCH_POKEMON', weight: 2 },
    { item: 'BATTLE_TRAINER', weight: 2 },
    { item: 'BUY_POTIONS', weight: 2 },
    { item: 'NOTHING', weight: 1 }
  ];

  /** Weighted events for main adventure phase */
  private mainAdventureWeights: { item: AdventureEvent; weight: number }[] = [
    { item: 'CATCH_POKEMON', weight: 3 },
    { item: 'BATTLE_TRAINER', weight: 1 },
    { item: 'BUY_POTIONS', weight: 1 },
    { item: 'NOTHING', weight: 1 },
    { item: 'CATCH_TWO', weight: 1 },
    { item: 'VISIT_DAYCARE', weight: 1 },
    { item: 'TEAM_ROCKET', weight: 1 },
    { item: 'MYSTERIOUS_EGG', weight: 1 },
    { item: 'LEGENDARY', weight: 1 },
    { item: 'TRADE', weight: 1 },
    { item: 'FIND_ITEM', weight: 1 },
    { item: 'EXPLORE_CAVE', weight: 1 },
    { item: 'SNORLAX', weight: 1 },
    { item: 'MULTITASK', weight: 1 },
    { item: 'FISHING', weight: 1 },
    { item: 'FOSSIL', weight: 1 },
    { item: 'RIVAL', weight: 1 }
  ];

  constructor() {
    this.repository = new JsonSessionRepository();
  }

  /**
   * Retrieves existing session or creates a new one with pre-determined generation.
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc userId - Player's unique identifier
   */
  async getSession(userId: number): Promise<PlayerSession> {
    let session = await this.repository.getSession(userId);

    if (!session) {
      const preSpinnedGeneration = this.spinGen();

      session = {
        userId,
        state: 'GEN_ROULETTE',
        gender: 'male',
        generation: preSpinnedGeneration,
        round: 0,
        team: [],
        storage: [],
        items: [{ id: 'potion', name: 'Poção', description: 'Revive o time', count: 1 }],
        badges: 0,
        gymRetriesLeft: 0
      };

      await this.repository.saveSession(session);
    }
    return session;
  }

  /** Persists session changes to storage. */
  async saveSession(session: PlayerSession): Promise<void> {
    await this.repository.saveSession(session);
  }

  /** Deletes and recreates session. */
  async resetSession(userId: number): Promise<PlayerSession> {
    await this.repository.deleteSession(userId);
    return this.getSession(userId);
  }

  /**
   * Weighted random selection.
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc options - Array of items with associated weights
   */
  spin<T>(options: { item: T; weight: number }[]): T {
    const totalWeight = options.reduce((acc, opt) => acc + opt.weight, 0);
    let random = Math.random() * totalWeight;
    for (const opt of options) {
      if (random < opt.weight) return opt.item;
      random -= opt.weight;
    }
    return options[0].item;
  }

  /** Spins for generation (1-8, equal weight). */
  spinGen(): number {
    const gens = [1, 2, 3, 4, 5, 6, 7, 8].map(g => ({ item: g, weight: 1 }));
    return this.spin(gens);
  }

  /** Spins for gender (50/50). */
  spinGender(): 'male' | 'female' {
    return this.spin([
      { item: 'male' as const, weight: 1 },
      { item: 'female' as const, weight: 1 }
    ]);
  }

  /**
   * Confirms generation selection and advances to gender selection.
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc userId - Player's unique identifier
   */
  async confirmGeneration(userId: number): Promise<PlayerSession> {
    const session = await this.getSession(userId);

    if (session.state === 'GEN_ROULETTE') {
      session.state = 'GENDER_ROULETTE';
      await this.repository.saveSession(session);
    }

    return session;
  }

  /**
   * Sets player gender and advances to starter selection.
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc userId - Player's unique identifier
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc gender - Selected gender
   */
  async selectGender(userId: number, gender: 'male' | 'female'): Promise<PlayerSession> {
    const session = await this.getSession(userId);

    if (session.state === 'GENDER_ROULETTE') {
      session.gender = gender;
      session.state = 'STARTER_ROULETTE';
      await this.repository.saveSession(session);
    }

    return session;
  }

  /**
   * Spins for starter Pokémon and adds to team.
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc userId - Player's unique identifier
   * @throws Error if session invalid or wrong state
   */
  async spinStarter(userId: number): Promise<void> {
    const session = await this.repository.getSession(userId);

    if (!session) {
      throw new Error('Session not found');
    }

    if (session.state !== 'STARTER_ROULETTE') {
      await this.repository.deleteSession(userId);
      throw new Error('Invalid state for starter selection');
    }

    if (session.team.length > 0) {
      return; // Idempotent: already has starter
    }

    const validStarters = this.starters[session.generation] || this.starters[1];
    const pick = validStarters[Math.floor(Math.random() * validStarters.length)];
    const isShiny = Math.random() < 0.01;

    const pokemonData = await pokemonService.getPokemon(pick.id, isShiny);

    const starterPokemon: Pokemon = {
      id: pick.id,
      name: pick.name,
      power: pokemonData?.power || 1,
      shiny: isShiny,
      baseStatsTotal: pokemonData?.baseStatsTotal || 300
    };

    session.team.push(starterPokemon);
    session.state = 'START_ADVENTURE';
    session.lastEvent = undefined;
    session.lastEventResult = undefined;

    await this.repository.saveSession(session);
  }

  /**
   * Spins the start adventure roulette and processes the resulting event.
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc userId - Player's unique identifier
   * @throws Error if session invalid or wrong state
   */
  async spinStartAdventure(userId: number): Promise<void> {
    const session = await this.repository.getSession(userId);

    if (!session) {
      throw new Error('Session not found');
    }

    if (session.state !== 'START_ADVENTURE') {
      throw new Error('Invalid state for start adventure');
    }

    const event = this.spin(this.startAdventureWeights);
    session.lastEvent = event;

    switch (event) {
      case 'CATCH_POKEMON':
        session.lastEventResult = await this.processCatchPokemon(session);
        session.state = 'ADVENTURE';
        break;

      case 'BATTLE_TRAINER':
        session.lastEventResult = this.processBattleTrainer(session);
        session.state = 'ADVENTURE';
        break;

      case 'BUY_POTIONS':
        session.lastEventResult = this.processBuyPotions(session);
        session.state = 'ADVENTURE';
        break;

      case 'NOTHING':
        session.lastEventResult = 'Nada aconteceu... Tente novamente!';
        // Stay in START_ADVENTURE
        break;
    }

    await this.repository.saveSession(session);
  }

  /**
   * Processes CATCH_POKEMON event - adds random Pokémon to team.
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc session - Current player session
   * @returns Result message
   */
  private async processCatchPokemon(session: PlayerSession): Promise<string> {
    // Generate random Pokémon ID based on generation range
    const genRanges: Record<number, [number, number]> = {
      1: [1, 151],
      2: [152, 251],
      3: [252, 386],
      4: [387, 493],
      5: [494, 649],
      6: [650, 721],
      7: [722, 809],
      8: [810, 905]
    };

    const [min, max] = genRanges[session.generation] || genRanges[1];
    const pokemonId = Math.floor(Math.random() * (max - min + 1)) + min;
    const isShiny = Math.random() < 0.01;

    const pokemon = await pokemonService.getPokemon(pokemonId, isShiny);

    if (pokemon && session.team.length < 6) {
      session.team.push(pokemon);
      const shinyText = pokemon.shiny ? ' ✨SHINY✨' : '';
      return `Você capturou ${pokemon.name}${shinyText}!`;
    } else if (pokemon) {
      session.storage.push(pokemon);
      return `Você capturou ${pokemon.name}! (Enviado ao PC)`;
    }

    return 'O Pokémon fugiu...';
  }

  /**
   * Processes BATTLE_TRAINER event.
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc session - Current player session
   * @returns Result message
   */
  private processBattleTrainer(session: PlayerSession): string {
    const won = this.calculateBattleVictory(session);

    if (won) {
      return 'Você venceu a batalha contra um treinador!';
    } else {
      return 'Você perdeu a batalha, mas seus Pokémon estão bem.';
    }
  }

  /**
   * Processes BUY_POTIONS event - adds potion to inventory.
   * @telegram_ai_bot_A\venv\Lib\site-packages\openai\types\__pycache__\auto_file_chunking_strategy_param.cpython-313.pyc session - Current player session
   * @returns Result message
   */
  private processBuyPotions(session: PlayerSession): string {
    const potion = session.items.find(i => i.id === 'potion');

    if (potion) {
      potion.count++;
    } else {
      session.items.push({
        id: 'potion',
        name: 'Poção',
        description: 'Revive o time',
        count: 1
      });
    }

    return 'Você comprou uma Poção na loja!';
  }

  /** Calculates battle victory based on team power vs round difficulty. */
  calculateBattleVictory(session: PlayerSession): boolean {
    const teamPower = session.team.reduce((acc, p) => acc + p.power, 0);
    const yesWedges = 1 + teamPower;
    const noWedges = session.round + 1;
    const totalWedges = yesWedges + noWedges;
    return Math.random() < yesWedges / totalWedges;
  }

  /** Uses a potion from inventory. Returns true if successful. */
  usePotion(session: PlayerSession): boolean {
    const potion = session.items.find(i => i.id === 'potion');
    if (potion && potion.count > 0) {
      potion.count--;
      return true;
    }
    return false;
  }
}

export const gameService = new GameService();