import { describe, it, expect, vi } from 'vitest';
import {
  normalizeGenre,
  fuzzyMatchAddon,
  findAddonForSource,
  getFolderResolvedSources,
  resolveCollectionsForHero,
} from '../collectionSourceResolver';
import type { NuvioCollection, NuvioCollectionFolder, NuvioCollectionSource } from '../nuvio-api';
import type { InstalledAddon } from '../../types/stremio';

describe('collectionSourceResolver', () => {
  describe('normalizeGenre', () => {
    it('returns undefined for empty, null, or "none"', () => {
      expect(normalizeGenre(null)).toBeUndefined();
      expect(normalizeGenre(undefined)).toBeUndefined();
      expect(normalizeGenre('')).toBeUndefined();
      expect(normalizeGenre('none')).toBeUndefined();
      expect(normalizeGenre('None')).toBeUndefined();
    });

    it('returns trimmed valid genre', () => {
      expect(normalizeGenre(' Action ')).toBe('Action');
      expect(normalizeGenre('Sci-Fi')).toBe('Sci-Fi');
    });
  });

  describe('findAddonForSource', () => {
    const mockAddons: InstalledAddon[] = [
      {
        id: 'community.cinemeta',
        baseUrl: 'https://v3-cinemeta.strem.io',
        manifest: {
          id: 'community.cinemeta',
          name: 'Cinemeta',
          version: '1.0.0',
          resources: ['catalog', 'meta'],
          types: ['movie', 'series'],
          catalogs: [
            { id: 'top', type: 'movie', name: 'Popular Movies' },
            { id: 'top', type: 'series', name: 'Popular Series' },
          ],
        },
      },
      {
        id: 'com.cyberflix.catalog',
        baseUrl: 'https://cyberflix.strem.fun',
        manifest: {
          id: 'com.cyberflix.catalog',
          name: 'Cyberflix',
          version: '1.0.0',
          resources: ['catalog'],
          types: ['movie'],
          catalogs: [
            { id: 'cyberflix.popular', type: 'movie', name: 'Cyberflix Popular' },
          ],
        },
      },
    ];

    it('matches exact addon ID and catalog type', () => {
      const source: NuvioCollectionSource = {
        provider: 'addon',
        addonId: 'com.cyberflix.catalog',
        type: 'movie',
        catalogId: 'cyberflix.popular',
      };
      const match = findAddonForSource(source, mockAddons);
      expect(match?.id).toBe('com.cyberflix.catalog');
    });

    it('falls back to finding catalog across addons when addonId is generic or omitted', () => {
      const source: NuvioCollectionSource = {
        provider: 'addon',
        addonId: '',
        type: 'movie',
        catalogId: 'top',
      };
      const match = findAddonForSource(source, mockAddons);
      expect(match?.id).toBe('community.cinemeta');
    });
  });

  describe('getFolderResolvedSources', () => {
    it('returns folder sources array when present', () => {
      const folder: NuvioCollectionFolder = {
        id: 'f1',
        title: 'Action Movies',
        focusGifEnabled: false,
        tileShape: 'poster',
        hideTitle: false,
        sources: [
          { provider: 'addon', addonId: 'cinemeta', type: 'movie', catalogId: 'top' },
        ],
      };
      expect(getFolderResolvedSources(folder)).toHaveLength(1);
    });

    it('converts legacy catalogSources array if sources is empty', () => {
      const folder: any = {
        id: 'f2',
        title: 'Sci-Fi',
        focusGifEnabled: false,
        tileShape: 'poster',
        hideTitle: false,
        catalogSources: [
          { addonId: 'cinemeta', type: 'movie', catalogId: 'top', genre: 'Sci-Fi' },
        ],
      };
      const resolved = getFolderResolvedSources(folder);
      expect(resolved).toHaveLength(1);
      expect(resolved[0].genre).toBe('Sci-Fi');
    });
  });

  describe('resolveCollectionsForHero', () => {
    it('returns empty array when collections have no folders', async () => {
      const emptyCollections: NuvioCollection[] = [
        {
          id: 'c1',
          title: 'Empty Coll',
          pinToTop: false,
          viewMode: 'TABBED_GRID',
          showAllTab: true,
          folders: [],
        },
      ];
      const result = await resolveCollectionsForHero(emptyCollections, []);
      expect(result).toEqual([]);
    });
  });
});
