/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo, useState } from 'react';
import {
  Check,
  Edit3,
  Loader2,
  Play,
  Plus,
  Sparkles,
  Trash2,
  Users,
} from 'lucide-react';
import {
  FishVoiceModel,
  Project,
  SavedFishVoice,
  SpeakerProfile,
} from '../types/studio';
import { api, resolveApiUrl } from '../lib/api';
import {
  addSpeakerProfile,
  countSegmentsPerSpeaker,
  deleteSpeakerAndClearSegments,
  normalizeSpeakerName,
  renameSpeakerAndSegments,
  syncSpeakersFromCaptions,
} from '../lib/speakers';

interface SpeakersManagerPanelProps {
  project: Project;
  savedVoices: SavedFishVoice[];
  fetchedVoices: FishVoiceModel[];
  onProjectUpdated: (p: Project) => void;
  onStatusMessage: (msg: string) => void;
  onErrorMessage: (msg: string) => void;
}

export function SpeakersManagerPanel({
  project,
  savedVoices,
  fetchedVoices,
  onProjectUpdated,
  onStatusMessage,
  onErrorMessage,
}: SpeakersManagerPanelProps) {
  const [newSpeakerName, setNewSpeakerName] = useState('');
  const [newSpeakerVoiceId, setNewSpeakerVoiceId] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);

  const speakers = project.speakers || [];
  const counts = useMemo(() => countSegmentsPerSpeaker(project.captions), [project.captions]);

  const voiceCatalogOptions = useMemo(() => {
    const map = new Map<string, { voiceId: string; title: string; source: string }>();
    for (const sv of savedVoices) {
      if (sv.voiceId && !map.has(sv.voiceId)) {
        map.set(sv.voiceId, {
          voiceId: sv.voiceId,
          title: sv.name,
          source: sv.isDefault ? 'Saved · Default' : 'Saved',
        });
      }
    }
    for (const fv of fetchedVoices) {
      if (fv.id && !map.has(fv.id)) {
        map.set(fv.id, {
          voiceId: fv.id,
          title: fv.title,
          source: 'Fish Catalog',
        });
      }
    }
    return Array.from(map.values());
  }, [savedVoices, fetchedVoices]);

  const persistPatch = async (patch: Partial<Project>, okMsg?: string) => {
    const nextProject = { ...project, ...patch };
    onProjectUpdated(nextProject);
    try {
      const { project: saved } = await api.updateProject(project.id, patch);
      onProjectUpdated(saved);
      if (okMsg) onStatusMessage(okMsg);
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSyncFromCaptions = async () => {
    onErrorMessage('');
    const synced = syncSpeakersFromCaptions(project.speakers, project.captions);
    if (synced.length === (project.speakers?.length || 0)) {
      const taggedCount = project.captions.filter((c) => Boolean(normalizeSpeakerName(c.speaker))).length;
      if (taggedCount === 0) {
        onStatusMessage(
          'No speaker labels were detected in current transcript segments. You can add speakers manually below and assign segments to each speaker.'
        );
      } else {
        onStatusMessage('All speakers from the transcript are already listed.');
      }
      return;
    }
    await persistPatch(
      { speakers: synced },
      `Detected ${synced.length} speaker profile(s) from transcript labels.`
    );
  };

  const handleAddSpeaker = async (e: React.FormEvent) => {
    e.preventDefault();
    onErrorMessage('');
    try {
      const matched = voiceCatalogOptions.find((v) => v.voiceId === newSpeakerVoiceId.trim());
      const nextSpeakers = addSpeakerProfile(
        project.speakers,
        newSpeakerName,
        newSpeakerVoiceId,
        matched?.title || (newSpeakerVoiceId.trim() ? `Voice ${newSpeakerVoiceId.trim().slice(0, 8)}...` : undefined)
      );
      setNewSpeakerName('');
      setNewSpeakerVoiceId('');
      await persistPatch(
        { speakers: nextSpeakers },
        `Added speaker "${nextSpeakers[nextSpeakers.length - 1].name}".`
      );
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSaveRename = async (speakerId: string) => {
    onErrorMessage('');
    try {
      const { speakers: nextSpeakers, captions: nextCaptions } = renameSpeakerAndSegments({
        speakers: project.speakers,
        captions: project.captions,
        speakerId,
        nextName: editingName,
      });
      setEditingId(null);
      await persistPatch(
        { speakers: nextSpeakers, captions: nextCaptions },
        `Renamed speaker to "${editingName.trim()}" across matching segments.`
      );
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDeleteSpeaker = async (sp: SpeakerProfile) => {
    onErrorMessage('');
    const { speakers: nextSpeakers, captions: nextCaptions } = deleteSpeakerAndClearSegments({
      speakers: project.speakers,
      captions: project.captions,
      speakerId: sp.id,
    });
    await persistPatch(
      { speakers: nextSpeakers, captions: nextCaptions },
      `Removed speaker "${sp.name}". Assigned segments reverted to project default voice.`
    );
  };

  const handleSpeakerVoiceChange = async (
    speakerId: string,
    voiceId: string,
    voiceTitle?: string
  ) => {
    onErrorMessage('');
    const cleanId = voiceId.trim();
    const matched = voiceCatalogOptions.find((v) => v.voiceId === cleanId);
    const nextSpeakers = speakers.map((s) =>
      s.id === speakerId
        ? {
            ...s,
            fishReferenceId: cleanId || undefined,
            fishVoiceTitle: cleanId
              ? voiceTitle || matched?.title || `Voice ${cleanId.slice(0, 8)}...`
              : undefined,
          }
        : s
    );
    await persistPatch({ speakers: nextSpeakers });
  };

  const handlePreviewSpeaker = async (sp: SpeakerProfile) => {
    onErrorMessage('');
    setPreviewingId(sp.id);
    try {
      const firstMatch = project.captions.find(
        (c) => normalizeSpeakerName(c.speaker).toLowerCase() === normalizeSpeakerName(sp.name).toLowerCase()
      );
      const sampleText =
        firstMatch?.translatedText?.trim() ||
        firstMatch?.text?.trim() ||
        `Hello, this is ${sp.name} speaking in the movie dub.`;

      const res = await api.previewFishDub(project.id, {
        text: sampleText,
        referenceId: sp.fishReferenceId || project.voice.fishReferenceId,
        speakingSpeed: 1.0,
      });
      setPreviewAudioUrl(res.audioUrl);
    } catch (err) {
      onErrorMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setPreviewingId(null);
    }
  };

  return (
    <div className="p-4 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-display font-semibold text-white flex items-center gap-2">
            <Users className="w-4 h-4 text-violet-400" />
            Speakers &amp; Multi-Voice Assignment ({speakers.length})
          </h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Assign distinct Fish Audio voices per speaker. Unassigned speakers use the project default voice above.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void handleSyncFromCaptions()}
          className="px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 flex items-center gap-1.5 cursor-pointer"
        >
          <Sparkles className="w-3.5 h-3.5 text-violet-400" />
          Detect from Script
        </button>
      </div>

      {speakers.length === 0 ? (
        <div className="p-3 rounded-lg bg-[#09090B] border border-white/[0.06] text-[11px] text-zinc-400 leading-relaxed">
          No speaker profiles defined yet. Click <strong className="text-zinc-200">Detect from Script</strong> after transcription/External Gemini import, or add speakers manually below to assign separate character voices.
        </div>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
          {speakers.map((sp) => {
            const segCount = counts.get(normalizeSpeakerName(sp.name).toLowerCase()) || 0;
            const isEditing = editingId === sp.id;
            const selectVal =
              sp.fishReferenceId &&
              voiceCatalogOptions.some((o) => o.voiceId === sp.fishReferenceId)
                ? sp.fishReferenceId
                : sp.fishReferenceId
                ? '__custom__'
                : '';

            return (
              <div
                key={sp.id}
                className="p-2.5 rounded-lg bg-[#18181D] border border-white/[0.08] space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <span
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: sp.color || '#8B5CF6' }}
                    />
                    {isEditing ? (
                      <div className="flex items-center gap-1.5 flex-1">
                        <input
                          type="text"
                          value={editingName}
                          onChange={(e) => setEditingName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void handleSaveRename(sp.id);
                          }}
                          className="bg-zinc-900 border border-violet-500/50 rounded px-2 py-0.5 text-xs text-white flex-1 min-w-[100px]"
                        />
                        <button
                          type="button"
                          onClick={() => void handleSaveRename(sp.id)}
                          className="p-1 rounded bg-violet-600 text-white cursor-pointer"
                          title="Save speaker name"
                        >
                          <Check className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <span className="text-xs font-semibold text-white truncate">
                          {sp.name}
                        </span>
                        <span className="px-1.5 py-0.5 rounded bg-zinc-900 border border-white/[0.06] text-[10px] font-mono text-zinc-400 shrink-0">
                          {segCount} {segCount === 1 ? 'line' : 'lines'}
                        </span>
                      </>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handlePreviewSpeaker(sp)}
                      disabled={previewingId === sp.id}
                      title="Preview speaker voice"
                      className="px-2 py-1 rounded bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-[11px] text-zinc-200 flex items-center gap-1 cursor-pointer"
                    >
                      {previewingId === sp.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Play className="w-3 h-3 text-violet-400" />
                      )}
                      Preview
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(sp.id);
                        setEditingName(sp.name);
                      }}
                      title="Rename speaker"
                      className="p-1 rounded text-zinc-400 hover:text-white hover:bg-zinc-800 cursor-pointer"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDeleteSpeaker(sp)}
                      title="Remove speaker"
                      className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <select
                    value={selectVal}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '__custom__') return;
                      void handleSpeakerVoiceChange(sp.id, val);
                    }}
                    aria-label={`Voice preset for ${sp.name}`}
                    className="bg-zinc-900 border border-white/[0.08] rounded-md px-2 py-1 text-[11px] text-zinc-200"
                  >
                    <option value="">Use Project Default Voice</option>
                    {voiceCatalogOptions.map((opt) => (
                      <option key={opt.voiceId} value={opt.voiceId}>
                        {opt.title} ({opt.source})
                      </option>
                    ))}
                    {selectVal === '__custom__' && sp.fishReferenceId && (
                      <option value="__custom__">
                        Custom ID ({sp.fishReferenceId.slice(0, 10)}...)
                      </option>
                    )}
                  </select>

                  <input
                    type="text"
                    value={sp.fishReferenceId || ''}
                    onChange={(e) => {
                      const nextVal = e.target.value;
                      const nextSpeakers = speakers.map((item) =>
                        item.id === sp.id
                          ? { ...item, fishReferenceId: nextVal }
                          : item
                      );
                      onProjectUpdated({ ...project, speakers: nextSpeakers });
                    }}
                    onBlur={(e) => void handleSpeakerVoiceChange(sp.id, e.target.value)}
                    placeholder="Or paste speaker Fish voice reference_id..."
                    className="bg-zinc-900 border border-white/[0.08] rounded-md px-2 py-1 text-[11px] font-mono text-zinc-200 placeholder:text-zinc-600"
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {previewAudioUrl && (
        <div className="p-2.5 rounded-lg bg-[#09090B] border border-violet-500/30 space-y-1">
          <div className="text-[11px] text-violet-300 font-medium">Speaker Voice Preview</div>
          <audio src={resolveApiUrl(previewAudioUrl)} controls autoPlay className="w-full h-8" />
        </div>
      )}

      <form
        onSubmit={handleAddSpeaker}
        className="pt-2 border-t border-white/[0.06] grid grid-cols-1 sm:grid-cols-12 gap-2"
      >
        <input
          type="text"
          value={newSpeakerName}
          onChange={(e) => setNewSpeakerName(e.target.value)}
          placeholder="Speaker name (e.g. Narrator, Elena)..."
          className="sm:col-span-5 bg-[#18181D] border border-white/[0.08] rounded-md px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500"
        />
        <select
          value={newSpeakerVoiceId}
          onChange={(e) => setNewSpeakerVoiceId(e.target.value)}
          aria-label="Initial voice for new speaker"
          className="sm:col-span-4 bg-[#18181D] border border-white/[0.08] rounded-md px-2 py-1.5 text-xs text-zinc-200"
        >
          <option value="">Default Project Voice</option>
          {voiceCatalogOptions.map((opt) => (
            <option key={opt.voiceId} value={opt.voiceId}>
              {opt.title}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!newSpeakerName.trim()}
          className="sm:col-span-3 px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center justify-center gap-1 cursor-pointer"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Speaker
        </button>
      </form>
    </div>
  );
}
