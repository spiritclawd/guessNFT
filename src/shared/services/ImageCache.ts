/**
 * ImageCache - Unified image loading and caching service
 *
 * SOLVES: Duplicate image loading between Three.js and React UI
 *
 * Features:
 * - Single source of truth for all loaded images
 * - Request deduplication (in-flight promises tracked)
 * - Provides THREE.Texture for WebGL
 * - Provides URLs for React <img> elements
 * - Provides HTMLCanvasElement for TextureAtlas
 * - Preloading support for visible characters first
 *
 * FIXED BUGS:
 * - globalTextureCache.set() now creates entry if missing
 * - getUrl() returns original URL when available (not always data URL)
 */

import * as THREE from 'three';

// ─── Types ────────────────────────────────────────────────────────────────

interface CachedImage {
  /** The loaded image element (source) */
  image: HTMLImageElement | HTMLCanvasElement;
  /** Pre-computed THREE.Texture (lazy-created on demand) */
  texture: THREE.Texture | null;
  /** Data URL for React <img> (lazy-created on demand) */
  dataUrl: string | null;
  /** Original URL used to load this image */
  sourceUrl: string;
  /** Timestamp when loaded */
  loadedAt: number;
}

interface LoadOptions {
  /** Size to resize image to (default: 128) */
  size?: number;
  /** Force reload even if cached */
  force?: boolean;
}

// ─── Global Cache & Deduplication ─────────────────────────────────────────

/** Main cache: character ID → cached image data */
const imageCache = new Map<string, CachedImage>();

/** In-flight promises to deduplicate concurrent requests */
const pendingLoads = new Map<string, Promise<HTMLImageElement | HTMLCanvasElement | null>>();

/** Pre-computed procedural canvases (instant placeholders) */
const proceduralCache = new Map<string, HTMLCanvasElement>();

/** Original image URLs for direct <img> use (avoids data URL creation) */
const originalUrls = new Map<string, string>();

/** Configuration */
const DEFAULT_SIZE = 128;
const MAX_CACHE_SIZE = 1500; // Limit memory for large NFT collections

// ─── Helper Functions ─────────────────────────────────────────────────────

/**
 * Extract image hash from schizodio URL for fast API path
 * Input:  "https://v1assets.schizod.io/images/revealed/5b377cf6...png"
 * Output: "5b377cf6..."
 */
function extractImageHash(url: string): string | null {
  const match = url.match(/\/([a-f0-9]+)\.png$/i);
  return match ? match[1] : null;
}

/**
 * Get URL priority list for loading (fastest first)
 */
function getLoadUrls(charId: string, imageUrl?: string): string[] {
  const numericId = charId.replace('nft_', '');
  const hash = imageUrl ? extractImageHash(imageUrl) : null;

  return [
    hash ? `/api/nft-img?hash=${hash}` : null,  // Fastest - direct hash
    `/nft/${numericId}.png`,                     // Local static
    `/api/nft-art/${numericId}`,                 // Slow fallback
    imageUrl,                                     // Original URL as last resort
  ].filter(Boolean) as string[];
}

/**
 * Load image from URL with timeout
 */
function loadImage(url: string, timeout = 10000): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';

    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      resolve(null);
    }, timeout);

    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };

    img.onerror = () => {
      clearTimeout(timer);
      resolve(null);
    };

    img.src = url;
  });
}

/**
 * Resize image to target size using canvas
 */
function resizeImage(source: HTMLImageElement | HTMLCanvasElement, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(source, 0, 0, size, size);
  return canvas;
}

/**
 * Evict old entries if cache is too large
 */
function evictIfNeeded(): void {
  if (imageCache.size <= MAX_CACHE_SIZE) return;

  // Sort by age and remove oldest
  const entries = Array.from(imageCache.entries());
  entries.sort((a, b) => a[1].loadedAt - b[1].loadedAt);

  const toEvict = entries.slice(0, entries.length - MAX_CACHE_SIZE);
  for (const [id, cached] of toEvict) {
    if (cached.texture) {
      cached.texture.dispose();
    }
    imageCache.delete(id);
    originalUrls.delete(id);
    proceduralCache.delete(id);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

export const ImageCache = {
  /**
   * Load and cache an image for a character.
   * Returns immediately if already cached.
   * Deduplicates concurrent requests for the same character.
   */
  async load(
    charId: string,
    imageUrl?: string,
    options: LoadOptions = {}
  ): Promise<HTMLImageElement | HTMLCanvasElement | null> {
    const { size = DEFAULT_SIZE, force = false } = options;

    // Store original URL for direct <img> use (avoids expensive data URL)
    if (imageUrl && !originalUrls.has(charId)) {
      originalUrls.set(charId, imageUrl);
    }

    // Return cached if available and not forcing reload
    if (!force && imageCache.has(charId)) {
      return imageCache.get(charId)!.image;
    }

    // Check for in-flight request (deduplication)
    if (pendingLoads.has(charId)) {
      return pendingLoads.get(charId)!;
    }

    // Start loading
    const loadPromise = (async (): Promise<HTMLImageElement | HTMLCanvasElement | null> => {
      const urls = getLoadUrls(charId, imageUrl);

      for (const url of urls) {
        const img = await loadImage(url);
        if (img) {
          const resized = resizeImage(img, size);
          imageCache.set(charId, {
            image: resized,
            texture: null,
            dataUrl: null,
            sourceUrl: url,
            loadedAt: Date.now(),
          });
          evictIfNeeded();
          return resized;
        }
      }

      return null;
    })();

    pendingLoads.set(charId, loadPromise);

    try {
      const result = await loadPromise;
      return result;
    } finally {
      pendingLoads.delete(charId);
    }
  },

  /**
   * Get cached image, or null if not loaded yet
   */
  get(charId: string): HTMLImageElement | HTMLCanvasElement | null {
    return imageCache.get(charId)?.image ?? null;
  },

  /**
   * Get THREE.Texture for WebGL rendering.
   * Creates texture lazily if image is cached but texture isn't.
   */
  getTexture(charId: string): THREE.Texture | null {
    const cached = imageCache.get(charId);
    if (!cached) return null;

    // Lazy-create texture
    if (!cached.texture) {
      const texture = new THREE.CanvasTexture(
        cached.image instanceof HTMLCanvasElement
          ? cached.image
          : resizeImage(cached.image, DEFAULT_SIZE)
      );
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      cached.texture = texture;
    }

    return cached.texture;
  },

  /**
   * Get URL for React <img> element.
   * FIX: Returns original imageUrl if available (avoids expensive data URL)
   * Falls back to data URL only if no original URL exists.
   */
  getUrl(charId: string): string | null {
    // Priority 1: Return original URL if we have it (free, no conversion)
    const originalUrl = originalUrls.get(charId);
    if (originalUrl) {
      return originalUrl;
    }

    // Priority 2: Create data URL from cached canvas
    const cached = imageCache.get(charId);
    if (!cached) return null;

    // Don't create data URL for procedural placeholders (use original URL if available)
    if (cached.sourceUrl === 'procedural') {
      return null;
    }

    // Lazy-create data URL only as fallback
    if (!cached.dataUrl) {
      if (cached.image instanceof HTMLCanvasElement) {
        cached.dataUrl = cached.image.toDataURL();
      } else {
        const canvas = resizeImage(cached.image, DEFAULT_SIZE);
        cached.dataUrl = canvas.toDataURL();
      }
    }

    return cached.dataUrl;
  },

  /**
   * Get original source URL (for direct <img> use)
   */
  getSourceUrl(charId: string): string | null {
    return imageCache.get(charId)?.sourceUrl ?? null;
  },

  /**
   * Check if image is cached
   */
  has(charId: string): boolean {
    return imageCache.has(charId);
  },

  /**
   * Check if image is currently loading
   */
  isLoading(charId: string): boolean {
    return pendingLoads.has(charId);
  },

  /**
   * Store a procedural canvas (instant placeholder)
   */
  setProcedural(charId: string, canvas: HTMLCanvasElement): void {
    proceduralCache.set(charId, canvas);

    // Also store in main cache if not already there
    if (!imageCache.has(charId)) {
      imageCache.set(charId, {
        image: canvas,
        texture: null,
        dataUrl: null,
        sourceUrl: 'procedural',
        loadedAt: Date.now(),
      });
    }
  },

  /**
   * Get procedural canvas placeholder
   */
  getProcedural(charId: string): HTMLCanvasElement | null {
    return proceduralCache.get(charId) ?? null;
  },

  /**
   * Batch load images for multiple characters.
   * Loads in parallel batches to avoid overwhelming the browser.
   */
  async batchLoad(
    characters: Array<{ id: string; imageUrl?: string }>,
    options: LoadOptions & { batchSize?: number; batchDelay?: number } = {}
  ): Promise<void> {
    const { batchSize = 20, batchDelay = 50, ...loadOptions } = options;

    for (let i = 0; i < characters.length; i += batchSize) {
      const batch = characters.slice(i, i + batchSize);

      await Promise.all(
        batch.map(char => this.load(char.id, char.imageUrl, loadOptions))
      );

      if (i + batchSize < characters.length && batchDelay > 0) {
        await new Promise(r => setTimeout(r, batchDelay));
      }
    }
  },

  /**
   * Preload visible characters first (for perceived performance)
   * visibleIndices: indices of characters currently visible on screen
   */
  async preloadVisible(
    characters: Array<{ id: string; imageUrl?: string }>,
    visibleIndices: number[],
    options: LoadOptions = {}
  ): Promise<void> {
    // Load visible first
    const visibleChars = visibleIndices
      .filter(i => i >= 0 && i < characters.length)
      .map(i => characters[i]);

    await this.batchLoad(visibleChars, { ...options, batchDelay: 0 });
  },

  /**
   * Clear all cached data
   */
  clear(): void {
    for (const cached of imageCache.values()) {
      if (cached.texture) {
        cached.texture.dispose();
      }
    }
    imageCache.clear();
    proceduralCache.clear();
    pendingLoads.clear();
    originalUrls.clear();
  },

  /**
   * Get cache stats for debugging
   */
  getStats(): { cached: number; pending: number; procedural: number; originalUrls: number } {
    return {
      cached: imageCache.size,
      pending: pendingLoads.size,
      procedural: proceduralCache.size,
      originalUrls: originalUrls.size,
    };
  },

  /** Expose caches for compatibility with existing code */
  _textureCache: imageCache,
  _proceduralCache: proceduralCache,
};

// ─── Backward Compatibility Exports ───────────────────────────────────────

/**
 * For existing code that imports globalTextureCache
 *
 * FIX: set() now creates entry if it doesn't exist (prevents silent data loss)
 */
export const globalTextureCache = {
  get(charId: string): THREE.Texture | undefined {
    const texture = ImageCache.getTexture(charId);
    return texture ?? undefined;
  },
  set(charId: string, texture: THREE.Texture): void {
    // FIX: Create entry if it doesn't exist
    const cached = imageCache.get(charId);
    if (cached) {
      cached.texture = texture;
    } else {
      // Create a new entry with the texture
      // Note: image will be null, but texture is set
      imageCache.set(charId, {
        image: texture.image as HTMLCanvasElement,
        texture: texture,
        dataUrl: null,
        sourceUrl: 'external',
        loadedAt: Date.now(),
      });
    }
  },
  has(charId: string): boolean {
    return ImageCache.has(charId);
  },
};

/** For existing code that imports proceduralCanvasCache */
export const proceduralCanvasCache = {
  get(charId: string): HTMLCanvasElement | undefined {
    return proceduralCache.get(charId) ?? undefined;
  },
  set(charId: string, canvas: HTMLCanvasElement): void {
    ImageCache.setProcedural(charId, canvas);
  },
  has(charId: string): boolean {
    return proceduralCache.has(charId);
  },
};

export default ImageCache;
