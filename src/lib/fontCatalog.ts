import { isLocalMediaUri, resolveBrowserMediaUrl } from './browserMediaStore';

export type FontCategoryId =
  | 'Modern'
  | 'Bold & Viral'
  | 'Condensed'
  | 'Clean'
  | 'Elegant'
  | 'Arabic'
  | 'Custom';

export interface FontCatalogItem {
  family: string;
  category: Exclude<FontCategoryId, 'Custom'>;
  weights: number[];
  defaultWeight: number;
  supportsItalic: boolean;
  isArabic?: boolean;
  sampleText?: string;
}

export type FontLoadStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface FontStatusEntry {
  family: string;
  status: FontLoadStatus;
  error?: string;
  availableForExport?: boolean;
  source?: 'builtin' | 'custom' | 'system';
  loadedWeights?: number[];
}

export const FONT_CATEGORIES: FontCategoryId[] = [
  'Modern',
  'Bold & Viral',
  'Condensed',
  'Clean',
  'Elegant',
  'Arabic',
  'Custom',
];

export const BUILTIN_FONT_CATALOG: FontCatalogItem[] = [
  // Modern
  { family: 'Inter', category: 'Modern', weights: [300, 400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Poppins', category: 'Modern', weights: [300, 400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Montserrat', category: 'Modern', weights: [300, 400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Manrope', category: 'Modern', weights: [300, 400, 500, 600, 700, 800], defaultWeight: 700, supportsItalic: false },
  { family: 'DM Sans', category: 'Modern', weights: [400, 500, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Plus Jakarta Sans', category: 'Modern', weights: [400, 500, 600, 700, 800], defaultWeight: 700, supportsItalic: true },

  // Bold and viral
  { family: 'Anton', category: 'Bold & Viral', weights: [400], defaultWeight: 400, supportsItalic: false },
  { family: 'Bebas Neue', category: 'Bold & Viral', weights: [400], defaultWeight: 400, supportsItalic: false },
  { family: 'Oswald', category: 'Bold & Viral', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: false },
  { family: 'Archivo Black', category: 'Bold & Viral', weights: [400], defaultWeight: 400, supportsItalic: false },
  { family: 'Impact', category: 'Bold & Viral', weights: [400, 700, 900], defaultWeight: 700, supportsItalic: false },

  // Condensed
  { family: 'Roboto Condensed', category: 'Condensed', weights: [400, 500, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Barlow Condensed', category: 'Condensed', weights: [400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Teko', category: 'Condensed', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: false },

  // Clean
  { family: 'Roboto', category: 'Clean', weights: [300, 400, 500, 700, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Open Sans', category: 'Clean', weights: [400, 600, 700, 800], defaultWeight: 700, supportsItalic: true },
  { family: 'Lato', category: 'Clean', weights: [400, 700, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Nunito Sans', category: 'Clean', weights: [400, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },

  // Elegant
  { family: 'Playfair Display', category: 'Elegant', weights: [400, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: true },
  { family: 'Cormorant Garamond', category: 'Elegant', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: true },
  { family: 'Libre Baskerville', category: 'Elegant', weights: [400, 700], defaultWeight: 700, supportsItalic: true },

  // Arabic
  { family: 'Cairo', category: 'Arabic', weights: [400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'ملخص فيلم مشوق جداً' },
  { family: 'Tajawal', category: 'Arabic', weights: [400, 500, 700, 800, 900], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'أحداث مثيرة ومفاجئة' },
  { family: 'IBM Plex Sans Arabic', category: 'Arabic', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'القصة الكاملة باحترافية' },
  { family: 'Noto Sans Arabic', category: 'Arabic', weights: [400, 500, 600, 700, 800, 900], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'نهاية غير متوقعة للقصة' },
  { family: 'Almarai', category: 'Arabic', weights: [400, 700, 800], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'ترجمة عربية احترافية' },
  { family: 'Changa', category: 'Arabic', weights: [400, 500, 600, 700, 800], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'عنوان عربي قوي وجذاب' },
  { family: 'Readex Pro', category: 'Arabic', weights: [400, 500, 600, 700], defaultWeight: 700, supportsItalic: false, isArabic: true, sampleText: 'مشهد حاسم في الفيلم' },
];

export const WEIGHT_LABELS: Record<number, string> = {
  100: '100 Thin',
  200: '200 ExtraLight',
  300: '300 Light',
  400: '400 Regular',
  500: '500 Medium',
  600: '600 SemiBold',
  700: '700 Bold',
  800: '800 ExtraBold',
  900: '900 Black',
};

export function resolveClosestSupportedWeight(family: string, desired: number): number {
  const item = BUILTIN_FONT_CATALOG.find((f) => f.family.toLowerCase() === family.toLowerCase());
  if (!item || item.weights.length === 0) return desired;
  if (item.weights.includes(desired)) return desired;
  return item.weights.reduce((best, cur) =>
    Math.abs(cur - desired) < Math.abs(best - desired) ? cur : best
  );
}

const statusCache = new Map<string, FontStatusEntry>();
const pendingLoads = new Map<string, Promise<FontStatusEntry>>();
const listeners = new Set<() => void>();
const injectedGoogleFontLinks = new Set<string>();

function notifyFontListeners() {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // ignore
    }
  }
}

export function subscribeFontStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getFontStatus(family: string, weight = 400): FontStatusEntry {
  const key = `${family}::${weight}`;
  return (
    statusCache.get(key) ||
    statusCache.get(`${family}::any`) || {
      family,
      status: 'idle',
    }
  );
}

export function getAllLoadedFontStatuses(): Record<string, FontStatusEntry> {
  const out: Record<string, FontStatusEntry> = {};
  for (const [k, v] of statusCache.entries()) {
    out[k] = v;
  }
  return out;
}

function injectGoogleFontStylesheet(family: string, weights: number[], supportsItalic: boolean): void {
  if (typeof document === 'undefined' || family.toLowerCase() === 'impact') return;
  const linkKey = `${family}:${weights.join(',')}`;
  if (injectedGoogleFontLinks.has(linkKey)) return;
  injectedGoogleFontLinks.add(linkKey);

  const uniqWeights = Array.from(new Set(weights)).sort((a, b) => a - b);
  const encodedFamily = family.trim().replace(/\s+/g, '+');
  let spec = '';
  if (supportsItalic) {
    const tuples = [
      ...uniqWeights.map((w) => `0,${w}`),
      ...uniqWeights.map((w) => `1,${w}`),
    ];
    spec = `ital,wght@${tuples.join(';')}`;
  } else {
    spec = `wght@${uniqWeights.join(';')}`;
  }

  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodedFamily}:${spec}&display=swap`;
  document.head.appendChild(link);
}

export async function ensureFontLoaded(params: {
  family: string;
  weight?: number;
  italic?: boolean;
  customUrl?: string;
}): Promise<FontStatusEntry> {
  const { family, italic = false, customUrl } = params;
  const cleanFamily = (family || '').trim();
  if (!cleanFamily) {
    return { family: '', status: 'error', error: 'No font family selected.' };
  }

  const resolvedWeight = customUrl
    ? params.weight || 400
    : resolveClosestSupportedWeight(cleanFamily, params.weight || 700);
  const key = `${cleanFamily}::${resolvedWeight}${italic ? 'i' : ''}`;

  const existing = statusCache.get(key);
  if (existing && existing.status === 'loaded') {
    return existing;
  }

  const inflight = pendingLoads.get(key);
  if (inflight) return inflight;

  const task = (async (): Promise<FontStatusEntry> => {
    statusCache.set(key, { family: cleanFamily, status: 'loading' });
    notifyFontListeners();

    try {
      if (customUrl) {
        const resolvedUrl = isLocalMediaUri(customUrl)
          ? await resolveBrowserMediaUrl(customUrl)
          : customUrl;
        if (!resolvedUrl) {
          throw new Error(`Custom font "${cleanFamily}" was not found in browser storage.`);
        }
        if (typeof FontFace !== 'undefined' && typeof document !== 'undefined') {
          const descriptors: FontFaceDescriptors = {
            weight: String(resolvedWeight),
            style: italic ? 'italic' : 'normal',
          };
          const face = new FontFace(cleanFamily, `url('${resolvedUrl}')`, descriptors);
          const loadedFace = await face.load();
          document.fonts.add(loadedFace);
          await document.fonts.ready;
        }
        const okEntry: FontStatusEntry = {
          family: cleanFamily,
          status: 'loaded',
          availableForExport: true,
          source: 'custom',
          loadedWeights: [resolvedWeight],
        };
        statusCache.set(key, okEntry);
        statusCache.set(`${cleanFamily}::any`, okEntry);
        notifyFontListeners();
        return okEntry;
      }

      // Built-in catalog font or system font loaded client-side via Google Fonts / document.fonts
      const catalogItem = BUILTIN_FONT_CATALOG.find(
        (f) => f.family.toLowerCase() === cleanFamily.toLowerCase()
      );
      if (catalogItem && cleanFamily.toLowerCase() !== 'impact') {
        injectGoogleFontStylesheet(
          catalogItem.family,
          catalogItem.weights,
          catalogItem.supportsItalic
        );
      }

      if (typeof document !== 'undefined' && document.fonts) {
        const spec = `${italic ? 'italic ' : ''}${resolvedWeight} 32px '${cleanFamily}'`;
        await Promise.race([
          document.fonts.load(spec),
          new Promise((resolve) => setTimeout(resolve, 3500)),
        ]);
      }

      const okEntry: FontStatusEntry = {
        family: cleanFamily,
        status: 'loaded',
        availableForExport: true,
        source: catalogItem ? 'builtin' : 'system',
        loadedWeights: [resolvedWeight],
      };
      statusCache.set(key, okEntry);
      statusCache.set(`${cleanFamily}::any`, okEntry);
      notifyFontListeners();
      return okEntry;
    } catch (err) {
      const failEntry: FontStatusEntry = {
        family: cleanFamily,
        status: 'error',
        availableForExport: false,
        error: err instanceof Error ? err.message : String(err),
      };
      statusCache.set(key, failEntry);
      statusCache.set(`${cleanFamily}::any`, failEntry);
      notifyFontListeners();
      return failEntry;
    } finally {
      pendingLoads.delete(key);
    }
  })();

  pendingLoads.set(key, task);
  return task;
}
