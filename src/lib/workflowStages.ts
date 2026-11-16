import {
  CaptionSegment,
  CaptionSyncSnapshot,
  DEFAULT_VIDEO_CANVAS,
  Project,
  ProjectWorkflowState,
  StageStatus,
  SupportedLanguage,
  VideoCanvasConfig,
  WorkflowStageId,
  WordTiming,
} from '../types/studio';

export interface WorkflowStageDef {
  id: WorkflowStageId;
  stepLabel: string;
  title: string;
  shortTitle: string;
  optional: boolean;
}

export const WORKFLOW_STAGES: WorkflowStageDef[] = [
  {
    id: 'dashboard',
    stepLabel: '1',
    title: 'Import Video',
    shortTitle: 'Import',
    optional: false,
  },
  {
    id: 'translator',
    stepLabel: '2',
    title: 'Analysis & Translation',
    shortTitle: 'Translation',
    optional: true,
  },
  {
    id: 'voice',
    stepLabel: '3–4',
    title: 'Voiceover & Sync',
    shortTitle: 'Voice & Sync',
    optional: true,
  },
  {
    id: 'editor',
    stepLabel: '5',
    title: 'Editing & Filters',
    shortTitle: 'Edit & Canvas',
    optional: true,
  },
  {
    id: 'captions',
    stepLabel: '6',
    title: 'Captions (Manual)',
    shortTitle: 'Captions',
    optional: true,
  },
  {
    id: 'export',
    stepLabel: '7',
    title: 'Final Preview & Export',
    shortTitle: 'Export',
    optional: false,
  },
];

export function getActiveCaptionSourceText(
  seg: CaptionSegment,
  _useTranslated = true
): string {
  // MANDATORY RULE: Captions NEVER use originalText (seg.text). Only segment.translatedText.
  return (seg.translatedText || '').trim();
}

export function countMissingTranslations(captions: CaptionSegment[]): number {
  return captions.filter((seg) => !seg.translatedText || !seg.translatedText.trim()).length;
}

export function normalizeCaptionDisplayMode(
  mode: Project['subtitleStyle']['mode']
): 'word-by-word' | 'karaoke' | 'phrase-chunk' | 'sentence' {
  if (mode === 'word' || mode === 'word-by-word') return 'word-by-word';
  if (mode === 'karaoke') return 'karaoke';
  if (mode === 'phrase-chunk' || mode === 'two-words' || mode === 'three-words' || mode === 'four-words') {
    return 'phrase-chunk';
  }
  return 'sentence';
}

export function distributeWordsEvenly(
  text: string,
  start: number,
  end: number
): WordTiming[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const safeStart = Math.max(0, start);
  const safeEnd = Math.max(safeStart + 0.15, end);
  const totalDur = safeEnd - safeStart;
  const weights = words.map((w) =>
    Math.max(2, w.replace(/[^a-zA-Z0-9\u0600-\u06FF]/g, '').length)
  );
  const weightSum = weights.reduce((a, b) => a + b, 0) || words.length;

  let cursor = safeStart;
  return words.map((word, idx) => {
    const share = (weights[idx] / weightSum) * totalDur;
    const wStart = cursor;
    const wEnd = idx === words.length - 1 ? safeEnd : wStart + share;
    cursor = wEnd;
    return {
      word,
      start: Number(wStart.toFixed(3)),
      end: Number(Math.max(wStart + 0.05, wEnd).toFixed(3)),
    };
  });
}

export interface SyncedPreviewCaption extends CaptionSegment {
  syncedStart: number;
  syncedEnd: number;
  speechStart: number;
  speechEnd: number;
  leadingSilence: number;
  trailingSilence: number;
  audioDuration: number;
  timingSource: 'actual' | 'estimated';
}

export function getSyncedCaptionsForPreview(project: Project): SyncedPreviewCaption[] {
  const useDubTimeline = Boolean(
    project.voice.enabled && (project.voice.syncPlan?.segments?.length || project.voice.generatedClips?.length)
  );
  const voiceOffset = Number(project.voice.timingOffsetSec || 0);
  const capOffset = Number(project.subtitleStyle.timingOffsetSec || 0);
  const totalOffset = (useDubTimeline ? voiceOffset : 0) + capOffset;

  const syncById = new Map(
    (project.voice.syncPlan?.segments || []).map((s) => [s.segmentId, s])
  );
  const clipById = new Map(
    (project.voice.generatedClips || []).map((c) => [c.segmentId, c])
  );

  return project.captions.map((seg) => {
    const syncSeg = useDubTimeline ? syncById.get(seg.id) : undefined;
    const clip = useDubTimeline ? clipById.get(seg.id) : undefined;

    const baseStart = syncSeg
      ? syncSeg.syncedStart
      : clip
      ? clip.start
      : seg.start;
    const baseEnd = syncSeg
      ? syncSeg.syncedEnd
      : clip
      ? clip.end
      : seg.end;

    const leadingSilence = syncSeg?.leadingSilence ?? clip?.leadingSilence ?? 0;
    const trailingSilence = syncSeg?.trailingSilence ?? clip?.trailingSilence ?? 0;
    const syncedStart = Math.max(0, Number((baseStart + totalOffset).toFixed(3)));
    const syncedEnd = Math.max(syncedStart + 0.15, Number((baseEnd + totalOffset).toFixed(3)));

    const rawSpeechStart = syncedStart + Math.max(0, leadingSilence);
    const rawSpeechEnd = Math.max(rawSpeechStart + 0.12, syncedEnd - Math.max(0, trailingSilence));
    const speechStart = Math.min(rawSpeechStart, syncedEnd - 0.12);
    const speechEnd = Math.min(syncedEnd, rawSpeechEnd);

    const activeText = getActiveCaptionSourceText(seg, true);
    const normalized = activeText.replace(/\s+/g, ' ').trim();
    const existingJoined = (seg.words || []).map((w) => w.word).join(' ').trim();
    const hasMatchingActualWords =
      seg.wordsSource === 'actual' &&
      Boolean(seg.words && seg.words.length > 0 && normalized && existingJoined === normalized);

    const words = hasMatchingActualWords
      ? seg.words!.map((w) => ({
          word: w.word,
          start: Math.max(0, Number((w.start + totalOffset).toFixed(3))),
          end: Math.max(0.05, Number((w.end + totalOffset).toFixed(3))),
        }))
      : distributeWordsEvenly(activeText, speechStart, speechEnd);

    return {
      ...seg,
      start: syncedStart,
      end: syncedEnd,
      syncedStart,
      syncedEnd,
      speechStart,
      speechEnd,
      leadingSilence,
      trailingSilence,
      audioDuration: clip?.duration ?? syncSeg?.audioDuration ?? Math.max(0, syncedEnd - syncedStart),
      words,
      wordsSource: hasMatchingActualWords ? 'actual' : 'estimated',
      timingSource: hasMatchingActualWords ? 'actual' : 'estimated',
    };
  });
}

export function resolveCaptionWords(
  seg: CaptionSegment,
  _useTranslated = true
): WordTiming[] {
  const activeSource = getActiveCaptionSourceText(seg, true);
  if (!activeSource) return [];
  const normalized = activeSource.replace(/\s+/g, ' ').trim();
  const existingJoined = (seg.words || []).map((w) => w.word).join(' ').trim();

  if (seg.words && seg.words.length > 0 && existingJoined === normalized) {
    return seg.words.map((w, idx) => {
      const next = seg.words![idx + 1];
      const start = idx === 0 ? Math.min(seg.start, w.start) : w.start;
      const end = next ? Math.max(w.end, next.start) : Math.max(seg.end, w.end);
      return {
        word: w.word,
        start,
        end: Math.max(start + 0.05, end),
      };
    });
  }
  return distributeWordsEvenly(activeSource, seg.start, seg.end);
}

export interface CaptionSyncStatus {
  hasSnapshot: boolean;
  generatedAt: string | null;
  sourceMode: 'translated' | 'original';
  targetLanguage: SupportedLanguage;
  outdatedSegmentIds: string[];
  outdatedReasons: Record<string, string>;
  hasOutdated: boolean;
}

export function computeCaptionSyncStatus(project: Project): CaptionSyncStatus {
  const snap = project.subtitleStyle.captionSync;
  const activeMode: 'translated' | 'original' = 'translated';
  const targetLanguage =
    project.voice.targetLanguage || project.translation.targetLanguage || 'French';

  if (!snap) {
    return {
      hasSnapshot: false,
      generatedAt: null,
      sourceMode: activeMode,
      targetLanguage,
      outdatedSegmentIds: [],
      outdatedReasons: {},
      hasOutdated: false,
    };
  }

  const outdatedSegmentIds: string[] = [];
  const outdatedReasons: Record<string, string> = {};
  const syncById = new Map(
    (project.voice.syncPlan?.segments || []).map((s) => [s.segmentId, s])
  );

  for (const seg of project.captions) {
    const currentText = getActiveCaptionSourceText(seg, true);
    const prevText = snap.segmentTexts?.[seg.id];
    const synced = syncById.get(seg.id);
    const currentTimeKey = synced
      ? `${synced.syncedStart.toFixed(2)}-${synced.syncedEnd.toFixed(2)}`
      : `${seg.start.toFixed(2)}-${seg.end.toFixed(2)}`;
    const prevTimeKey = snap.segmentTimes?.[seg.id];

    if (prevText === undefined) {
      outdatedSegmentIds.push(seg.id);
      outdatedReasons[seg.id] = 'Segment added after captions were generated';
    } else if (currentText !== prevText) {
      outdatedSegmentIds.push(seg.id);
      outdatedReasons[seg.id] = 'translatedText edited in Transcript & Translation Editor';
    } else if (prevTimeKey && prevTimeKey !== currentTimeKey) {
      outdatedSegmentIds.push(seg.id);
      outdatedReasons[seg.id] = 'Voiceover narration timeline updated';
    }
  }

  return {
    hasSnapshot: true,
    generatedAt: snap.generatedAt,
    sourceMode: activeMode,
    targetLanguage,
    outdatedSegmentIds,
    outdatedReasons,
    hasOutdated: outdatedSegmentIds.length > 0,
  };
}

/**
 * Generates timed captions strictly from segment.translatedText and the FINAL voiceover timeline
 * (NEVER falls back to originalText / ASR).
 */
export function buildCaptionsFromTranscript(project: Project): {
  captions: CaptionSegment[];
  subtitleStyle: Project['subtitleStyle'];
  sourceMode: 'translated';
  targetLanguage: SupportedLanguage;
  missingCount: number;
} {
  if (!project.captions || project.captions.length === 0) {
    throw new Error(
      'No segments found in Transcript & Translation Editor. Add or import translated JSON in Stage 2 / Stage 3–4 first.'
    );
  }

  const translatedCount = project.captions.filter((c) => Boolean(c.translatedText?.trim())).length;
  if (translatedCount === 0) {
    throw new Error(
      'Missing translatedText on all segments. Captions are generated exclusively from segment.translatedText and never fall back to original text.'
    );
  }

  const missingCount = project.captions.length - translatedCount;
  const targetLanguage =
    project.voice.targetLanguage || project.translation.targetLanguage || 'French';

  const syncById = new Map(
    (project.voice.syncPlan?.segments || []).map((s) => [s.segmentId, s])
  );
  const clipById = new Map(
    (project.voice.generatedClips || []).map((c) => [c.segmentId, c])
  );

  const segmentTexts: Record<string, string> = {};
  const segmentTimes: Record<string, string> = {};

  const updatedCaptions: CaptionSegment[] = project.captions.map((seg) => {
    const activeText = getActiveCaptionSourceText(seg, true);
    const synced = syncById.get(seg.id);
    const clip = clipById.get(seg.id);
    const tStart = synced ? synced.syncedStart : clip ? clip.start : seg.start;
    const tEnd = synced ? synced.syncedEnd : clip ? clip.end : seg.end;
    const leadSil = synced?.leadingSilence ?? clip?.leadingSilence ?? 0;
    const trailSil = synced?.trailingSilence ?? clip?.trailingSilence ?? 0;
    const speechStart = Math.min(tEnd - 0.12, tStart + Math.max(0, leadSil));
    const speechEnd = Math.max(speechStart + 0.12, tEnd - Math.max(0, trailSil));

    segmentTexts[seg.id] = activeText;
    segmentTimes[seg.id] = `${tStart.toFixed(2)}-${tEnd.toFixed(2)}`;

    return {
      ...seg,
      wordsSource: 'estimated' as const,
      words: activeText ? distributeWordsEvenly(activeText, speechStart, speechEnd) : [],
    };
  });

  const captionSync: CaptionSyncSnapshot = {
    generatedAt: new Date().toISOString(),
    sourceMode: 'translated',
    targetLanguage,
    segmentTexts,
    segmentTimes,
  };

  return {
    captions: updatedCaptions,
    subtitleStyle: {
      ...project.subtitleStyle,
      enabled: true,
      useTranslated: true,
      captionSync,
    },
    sourceMode: 'translated',
    targetLanguage,
    missingCount,
  };
}

export interface StageStatusInfo {
  id: WorkflowStageId;
  stepLabel: string;
  title: string;
  shortTitle: string;
  status: StageStatus;
  canContinue: boolean;
  validationMessage?: string;
  attentionReason?: string;
  optional: boolean;
}

export function computeStageStatuses(
  project: Project | null,
  activeStage: WorkflowStageId
): StageStatusInfo[] {
  const wf = project?.workflow;
  const visited = new Set<WorkflowStageId>(wf?.visitedStages || []);
  const completed = new Set<WorkflowStageId>(wf?.completedStages || []);
  const attention = new Set<WorkflowStageId>(wf?.needsAttentionStages || []);
  const captionSync = project ? computeCaptionSyncStatus(project) : null;

  return WORKFLOW_STAGES.map((def): StageStatusInfo => {
    if (!project) {
      return {
        ...def,
        status: def.id === activeStage ? 'In Progress' : 'Not Started',
        canContinue: false,
        validationMessage: 'Create or upload a project video first.',
      };
    }

    const hasVideo = Boolean(project.sourceVideoUrl && project.metadata);
    const hasTranscript = project.captions.length > 0;
    const hasTranslations = project.captions.some((c) => Boolean(c.translatedText?.trim()));
    const hasDub = Boolean(project.voice.enabled && project.voice.fullDubUrl);
    const hasPendingVoiceRegen =
      (project.translation.pendingRegenerateSegmentIds?.length || 0) > 0;
    const hasVoiceConflict = Boolean(
      project.voice.syncPlan &&
        (project.voice.syncPlan.conflictCount > 0 ||
          (project.voice.syncPlan.narrationAudit &&
            !project.voice.syncPlan.narrationAudit.isComplete))
    );
    const canvasEdited =
      project.canvas &&
      (project.canvas.aspectRatio !== 'original' ||
        project.canvas.zoom !== 1 ||
        project.canvas.offsetX !== 0 ||
        project.canvas.offsetY !== 0 ||
        project.canvas.cropTop > 0 ||
        project.canvas.cropRight > 0 ||
        project.canvas.cropBottom > 0 ||
        project.canvas.cropLeft > 0);
    const hasVisualEdits =
      project.videoEffects?.filterPreset !== 'none' ||
      (project.videoEffects?.effects?.some((e) => e.enabled) ?? false) ||
      project.blurs.some((b) => b.enabled) ||
      project.logos.some((l) => l.enabled) ||
      Boolean(canvasEdited);

    let canContinue = true;
    let validationMessage: string | undefined;
    let attentionReason: string | undefined;
    let status: StageStatus = 'Not Started';

    if (def.id === 'dashboard') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Upload a source video (MP4, MOV, or MKV) before continuing to Stage 2.';
        status = activeStage === 'dashboard' || project.id ? 'In Progress' : 'Not Started';
      } else {
        status = 'Completed';
      }
    } else if (def.id === 'translator') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Stage 1 requires a source video first.';
      }
      if (attention.has('translator')) {
        status = 'Needs Attention';
        attentionReason = 'Source video changed — review transcript and translations.';
      } else if (hasTranslations || completed.has('translator')) {
        status = 'Completed';
      } else if (hasTranscript || visited.has('translator') || activeStage === 'translator') {
        status = 'In Progress';
      }
    } else if (def.id === 'voice') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Stage 1 requires a source video first.';
      }
      if (attention.has('voice') || hasPendingVoiceRegen || hasVoiceConflict) {
        status = 'Needs Attention';
        attentionReason = hasPendingVoiceRegen
          ? `${project.translation.pendingRegenerateSegmentIds?.length} edited segment(s) need Fish Audio regeneration.`
          : hasVoiceConflict
          ? 'Audio sync conflicts or missing narration segments detected.'
          : 'Upstream script or media changed — review Voiceover & Sync.';
      } else if (hasDub || completed.has('voice')) {
        status = 'Completed';
      } else if (visited.has('voice') || activeStage === 'voice' || hasTranscript) {
        status = 'In Progress';
      }
    } else if (def.id === 'editor') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Stage 1 requires a source video first.';
      }
      if (attention.has('editor')) {
        status = 'Needs Attention';
        attentionReason = 'Source video changed — review canvas, blurs, and logos.';
      } else if (completed.has('editor') || (hasVisualEdits && activeStage !== 'editor')) {
        status = 'Completed';
      } else if (visited.has('editor') || activeStage === 'editor' || hasVisualEdits) {
        status = 'In Progress';
      }
    } else if (def.id === 'captions') {
      if (!hasVideo) {
        canContinue = false;
        validationMessage = 'Stage 1 requires a source video first.';
      }
      if (attention.has('captions') || captionSync?.hasOutdated) {
        status = 'Needs Attention';
        attentionReason = captionSync?.hasOutdated
          ? `${captionSync.outdatedSegmentIds.length} caption segment(s) outdated after translation edits.`
          : 'Upstream transcript changed — review manual captions.';
      } else if (completed.has('captions') || captionSync?.hasSnapshot || project.subtitleStyle.enabled) {
        status = 'Completed';
      } else if (visited.has('captions') || activeStage === 'captions') {
        status = 'In Progress';
      }
    } else if (def.id === 'export') {
      canContinue = false; // Final stage
      if (!hasVideo) {
        validationMessage = 'Stage 1 requires a source video before exporting.';
      }
      if (attention.has('export')) {
        status = 'Needs Attention';
        attentionReason = 'Project settings changed since last MP4 export — re-render when ready.';
      } else if (project.lastExportUrl) {
        status = 'Completed';
      } else if (visited.has('export') || activeStage === 'export') {
        status = 'In Progress';
      }
    }

    return {
      ...def,
      status,
      canContinue,
      validationMessage,
      attentionReason,
    };
  });
}

export function createWorkflowUpdate(
  existing: ProjectWorkflowState | undefined,
  opts: {
    visitStage?: WorkflowStageId;
    completeStage?: WorkflowStageId;
    clearAttentionFor?: WorkflowStageId;
    modifiedStage?: WorkflowStageId;
    hasExistingExport?: boolean;
    hasGeneratedDub?: boolean;
    hasGeneratedCaptions?: boolean;
  }
): ProjectWorkflowState {
  const visited = new Set<WorkflowStageId>(existing?.visitedStages || []);
  const completed = new Set<WorkflowStageId>(existing?.completedStages || []);
  const attention = new Set<WorkflowStageId>(existing?.needsAttentionStages || []);

  if (opts.visitStage) visited.add(opts.visitStage);
  if (opts.completeStage) {
    visited.add(opts.completeStage);
    completed.add(opts.completeStage);
    attention.delete(opts.completeStage);
  }
  if (opts.clearAttentionFor) {
    attention.delete(opts.clearAttentionFor);
  }

  if (opts.modifiedStage === 'dashboard') {
    if (completed.has('translator') || visited.has('translator')) attention.add('translator');
    if (opts.hasGeneratedDub || completed.has('voice')) attention.add('voice');
    if (completed.has('editor')) attention.add('editor');
    if (opts.hasGeneratedCaptions || completed.has('captions')) attention.add('captions');
    if (opts.hasExistingExport) attention.add('export');
  } else if (opts.modifiedStage === 'translator') {
    if (opts.hasGeneratedDub) attention.add('voice');
    if (opts.hasGeneratedCaptions) attention.add('captions');
    if (opts.hasExistingExport) attention.add('export');
  } else if (opts.modifiedStage === 'voice') {
    if (opts.hasGeneratedCaptions) attention.add('captions');
    if (opts.hasExistingExport) attention.add('export');
  } else if (opts.modifiedStage === 'editor') {
    if (opts.hasExistingExport) attention.add('export');
  } else if (opts.modifiedStage === 'captions') {
    if (opts.hasExistingExport) attention.add('export');
  }

  return {
    visitedStages: Array.from(visited),
    completedStages: Array.from(completed),
    needsAttentionStages: Array.from(attention),
    lastModifiedStage: opts.modifiedStage || existing?.lastModifiedStage,
    revisions: existing?.revisions,
  };
}

export function resolveCanvasDimensions(
  canvas: VideoCanvasConfig | undefined,
  exportSettings: Project['exportSettings'],
  metadata: Project['metadata']
): { width: number; height: number } {
  const c = canvas || DEFAULT_VIDEO_CANVAS;
  const effectiveRatio =
    c.aspectRatio && c.aspectRatio !== 'original'
      ? c.aspectRatio
      : exportSettings.aspectRatio;

  if (effectiveRatio === 'custom') {
    const w = Math.max(240, Math.min(3840, Math.round(c.customWidth || 1080))) & ~1;
    const h = Math.max(240, Math.min(3840, Math.round(c.customHeight || 1920))) & ~1;
    return { width: w, height: h };
  }

  const shortSide =
    exportSettings.resolution === '480p'
      ? 480
      : exportSettings.resolution === '720p'
      ? 720
      : 1080;

  if (effectiveRatio === 'original' && metadata?.width && metadata?.height) {
    if (metadata.width >= metadata.height) {
      const height = shortSide & ~1;
      const width = Math.max(2, Math.round((metadata.width / metadata.height) * height) & ~1);
      return { width, height };
    }
    const width = shortSide & ~1;
    const height = Math.max(2, Math.round((metadata.height / metadata.width) * width) & ~1);
    return { width, height };
  }

  if (effectiveRatio === '9:16') {
    const width = shortSide & ~1;
    const height = Math.round((width * 16) / 9) & ~1;
    return { width, height };
  }
  if (effectiveRatio === '4:5') {
    const width = shortSide & ~1;
    const height = Math.round((width * 5) / 4) & ~1;
    return { width, height };
  }
  if (effectiveRatio === '3:4') {
    const width = shortSide & ~1;
    const height = Math.round((width * 4) / 3) & ~1;
    return { width, height };
  }
  if (effectiveRatio === '1:1') {
    return { width: shortSide & ~1, height: shortSide & ~1 };
  }

  const height = shortSide & ~1;
  const width = Math.round((height * 16) / 9) & ~1;
  return { width, height };
}
