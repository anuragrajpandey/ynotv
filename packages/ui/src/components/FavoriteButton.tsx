import React from 'react';
import { useTranslation } from 'react-i18next';
import { setChannelFavorite } from '../db';
import { useFavoriteOverride, useFavoriteOverridesStore } from '../stores/favoriteOverridesStore';
import './FavoriteButton.css';

interface FavoriteButtonProps {
    streamId: string;
    isFavorite: boolean;
    onToggle?: () => void;
    // Render the star as an SVG outline/filled glyph (matches the EPG category
    // list star) instead of the ★/☆ text character.
    svg?: boolean;
}

export function FavoriteButton({ streamId, isFavorite, onToggle, svg = false }: FavoriteButtonProps) {
    const { t } = useTranslation('live');
    const override = useFavoriteOverride(streamId);
    const setOverride = useFavoriteOverridesStore((s) => s.setOverride);

    // The optimistic override wins so the star flips instantly on click,
    // before the database write (and the debounced live-query refresh) lands.
    const effectiveFavorite = override ?? isFavorite;

    async function handleClick(e: React.MouseEvent) {
        e.stopPropagation(); // Prevent triggering channel selection

        const previous = effectiveFavorite;
        const next = !previous;

        // Optimistic UI: flip the star immediately.
        setOverride(streamId, next);

        try {
            await setChannelFavorite(streamId, next);
            if (onToggle) {
                onToggle();
            }
        } catch (err) {
            console.error('[FavoriteButton] Error toggling favorite:', err);
            // Revert to the previous state on failure.
            setOverride(streamId, previous);
        }
    }

    return (
        <button
            className={`favorite-btn ${svg ? 'favorite-btn-svg' : ''} ${effectiveFavorite ? 'favorited' : ''}`}
            onClick={handleClick}
            title={effectiveFavorite ? t('removeFromFavorites') : t('addToFavorites')}
        >
            {svg ? (
                <svg viewBox="0 0 24 24" fill={effectiveFavorite ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                </svg>
            ) : effectiveFavorite ? '★' : '☆'}
        </button>
    );
}
