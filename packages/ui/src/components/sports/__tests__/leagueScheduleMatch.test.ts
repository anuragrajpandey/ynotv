import { describe, it, expect } from 'vitest';
import type { SportsEvent } from '@ynotv/core';

function filterScheduleEvents(
  events: SportsEvent[],
  targetDate: Date,
  isIndividualSport: boolean = false
): SportsEvent[] {
  if (isIndividualSport) {
    return events;
  }
  return events
    .filter((event) => {
      const eventDate = event.startTime instanceof Date ? event.startTime : new Date(event.startTime);
      return (
        eventDate.getFullYear() === targetDate.getFullYear() &&
        eventDate.getMonth() === targetDate.getMonth() &&
        eventDate.getDate() === targetDate.getDate()
      );
    })
    .sort((a, b) => {
      const timeA = a.startTime instanceof Date ? a.startTime.getTime() : new Date(a.startTime).getTime();
      const timeB = b.startTime instanceof Date ? b.startTime.getTime() : new Date(b.startTime).getTime();
      return timeA - timeB;
    });
}

function makeEvent(id: string, name: string, startTime: Date, leagueId = 'nfl'): SportsEvent {
  return {
    id,
    title: name,
    homeTeam: { id: `home_${id}`, name: `Home ${id}` },
    awayTeam: { id: `away_${id}`, name: `Away ${id}` },
    league: { id: leagueId, name: leagueId.toUpperCase(), sport: 'football' },
    startTime,
    status: 'scheduled',
    channels: [],
  };
}

describe('League schedule game date matching', () => {
  const thursday = new Date(2026, 7, 20, 20, 0); // 2026-08-20 20:00 (Thu)
  const fridayEarly = new Date(2026, 7, 21, 18, 0); // 2026-08-21 18:00 (Fri)
  const fridayLate = new Date(2026, 7, 21, 20, 30); // 2026-08-21 20:30 (Fri)
  const saturday = new Date(2026, 7, 22, 19, 0); // 2026-08-22 19:00 (Sat)
  const sunday = new Date(2026, 7, 23, 13, 0); // 2026-08-23 13:00 (Sun)

  const nflWeekEvents: SportsEvent[] = [
    makeEvent('1', 'SAN vs LOS', thursday),
    makeEvent('2', 'NEW vs PIT', fridayEarly),
    makeEvent('3', 'CAR vs JAC', fridayLate),
    makeEvent('4', 'GRE vs DEN', saturday),
    makeEvent('5', 'WAS vs DET', sunday),
  ];

  it('filters to only games scheduled on Thursday when Thursday is selected', () => {
    const matched = filterScheduleEvents(nflWeekEvents, new Date(2026, 7, 20));
    expect(matched.length).toBe(1);
    expect(matched[0].id).toBe('1');
    expect(matched[0].title).toBe('SAN vs LOS');
  });

  it('filters to only games scheduled on Friday when Friday is selected', () => {
    const matched = filterScheduleEvents(nflWeekEvents, new Date(2026, 7, 21));
    expect(matched.length).toBe(2);
    expect(matched.map((e) => e.id)).toEqual(['2', '3']);
  });

  it('sorts games on the same day chronologically by startTime', () => {
    // Pass in reverse order
    const reverseFriday = [
      makeEvent('3', 'CAR vs JAC', fridayLate),
      makeEvent('2', 'NEW vs PIT', fridayEarly),
    ];
    const matched = filterScheduleEvents(reverseFriday, new Date(2026, 7, 21));
    expect(matched[0].id).toBe('2'); // 18:00 before 20:30
    expect(matched[1].id).toBe('3');
  });

  it('returns empty array when no games are scheduled for the selected day', () => {
    const wednesday = new Date(2026, 7, 19);
    const matched = filterScheduleEvents(nflWeekEvents, wednesday);
    expect(matched.length).toBe(0);
  });

  it('bypasses daily filter for individual sports (e.g. PGA, UFC tournaments)', () => {
    const matched = filterScheduleEvents(nflWeekEvents, new Date(2026, 7, 20), true);
    expect(matched.length).toBe(5);
  });
});
