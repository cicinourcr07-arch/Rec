import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  EyeOff,
  Flame,
  Layers,
  Loader2,
  Lock,
  Merge,
  Move,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Sparkles,
  Star,
  Trash2,
  Type,
  Unlock,
  UploadCloud,
} from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import {
  CaptionAnimationPreset,
  CaptionDisplayMode,
  CaptionElementLayer,
  CaptionHighlightBehavior,
  CaptionSegment,
  CaptionTextTransform,
  DEFAULT_SUBTITLE_STYLE,
  Project,
  SavedFontAsset,
  StudioElementSelection,
  StudioPreset,
  StudioPresetAssetRef,
  SubtitleStyle,
} from '../types/studio';
import { api } from '../lib/api';
import {
  BUILTIN_FONT_CATALOG,
  ensureFontLoaded,
  FONT_CATEGORIES,
  FontCategoryId,
  FontStatusEntry,
  getFontStatus,
  resolveClosestSupportedWeight,
  subscribeFontStatus,
  WEIGHT_LABELS,
} from '../lib/fontCatalog';
import { CAPTION_DISPLAY_MODES, normalizeCanonicalMode } from '../lib/captionModes';
import {
  buildCaptionsFromTranscript,
  computeCaptionSyncStatus,
  countMissingTranslations,
  createWorkflowUpdate,
  getSyncedCaptionsForPreview,
} from '../lib/workflowStages';
import { PresetLibraryPanel } from '../components/PresetLibraryPanel';

interface CaptionsPageProps {
  project: Project;
  onProjectUpdated: (p: Project) => void;
  onSeek: (time: number) => void;
  customFonts?: SavedFontAsset[];
  onCustomFontsChanged?: () => void;
  selectedElement?: StudioElementSelection;
  onSelectElement?: (el: StudioElementSelection) => void;
}

interface TrendingPresetDef {
  id: string;
  name: string;
  tag: string;
  previewBg: string;
  previewFg: string;
  sampleWord: string;
  style: Partial<SubtitleStyle>;
}

const TRENDING_PRESETS: TrendingPresetDef[] = [
  {
    id: 'tiktok-pop',
    name: 'TikTok Word Pop',
    tag: '1 Word',
    previewBg: '#09090B',
    previewFg: '#FFFFFF',
    sampleWord: 'SHOCKING',
    style: {
      template: 'tiktok',
      mode: 'word-by-word',
      fontFamily: 'Montserrat',
      fontSize: 44,
      fontWeight: '900',
      fontWeightNum: 900,
      primaryColor: '#FFFFFF',
      highlightColor: '#FACC15',
      gradientEnabled: false,
      highlightBoxEnabled: false,
      outlineColor: '#000000',
      outlineWidth: 4,
      backgroundOpacity: 0,
      shadowEnabled: true,
      textTransform: 'uppercase',
      uppercase: true,
      animationPreset: 'word-popup',
      highlightBehavior: 'scale',
    },
  },
  {
    id: 'hormozi-bold',
    name: 'Bold Viral',
    tag: 'Two Words',
    previewBg: '#111827',
    previewFg: '#4ADE80',
    sampleWord: 'THE TWIST',
    style: {
      template: 'custom',
      mode: 'two-words',
      fontFamily: 'Bebas Neue',
      fontSize: 48,
      fontWeight: 'bold',
      fontWeightNum: 400,
      primaryColor: '#4ADE80',
      highlightColor: '#FACC15',
      gradientEnabled: false,
      highlightBoxEnabled: false,
      outlineColor: '#000000',
      outlineWidth: 5,
      backgroundOpacity: 0,
      shadowEnabled: true,
      textTransform: 'uppercase',
      uppercase: true,
      animationPreset: 'bounce',
      highlightBehavior: 'color',
    },
  },
  {
    id: 'highlight-pill',
    name: 'Boxed Captions',
    tag: 'Boxed',
    previewBg: '#7C3AED',
    previewFg: '#FFFFFF',
    sampleWord: 'FOCUS',
    style: {
      template: 'shorts',
      mode: 'boxed-captions',
      fontFamily: 'Poppins',
      fontSize: 38,
      fontWeight: 'bold',
      fontWeightNum: 700,
      primaryColor: '#FFFFFF',
      highlightColor: '#FFFFFF',
      gradientEnabled: false,
      highlightBoxEnabled: true,
      highlightBoxColor: '#7C3AED',
      highlightBoxOpacity: 0.9,
      outlineColor: '#09090B',
      outlineWidth: 2,
      backgroundOpacity: 0.35,
      textTransform: 'none',
      uppercase: false,
      animationPreset: 'box-highlight',
      highlightBehavior: 'box',
    },
  },
  {
    id: 'arabic-modern',
    name: 'Arabic Cairo Bold',
    tag: 'Arabic',
    previewBg: '#18181B',
    previewFg: '#FACC15',
    sampleWord: 'ملخص الفيلم',
    style: {
      template: 'custom',
      mode: 'three-words',
      fontFamily: 'Cairo',
      fontSize: 40,
      fontWeight: 'bold',
      fontWeightNum: 700,
      primaryColor: '#FFFFFF',
      highlightColor: '#FACC15',
      gradientEnabled: false,
      highlightBoxEnabled: false,
      outlineColor: '#000000',
      outlineWidth: 4,
      backgroundColor: '#09090B',
      backgroundOpacity: 0.5,
      textTransform: 'none',
      uppercase: false,
      animationPreset: 'pop',
      highlightBehavior: 'color',
    },
  },
];

const ANIMATIONS: Array<{ id: CaptionAnimationPreset; label: string; desc: string }> = [
  { id: 'none', label: 'None (Static)', desc: 'Clean static display' },
  { id: 'word-popup', label: 'Word Pop-up', desc: 'Punchy pop entrance per word' },
  { id: 'karaoke', label: 'Karaoke Sweep', desc: 'Word highlight sweep' },
  { id: 'bounce', label: 'Playful Bounce', desc: 'Springy vertical bounce' },
  { id: 'pop', label: 'Pop Spring', desc: 'Elastic scale snap' },
  { id: 'scale', label: 'Scale-In', desc: 'Zoom settle transition' },
  { id: 'slide-up', label: 'Slide Up', desc: 'Smooth upward reveal' },
  { id: 'fade', label: 'Smooth Fade', desc: 'Cinematic opacity fade' },
  { id: 'typewriter', label: 'Typewriter', desc: 'Word-by-word reveal' },
  { id: 'gradient-emphasis', label: 'Gradient Glow', desc: 'Two-tone gradient highlight' },
  { id: 'box-highlight', label: 'Pill Box Pop', desc: 'Colored backdrop highlight' },
  { id: 'highlight-sweep', label: 'Neon Glow', desc: 'Emissive accent halo' },
];

const QUICK_COLORS = ['#FFFFFF', '#FACC15', '#38BDF8', '#4ADE80', '#F43F5E', '#C084FC', '#FB923C'];

interface SliderNumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  disabled?: boolean;
  onChange: (val: number) => void;
}

function SliderNumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit = '',
  disabled = false,
  onChange,
}: SliderNumberFieldProps) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-[11px] text-zinc-300">
        <span className="truncate">{label}</span>
        <div className="flex items-center gap-1 shrink-0">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            value={Number.isFinite(value) ? value : min}
            onChange={(e) => {
              const parsed = Number(e.target.value);
              if (!Number.isNaN(parsed)) {
                onChange(Math.max(min, Math.min(max, parsed)));
              }
            }}
            className="w-16 bg-zinc-900 border border-white/[0.1] rounded px-1.5 py-0.5 text-[11px] font-mono text-zinc-100 text-right tabular-nums"
          />
          {unit && <span className="text-[10px] font-mono text-zinc-500">{unit}</span>}
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        value={Math.max(min, Math.min(max, Number.isFinite(value) ? value : min))}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-violet-500 disabled:opacity-40"
      />
    </div>
  );
}

export function CaptionsPage({
  project,
  onProjectUpdated,
  onSeek,
  customFonts: externalFonts,
  onCustomFontsChanged,
  selectedElement,
  onSelectElement,
}: CaptionsPageProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const styleSaveTimerRef = useRef<number | null>(null);

  const [busy, setBusy] = useState(false);
  const [uploadingFont, setUploadingFont] = useState(false);
  const [localFonts, setLocalFonts] = useState<SavedFontAsset[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<
    'fonts' | 'style' | 'modes' | 'position' | 'segments'
  >('fonts');

  // Font Library UI State
  const [fontCategory, setFontCategory] = useState<'All' | 'Favorites' | FontCategoryId>('All');
  const [fontSearch, setFontSearch] = useState('');
  const [fontPreviewInput, setFontPreviewInput] = useState('');
  const [, setFontStatusTick] = useState(0);

  // 18 Display Modes UI State
  const [modeSearch, setModeSearch] = useState('');
  const [modeCategory, setModeCategory] = useState<string>('All');

  const customFonts = externalFonts || localFonts;
  const canonicalMode = normalizeCanonicalMode(project.subtitleStyle.mode);
  const activeModeDef =
    CAPTION_DISPLAY_MODES.find((m) => m.id === canonicalMode) || CAPTION_DISPLAY_MODES[0];
  const syncedCaptions = useMemo(() => getSyncedCaptionsForPreview(project), [project]);
  const missingTranslatedCount = useMemo(
    () => countMissingTranslations(project.captions),
    [project.captions]
  );

  // Determine whether user is editing Main Captions or an Extra Caption Element
  const extraElements = project.subtitleStyle.extraElements || [];
  const activeExtraEl: CaptionElementLayer | null =
    selectedElement?.kind === 'caption-element'
      ? extraElements.find((el) => el.id === selectedElement.id) || null
      : null;

  const activeTypography = activeExtraEl
    ? { ...DEFAULT_SUBTITLE_STYLE, ...project.subtitleStyle, ...activeExtraEl.style }
    : project.subtitleStyle;

  useEffect(() => {
    const unsub = subscribeFontStatus(() => setFontStatusTick((n) => n + 1));
    return unsub;
  }, []);

  useEffect(() => {
    if (!externalFonts) {
      void api.listCustomFonts().then((r) => setLocalFonts(r.fonts || [])).catch(() => {});
    }
  }, [externalFonts]);

  // Ensure active font & visible catalog fonts load cleanly
  const activeWeightNum =
    activeTypography.fontWeightNum ??
    (activeTypography.fontWeight === '900'
      ? 900
      : activeTypography.fontWeight === 'bold'
      ? 700
      : 400);

  useEffect(() => {
    void ensureFontLoaded({
      family: activeTypography.fontFamily,
      weight: activeWeightNum,
      italic: activeTypography.italic,
      customUrl: activeTypography.customFontUrl,
    });
  }, [
    activeTypography.fontFamily,
    activeWeightNum,
    activeTypography.italic,
    activeTypography.customFontUrl,
  ]);

  const activeFontStatus: FontStatusEntry = getFontStatus(
    activeTypography.fontFamily,
    resolveClosestSupportedWeight(activeTypography.fontFamily, activeWeightNum)
  );

  const defaultCaptionPreviewText = useMemo(() => {
    if (fontPreviewInput.trim()) return fontPreviewInput.trim();
    const firstTranslated = project.captions.find((c) => c.translatedText?.trim())?.translatedText;
    return firstTranslated?.trim() || 'The secret behind the ending';
  }, [fontPreviewInput, project.captions]);

  const filteredCatalogFonts = useMemo(() => {
    const q = fontSearch.trim().toLowerCase();
    const favs = new Set((project.subtitleStyle.favoriteFonts || []).map((f) => f.toLowerCase()));
    return BUILTIN_FONT_CATALOG.filter((item) => {
      if (fontCategory === 'Favorites' && !favs.has(item.family.toLowerCase())) return false;
      if (
        fontCategory !== 'All' &&
        fontCategory !== 'Favorites' &&
        fontCategory !== 'Custom' &&
        item.category !== fontCategory
      ) {
        return false;
      }
      if (fontCategory === 'Custom') return false;
      if (q && !item.family.toLowerCase().includes(q) && !item.category.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [fontCategory, fontSearch, project.subtitleStyle.favoriteFonts]);

  // Preload visible filtered fonts cleanly when font library tab is open
  useEffect(() => {
    if (activeTab !== 'fonts') return;
    filteredCatalogFonts.slice(0, 12).forEach((item) => {
      void ensureFontLoaded({
        family: item.family,
        weight: item.defaultWeight,
        italic: false,
      });
    });
    customFonts.forEach((cf) => {
      void ensureFontLoaded({
        family: cf.family,
        weight: 400,
        customUrl: cf.url,
      });
    });
  }, [activeTab, filteredCatalogFonts, customFonts]);

  const syncStatus = computeCaptionSyncStatus(project);

  const persistSubtitleStyle = (nextStyle: SubtitleStyle, immediate = false) => {
    const nextWorkflow = createWorkflowUpdate(project.workflow, {
      visitStage: 'captions',
      modifiedStage: 'captions',
      hasExistingExport: Boolean(project.lastExportUrl),
    });
    onProjectUpdated({ ...project, subtitleStyle: nextStyle, workflow: nextWorkflow });
    if (styleSaveTimerRef.current) window.clearTimeout(styleSaveTimerRef.current);
    const delay = immediate ? 0 : 200;
    styleSaveTimerRef.current = window.setTimeout(() => {
      void api
        .updateProject(project.id, {
          subtitleStyle: nextStyle,
          workflow: nextWorkflow,
        })
        .then(({ project: saved }) => onProjectUpdated(saved))
        .catch(() => {});
    }, delay);
  };

  const updateStyle = (patch: Partial<SubtitleStyle>, immediate = false) => {
    const nextStyle = { ...project.subtitleStyle, ...patch, useTranslated: true };
    persistSubtitleStyle(nextStyle, immediate);
  };

  const updateActiveTargetStyle = (patch: Partial<SubtitleStyle>, immediate = false) => {
    if (activeExtraEl) {
      const nextElements = extraElements.map((el) =>
        el.id === activeExtraEl.id
          ? { ...el, style: { ...el.style, ...patch } }
          : el
      );
      updateStyle({ extraElements: nextElements }, immediate);
    } else {
      updateStyle(patch, immediate);
    }
  };

  const handleSelectFont = async (params: {
    family: string;
    weight?: number;
    customId?: string;
    customUrl?: string;
  }) => {
    setErrorMsg(null);
    const weightToUse = resolveClosestSupportedWeight(
      params.family,
      params.weight ?? activeWeightNum
    );
    const res = await ensureFontLoaded({
      family: params.family,
      weight: weightToUse,
      italic: activeTypography.italic,
      customUrl: params.customUrl,
    });
    if (res.status === 'error') {
      setErrorMsg(
        res.error ||
          `Font "${params.family}" could not be loaded and was NOT selected.`
      );
      return;
    }
    updateActiveTargetStyle(
      {
        fontFamily: params.family,
        fontWeightNum: weightToUse,
        fontWeight: weightToUse >= 850 ? '900' : weightToUse >= 600 ? 'bold' : 'normal',
        customFontId: params.customId,
        customFontUrl: params.customUrl,
        template: 'custom',
      },
      true
    );
    if (res.availableForExport === false) {
      setErrorMsg(
        `Loaded "${params.family}" for browser preview only. Upload a .TTF or .OTF version for FFmpeg MP4 burn-in.`
      );
    }
  };

  const toggleFavoriteFont = (family: string) => {
    const existing = project.subtitleStyle.favoriteFonts || [];
    const exists = existing.some((f) => f.toLowerCase() === family.toLowerCase());
    const next = exists
      ? existing.filter((f) => f.toLowerCase() !== family.toLowerCase())
      : [...existing, family];
    updateStyle({ favoriteFonts: next }, true);
  };

  const handleUploadFont = async (file: File) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setUploadingFont(true);
    try {
      const res = await api.uploadCustomFont(file);
      if (!externalFonts) setLocalFonts(res.fonts);
      onCustomFontsChanged?.();
      await ensureFontLoaded({
        family: res.font.family,
        weight: 400,
        customUrl: res.font.url,
      });
      updateActiveTargetStyle(
        {
          fontFamily: res.font.family,
          customFontId: res.font.id,
          customFontUrl: res.font.url,
          template: 'custom',
        },
        true
      );
      setSuccessMsg(
        res.exportCompatible === false
          ? `Uploaded "${res.font.family}" (${res.font.filename}) for browser preview. For MP4 export burn-in, upload .TTF or .OTF.`
          : `Uploaded font "${res.font.family}" for preview and MP4 burn-in.`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setUploadingFont(false);
    }
  };

  const handleDeleteCustomFont = async (font: SavedFontAsset) => {
    setErrorMsg(null);
    try {
      const res = await api.deleteCustomFont(font.id);
      if (!externalFonts) setLocalFonts(res.fonts);
      onCustomFontsChanged?.();
      if (project.subtitleStyle.customFontId === font.id) {
        updateStyle(
          {
            fontFamily: 'Montserrat',
            customFontId: undefined,
            customFontUrl: undefined,
          },
          true
        );
      }
      setSuccessMsg(`Deleted custom font "${font.family}".`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const handleAddTextElement = () => {
    const newEl: CaptionElementLayer = {
      id: uuidv4(),
      label: `Overlay Text ${extraElements.length + 1}`,
      text: 'WATCH UNTIL END',
      visible: true,
      locked: false,
      startTime: 0,
      endTime: 0,
      style: {
        fontFamily: project.subtitleStyle.fontFamily,
        fontSize: 34,
        fontWeightNum: 800,
        fontWeight: 'bold',
        primaryColor: '#FACC15',
        outlineColor: '#000000',
        outlineWidth: 3,
        backgroundOpacity: 0.45,
        backgroundColor: '#09090B',
        posX: 50,
        posY: 16,
        opacity: 1,
        rotation: 0,
        maxWidthPct: 86,
        textTransform: 'uppercase',
      },
    };
    const nextElements = [...extraElements, newEl];
    updateStyle({ extraElements: nextElements }, true);
    onSelectElement?.({ kind: 'caption-element', id: newEl.id });
  };

  const handleDuplicateExtraElement = (el: CaptionElementLayer) => {
    const copy: CaptionElementLayer = {
      ...el,
      id: uuidv4(),
      label: `${el.label} Copy`,
      locked: false,
      style: {
        ...el.style,
        posX: Math.min(90, (el.style.posX ?? 50) + 4),
        posY: Math.min(90, (el.style.posY ?? 18) + 6),
      },
    };
    updateStyle({ extraElements: [...extraElements, copy] }, true);
    onSelectElement?.({ kind: 'caption-element', id: copy.id });
  };

  const handleDeleteExtraElement = (id: string) => {
    updateStyle(
      { extraElements: extraElements.filter((el) => el.id !== id) },
      true
    );
    onSelectElement?.({ kind: 'captions' });
  };

  const handleReorderExtraElement = (id: string, dir: 'up' | 'down') => {
    const idx = extraElements.findIndex((el) => el.id === id);
    if (idx === -1) return;
    const swapIdx = dir === 'up' ? idx + 1 : idx - 1;
    if (swapIdx < 0 || swapIdx >= extraElements.length) return;
    const next = [...extraElements];
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    updateStyle({ extraElements: next }, true);
  };

  const handleResetStyle = () => {
    if (activeExtraEl) {
      updateStyle(
        {
          extraElements: extraElements.map((el) =>
            el.id === activeExtraEl.id
              ? {
                  ...el,
                  style: {
                    fontFamily: 'Montserrat',
                    fontSize: 34,
                    fontWeightNum: 700,
                    fontWeight: 'bold',
                    primaryColor: '#FACC15',
                    outlineColor: '#000000',
                    outlineWidth: 3,
                    posX: 50,
                    posY: 16,
                    opacity: 1,
                    rotation: 0,
                  },
                }
              : el
          ),
        },
        true
      );
      setSuccessMsg(`Reset style for "${activeExtraEl.label}".`);
    } else {
      updateStyle(
        {
          ...DEFAULT_SUBTITLE_STYLE,
          enabled: project.subtitleStyle.enabled,
          captionSync: project.subtitleStyle.captionSync,
          favoriteFonts: project.subtitleStyle.favoriteFonts,
          extraElements: project.subtitleStyle.extraElements,
        },
        true
      );
      setSuccessMsg('Reset main caption typography & positioning to defaults.');
    }
  };

  const handleApplyToAllCaptions = async () => {
    setErrorMsg(null);
    const cleaned = project.captions.map((c) => {
      const { styleOverride: _ignored, ...rest } = c;
      return rest;
    });
    const nextStyle: SubtitleStyle = {
      ...project.subtitleStyle,
      ...(activeExtraEl ? activeExtraEl.style : {}),
      useTranslated: true,
    };
    const nextWorkflow = createWorkflowUpdate(project.workflow, {
      visitStage: 'captions',
      modifiedStage: 'captions',
      hasExistingExport: Boolean(project.lastExportUrl),
    });
    onProjectUpdated({
      ...project,
      captions: cleaned,
      subtitleStyle: nextStyle,
      workflow: nextWorkflow,
    });
    const { project: saved } = await api.updateProject(project.id, {
      captions: cleaned,
      subtitleStyle: nextStyle,
      workflow: nextWorkflow,
    });
    onProjectUpdated(saved);
    setSuccessMsg(`Applied current style uniformly across all ${cleaned.length} translated caption segments.`);
  };

  const updateExportSettings = async (applyCaptions: boolean) => {
    const nextSettings = { ...project.exportSettings, applyCaptions };
    const nextWorkflow = createWorkflowUpdate(project.workflow, {
      visitStage: 'captions',
      modifiedStage: 'captions',
      hasExistingExport: Boolean(project.lastExportUrl),
    });
    onProjectUpdated({ ...project, exportSettings: nextSettings, workflow: nextWorkflow });
    const { project: saved } = await api.updateProject(project.id, {
      exportSettings: nextSettings,
      workflow: nextWorkflow,
    });
    onProjectUpdated(saved);
  };

  // STRICT TRANSLATED-ONLY GENERATION: Builds timed captions strictly from segment.translatedText + synced voiceover timeline
  const handleManualGenerateCaptions = async () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    setBusy(true);
    try {
      const built = buildCaptionsFromTranscript(project);
      const nextWorkflow = createWorkflowUpdate(project.workflow, {
        completeStage: 'captions',
        modifiedStage: 'captions',
        hasExistingExport: Boolean(project.lastExportUrl),
      });
      const { project: saved } = await api.updateProject(project.id, {
        captions: built.captions,
        subtitleStyle: built.subtitleStyle,
        workflow: nextWorkflow,
      });
      onProjectUpdated(saved);
      setSuccessMsg(
        `Generated ${built.captions.length} captions strictly from segment.translatedText (${built.targetLanguage}) synced to the voiceover timeline.${
          built.missingCount > 0 ? ` (${built.missingCount} segment(s) have empty translatedText and were skipped.)` : ''
        }`
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleImportSrtVtt = async (file: File) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      const text = await file.text();
      const res = await api.importCaptions(project.id, text);
      // Populate translatedText on imported SRT/VTT lines so mandatory translatedText source rule is honored
      const importedTranslated = res.project.captions.map((c) => ({
        ...c,
        translatedText: c.translatedText?.trim() || c.text,
      }));
      const updatedStyle = { ...res.project.subtitleStyle, enabled: true, useTranslated: true };
      const nextWorkflow = createWorkflowUpdate(res.project.workflow, {
        completeStage: 'captions',
        modifiedStage: 'captions',
        hasExistingExport: Boolean(res.project.lastExportUrl),
      });
      const { project: saved } = await api.updateProject(project.id, {
        captions: importedTranslated,
        subtitleStyle: updatedStyle,
        workflow: nextWorkflow,
      });
      onProjectUpdated(saved);
      setSuccessMsg(`Imported ${res.count} translated caption lines from ${file.name}.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const updateSegment = (id: string, patch: Partial<CaptionSegment>) => {
    const next = project.captions.map((c) => (c.id === id ? { ...c, ...patch } : c));
    onProjectUpdated({ ...project, captions: next });
  };

  const saveSegments = async (next: CaptionSegment[]) => {
    const nextWorkflow = createWorkflowUpdate(project.workflow, {
      visitStage: 'captions',
      modifiedStage: 'captions',
      hasExistingExport: Boolean(project.lastExportUrl),
    });
    const { project: saved } = await api.updateProject(project.id, {
      captions: next,
      workflow: nextWorkflow,
    });
    onProjectUpdated(saved);
  };

  const addManualSegment = async () => {
    const lastEnd = project.captions.length
      ? project.captions[project.captions.length - 1].end
      : 0;
    const dur = project.metadata?.duration || 12;
    const start = Math.min(dur - 1, Math.max(0, lastEnd));
    const end = Math.min(dur, start + 2.5);
    const seg: CaptionSegment = {
      id: uuidv4(),
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      text: '',
      translatedText: 'New translated caption',
    };
    const next = [...project.captions, seg];
    onProjectUpdated({ ...project, captions: next });
    await saveSegments(next);
  };

  const splitSegment = async (id: string) => {
    const idx = project.captions.findIndex((c) => c.id === id);
    if (idx === -1) return;
    const seg = project.captions[idx];
    const duration = seg.end - seg.start;
    if (duration < 0.6) return;

    const src = (seg.translatedText || '').trim();
    const words = src.split(/\s+/).filter(Boolean);
    const midWord = Math.max(1, Math.floor(words.length / 2));
    const t1 = words.slice(0, midWord).join(' ');
    const t2 = words.slice(midWord).join(' ') || '...';
    const midTime = Number((seg.start + duration / 2).toFixed(2));

    const seg1: CaptionSegment = {
      ...seg,
      end: midTime,
      translatedText: t1,
      words: undefined,
    };
    const seg2: CaptionSegment = {
      id: uuidv4(),
      start: midTime,
      end: seg.end,
      text: seg.text,
      translatedText: t2,
    };

    const next = [...project.captions];
    next.splice(idx, 1, seg1, seg2);
    onProjectUpdated({ ...project, captions: next });
    await saveSegments(next);
  };

  const mergeWithNextSegment = async (id: string) => {
    const idx = project.captions.findIndex((c) => c.id === id);
    if (idx === -1 || idx >= project.captions.length - 1) return;
    const cur = project.captions[idx];
    const next = project.captions[idx + 1];

    const merged: CaptionSegment = {
      id: cur.id,
      start: cur.start,
      end: next.end,
      text: `${cur.text} ${next.text}`.trim(),
      translatedText: `${cur.translatedText || ''} ${next.translatedText || ''}`.trim(),
    };

    const nextCaptions = [...project.captions];
    nextCaptions.splice(idx, 2, merged);
    onProjectUpdated({ ...project, captions: nextCaptions });
    await saveSegments(nextCaptions);
  };

  const removeSegment = async (id: string) => {
    const next = project.captions.filter((c) => c.id !== id);
    onProjectUpdated({ ...project, captions: next });
    await saveSegments(next);
  };

  const activeFontCatalogEntry = BUILTIN_FONT_CATALOG.find(
    (f) => f.family.toLowerCase() === activeTypography.fontFamily.toLowerCase()
  );
  const availableWeights = activeFontCatalogEntry?.weights || [
    100, 200, 300, 400, 500, 600, 700, 800, 900,
  ];
  const filteredModes = CAPTION_DISPLAY_MODES.filter((m) => {
    if (modeCategory !== 'All' && m.category !== modeCategory) return false;
    const q = modeSearch.trim().toLowerCase();
    if (q && !m.label.toLowerCase().includes(q) && !m.description.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });

  const currentTransform: CaptionTextTransform =
    activeTypography.textTransform || (activeTypography.uppercase ? 'uppercase' : 'none');

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="border-b border-white/[0.08] pb-3 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
              <Type className="w-4 h-4 text-violet-400" />
              Stage 6: Captions Typography &amp; Sync Studio
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Strict translated narration captions, verified fonts, 18 display modes, and multi-element styling.
            </p>
          </div>

          <button
            type="button"
            onClick={() => updateStyle({ enabled: !project.subtitleStyle.enabled }, true)}
            className={`px-2.5 py-1 rounded-md text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shrink-0 ${
              project.subtitleStyle.enabled
                ? 'bg-violet-600/30 text-violet-300 border border-violet-500/50'
                : 'bg-zinc-800 text-zinc-400 border border-white/[0.08]'
            }`}
          >
            {project.subtitleStyle.enabled ? (
              <>
                <Eye className="w-3.5 h-3.5" />
                Preview: On
              </>
            ) : (
              <>
                <EyeOff className="w-3.5 h-3.5" />
                Preview: Off
              </>
            )}
          </button>
        </div>

        {/* Active Font Loading Status Bar */}
        <div className="p-2 rounded-lg bg-zinc-900/90 border border-white/[0.07] flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-zinc-400">Active Font:</span>
            <span className="font-semibold text-white truncate">
              {activeTypography.fontFamily} ({activeWeightNum})
            </span>
            {activeFontStatus.status === 'loaded' ? (
              <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-emerald-300 font-mono text-[10px]">
                Loaded{activeFontStatus.availableForExport === false ? ' · Preview Only (WOFF2)' : ' · Export Ready'}
              </span>
            ) : activeFontStatus.status === 'loading' ? (
              <span className="px-1.5 py-0.5 rounded bg-sky-500/15 border border-sky-500/35 text-sky-300 font-mono text-[10px] flex items-center gap-1">
                <Loader2 className="w-2.5 h-2.5 animate-spin" /> Loading TTF...
              </span>
            ) : (
              <span className="px-1.5 py-0.5 rounded bg-red-500/15 border border-red-500/35 text-red-300 font-mono text-[10px]">
                Unavailable
              </span>
            )}
          </div>
          <span className="text-[10px] font-mono text-violet-300">
            Source: translatedText ONLY
          </span>
        </div>
      </div>

      {/* Missing translatedText Mandatory Warning */}
      {project.captions.length > 0 && missingTranslatedCount > 0 && (
        <div className="p-3 rounded-lg bg-red-500/12 border border-red-500/40 text-xs text-red-200 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <div>
            <div className="font-semibold">
              {missingTranslatedCount} of {project.captions.length} segment(s) have empty translatedText
            </div>
            <div className="text-[11px] text-red-200/80 mt-0.5">
              Captions NEVER fall back to original audio text. Translate in Stage 2 or edit translatedText below.
            </div>
          </div>
        </div>
      )}

      {activeFontStatus.status === 'error' && activeFontStatus.error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/35 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{activeFontStatus.error}</span>
        </div>
      )}

      {errorMsg && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-200 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div className="p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-200 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
          <span>{successMsg}</span>
        </div>
      )}

      {syncStatus.hasOutdated && (
        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/35 text-xs text-amber-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">
                Captions Outdated ({syncStatus.outdatedSegmentIds.length} edited segment
                {syncStatus.outdatedSegmentIds.length === 1 ? '' : 's'})
              </div>
              <div className="text-[11px] text-amber-200/80 mt-0.5">
                translatedText or voiceover timeline changed since captions were synced.
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleManualGenerateCaptions}
            disabled={busy || project.captions.length === 0}
            className="px-3 py-1.5 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-[11px] font-semibold text-amber-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Resync Captions
          </button>
        </div>
      )}

      {/* Sync Captions Action Card */}
      <div className="p-3.5 rounded-xl bg-[#18181D] border border-violet-500/30 space-y-2.5">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="space-y-0.5">
            <div className="text-xs font-semibold text-white flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-violet-400" />
              Sync Captions from Translated Narration
            </div>
            <div className="text-[11px] text-zinc-400">
              {project.captions.length > 0
                ? `Using segment.translatedText (${syncStatus.targetLanguage}) + ${
                    project.voice.enabled && project.voice.syncPlan
                      ? `Fish Audio ${project.voice.syncMode} timeline`
                      : 'segment timings'
                  }.`
                : 'No segments yet. Run Stage 2 Translation or import translated JSON first.'}
            </div>
          </div>

          <button
            type="button"
            onClick={handleManualGenerateCaptions}
            disabled={busy || project.captions.length === 0 || missingTranslatedCount === project.captions.length}
            className="py-2 px-4 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-bold text-white flex items-center justify-center gap-2 whitespace-nowrap shadow-sm shadow-violet-600/30 cursor-pointer"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Flame className="w-4 h-4" />}
            {busy
              ? 'Syncing...'
              : syncStatus.hasSnapshot
              ? 'RESYNC TRANSLATED CAPTIONS'
              : 'GENERATE CAPTIONS'}
          </button>
        </div>

        <label className="flex items-center gap-2 pt-2 border-t border-white/[0.06] text-xs text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={project.exportSettings.applyCaptions}
            onChange={(e) => void updateExportSettings(e.target.checked)}
            className="accent-violet-500 rounded"
          />
          <span className="font-medium text-white">Burn Captions into Final Exported MP4</span>
          <span className="text-[11px] text-zinc-500 ml-auto font-mono">
            {project.exportSettings.applyCaptions ? 'Included' : 'Excluded'}
          </span>
        </label>
      </div>

      {/* Caption Elements Manager & Quick Actions Bar */}
      <div className="p-3 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-semibold text-white flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-violet-400" />
            Caption &amp; Text Elements
          </span>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={handleAddTextElement}
              className="px-2 py-1 rounded bg-violet-600/25 hover:bg-violet-600/40 border border-violet-500/40 text-[11px] font-medium text-violet-200 flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              Add Text Element
            </button>
            <button
              type="button"
              onClick={handleResetStyle}
              title="Reset current element typography to default"
              className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 text-[11px] text-zinc-300 flex items-center gap-1 cursor-pointer"
            >
              <RotateCcw className="w-3 h-3" />
              Reset Style
            </button>
            <button
              type="button"
              onClick={() => void handleApplyToAllCaptions()}
              title="Apply typography style uniformly to all captions"
              className="px-2 py-1 rounded bg-emerald-600/20 hover:bg-emerald-600/35 border border-emerald-500/35 text-[11px] font-medium text-emerald-200 cursor-pointer"
            >
              Apply to All
            </button>
          </div>
        </div>

        {/* Element Selector List */}
        <div className="space-y-1">
          {/* Primary Captions Element */}
          <div
            onClick={() => onSelectElement?.({ kind: 'captions' })}
            className={`px-2.5 py-1.5 rounded-lg border flex items-center justify-between gap-2 text-xs cursor-pointer ${
              !activeExtraEl
                ? 'bg-violet-600/20 border-violet-500/60 text-white'
                : 'bg-zinc-900/70 border-white/[0.06] text-zinc-300 hover:border-white/[0.15]'
            }`}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Type className="w-3.5 h-3.5 text-pink-400 shrink-0" />
              <span className="font-medium truncate">Main Narration Captions</span>
            </div>
            <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                onClick={() =>
                  updateStyle({ visible: project.subtitleStyle.visible === false }, true)
                }
                title={project.subtitleStyle.visible === false ? 'Show' : 'Hide'}
                className="p-1 text-zinc-400 hover:text-white cursor-pointer"
              >
                {project.subtitleStyle.visible === false ? (
                  <EyeOff className="w-3.5 h-3.5" />
                ) : (
                  <Eye className="w-3.5 h-3.5" />
                )}
              </button>
              <button
                type="button"
                onClick={() => updateStyle({ locked: !project.subtitleStyle.locked }, true)}
                title={project.subtitleStyle.locked ? 'Unlock' : 'Lock'}
                className={`p-1 cursor-pointer ${
                  project.subtitleStyle.locked ? 'text-amber-400' : 'text-zinc-400 hover:text-white'
                }`}
              >
                {project.subtitleStyle.locked ? (
                  <Lock className="w-3.5 h-3.5" />
                ) : (
                  <Unlock className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>

          {extraElements.map((el, idx) => {
            const isSel = activeExtraEl?.id === el.id;
            return (
              <div
                key={el.id}
                onClick={() => onSelectElement?.({ kind: 'caption-element', id: el.id })}
                className={`px-2.5 py-1.5 rounded-lg border flex items-center justify-between gap-2 text-xs cursor-pointer ${
                  isSel
                    ? 'bg-sky-600/20 border-sky-500/60 text-white'
                    : 'bg-zinc-900/70 border-white/[0.06] text-zinc-300 hover:border-white/[0.15]'
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Type className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                  <span className="truncate font-medium">{el.label}</span>
                  <span className="text-[10px] text-zinc-500 truncate">({el.text})</span>
                </div>
                <div className="flex items-center gap-0.5 shrink-0" onClick={(e) => e.stopPropagation()}>
                  <button
                    type="button"
                    disabled={idx === extraElements.length - 1}
                    onClick={() => handleReorderExtraElement(el.id, 'up')}
                    title="Move Layer Up"
                    className="p-1 text-zinc-400 hover:text-white disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    disabled={idx === 0}
                    onClick={() => handleReorderExtraElement(el.id, 'down')}
                    title="Move Layer Down"
                    className="p-1 text-zinc-400 hover:text-white disabled:opacity-30 cursor-pointer"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateStyle(
                        {
                          extraElements: extraElements.map((item) =>
                            item.id === el.id ? { ...item, visible: !item.visible } : item
                          ),
                        },
                        true
                      )
                    }
                    title={el.visible ? 'Hide' : 'Show'}
                    className="p-1 text-zinc-400 hover:text-white cursor-pointer"
                  >
                    {el.visible ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      updateStyle(
                        {
                          extraElements: extraElements.map((item) =>
                            item.id === el.id ? { ...item, locked: !item.locked } : item
                          ),
                        },
                        true
                      )
                    }
                    title={el.locked ? 'Unlock' : 'Lock'}
                    className={`p-1 cursor-pointer ${
                      el.locked ? 'text-amber-400' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {el.locked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDuplicateExtraElement(el)}
                    title="Duplicate element"
                    className="p-1 text-zinc-400 hover:text-white cursor-pointer"
                  >
                    <Copy className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteExtraElement(el.id)}
                    title="Delete element"
                    className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {activeExtraEl && (
          <div className="pt-2 border-t border-white/[0.06] grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] text-zinc-400">Element Label</label>
              <input
                type="text"
                value={activeExtraEl.label}
                onChange={(e) =>
                  updateStyle({
                    extraElements: extraElements.map((item) =>
                      item.id === activeExtraEl.id ? { ...item, label: e.target.value } : item
                    ),
                  })
                }
                className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs text-zinc-100"
              />
            </div>
            <div>
              <label className="text-[10px] text-zinc-400">Text Content</label>
              <input
                type="text"
                value={activeExtraEl.text}
                onChange={(e) =>
                  updateStyle({
                    extraElements: extraElements.map((item) =>
                      item.id === activeExtraEl.id ? { ...item, text: e.target.value } : item
                    ),
                  })
                }
                className="mt-0.5 w-full bg-zinc-900 border border-white/[0.08] rounded px-2 py-1 text-xs text-zinc-100"
              />
            </div>
          </div>
        )}
      </div>

      {/* Sub-Tabs */}
      <div className="flex flex-wrap border-b border-white/[0.08] gap-x-3.5 gap-y-1 text-xs font-medium text-zinc-400">
        {[
          { id: 'fonts' as const, label: 'Font Library' },
          { id: 'style' as const, label: 'Typography' },
          { id: 'modes' as const, label: '18 Modes & FX' },
          { id: 'position' as const, label: 'Box & Transform' },
          { id: 'segments' as const, label: `Translated (${project.captions.length})` },
        ].map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActiveTab(t.id)}
            className={`pb-2 transition-colors relative whitespace-nowrap cursor-pointer ${
              activeTab === t.id ? 'text-violet-400 font-semibold' : 'hover:text-zinc-200'
            }`}
          >
            {t.label}
            {activeTab === t.id && (
              <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-violet-500 rounded-full" />
            )}
          </button>
        ))}
      </div>

      {/* TAB 1: VERIFIED FONT LIBRARY & CUSTOM FONT MANAGER */}
      {activeTab === 'fonts' && (
        <div className="space-y-3">
          <div className="p-3.5 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
            {/* Search & Preview Sample Input */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={fontSearch}
                  onChange={(e) => setFontSearch(e.target.value)}
                  placeholder="Search fonts by name..."
                  className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-violet-500"
                />
              </div>
              <input
                type="text"
                value={fontPreviewInput}
                onChange={(e) => setFontPreviewInput(e.target.value)}
                placeholder={`Preview: "${defaultCaptionPreviewText.slice(0, 26)}"`}
                className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100 focus:outline-none focus:border-violet-500"
              />
            </div>

            {/* Category Pills */}
            <div className="flex flex-wrap gap-1">
              {(['All', 'Favorites', ...FONT_CATEGORIES] as const).map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setFontCategory(cat)}
                  className={`px-2 py-1 rounded-md text-[10.5px] font-medium border cursor-pointer transition-colors ${
                    fontCategory === cat
                      ? 'bg-violet-600 border-violet-500 text-white'
                      : 'bg-zinc-900 border-white/[0.07] text-zinc-300 hover:bg-zinc-800'
                  }`}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Weight & Style Controls for Selected Font */}
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-white/[0.06]">
              <div>
                <label className="text-[10.5px] text-zinc-400">
                  Weight ({activeFontCatalogEntry ? `${availableWeights.length} supported` : '100–900'})
                </label>
                <select
                  value={resolveClosestSupportedWeight(activeTypography.fontFamily, activeWeightNum)}
                  onChange={(e) => {
                    const w = Number(e.target.value);
                    void handleSelectFont({
                      family: activeTypography.fontFamily,
                      weight: w,
                      customId: activeTypography.customFontId,
                      customUrl: activeTypography.customFontUrl,
                    });
                  }}
                  className="mt-1 w-full bg-zinc-900 border border-white/[0.08] rounded-md px-2 py-1.5 text-xs text-zinc-100"
                >
                  {availableWeights.map((w) => (
                    <option key={w} value={w}>
                      {WEIGHT_LABELS[w] || w}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-end gap-1.5">
                <button
                  type="button"
                  disabled={activeFontCatalogEntry ? !activeFontCatalogEntry.supportsItalic : false}
                  onClick={() =>
                    updateActiveTargetStyle({ italic: !activeTypography.italic }, true)
                  }
                  className={`flex-1 py-1.5 rounded-md text-xs italic border cursor-pointer disabled:opacity-35 ${
                    activeTypography.italic
                      ? 'bg-violet-600 border-violet-500 text-white'
                      : 'bg-zinc-900 border-white/[0.08] text-zinc-300'
                  }`}
                >
                  Italic
                </button>
                <button
                  type="button"
                  onClick={() =>
                    updateActiveTargetStyle({ underline: !activeTypography.underline }, true)
                  }
                  className={`flex-1 py-1.5 rounded-md text-xs underline border cursor-pointer ${
                    activeTypography.underline
                      ? 'bg-violet-600 border-violet-500 text-white'
                      : 'bg-zinc-900 border-white/[0.08] text-zinc-300'
                  }`}
                >
                  Underline
                </button>
              </div>
            </div>

            {/* Built-in Categorized Font Cards with Honest Load Status */}
            {fontCategory !== 'Custom' && (
              <div className="space-y-1.5 max-h-[280px] overflow-y-auto pr-1">
                {filteredCatalogFonts.map((item) => {
                  const status = getFontStatus(item.family, item.defaultWeight);
                  const isSelected =
                    activeTypography.fontFamily.toLowerCase() === item.family.toLowerCase();
                  const isFav = (project.subtitleStyle.favoriteFonts || []).some(
                    (f) => f.toLowerCase() === item.family.toLowerCase()
                  );
                  const sampleText =
                    item.isArabic && !fontPreviewInput.trim()
                      ? project.captions.find((c) => /[\u0600-\u06FF]/.test(c.translatedText || ''))
                          ?.translatedText || item.sampleText || defaultCaptionPreviewText
                      : defaultCaptionPreviewText;

                  return (
                    <div
                      key={item.family}
                      onClick={() =>
                        void handleSelectFont({
                          family: item.family,
                          weight: item.defaultWeight,
                        })
                      }
                      className={`p-2.5 rounded-lg border transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-violet-600/20 border-violet-500'
                          : status.status === 'error'
                          ? 'bg-red-950/15 border-red-500/30'
                          : 'bg-zinc-900/75 border-white/[0.06] hover:border-white/[0.18]'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFavoriteFont(item.family);
                            }}
                            title="Toggle favorite font"
                            className={`p-0.5 cursor-pointer ${
                              isFav ? 'text-amber-400' : 'text-zinc-600 hover:text-zinc-300'
                            }`}
                          >
                            <Star className="w-3.5 h-3.5" fill={isFav ? 'currentColor' : 'none'} />
                          </button>
                          <span className="text-xs font-semibold text-white truncate">
                            {item.family}
                          </span>
                          <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                            {item.category}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {status.status === 'loaded' ? (
                            <span className="text-[10px] font-mono text-emerald-400">Ready</span>
                          ) : status.status === 'loading' ? (
                            <Loader2 className="w-3 h-3 animate-spin text-sky-400" />
                          ) : status.status === 'error' ? (
                            <span className="text-[10px] font-mono text-red-400">Unavailable</span>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                void ensureFontLoaded({
                                  family: item.family,
                                  weight: item.defaultWeight,
                                });
                              }}
                              className="text-[10px] font-mono text-zinc-400 hover:text-zinc-200 underline cursor-pointer"
                            >
                              Load
                            </button>
                          )}
                        </div>
                      </div>
                      <div
                        dir={item.isArabic ? 'rtl' : 'ltr'}
                        className="mt-1.5 text-sm text-zinc-100 truncate"
                        style={{
                          fontFamily:
                            status.status === 'loaded'
                              ? `'${item.family}', sans-serif`
                              : 'inherit',
                          fontWeight: item.defaultWeight,
                        }}
                      >
                        {status.status === 'error' ? (
                          <span className="text-[11px] text-red-300 font-sans">
                            {status.error}
                          </span>
                        ) : (
                          sampleText
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Custom Uploaded Font Upload & Management */}
            <div className="pt-2 border-t border-white/[0.06] space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <div className="text-xs font-semibold text-white">
                    Custom Fonts (.TTF, .OTF, .WOFF2)
                  </div>
                  <div className="text-[10.5px] text-zinc-500">
                    Use .TTF or .OTF for full FFmpeg MP4 burn-in compatibility.
                  </div>
                </div>
                <input
                  ref={fontInputRef}
                  type="file"
                  accept=".ttf,.otf,.woff,.woff2"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleUploadFont(f);
                    e.target.value = '';
                  }}
                />
                <button
                  type="button"
                  disabled={uploadingFont}
                  onClick={() => fontInputRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 shrink-0 cursor-pointer"
                >
                  {uploadingFont ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <UploadCloud className="w-3.5 h-3.5" />
                  )}
                  Upload Font
                </button>
              </div>

              {customFonts.length > 0 && (
                <div className="space-y-1.5">
                  {customFonts.map((cf) => {
                    const isWoff2 = /\.woff2?$/i.test(cf.filename);
                    const isSel =
                      activeTypography.customFontId === cf.id ||
                      activeTypography.fontFamily.toLowerCase() === cf.family.toLowerCase();
                    return (
                      <div
                        key={cf.id}
                        onClick={() =>
                          void handleSelectFont({
                            family: cf.family,
                            weight: 400,
                            customId: cf.id,
                            customUrl: cf.url,
                          })
                        }
                        className={`p-2 rounded-lg border flex items-center justify-between gap-2 cursor-pointer ${
                          isSel
                            ? 'bg-violet-600/20 border-violet-500'
                            : 'bg-zinc-900 border-white/[0.06] hover:border-white/[0.16]'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-white flex items-center gap-1.5">
                            <span className="truncate">{cf.family}</span>
                            {isWoff2 && (
                              <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono">
                                Preview Only (WOFF2)
                              </span>
                            )}
                          </div>
                          <div
                            className="text-xs text-zinc-300 truncate mt-0.5"
                            style={{ fontFamily: `'${cf.family}'` }}
                          >
                            {defaultCaptionPreviewText}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDeleteCustomFont(cf);
                          }}
                          title="Delete custom font"
                          className="p-1 text-zinc-500 hover:text-red-400 cursor-pointer shrink-0"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Quick Style & Saved Presets Library */}
          <div className="p-3.5 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <span className="text-xs font-semibold text-zinc-200">Quick Style Templates</span>
            <div className="grid grid-cols-2 gap-2">
              {TRENDING_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => updateStyle(preset.style, true)}
                  className="p-2 rounded-lg bg-zinc-900/90 hover:bg-zinc-800 border border-white/[0.07] hover:border-violet-500/50 text-left cursor-pointer"
                >
                  <div
                    className="h-8 rounded flex items-center justify-center font-extrabold text-xs mb-1 px-2 truncate"
                    style={{ backgroundColor: preset.previewBg, color: preset.previewFg }}
                  >
                    {preset.sampleWord}
                  </div>
                  <div className="flex items-center justify-between gap-1 text-[10.5px]">
                    <span className="font-medium text-zinc-200 truncate">{preset.name}</span>
                    <span className="font-mono text-violet-300 shrink-0">{preset.tag}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <PresetLibraryPanel
            category="caption"
            title="Saved Custom Font & Caption Presets"
            subtitle="Save font, colors, shadows, and mode settings globally across projects."
            getPayload={() => {
              const assetRefs: StudioPresetAssetRef[] = [];
              if (project.subtitleStyle.customFontUrl) {
                assetRefs.push({
                  kind: 'font',
                  label: project.subtitleStyle.fontFamily,
                  url: project.subtitleStyle.customFontUrl,
                });
              }
              const {
                enabled: _enabled,
                captionSync: _captionSync,
                ...cleanStyle
              } = project.subtitleStyle;
              return {
                payload: cleanStyle as Record<string, unknown>,
                assetRefs,
                thumbnailStyle: {
                  bg: project.subtitleStyle.backgroundColor || '#09090B',
                  fg: project.subtitleStyle.highlightColor || '#FACC15',
                  sampleText: 'Aa',
                  badge: `${canonicalMode} · ${project.subtitleStyle.fontFamily}`,
                },
              };
            }}
            onApplyPreset={async (preset: StudioPreset) => {
              const res = await api.applyPresetsToProject(project.id, {
                captionPresetId: preset.id,
              });
              onProjectUpdated(res.project);
              setSuccessMsg(`Applied caption preset "${preset.name}".`);
            }}
          />
        </div>
      )}

      {/* TAB 2: COMPLETE TYPOGRAPHY CONTROLS */}
      {activeTab === 'style' && (
        <div className="p-4 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-4">
          {/* Transform & Alignment */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-zinc-400">Text Transform</label>
              <div className="mt-1 grid grid-cols-3 gap-1 bg-zinc-900 p-0.5 rounded-lg border border-white/[0.06]">
                {(
                  [
                    { id: 'none', label: 'Normal' },
                    { id: 'uppercase', label: 'UPPER' },
                    { id: 'lowercase', label: 'lower' },
                  ] as const
                ).map((tf) => (
                  <button
                    key={tf.id}
                    type="button"
                    onClick={() =>
                      updateActiveTargetStyle({
                        textTransform: tf.id,
                        uppercase: tf.id === 'uppercase',
                      })
                    }
                    className={`py-1 rounded text-[11px] font-medium cursor-pointer ${
                      currentTransform === tf.id
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {tf.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-[11px] text-zinc-400">Text Alignment</label>
              <div className="mt-1 grid grid-cols-3 gap-1 bg-zinc-900 p-0.5 rounded-lg border border-white/[0.06]">
                {(['left', 'center', 'right'] as const).map((align) => (
                  <button
                    key={align}
                    type="button"
                    onClick={() => updateActiveTargetStyle({ textAlign: align })}
                    className={`py-1 rounded text-[11px] capitalize cursor-pointer ${
                      (activeTypography.textAlign || 'center') === align
                        ? 'bg-violet-600 text-white'
                        : 'text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    {align}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Font Size, Letter Spacing, Line Spacing */}
          <div className="space-y-3 pt-2 border-t border-white/[0.06]">
            <SliderNumberField
              label="Font Size"
              value={activeTypography.fontSize || 42}
              min={14}
              max={110}
              step={1}
              unit="px"
              onChange={(v) => updateActiveTargetStyle({ fontSize: v })}
            />
            <SliderNumberField
              label="Letter Spacing"
              value={activeTypography.letterSpacing || 0}
              min={-4}
              max={16}
              step={0.5}
              unit="px"
              onChange={(v) => updateActiveTargetStyle({ letterSpacing: v })}
            />
            <SliderNumberField
              label="Line Spacing"
              value={activeTypography.lineSpacing || 1.25}
              min={0.8}
              max={2.5}
              step={0.05}
              unit="x"
              onChange={(v) => updateActiveTargetStyle({ lineSpacing: v })}
            />
          </div>

          {/* Text Color & Highlight Color */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-white/[0.06]">
            <div>
              <label className="text-[11px] text-zinc-400 block mb-1">Text Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={activeTypography.primaryColor || '#FFFFFF'}
                  onChange={(e) => updateActiveTargetStyle({ primaryColor: e.target.value })}
                  className="w-8 h-8 rounded bg-transparent cursor-pointer shrink-0"
                />
                <div className="flex flex-wrap gap-1">
                  {QUICK_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => updateActiveTargetStyle({ primaryColor: c })}
                      style={{ backgroundColor: c }}
                      className="w-4 h-4 rounded-full border border-white/25 cursor-pointer"
                    />
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label className="text-[11px] text-zinc-400 block mb-1">Highlight Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={activeTypography.highlightColor || '#FACC15'}
                  onChange={(e) => updateActiveTargetStyle({ highlightColor: e.target.value })}
                  className="w-8 h-8 rounded bg-transparent cursor-pointer shrink-0"
                />
                <div className="flex flex-wrap gap-1">
                  {['#FACC15', '#38BDF8', '#4ADE80', '#F43F5E', '#A855F7'].map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => updateActiveTargetStyle({ highlightColor: c })}
                      style={{ backgroundColor: c }}
                      className="w-4 h-4 rounded-full border border-white/25 cursor-pointer"
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Outline / Stroke */}
          <div className="p-3 rounded-lg bg-zinc-900/60 border border-white/[0.06] space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">Outline / Stroke</span>
              <input
                type="color"
                value={activeTypography.outlineColor || '#000000'}
                onChange={(e) => updateActiveTargetStyle({ outlineColor: e.target.value })}
                className="w-6 h-6 rounded bg-transparent cursor-pointer"
              />
            </div>
            <SliderNumberField
              label="Stroke Thickness"
              value={activeTypography.outlineWidth ?? 3}
              min={0}
              max={12}
              step={0.5}
              unit="px"
              onChange={(v) => updateActiveTargetStyle({ outlineWidth: v })}
            />
          </div>

          {/* Drop Shadow (Color, Blur, Opacity, Distance) */}
          <div className="p-3 rounded-lg bg-zinc-900/60 border border-white/[0.06] space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="flex items-center gap-2 text-xs font-semibold text-white cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeTypography.shadowEnabled !== false}
                  onChange={(e) => updateActiveTargetStyle({ shadowEnabled: e.target.checked })}
                  className="accent-violet-500"
                />
                Drop Shadow
              </label>
              <input
                type="color"
                value={activeTypography.shadowColor || '#000000'}
                onChange={(e) => updateActiveTargetStyle({ shadowColor: e.target.value })}
                className="w-6 h-6 rounded bg-transparent cursor-pointer"
              />
            </div>
            {activeTypography.shadowEnabled !== false && (
              <div className="space-y-2">
                <SliderNumberField
                  label="Shadow Blur"
                  value={activeTypography.shadowBlur ?? 4}
                  min={0}
                  max={24}
                  step={1}
                  unit="px"
                  onChange={(v) => updateActiveTargetStyle({ shadowBlur: v })}
                />
                <SliderNumberField
                  label="Shadow Opacity"
                  value={Math.round((activeTypography.shadowOpacity ?? 0.75) * 100)}
                  min={0}
                  max={100}
                  step={5}
                  unit="%"
                  onChange={(v) => updateActiveTargetStyle({ shadowOpacity: v / 100 })}
                />
                <SliderNumberField
                  label="Shadow Distance"
                  value={activeTypography.shadowDistance ?? 2}
                  min={0}
                  max={20}
                  step={1}
                  unit="px"
                  onChange={(v) => updateActiveTargetStyle({ shadowDistance: v })}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: 18 DISPLAY MODES & ANIMATIONS */}
      {activeTab === 'modes' && (
        <div className="space-y-3">
          <div className="p-3.5 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">
                18 Caption Display Modes
              </span>
              <span className="text-[11px] font-mono text-violet-300">{canonicalMode}</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={modeSearch}
                  onChange={(e) => setModeSearch(e.target.value)}
                  placeholder="Search 18 display modes..."
                  className="w-full bg-zinc-900 border border-white/[0.08] rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-zinc-100"
                />
              </div>
              <select
                value={modeCategory}
                onChange={(e) => setModeCategory(e.target.value)}
                className="bg-zinc-900 border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-xs text-zinc-100"
              >
                <option value="All">All Categories (18)</option>
                <option value="Word Focus">Word Focus</option>
                <option value="Chunked">Chunked</option>
                <option value="Karaoke & Reveal">Karaoke &amp; Reveal</option>
                <option value="Classic & Clean">Classic &amp; Clean</option>
                <option value="Viral Styled">Viral Styled</option>
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-[260px] overflow-y-auto pr-1">
              {filteredModes.map((m) => {
                const isSel = canonicalMode === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() =>
                      updateStyle(
                        {
                          mode: m.id as CaptionDisplayMode,
                          wordsPerDisplay:
                            m.defaultWordsPerDisplay > 0
                              ? m.defaultWordsPerDisplay
                              : project.subtitleStyle.wordsPerDisplay,
                          highlightBehavior: m.defaultHighlightBehavior,
                          template: 'custom',
                        },
                        true
                      )
                    }
                    className={`p-2 rounded-lg text-left border transition-colors cursor-pointer ${
                      isSel
                        ? 'bg-violet-600/25 border-violet-500 text-white'
                        : 'bg-zinc-900/75 border-white/[0.06] text-zinc-300 hover:border-white/[0.16]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] font-semibold truncate">{m.label}</span>
                      <span className="text-[9px] font-mono text-zinc-500 shrink-0">
                        {m.category}
                      </span>
                    </div>
                    <div className="text-[10px] text-zinc-400 mt-0.5 line-clamp-2">
                      {m.description}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Mode Configuration Controls */}
            <div className="pt-2 border-t border-white/[0.06] space-y-2.5">
              {activeModeDef.supportsWordCount && (
                <SliderNumberField
                  label="Words Per Display"
                  value={
                    project.subtitleStyle.wordsPerDisplay ||
                    activeModeDef.defaultWordsPerDisplay ||
                    3
                  }
                  min={1}
                  max={14}
                  step={1}
                  onChange={(v) => updateStyle({ wordsPerDisplay: v })}
                />
              )}

              <div>
                <label className="text-[11px] text-zinc-400">Highlight Behavior</label>
                <div className="mt-1 grid grid-cols-5 gap-1 bg-zinc-900 p-0.5 rounded-lg border border-white/[0.06]">
                  {(
                    [
                      { id: 'color', label: 'Color' },
                      { id: 'box', label: 'Box' },
                      { id: 'scale', label: 'Scale' },
                      { id: 'underline', label: 'Line' },
                      { id: 'glow', label: 'Glow' },
                    ] as Array<{ id: CaptionHighlightBehavior; label: string }>
                  ).map((hb) => (
                    <button
                      key={hb.id}
                      type="button"
                      onClick={() => updateStyle({ highlightBehavior: hb.id }, true)}
                      className={`py-1 rounded text-[10.5px] font-medium cursor-pointer ${
                        (project.subtitleStyle.highlightBehavior || 'color') === hb.id
                          ? 'bg-violet-600 text-white'
                          : 'text-zinc-400 hover:text-zinc-200'
                      }`}
                    >
                      {hb.label}
                    </button>
                  ))}
                </div>
              </div>

              <SliderNumberField
                label="Transition Duration"
                value={project.subtitleStyle.transitionDurationMs ?? 160}
                min={0}
                max={600}
                step={20}
                unit="ms"
                onChange={(v) => updateStyle({ transitionDurationMs: v })}
              />

              <SliderNumberField
                label="Caption Timing Offset"
                value={project.subtitleStyle.timingOffsetSec ?? 0}
                min={-3}
                max={3}
                step={0.05}
                unit="s"
                onChange={(v) => updateStyle({ timingOffsetSec: v })}
              />
            </div>
          </div>

          {/* Animation Presets */}
          <div className="p-3.5 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-2.5">
            <span className="text-xs font-semibold text-white">Entrance &amp; Word Animation</span>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {ANIMATIONS.map((anim) => {
                const active = (project.subtitleStyle.animationPreset || 'none') === anim.id;
                return (
                  <button
                    key={anim.id}
                    type="button"
                    onClick={() => updateStyle({ animationPreset: anim.id, template: 'custom' }, true)}
                    className={`p-2 rounded-lg text-left text-[11px] border cursor-pointer ${
                      active
                        ? 'bg-violet-600/20 border-violet-500 text-violet-200'
                        : 'bg-zinc-900 border-white/[0.06] text-zinc-300 hover:border-white/[0.15]'
                    }`}
                  >
                    <div className="font-semibold">{anim.label}</div>
                    <div className="text-[9.5px] text-zinc-500">{anim.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* TAB 4: BACKGROUND BOX, WRAPPING & TRANSFORM */}
      {activeTab === 'position' && (
        <div className="p-4 rounded-xl bg-[#18181D] border border-white/[0.08] space-y-4">
          {/* Background Box */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">Background Box &amp; Corners</span>
              <input
                type="color"
                value={activeTypography.backgroundColor || '#09090B'}
                onChange={(e) => updateActiveTargetStyle({ backgroundColor: e.target.value })}
                className="w-6 h-6 rounded bg-transparent cursor-pointer"
              />
            </div>
            <SliderNumberField
              label="Background Opacity"
              value={Math.round((activeTypography.backgroundOpacity ?? 0.55) * 100)}
              min={0}
              max={100}
              step={5}
              unit="%"
              onChange={(v) => updateActiveTargetStyle({ backgroundOpacity: v / 100 })}
            />
            <SliderNumberField
              label="Horizontal Padding"
              value={activeTypography.paddingH ?? 14}
              min={0}
              max={64}
              step={1}
              unit="px"
              onChange={(v) => updateActiveTargetStyle({ paddingH: v })}
            />
            <SliderNumberField
              label="Vertical Padding"
              value={activeTypography.paddingV ?? 6}
              min={0}
              max={48}
              step={1}
              unit="px"
              onChange={(v) => updateActiveTargetStyle({ paddingV: v })}
            />
            <SliderNumberField
              label="Rounded Corners"
              value={activeTypography.borderRadius ?? 8}
              min={0}
              max={36}
              step={1}
              unit="px"
              onChange={(v) => updateActiveTargetStyle({ borderRadius: v })}
            />
          </div>

          {/* Wrapping & Max Width / Lines */}
          <div className="space-y-2.5 pt-2 border-t border-white/[0.06]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">Width &amp; Line Wrapping</span>
              <label className="flex items-center gap-1.5 text-[11px] text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={activeTypography.textWrap !== false}
                  onChange={(e) => updateActiveTargetStyle({ textWrap: e.target.checked })}
                  className="accent-violet-500"
                />
                Wrap Text
              </label>
            </div>
            <SliderNumberField
              label="Maximum Width"
              value={activeTypography.maxWidthPct ?? 88}
              min={25}
              max={98}
              step={1}
              unit="%"
              onChange={(v) => updateActiveTargetStyle({ maxWidthPct: v })}
            />
            <SliderNumberField
              label="Max Lines"
              value={activeTypography.maxLines ?? 2}
              min={1}
              max={6}
              step={1}
              onChange={(v) => updateActiveTargetStyle({ maxLines: v })}
            />
          </div>

          {/* Positioning & Transform */}
          <div className="space-y-2.5 pt-2 border-t border-white/[0.06]">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                <Move className="w-3.5 h-3.5 text-violet-400" />
                Position, Scale &amp; Rotation
              </span>
              {!activeExtraEl && (
                <label className="flex items-center gap-1.5 text-[11px] text-zinc-400 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(project.subtitleStyle.showSafeGuides)}
                    onChange={(e) => updateStyle({ showSafeGuides: e.target.checked }, true)}
                    className="accent-violet-500"
                  />
                  Safe Guides
                </label>
              )}
            </div>

            <div className="grid grid-cols-3 gap-1.5">
              {[
                { pos: 'top' as const, y: 14, label: 'Top' },
                { pos: 'middle' as const, y: 50, label: 'Center' },
                { pos: 'bottom' as const, y: 82, label: 'Bottom' },
              ].map((p) => (
                <button
                  key={p.pos}
                  type="button"
                  onClick={() =>
                    updateActiveTargetStyle({ position: p.pos, posX: 50, posY: p.y }, true)
                  }
                  className="py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-white/[0.08] text-[11px] text-zinc-200 cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
            </div>

            <SliderNumberField
              label="Horizontal Position (X)"
              value={activeTypography.posX ?? 50}
              min={5}
              max={95}
              step={1}
              unit="%"
              onChange={(v) => updateActiveTargetStyle({ posX: v, position: 'custom' })}
            />
            <SliderNumberField
              label="Vertical Position (Y)"
              value={activeTypography.posY ?? 82}
              min={5}
              max={95}
              step={1}
              unit="%"
              onChange={(v) => updateActiveTargetStyle({ posY: v, position: 'custom' })}
            />
            <SliderNumberField
              label="Text Scale"
              value={Math.round((activeTypography.scale ?? 1) * 100)}
              min={40}
              max={250}
              step={5}
              unit="%"
              onChange={(v) => updateActiveTargetStyle({ scale: v / 100 })}
            />
            <SliderNumberField
              label="Rotation"
              value={Math.round(activeTypography.rotation ?? 0)}
              min={-180}
              max={180}
              step={1}
              unit="°"
              onChange={(v) => updateActiveTargetStyle({ rotation: v })}
            />
            <SliderNumberField
              label="Text Opacity"
              value={Math.round((activeTypography.opacity ?? 1) * 100)}
              min={5}
              max={100}
              step={5}
              unit="%"
              onChange={(v) => updateActiveTargetStyle({ opacity: v / 100 })}
            />
          </div>
        </div>
      )}

      {/* TAB 5: TRANSLATED SEGMENTS TIMELINE (STRICT translatedText ONLY) */}
      {activeTab === 'segments' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-zinc-300">
              Translated Narration Segments ({syncedCaptions.length})
            </span>
            <button
              type="button"
              onClick={addManualSegment}
              className="px-2.5 py-1 rounded-md bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200 flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Translated Line
            </button>
          </div>

          <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
            {syncedCaptions.length === 0 ? (
              <div className="p-6 rounded-lg bg-[#18181D] border border-white/[0.06] text-xs text-zinc-500 text-center">
                No translated segments yet. Import translated JSON or translate in Stage 2.
              </div>
            ) : (
              syncedCaptions.map((seg, idx) => {
                const missingText = !seg.translatedText || !seg.translatedText.trim();
                const isOutdated = syncStatus.outdatedSegmentIds.includes(seg.id);
                return (
                  <div
                    key={seg.id}
                    onClick={() => onSeek(seg.syncedStart)}
                    className={`p-3 rounded-lg bg-[#18181D] border space-y-2 transition-colors ${
                      missingText
                        ? 'border-red-500/50'
                        : isOutdated
                        ? 'border-amber-500/45'
                        : 'border-white/[0.06] hover:border-violet-500/40'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-1.5 text-[10.5px] font-mono">
                        <span className="text-zinc-500 font-sans">#{idx + 1}</span>
                        <span className="px-1.5 py-0.5 rounded bg-zinc-900 text-sky-300">
                          {seg.syncedStart.toFixed(2)}s → {seg.syncedEnd.toFixed(2)}s
                        </span>
                        <span className="text-zinc-500">
                          (Dur: {seg.audioDuration.toFixed(2)}s · Lead: {seg.leadingSilence.toFixed(2)}s)
                        </span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[9.5px] ${
                            seg.timingSource === 'actual'
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {seg.timingSource === 'actual' ? 'Actual words' : 'Estimated sync'}
                        </span>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void splitSegment(seg.id);
                          }}
                          title="Split caption"
                          className="p-1 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 cursor-pointer"
                        >
                          <Scissors className="w-3.5 h-3.5" />
                        </button>
                        {idx < syncedCaptions.length - 1 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void mergeWithNextSegment(seg.id);
                            }}
                            title="Merge with next"
                            className="p-1 text-zinc-400 hover:text-white rounded hover:bg-zinc-800 cursor-pointer"
                          >
                            <Merge className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeSegment(seg.id);
                          }}
                          title="Delete segment"
                          className="p-1 text-zinc-500 hover:text-red-400 rounded hover:bg-zinc-800 cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    <textarea
                      rows={2}
                      placeholder="Missing translatedText — enter translated caption line (never falls back to original text)..."
                      value={seg.translatedText || ''}
                      onChange={(e) =>
                        updateSegment(seg.id, {
                          translatedText: e.target.value,
                          words: undefined,
                        })
                      }
                      onBlur={() => void saveSegments(project.captions)}
                      className={`w-full bg-zinc-900 border rounded px-2.5 py-1.5 text-xs text-zinc-100 resize-none focus:outline-none focus:border-violet-500 ${
                        missingText ? 'border-red-500/60' : 'border-white/[0.08]'
                      }`}
                    />
                    {seg.text && (
                      <div className="text-[10.5px] text-zinc-500 bg-zinc-900/50 px-2 py-1 rounded border border-white/[0.04] truncate">
                        Reference only (not displayed in captions): {seg.text}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* SRT / VTT Import & Export Bar */}
      <div className="pt-2 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".srt,.vtt,text/plain"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void handleImportSrtVtt(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1.5 cursor-pointer"
          >
            <UploadCloud className="w-3.5 h-3.5" />
            Import SRT / VTT
          </button>
        </div>

        {project.captions.length > 0 && (
          <div className="flex items-center gap-2">
            <a
              href={`/api/projects/${project.id}/subtitles/srt`}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
            >
              <Download className="w-3 h-3" />
              SRT
            </a>
            <a
              href={`/api/projects/${project.id}/subtitles/vtt`}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
            >
              <Download className="w-3 h-3" />
              VTT
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
