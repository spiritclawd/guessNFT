import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { useGameCharacters } from '@/core/store/selectors';
import { renderPortrait } from '@/rendering/canvas/PortraitRenderer';
import ImageCache from '@/shared/services/ImageCache';

/**
 * Generates portrait preview URLs for all characters.
 *
 * OPTIMIZED: Uses unified ImageCache to prevent duplicate loading.
 * Images loaded here are shared with Three.js textures.
 *
 * Used in UI panels (character select, guess panel) where we need
 * thumbnails rather than Three.js textures.
 *
 * FIXED: Removed polling hack, now uses proper async loading with callbacks.
 */
export function useCharacterPreviews(): Map<string, string> {
  const characters = useGameCharacters();
  const [loadedCount, setLoadedCount] = useState(0);
  const loadingRef = useRef<Set<string>>(new Set());

  // Track which images we've started loading
  const pendingLoads = useRef<Map<string, Promise<void>>>(new Map());

  useEffect(() => {
    // Count how many images are already cached
    const cachedCount = characters.filter(c => ImageCache.has(c.id)).length;
    if (cachedCount !== loadedCount) {
      setLoadedCount(cachedCount);
    }
  }, [characters, loadedCount]);

  return useMemo(() => {
    const map = new Map<string, string>();
    // For large collections (>50 tokens), skip expensive canvas generation.
    const skipCanvas = characters.length > 50;

    for (const char of characters) {
      // Priority 1: Check unified cache for URL
      const cachedUrl = ImageCache.getUrl(char.id);
      if (cachedUrl) {
        map.set(char.id, cachedUrl);
        continue;
      }

      // Priority 2: Use imageUrl directly for NFT characters
      const imageUrl = (char as any).imageUrl as string | undefined;
      if (imageUrl) {
        map.set(char.id, imageUrl);

        // Trigger async load for future cache hits (deduped by ImageCache)
        if (!loadingRef.current.has(char.id)) {
          loadingRef.current.add(char.id);
          ImageCache.load(char.id, imageUrl).then(() => {
            loadingRef.current.delete(char.id);
            // Trigger re-render to pick up cached URL
            setLoadedCount(c => c + 1);
          });
        }
        continue;
      }

      if (skipCanvas) continue; // Large collection — colour swatch used instead

      // Priority 3: Fall back to procedural canvas portrait (small collections only)
      const texture = renderPortrait(char);
      if (texture.image instanceof HTMLCanvasElement) {
        const small = document.createElement('canvas');
        small.width = 128;
        small.height = 128;
        const ctx = small.getContext('2d')!;
        ctx.drawImage(texture.image, 0, 0, 128, 128);
        const dataUrl = small.toDataURL();
        map.set(char.id, dataUrl);

        // Also cache for future use
        ImageCache.setProcedural(char.id, texture.image);
      }
      texture.dispose();
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characters, loadedCount]);
}

/**
 * Hook for a single character preview - more efficient for individual use
 */
export function useCharacterPreview(charId: string): string | null {
  const characters = useGameCharacters();
  const char = characters.find(c => c.id === charId);
  const [previewUrl, setPreviewUrl] = useState<string | null>(() => {
    // Initialize synchronously from cache if available
    return ImageCache.getUrl(charId) ?? null;
  });

  useEffect(() => {
    if (!char) {
      setPreviewUrl(null);
      return;
    }

    // Check cache first
    const cached = ImageCache.getUrl(charId);
    if (cached) {
      setPreviewUrl(cached);
      return;
    }

    // Use direct URL if available
    const imageUrl = (char as any).imageUrl as string | undefined;
    if (imageUrl) {
      setPreviewUrl(imageUrl);
      // Trigger async load (deduped by ImageCache)
      ImageCache.load(charId, imageUrl).then(() => {
        const url = ImageCache.getUrl(charId);
        if (url) setPreviewUrl(url);
      });
      return;
    }

    // Generate procedural
    const texture = renderPortrait(char);
    if (texture.image instanceof HTMLCanvasElement) {
      const small = document.createElement('canvas');
      small.width = 128;
      small.height = 128;
      const ctx = small.getContext('2d')!;
      ctx.drawImage(texture.image, 0, 0, 128, 128);
      setPreviewUrl(small.toDataURL());
      ImageCache.setProcedural(charId, texture.image);
    }
    texture.dispose();
  }, [charId, char]);

  return previewUrl;
}
