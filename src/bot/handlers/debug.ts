/**
 * =============================================================================
 * Debug Handlers - Monitoring and debugging commands
 * =============================================================================
 */

import { Context } from 'grammy';
import { RateLimiter } from '../middleware';
import { Database } from '../../database';
import { auditLog } from '../../assistant/audit-log';

/**
 * Debug handler configuration
 */
export interface DebugHandlerConfig {
  rateLimiter: RateLimiter;
  database?: Database;
  adminUserIds?: number[];  // Optional: restrict to admin users only
}

/**
 * Debug handler interface
 */
export interface DebugHandler {
  handleIdsCommand: (ctx: Context) => Promise<void>;
  handleStatsCommand: (ctx: Context) => Promise<void>;
  handleCleanupCommand: (ctx: Context) => Promise<void>;
}

/**
 * Creates the debug handler.
 * 
 * Factory function pattern - returns a closure of methods.
 * 
 * @param config - Handler configuration
 * @returns DebugHandler instance
 */
export function createDebugHandler(config: DebugHandlerConfig): DebugHandler {
  const { rateLimiter, database, adminUserIds } = config;

  /**
   * Checks if user is an admin
   */
  function isAdmin(userId: number | undefined): boolean {
    if (!userId) return false;
    if (!adminUserIds || adminUserIds.length === 0) return true;
    return adminUserIds.includes(userId);
  }

  /**
   * Handles /ids command - lists all users currently in locked state.
   * 
   * This is useful for monitoring if any locks are being held too long,
   * which could indicate a bug or performance issue.
   */
  async function handleIdsCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;

    if (!isAdmin(userId)) {
      await ctx.reply('🚫 This command is restricted to administrators.')
        .catch(() => {});
      return;
    }

    auditLog.trace(`/ids command invoked by user ${userId}`);

    const lockedUsers = rateLimiter.getLockedUsers();

    if (lockedUsers.length === 0) {
      await ctx.reply('✅ No users currently have locked state.')
        .catch(() => {});
      return;
    }

    // Format the response
    const lines = ['🔒 **Users with locked state:**', ''];
    
    for (const user of lockedUsers) {
      const ageSeconds = (user.oldestRequestAge / 1000).toFixed(2);
      lines.push(`• User \`${user.userId}\`: ${user.requestCount} requests, oldest: ${ageSeconds}s ago`);
    }

    lines.push('');
    lines.push(`Total: ${lockedUsers.length} user(s)`);

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
      .catch(() => {});

    auditLog.trace(`/ids: found ${lockedUsers.length} locked users`);
  }

  /**
   * Handles /stats command - shows database statistics
   */
  async function handleStatsCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;

    if (!isAdmin(userId)) {
      await ctx.reply('🚫 This command is restricted to administrators.')
        .catch(() => {});
      return;
    }

    if (!database) {
      await ctx.reply('❌ Database not available.')
        .catch(() => {});
      return;
    }

    auditLog.trace(`/stats command invoked by user ${userId}`);

    const stats = database.getStats();
    
    const lastCleanupStr = stats.lastCleanup 
      ? new Date(stats.lastCleanup).toISOString()
      : 'Never';
    
    const lastSavedStr = new Date(stats.lastSaved).toISOString();

    const lines = [
      '📊 **Database Statistics**',
      '',
      `💬 Conversations: ${stats.conversations}`,
      `🔗 Active Links: ${stats.links}`,
      `🔄 Duylhou Incidents: ${stats.incidents}`,
      `🏆 Leaderboard Entries: ${stats.leaderboardEntries}`,
      `⏱️ Rate Limit Records: ${stats.rateLimits}`,
      '',
      `🧹 Last Cleanup: ${lastCleanupStr}`,
      `💾 Last Saved: ${lastSavedStr}`,
    ];

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
      .catch(() => {});
  }

  /**
   * Handles /cleanup command - forces a database cleanup
   */
  async function handleCleanupCommand(ctx: Context): Promise<void> {
    const userId = ctx.from?.id;

    if (!isAdmin(userId)) {
      await ctx.reply('🚫 This command is restricted to administrators.')
        .catch(() => {});
      return;
    }

    if (!database) {
      await ctx.reply('❌ Database not available.')
        .catch(() => {});
      return;
    }

    auditLog.trace(`/cleanup command invoked by user ${userId}`);

    const result = database.runCleanup();

    const totalRemoved = 
      result.conversationsRemoved +
      result.linksRemoved +
      result.incidentsRemoved +
      result.leaderboardEntriesRemoved +
      result.rateLimitsRemoved;

    if (totalRemoved === 0) {
      await ctx.reply('✅ Cleanup complete. Nothing to remove.')
        .catch(() => {});
      return;
    }

    const lines = [
      '🧹 **Cleanup Complete**',
      '',
    ];

    if (result.conversationsRemoved > 0) {
      lines.push(`💬 Conversations: ${result.conversationsRemoved} removed`);
    }
    if (result.linksRemoved > 0) {
      lines.push(`🔗 Links: ${result.linksRemoved} removed`);
    }
    if (result.incidentsRemoved > 0) {
      lines.push(`🔄 Incidents: ${result.incidentsRemoved} removed`);
    }
    if (result.leaderboardEntriesRemoved > 0) {
      lines.push(`🏆 Leaderboard: ${result.leaderboardEntriesRemoved} removed`);
    }
    if (result.rateLimitsRemoved > 0) {
      lines.push(`⏱️ Rate Limits: ${result.rateLimitsRemoved} removed`);
    }

    lines.push('');
    lines.push(`**Total: ${totalRemoved} records removed**`);

    await ctx.reply(lines.join('\n'), { parse_mode: 'Markdown' })
      .catch(() => {});
  }

  return {
    handleIdsCommand,
    handleStatsCommand,
    handleCleanupCommand,
  };
}
