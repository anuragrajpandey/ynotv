import { describe, it, expect } from 'vitest';
import {
  extractTeamSearchTerms,
  buildTeamSearchQueries,
  buildTeamSearchQuery,
  stripCityPrefix,
  splitTeamName,
} from '../teamChannelMatcher';
import { buildSearchQueryClauses, matchesSearch } from '../../../utils/searchNormalization';

describe('teamChannelMatcher search improvements', () => {
  describe('extractTeamSearchTerms', () => {
    it('extracts city and nickname for soccer teams with prefix club names', () => {
      const skc = extractTeamSearchTerms('Sporting Kansas City');
      expect(skc.city).toBe('Kansas City');
      expect(skc.nickname).toBe('Sporting');

      const rsl = extractTeamSearchTerms('Real Salt Lake');
      expect(rsl.city).toBe('Salt Lake');
      expect(rsl.nickname).toBe('Real');

      const imcf = extractTeamSearchTerms('Inter Miami CF');
      expect(imcf.city).toBe('Miami');
      expect(imcf.nickname).toBe('Inter');
    });

    it('extracts city and nickname for soccer teams with suffix club names', () => {
      const atl = extractTeamSearchTerms('Atlanta United FC');
      expect(atl.city).toBe('Atlanta');
      expect(atl.nickname).toBe('United');

      const revs = extractTeamSearchTerms('New England Revolution');
      expect(revs.city).toBe('New England');
      expect(revs.nickname).toBe('Revolution');

      const nycfc = extractTeamSearchTerms('New York City FC');
      expect(nycfc.city).toBe('New York City');
    });

    it('extracts city and nickname for standard major league teams', () => {
      const chiefs = extractTeamSearchTerms('Kansas City Chiefs');
      expect(chiefs.city).toBe('Kansas City');
      expect(chiefs.nickname).toBe('Chiefs');

      const ravens = extractTeamSearchTerms('Baltimore Ravens');
      expect(ravens.city).toBe('Baltimore');
      expect(ravens.nickname).toBe('Ravens');

      const lakers = extractTeamSearchTerms('Los Angeles Lakers');
      expect(lakers.city).toBe('Los Angeles');
      expect(lakers.nickname).toBe('Lakers');
    });
  });

  describe('buildTeamSearchQueries', () => {
    it('generates City vs. City and nickname candidates for MLS matchup (Sporting KC vs Atlanta Utd)', () => {
      const queries = buildTeamSearchQueries('Sporting Kansas City', 'Atlanta United FC', 'mls');
      
      // Must contain City vs City variants
      expect(queries).toContain('Kansas City Atlanta');
      expect(queries).toContain('Atlanta Kansas City');

      // Must contain nickname variants
      expect(queries).toContain('Sporting United');
    });

    it('generates City vs. City candidates for New England Revolution vs New York City FC', () => {
      const queries = buildTeamSearchQueries('New England Revolution', 'New York City FC', 'mls');
      
      expect(queries.some((q) => q.includes('New England') && q.includes('New York'))).toBe(true);
    });

    it('generates both nickname and city queries for NFL games (Chiefs vs Ravens)', () => {
      const queries = buildTeamSearchQueries('Kansas City Chiefs', 'Baltimore Ravens', 'nfl');
      
      expect(queries).toContain('Kansas City Baltimore');
      expect(queries).toContain('Chiefs Ravens');
    });

    it('handles individual sports (UFC, F1) using event title', () => {
      const queries = buildTeamSearchQueries('Fighter A', 'Fighter B', 'ufc', 'UFC 300: Pereira vs Prochazka');
      expect(queries).toEqual(['UFC 300: Pereira vs Prochazka']);
    });

    it('handles college sports with mascot stripping', () => {
      const queries = buildTeamSearchQueries('Alabama Crimson Tide', 'Georgia Bulldogs', 'college-football');
      expect(queries).toContain('Alabama Georgia');
    });
  });

  describe('EPG string matching simulation', () => {
    it('matches provider EPG program title "(Apple) (MLS) 003 | Atlanta vs. Kansas City" against generated queries', () => {
      const epgTitle = '(Apple) (MLS) 003 | Atlanta vs. Kansas City (2026-08-23 18:25:00)';
      const queries = buildTeamSearchQueries('Sporting Kansas City', 'Atlanta United FC', 'mls');

      // At least one generated query must match the EPG title via matchesSearch
      const matches = queries.some((q) => matchesSearch(epgTitle, q));
      expect(matches).toBe(true);
    });

    it('matches provider EPG program title with underscore "(Apple) (MLS) 001 | New England vs. New_York_City" against generated queries', () => {
      const epgTitle = '(Apple) (MLS) 001 | New England vs. New_York_City (2026-08-23 16:25:00)';
      const queries = buildTeamSearchQueries('New England Revolution', 'New York City FC', 'mls');

      const matches = queries.some((q) => matchesSearch(epgTitle, q));
      expect(matches).toBe(true);
    });
  });
});
