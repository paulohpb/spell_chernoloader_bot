import { PlayerSession, AdventureEvent, Item } from '../types';
import { pokemonService } from './pokemon.service';

export class GameService {
  private sessions: Map<number, PlayerSession> = new Map();

  // Dados dos Iniciais por Geração
  private starters: Record<number, number[]> = {
    1: [1, 4, 7, 25],      // Bulbasaur, Charmander, Squirtle, Pikachu
    2: [152, 155, 158],    // Chikorita, Cyndaquil, Totodile
    3: [252, 255, 258],    // Treecko, Torchic, Mudkip
    4: [387, 390, 393],    // Turtwig, Chimchar, Piplup
    5: [495, 498, 501],    // Snivy, Tepig, Oshawott
    6: [650, 653, 656],    // Chespin, Fennekin, Froakie
    7: [722, 725, 728],    // Rowlet, Litten, Popplio
    8: [810, 813, 816]     // Grookey, Scorbunny, Sobble
  };

  // Pesos para eventos (Aventura)
  private startAdventureWeights: { item: AdventureEvent; weight: number }[] = [
    { item: 'CATCH_POKEMON', weight: 2 },
    { item: 'BATTLE_TRAINER', weight: 2 },
    { item: 'BUY_POTIONS', weight: 2 },
    { item: 'NOTHING', weight: 1 }
  ];

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
    { item: 'RIVAL', weight: 1 },
  ];

  getSession(userId: number): PlayerSession {
    if (!this.sessions.has(userId)) {
      this.sessions.set(userId, {
        userId,
        state: 'GEN_ROULETTE',
        gender: 'male',
        generation: 1,
        round: 0,
        team: [],
        storage: [],
        items: [{ id: 'potion', name: 'Poção', description: 'Revive o time', count: 1 }],
        badges: 0,
        gymRetriesLeft: 0
      });
    }
    return this.sessions.get(userId)!;
  }

  resetSession(userId: number) {
    this.sessions.delete(userId);
    return this.getSession(userId);
  }

  spin<T>(options: { item: T, weight: number }[]): T {
    const totalWeight = options.reduce((acc, opt) => acc + opt.weight, 0);
    let random = Math.random() * totalWeight;
    for (const opt of options) {
      if (random < opt.weight) return opt.item;
      random -= opt.weight;
    }
    return options[0].item;
  }

  spinGen(): number {
    const gens = [1, 2, 3, 4, 5, 6, 7, 8].map(g => ({ item: g, weight: 1 }));
    return this.spin(gens);
  }

  spinGender(): 'male' | 'female' {
    return this.spin([{ item: 'male', weight: 1 }, { item: 'female', weight: 1 }]) as 'male' | 'female';
  }

  // NOVA FUNÇÃO: Sorteia um inicial válido da geração atual
  async spinStarter(generation: number) {
      const validIds = this.starters[generation] || this.starters[1];
      const pickId = validIds[Math.floor(Math.random() * validIds.length)];
      const isShiny = Math.random() < 0.02; // 2% chance
      return await pokemonService.getPokemon(pickId, isShiny);
  }

  spinStartAdventure(): AdventureEvent {
    return this.spin(this.startAdventureWeights);
  }

  spinMainAdventure(): AdventureEvent {
    return this.spin(this.mainAdventureWeights);
  }

  calculateBattleVictory(session: PlayerSession): boolean {
    const teamPower = session.team.reduce((acc, p) => acc + p.power, 0);
    const yesWedges = 1 + teamPower; 
    const noWedges = session.round + 1; 
    const totalWedges = yesWedges + noWedges;
    return Math.random() < (yesWedges / totalWedges);
  }

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
