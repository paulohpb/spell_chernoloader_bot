import { PlayerSession, AdventureEvent, Item } from '../types';
import { pokemonService } from './pokemon.service';

export class GameService {
  private sessions: Map<number, PlayerSession> = new Map();

  // Dados dos Iniciais por Geração (ID e Nome para Fallback)
  private starters: Record<number, {id: number, name: string}[]> = {
    1: [{id: 1, name: 'Bulbasaur'}, {id: 4, name: 'Charmander'}, {id: 7, name: 'Squirtle'}, {id: 25, name: 'Pikachu'}],
    2: [{id: 152, name: 'Chikorita'}, {id: 155, name: 'Cyndaquil'}, {id: 158, name: 'Totodile'}],
    3: [{id: 252, name: 'Treecko'}, {id: 255, name: 'Torchic'}, {id: 258, name: 'Mudkip'}],
    4: [{id: 387, name: 'Turtwig'}, {id: 390, name: 'Chimchar'}, {id: 393, name: 'Piplup'}],
    5: [{id: 495, name: 'Snivy'}, {id: 498, name: 'Tepig'}, {id: 501, name: 'Oshawott'}],
    6: [{id: 650, name: 'Chespin'}, {id: 653, name: 'Fennekin'}, {id: 656, name: 'Froakie'}],
    7: [{id: 722, name: 'Rowlet'}, {id: 725, name: 'Litten'}, {id: 728, name: 'Popplio'}],
    8: [{id: 810, name: 'Grookey'}, {id: 813, name: 'Scorbunny'}, {id: 816, name: 'Sobble'}]
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
      const validStarters = this.starters[generation] || this.starters[1];
      const pick = validStarters[Math.floor(Math.random() * validStarters.length)];
      const isShiny = Math.random() < 0.02; // 2% chance
      
      const mon = await pokemonService.getPokemon(pick.id, isShiny);
      
      if (mon) return mon;

      // Fallback se a API falhar
      return {
          id: pick.id,
          name: pick.name,
          power: 1, // Power básico
          shiny: isShiny,
          baseStatsTotal: 300 // Média baixa
      };
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