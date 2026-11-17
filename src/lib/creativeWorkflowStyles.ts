/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_VIDEO_CANVAS,
  ExportSettings,
  Project,
  SubtitleStyle,
  SupportedLanguage,
  TranslationConfig,
  VideoCanvasConfig,
  VideoEffectsConfig,
  VoiceConfig,
} from '../types/studio';
import { indexedDbStore } from './indexedDbStore';

export interface CreativeWorkflowStyle {
  id: string;
  schemaVersion: number;
  name: string;
  description: string;
  previewImage?: string;
  isDefault?: boolean;
  isFavorite?: boolean;
  createdAt: string;
  updatedAt: string;
  config: {
    analysis?: {
      instructions?: string;
      detectionSensitivity?: number;
    };
    translation?: {
      sourceLanguage?: string;
      targetLanguage?: SupportedLanguage;
      preserveProperNouns?: boolean;
      defaultShorteningIntensity?: string;
    };
    voice?: Partial<VoiceConfig>;
    captions?: Partial<SubtitleStyle>;
    videoEditing?: {
      videoSpeed?: Project['videoSpeed'];
      videoEffects?: Partial<VideoEffectsConfig>;
      canvas?: Partial<VideoCanvasConfig>;
    };
    thumbnail?: {
      aspectRatio?: string;
      titleSize?: number;
      palette?: { bg: string; fg: string; accent: string };
    };
    exportSettings?: Partial<ExportSettings>;
  };
}

const CREATIVE_STYLES_KV = 'recap_studio_creative_styles_v1';
const DEFAULT_STYLE_ID_KV = 'recap_studio_default_style_id_v1';

export const STARTER_CREATIVE_STYLES: CreativeWorkflowStyle[] = [
  {
    id: 'style-dark-cinematic-docu',
    schemaVersion: 1,
    name: 'Dark Cinematic Documentary',
    description: 'High contrast teal/orange grade, slow dramatic pacing, serif narration styling, and 1080p cinematic export.',
    isDefault: true,
    isFavorite: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      translation: { targetLanguage: 'French', preserveProperNouns: true, defaultShorteningIntensity: 'medium' },
      voice: { provider: 'fish', narrationStyle: 'cinematic', style: 'Dark cinematic documentary narrator with slow gravitas' },
      captions: {
        template: 'cinematic',
        fontFamily: 'Merriweather',
        fontSize: 36,
        fontWeight: 'bold',
        fontWeightNum: 700,
        primaryColor: '#F8FAFC',
        highlightColor: '#38BDF8',
        animationPreset: 'fade',
      },
      videoEditing: {
        videoEffects: { filterPreset: 'cinematic' },
      },
      exportSettings: { resolution: '1080p', fitMode: 'crop', applyCaptions: false },
    },
  },
  {
    id: 'style-viral-fast-shorts',
    schemaVersion: 1,
    name: 'Viral Fast-Cut Shorts',
    description: 'Energetic pop-up captions, vibrant high-contrast filter, 9:16 vertical crop, and snappy spoken pacing.',
    isDefault: false,
    isFavorite: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      translation: { targetLanguage: 'English', preserveProperNouns: true, defaultShorteningIntensity: 'strong' },
      voice: { provider: 'fish', narrationStyle: 'energetic', style: 'Fast energetic short-form narrator' },
      captions: {
        template: 'tiktok',
        mode: 'word-by-word',
        fontFamily: 'Montserrat',
        fontSize: 46,
        fontWeight: '900',
        fontWeightNum: 900,
        primaryColor: '#FFFFFF',
        highlightColor: '#FACC15',
        animationPreset: 'word-popup',
        highlightBehavior: 'scale',
      },
      videoEditing: {
        videoEffects: { filterPreset: 'vibrant' },
      },
      exportSettings: { resolution: '1080p', fitMode: 'crop', applyCaptions: false },
    },
  },
];

export async function listCreativeStyles(): Promise<CreativeWorkflowStyle[]> {
  const custom = (await indexedDbStore.getKv<CreativeWorkflowStyle[]>(CREATIVE_STYLES_KV)) || [];
  if (custom.length === 0) {
    await indexedDbStore.setKv(CREATIVE_STYLES_KV, STARTER_CREATIVE_STYLES);
    return STARTER_CREATIVE_STYLES;
  }
  return custom;
}

export async function saveCreativeStyle(style: CreativeWorkflowStyle): Promise<CreativeWorkflowStyle[]> {
  const current = await listCreativeStyles();
  const next = [style, ...current.filter((s) => s.id !== style.id)];
  await indexedDbStore.setKv(CREATIVE_STYLES_KV, next);
  return next;
}

export async function deleteCreativeStyle(id: string): Promise<CreativeWorkflowStyle[]> {
  const current = await listCreativeStyles();
  const next = current.filter((s) => s.id !== id);
  await indexedDbStore.setKv(CREATIVE_STYLES_KV, next);
  return next;
}

export async function getDefaultStyleId(): Promise<string> {
  const saved = await indexedDbStore.getKv<string>(DEFAULT_STYLE_ID_KV);
  if (saved) return saved;
  const styles = await listCreativeStyles();
  const def = styles.find((s) => s.isDefault) || styles[0];
  return def?.id || 'style-dark-cinematic-docu';
}

export async function setDefaultStyleId(id: string): Promise<void> {
  await indexedDbStore.setKv(DEFAULT_STYLE_ID_KV, id);
  const styles = await listCreativeStyles();
  const next = styles.map((s) => ({ ...s, isDefault: s.id === id }));
  await indexedDbStore.setKv(CREATIVE_STYLES_KV, next);
}

export function applyCreativeStyleToProject(project: Project, style: CreativeWorkflowStyle): Project {
  const cfg = style.config;
  return {
    ...project,
    translation: {
      ...project.translation,
      ...(cfg.translation?.targetLanguage ? { targetLanguage: cfg.translation.targetLanguage } : {}),
      ...(cfg.translation?.preserveProperNouns !== undefined ? { preserveProperNouns: cfg.translation.preserveProperNouns } : {}),
    },
    voice: {
      ...project.voice,
      ...(cfg.voice || {}),
      enabled: project.voice.enabled,
    },
    subtitleStyle: {
      ...project.subtitleStyle,
      ...(cfg.captions || {}),
      enabled: project.subtitleStyle.enabled, // preserve user preview toggle
      useTranslated: true,
    },
    videoEffects: {
      ...project.videoEffects,
      ...(cfg.videoEditing?.videoEffects || {}),
    },
    canvas: {
      ...DEFAULT_VIDEO_CANVAS,
      ...(project.canvas || {}),
      ...(cfg.videoEditing?.canvas || {}),
    },
    videoSpeed: cfg.videoEditing?.videoSpeed || project.videoSpeed,
    exportSettings: {
      ...project.exportSettings,
      ...(cfg.exportSettings || {}),
    },
  };
}

export function extractCreativeStyleFromProject(
  project: Project,
  name: string,
  description: string
): CreativeWorkflowStyle {
  return {
    id: `style_${Date.now()}`,
    schemaVersion: 1,
    name: name.trim() || 'Custom Workflow Style',
    description: description.trim(),
    isDefault: false,
    isFavorite: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    config: {
      translation: {
        targetLanguage: project.translation.targetLanguage,
        preserveProperNouns: project.translation.preserveProperNouns,
      },
      voice: {
        provider: project.voice.provider,
        narrationStyle: project.voice.narrationStyle,
        style: project.voice.style,
      },
      captions: {
        template: project.subtitleStyle.template,
        mode: project.subtitleStyle.mode,
        fontFamily: project.subtitleStyle.fontFamily,
        fontSize: project.subtitleStyle.fontSize,
        fontWeight: project.subtitleStyle.fontWeight,
        primaryColor: project.subtitleStyle.primaryColor,
        highlightColor: project.subtitleStyle.highlightColor,
        animationPreset: project.subtitleStyle.animationPreset,
      },
      videoEditing: {
        videoSpeed: project.videoSpeed,
        videoEffects: project.videoEffects,
        canvas: project.canvas,
      },
      exportSettings: project.exportSettings,
    },
  };
}
