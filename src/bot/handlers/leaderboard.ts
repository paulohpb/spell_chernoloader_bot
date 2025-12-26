/**
 * =============================================================================
 * Leaderboard Handler - Displays Duylhou rankings
 * 
 * Shows who triggered the most 'Duylhou' alerts in the current month.
 * Rankings persist for a month, then a new "greatest Duyllier" is crowned.
 * =============================================================================
 */

import { Context } from 'grammy';
import { Database, LeaderboardRanking } from '../../database';
import { AppError, Result } from '../../assistant/types';
import { auditLog } from '../../assistant/audit-log';

/**
 * Leaderboard handler error codes
 */
export const LEADERBOARD_ERROR_CODES = {
  FETCH_FAILED: 'LEADERBOARD_001',
  USER_RESOLVE_FAILED: 'LEADERBOARD_002',
} as const;

/**
 * Leaderboard handler configuration
 */
export interface LeaderboardHandlerConfig {
  database: Database;
  maxEntries?: number;  // Default: 10
}

/**
 * Leaderboard handler interface
 */
export interface LeaderboardHandler {
  handleCommand: (ctx: Context) => Promise<void>;
  getLeaderboard: (month?: string) => Result<LeaderboardRanking[]>;
}

/**
 * Creates a leaderboard error
 */
function createLeaderboardError(code: string, message: string, details?: string): AppError {
  return {
    code,
    category: 'LLM',
    message,
    details,
  };
}

/**
 * Medal emojis for top ranks
 */
const RANK_MEDALS: Record<number, string> = {
  1: '🥇',
  2: '🥈',
  3: '🥉',
};

/**
 * Gets month name from YYYY-MM format
 */
function getMonthName(month: string): string {
  const [year, monthNum] = month.split('-');
  const date = new Date(parseInt(year), parseInt(monthNum) - 1);
  return date.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Creates the leaderboard handler.
 * 
 * Factory function pattern - returns a closure of methods.
 * 
 * @param config - Handler configuration
 * @returns LeaderboardHandler instance
 */
export function createLeaderboardHandler(config: LeaderboardHandlerConfig): LeaderboardHandler {
  const { database, maxEntries = 10 } = config;

  /**
   * Gets the leaderboard data
   */
  async function getLeaderboard(month?: string): Result<LeaderboardRanking[]> {
    return Promise.resolve()
      .then(() => {
        const rankings = database.getDuylhouLeaderboard(month, maxEntries);
        auditLog.trace(`Leaderboard fetched: ${rankings.length} entries`);
        return [null, rankings] as [null, LeaderboardRanking[]];
      })
      .catch((e: Error) => {
        const error = createLeaderboardError(
          LEADERBOARD_ERROR_CODES.FETCH_FAILED,
          'Failed to fetch leaderboard',
          e.message
        );
        auditLog.record(error.code, { error: e.message });
        return [error, null] as [AppError, null];
      });
  }

  /**
   * Resolves a user ID to a display name
   */
  async function resolveUserName(ctx: Context, userId: number): Promise<string> {
    return ctx.api.getChatMember(ctx.chat!.id, userId)
      .then((member) => {
        const user = member.user;
        if (user.username) {
          return `@${user.username}`;
        }
        return user.first_name + (user.last_name ? ` ${user.last_name}` : '');
      })
      .catch(() => `User ${userId}`);
  }

  /**
   * Handles the /leaderboard command
   */
  async function handleCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (!chatId) return;

    auditLog.trace(`/leaderboard command invoked in chat ${chatId}`);

    const [error, rankings] = await getLeaderboard();

    if (error) {
      await ctx.reply('❌ Failed to fetch leaderboard. Please try again later.')
        .catch(() => {});
      return;
    }

    if (!rankings || rankings.length === 0) {
      const currentMonth = database.getCurrentMonth();
      const monthName = getMonthName(currentMonth);
      await ctx.reply(
        `📊 **Duylhou Leaderboard - ${monthName}**\n\n` +
        `No incidents recorded yet this month.\n` +
        `Be careful not to become the first Duyllier! 🔄`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
      return;
    }

    // Build the leaderboard message
    const currentMonth = database.getCurrentMonth();
    const monthName = getMonthName(currentMonth);
    
    const lines: string[] = [
      `📊 **Duylhou Leaderboard - ${monthName}**`,
      '',
    ];

    // Check if we have a clear winner (rank 1 with no ties)
    const topCount = rankings[0].count;
    const topRankers = rankings.filter(r => r.count === topCount);
    
    if (topRankers.length === 1 && topCount >= 3) {
      lines.push(`👑 **Current Greatest Duyllier** 👑`);
      lines.push('');
    }

    // Resolve user names and build entries
    for (const ranking of rankings) {
      const userName = await resolveUserName(ctx, ranking.userId);
      const medal = RANK_MEDALS[ranking.rank] || `${ranking.rank}.`;
      const plural = ranking.count === 1 ? 'time' : 'times';
      
      lines.push(`${medal} ${userName} - ${ranking.count} ${plural}`);
    }

    lines.push('');
    lines.push('_Reposting links that were already shared = Duylhou!_');

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
      .catch(() => {});

    auditLog.trace(`Leaderboard displayed with ${rankings.length} entries`);
  }

  return {
    handleCommand,
    getLeaderboard,
  };
}
