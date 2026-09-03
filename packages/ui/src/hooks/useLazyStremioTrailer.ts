import { useState, useEffect, useRef } from 'react';
import type { StremioMeta } from '../types/stremio';
import { getTmdb, searchMovies, searchTvShows, getMovieVideos, getTvShowVideos, findTrailerUrl } from '../services/tmdb';

interface StremioTrailerResult {
  trailerUrl: string | null;
  loading: boolean;
}

export function useLazyStremioTrailer(
  meta: StremioMeta | null,
  accessToken: string | null
): StremioTrailerResult {
  const [trailerUrl, setTrailerUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const fetchingRef = useRef(false);

  useEffect(() => {
    setTrailerUrl(null);
    if (!meta || !accessToken) {
      setLoading(false);
      return;
    }
    if (fetchingRef.current) return;

    let cancelled = false;

    const fetchTrailer = async () => {
      fetchingRef.current = true;
      setLoading(true);

      try {
        const isSeries = meta.type === 'series';
        const title = meta.name;
        const year = meta.year;

        let tmdbId: number | null = null;

        // 1. Try to get TMDB ID directly from meta ID if it starts with tmdb:
        if (meta.id.startsWith('tmdb:')) {
          tmdbId = parseInt(meta.id.replace('tmdb:', ''), 10);
        }

        // 2. Try to get it from moviedb_id
        if (!tmdbId && (meta as any).moviedb_id) {
          tmdbId = parseInt(String((meta as any).moviedb_id), 10);
        }

        // 3. Try finding it by IMDb ID via TMDB find API
        if (!tmdbId && meta.id.startsWith('tt')) {
          try {
            const tmdb = getTmdb(accessToken);
            const findResult = await tmdb.find.byExternalId(meta.id, { external_source: 'imdb_id' });
            if (isSeries) {
              tmdbId = findResult.tv_results?.[0]?.id || null;
            } else {
              tmdbId = findResult.movie_results?.[0]?.id || null;
            }
          } catch (err) {
            console.error('[TMDB] Find by IMDb ID failed in trailer hook:', err);
          }
        }

        // 4. Fallback to title/year search
        if (!tmdbId) {
          if (isSeries) {
            const results = await searchTvShows(accessToken, title, year ? parseInt(String(year)) : undefined);
            if (!cancelled && results.length > 0) {
              tmdbId = results[0].id;
            }
          } else {
            const results = await searchMovies(accessToken, title, year ? parseInt(String(year)) : undefined);
            if (!cancelled && results.length > 0) {
              tmdbId = results[0].id;
            }
          }
        }

        if (!tmdbId || cancelled) {
          fetchingRef.current = false;
          setLoading(false);
          return;
        }

        const videos = isSeries
          ? await getTvShowVideos(accessToken, tmdbId)
          : await getMovieVideos(accessToken, tmdbId);

        if (!cancelled) {
          const url = findTrailerUrl(videos);
          setTrailerUrl(url);
        }
      } catch {
        // Silently fail
      } finally {
        fetchingRef.current = false;
        if (!cancelled) setLoading(false);
      }
    };

    fetchTrailer();

    return () => {
      cancelled = true;
      fetchingRef.current = false;
    };
  }, [meta?.id, meta?.name, meta?.year, meta?.type, accessToken]);

  return { trailerUrl, loading };
}
