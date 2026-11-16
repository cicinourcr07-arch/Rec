import fs from 'fs';
import { VideoExtensionHold, VoiceConfig } from '../../src/types/studio.ts';
import { getAssetByUrl } from '../db.ts';
import { buildAudioHoldFilter } from './timeline_sync_service.ts';

export interface AudioFilterResult {
  extraInputs: string[];
  filterSteps: string[];
  audioMapLabel: string | null;
  nextInputIndex: number;
}

export function isOriginalAudioActive(voice: VoiceConfig): boolean {
  const muted =
    voice.originalAudioMuted !== undefined
      ? Boolean(voice.originalAudioMuted)
      : !Boolean(voice.preserveOriginalAudio);
  const enabled =
    voice.originalAudioEnabled !== undefined
      ? Boolean(voice.originalAudioEnabled)
      : Boolean(voice.preserveOriginalAudio);
  const vol = Math.max(0, Math.min(2.0, Number(voice.originalAudioVolume ?? 1.0)));
  return enabled && !muted && vol > 0.005;
}

export function buildAudioMixFilters(params: {
  hasSourceAudio: boolean;
  duration: number;
  originalDuration?: number;
  holds?: VideoExtensionHold[];
  voice: VoiceConfig;
  applyDubbing: boolean;
  applyAudioMix: boolean;
  nextInputIndex: number;
}): AudioFilterResult {
  const extraInputs: string[] = [];
  const filterSteps: string[] = [];
  const mixBranches: string[] = [];
  let inputIdx = params.nextInputIndex;

  const dubAsset =
    params.applyDubbing &&
    params.voice.enabled &&
    !params.voice.voiceMuted &&
    Math.max(0, Number(params.voice.voiceVolume ?? 1.0)) > 0.005 &&
    params.voice.fullDubUrl
      ? getAssetByUrl(params.voice.fullDubUrl)
      : null;

  const bgmEnabled =
    params.voice.bgMusicEnabled !== undefined ? Boolean(params.voice.bgMusicEnabled) : Boolean(params.voice.bgMusicUrl && Number(params.voice.bgMusicVolume ?? 0) > 0.005);
  const musicAsset =
    params.applyAudioMix &&
    bgmEnabled &&
    !params.voice.bgMusicMuted &&
    Math.max(0, Number(params.voice.bgMusicVolume ?? 0)) > 0.005 &&
    params.voice.bgMusicUrl
      ? getAssetByUrl(params.voice.bgMusicUrl)
      : null;

  const sfxEnabled = Boolean(params.voice.sfxEnabled);
  const sfxAsset =
    params.applyAudioMix &&
    sfxEnabled &&
    !params.voice.sfxMuted &&
    Math.max(0, Number(params.voice.sfxVolume ?? 1.0)) > 0.005 &&
    params.voice.sfxUrl
      ? getAssetByUrl(params.voice.sfxUrl)
      : null;

  // 1. Original Video Audio (independent of voiceover; muted by default)
  const origActive = params.hasSourceAudio && isOriginalAudioActive(params.voice);
  if (origActive) {
    const vol = Math.max(0, Math.min(2.0, Number(params.voice.originalAudioVolume ?? 1.0)));
    let chain = `[0:a]volume=${vol.toFixed(2)}`;
    if (params.applyAudioMix && params.voice.fadeInSec > 0) {
      chain += `,afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`;
    }
    if (
      params.applyAudioMix &&
      params.voice.fadeOutSec > 0 &&
      params.duration > params.voice.fadeOutSec
    ) {
      const fadeStart = Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2);
      chain += `,afade=t=out:st=${fadeStart}:d=${params.voice.fadeOutSec.toFixed(2)}`;
    }

    if (params.holds && params.holds.length > 0) {
      const holdSteps = buildAudioHoldFilter({
        sourceAudioChainPrefix: chain,
        outputLabel: 'a_orig',
        originalDuration: params.originalDuration || params.duration,
        holds: params.holds,
      });
      filterSteps.push(...holdSteps);
    } else {
      filterSteps.push(`${chain},apad=whole_dur=${params.duration.toFixed(2)},atrim=0:${params.duration.toFixed(2)}[a_orig]`);
    }
    mixBranches.push('[a_orig]');
  }

  // 2. Fish Audio Voiceover (independent volume 0..2.0, never muted by original mute)
  if (dubAsset && fs.existsSync(dubAsset.file_path)) {
    const dubIdx = inputIdx++;
    extraInputs.push('-i', dubAsset.file_path);

    const offsetSec = Number(params.voice.timingOffsetSec || 0);
    const filters: string[] = [];

    if (offsetSec > 0.02) {
      const delayMs = Math.round(offsetSec * 1000);
      filters.push(`adelay=${delayMs}|${delayMs}`);
    } else if (offsetSec < -0.02) {
      const trimStart = Math.abs(offsetSec).toFixed(2);
      filters.push(`atrim=start=${trimStart},asetpts=PTS-STARTPTS`);
    }

    const voiceVol = Math.max(0, Math.min(2.0, Number(params.voice.voiceVolume ?? 1.0)));
    filters.push(`volume=${voiceVol.toFixed(2)}`);
    if (params.applyAudioMix && params.voice.fadeInSec > 0) {
      filters.push(`afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`);
    }
    if (
      params.applyAudioMix &&
      params.voice.fadeOutSec > 0 &&
      params.duration > params.voice.fadeOutSec
    ) {
      const fadeStart = Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2);
      filters.push(`afade=t=out:st=${fadeStart}:d=${params.voice.fadeOutSec.toFixed(2)}`);
    }
    filters.push(`apad=whole_dur=${params.duration.toFixed(2)}`);
    filters.push(`atrim=0:${params.duration.toFixed(2)}`);

    filterSteps.push(`[${dubIdx}:a]${filters.join(',')}[a_dub]`);
    mixBranches.push('[a_dub]');
  }

  // 3. Background Music (0..2.0)
  if (musicAsset && fs.existsSync(musicAsset.file_path)) {
    const musicIdx = inputIdx++;
    extraInputs.push('-stream_loop', '-1', '-i', musicAsset.file_path);
    const vol = Math.max(0, Math.min(2.0, Number(params.voice.bgMusicVolume ?? 0)));
    let chain = `[${musicIdx}:a]atrim=0:${params.duration.toFixed(2)},asetpts=PTS-STARTPTS,volume=${vol.toFixed(2)}`;
    if (params.voice.fadeInSec > 0) {
      chain += `,afade=t=in:st=0:d=${params.voice.fadeInSec.toFixed(2)}`;
    }
    if (params.voice.fadeOutSec > 0 && params.duration > params.voice.fadeOutSec) {
      const fadeStart = Math.max(0, params.duration - params.voice.fadeOutSec).toFixed(2);
      chain += `,afade=t=out:st=${fadeStart}:d=${params.voice.fadeOutSec.toFixed(2)}`;
    }
    chain += `[a_bgm]`;
    filterSteps.push(chain);
    mixBranches.push('[a_bgm]');
  }

  // 4. Sound Effects track (0..2.0)
  if (sfxAsset && fs.existsSync(sfxAsset.file_path)) {
    const sfxIdx = inputIdx++;
    extraInputs.push('-i', sfxAsset.file_path);
    const vol = Math.max(0, Math.min(2.0, Number(params.voice.sfxVolume ?? 1.0)));
    filterSteps.push(
      `[${sfxIdx}:a]volume=${vol.toFixed(2)},apad=whole_dur=${params.duration.toFixed(2)},atrim=0:${params.duration.toFixed(2)}[a_sfx]`
    );
    mixBranches.push('[a_sfx]');
  }

  if (mixBranches.length === 0) {
    return {
      extraInputs,
      filterSteps,
      audioMapLabel: null,
      nextInputIndex: inputIdx,
    };
  }

  if (mixBranches.length === 1) {
    return {
      extraInputs,
      filterSteps,
      audioMapLabel: mixBranches[0],
      nextInputIndex: inputIdx,
    };
  }

  filterSteps.push(
    `${mixBranches.join('')}amix=inputs=${mixBranches.length}:duration=first:dropout_transition=2:normalize=0[a_final]`
  );

  return {
    extraInputs,
    filterSteps,
    audioMapLabel: '[a_final]',
    nextInputIndex: inputIdx,
  };
}
