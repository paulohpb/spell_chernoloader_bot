import { PlayerSession, AdventureEvent, Item } from '../types';

export class GameService {
  private sessions: Map<number, PlayerSession> = new Map();

  // Weights for "What to do first?" (Start of game)
  private startAdventureWeights: { item: AdventureEvent; weight: number }[] = [
    { item: 'CATCH_POKEMON', weight: 2 },
    { item: 'BATTLE_TRAINER', weight: 2 },
    { item: 'BUY_POTIONS', weight: 2 },
    { item: 'NOTHING', weight: 1 } // "Go Straight"
  ];

  // Weights for "Adventure Continues" (Between Gyms)
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
        state: 'GEN_ROULETTE', // Start here
        gender: 'male',
        generation: 1,
        round: 0,
        team: [],
        storage: [],
        items: [{ id: 'potion', name: 'Potion', description: 'Retry a battle', count: 1 }],
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

  // Generic Roulette Spinner
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
    // Equal weights for Gens 1-8
    const gens = [1, 2, 3, 4, 5, 6, 7, 8].map(g => ({ item: g, weight: 1 }));
    return this.spin(gens);
  }

  spinGender(): 'male' | 'female' {
    return this.spin([{ item: 'male', weight: 1 }, { item: 'female', weight: 1 }]) as 'male' | 'female';
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
    const noWedges = session.round + 1; // Difficulty increases with round
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
