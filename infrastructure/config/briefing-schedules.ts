/**
 * briefing-schedules.ts
 *
 * Defines when the briefing generator Lambda runs.
 * Each entry creates an EventBridge Scheduler rule in America/New_York timezone.
 *
 * To change the schedule:
 *   1. Edit scheduleExpression below (standard cron syntax)
 *   2. git commit + push to main
 *   3. Amplify CI/CD runs `cdk deploy` automatically
 *
 * EventBridge Scheduler cron format:
 *   cron(minutes hours day-of-month month day-of-week year)
 *   Uses America/New_York timezone (set on the scheduler).
 */

export interface BriefingSchedule {
  /** Short identifier used in resource names */
  name: 'morning' | 'evening';
  /** Human-readable label used in the briefing title and manifest */
  label: 'Morning' | 'Evening';
  /** Display time in HH:MM 24h ET — used in manifest.json */
  time: string;
  /** EventBridge Scheduler cron expression — runs in America/New_York */
  scheduleExpression: string;
  /** Emoji prefix for the briefing header and Pushover notification */
  emoji: string;
}

export const BRIEFING_SCHEDULES: BriefingSchedule[] = [
  {
    name: 'morning',
    label: 'Morning',
    time: '08:00',
    scheduleExpression: 'cron(0 8 * * ? *)',   // 8:00am ET every day
    emoji: '☀️',
  },
  {
    name: 'evening',
    label: 'Evening',
    time: '17:30',
    scheduleExpression: 'cron(30 17 * * ? *)',  // 5:30pm ET every day
    emoji: '🌆',
  },
];
