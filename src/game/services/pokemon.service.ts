import axios from 'axios';
import { Pokemon } from '../types';
import { evolutionChain } from '../data/evolution';

export class PokemonService {
  private cache: Map<number, Pokemon> = new Map();
  private readonly API_URL = 'https://pokeapi.co/api/v2/pokemon';

  private calculatePower(bst: number): number {
    if (bst < 320) return 1;
    if (bst < 450) return 2;
    if (bst < 580) return 3;
    if (bst < 670) return 4;
    return 5;
  }

  // Check if ID exists in the chain keys
  canEvolve(id: number): boolean {
    return !!evolutionChain[id];
  }

  // Get new Pokemon data for evolution
  async evolve(pokemon: Pokemon): Promise<Pokemon | null> {
    const possibleEvolutions = evolutionChain[pokemon.id];
    if (!possibleEvolutions) return null;

    // Pick random evolution (e.g. for Eevee)
    const nextId = possibleEvolutions[Math.floor(Math.random() * possibleEvolutions.length)];
    
    // Fetch new species data (keeps shiny status)
    return this.getPokemon(nextId, pokemon.shiny);
  }

  async getPokemon(id: number, isShiny: boolean = false): Promise<Pokemon | null> {
    if (this.cache.has(id)) {
      const cached = this.cache.get(id)!;
      return { ...cached, shiny: isShiny };
    }

    try {
      const response = await axios.get(`${this.API_URL}/${id}`);
      const data = response.data;
      
      const bst = data.stats.reduce((acc: number, stat: any) => acc + stat.base_stat, 0);
      const power = this.calculatePower(bst);

      const pokemon: Pokemon = {
        id: data.id,
        name: data.name.charAt(0).toUpperCase() + data.name.slice(1),
        power: power,
        shiny: isShiny,
        baseStatsTotal: bst
      };

      this.cache.set(id, pokemon);
      return pokemon;
    } catch (error) {
      console.error(`Failed to fetch Pokemon ID ${id}`);
      return null;
    }
  }

  async getRandomPokemon(gen: number): Promise<Pokemon | null> {
    const ranges: {[key: number]: [number, number]} = {
      1: [1, 151], 2: [152, 251], 3: [252, 386], 4: [387, 493],
      5: [494, 649], 6: [650, 721], 7: [722, 809], 8: [810, 905]
    };

    const [min, max] = ranges[gen] || ranges[1];
    const randomId = Math.floor(Math.random() * (max - min + 1)) + min;
    const isShiny = Math.random() < 0.01;
    
    return this.getPokemon(randomId, isShiny);
  }
}

export const pokemonService = new PokemonService();
