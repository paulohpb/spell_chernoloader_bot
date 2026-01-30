export type GameState = 
  | 'GEN_ROULETTE'       // 1. Spin for Generation
  | 'GENDER_ROULETTE'    // 2. Spin for Gender
  | 'STARTER_ROULETTE'   // 3. Spin for Starter
  | 'START_ADVENTURE'    // 4. "What to do first?"
  | 'ADVENTURE'          // 5. "Adventure Continues" (Between Gyms)
  | 'GYM_BATTLE'         // 6. Battle logic
  | 'EVOLUTION'          // 7. Post-Gym Reward
  | 'GAME_OVER'
  | 'VICTORY';

export interface Pokemon {
  id: number;
  name: string;
  power: number;
  shiny: boolean;
  baseStatsTotal: number;
}

export interface Item {
  id: string;
  name: string;
  description: string;
  count: number;
}

export interface GymLeader {
  name: string;
  sprite: string;
  quote: string;
  type: string;
  badge: string;
}

export interface PlayerSession {
  userId: number;
  state: GameState;
  gender: 'male' | 'female';
  generation: number;
  round: number; // 0-8. 8 = Elite 4/Champion
  team: Pokemon[];
  storage: Pokemon[];
  items: Item[];
  badges: number;
  gymRetriesLeft: number;
  lastEventResult?: string;
  lastEvent?: AdventureEvent;
  lastCapturedPokemon?: Pokemon; // Track last captured for UI display
}

export type AdventureEvent = 
  | 'CATCH_POKEMON' | 'BATTLE_TRAINER' | 'BUY_POTIONS' | 'NOTHING' 
  | 'CATCH_TWO' | 'VISIT_DAYCARE' | 'TEAM_ROCKET' | 'MYSTERIOUS_EGG' 
  | 'LEGENDARY' | 'TRADE' | 'FIND_ITEM' | 'EXPLORE_CAVE' 
  | 'SNORLAX' | 'MULTITASK' | 'FISHING' | 'FOSSIL' | 'RIVAL';
