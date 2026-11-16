/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  FolderCog,
  Loader2,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { SystemStatus } from '../types/studio';
import { api } from '../lib/api';

interface SettingsPageProps {
  onOpenBackupModal?: () => void;
}

export function SettingsPage({ onOpenBackupModal }: SettingsPageProps) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);

  useEffect(() => {
    void api.getSystemStatus().then(setStatus).catch(() => {});
  }, []);

  const handleCleanup = async () => {
    setCleaning(true);
    setCleanupMsg(null);
    try {
      const res = await api.runCleanup();
      setCleanupMsg(`Cleanup complete: ${res.removedFiles} expired temporary items removed.`);
    } catch (err) {
      setCleanupMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  };

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="border-b border-white/[0.08] pb-5">
        <h1 className="text-2xl font-display font-bold tracking-tight text-white">
          Settings & System Integration
        </h1>
        <p className="text-sm text-zinc-400 mt-1">
          Verify backend media processing engines, server-side AI provider configuration, and local SQLite storage.
        </p>
      </div>

      {/* Live Engine Readiness */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-4">
        <h2 className="text-sm font-display font-semibold text-white">
          Backend Engine & AI Provider Status
        </h2>

        {!status ? (
          <div className="text-xs text-zinc-400 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking server diagnostics...
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06] text-xs">
            <div className="py-3 flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-zinc-100">
                  Fish Audio Dubbing Engine (ASR & s2.1-pro-free TTS)
                </div>
                <div className="text-zinc-500 mt-0.5">
                  Powered server-side via api.fish.audio (transcribe-1-pro ASR, s2.1-pro-free MP3 TTS)
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 font-medium">
                {status.fishConfigured ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-emerald-300">Configured</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-4 h-4 text-amber-400" />
                    <span className="text-amber-300">Missing FISH_API_KEY</span>
                  </>
                )}
              </div>
            </div>

            <div className="py-3 flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-zinc-100">
                  Gemini Translation Workflow (Manual Mode Free · Optional API)
                </div>
                <div className="text-zinc-500 mt-0.5">
                  Manual External Gemini JSON workflow requires zero API key. Optional backend API available if GEMINI_API_KEY is set.
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 font-medium">
                {status.geminiConfigured ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-emerald-300">API Key + Manual Ready</span>
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-emerald-300">Manual Free Mode Ready (No Key Needed)</span>
                  </>
                )}
              </div>
            </div>

            <div className="py-3 flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-zinc-100">FFmpeg Video Processing Engine</div>
                <div className="text-zinc-500 mt-0.5 font-mono">
                  Version {status.ffmpegVersion} · H.264 / AAC / libass / gblur / overlay
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 font-medium">
                {status.ffmpegAvailable ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-emerald-300">Ready</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-4 h-4 text-red-400" />
                    <span className="text-red-300">Unavailable</span>
                  </>
                )}
              </div>
            </div>

            <div className="py-3 flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-zinc-100">FFprobe Stream Analyzer</div>
                <div className="text-zinc-500 mt-0.5">
                  Extracts duration, resolution, FPS, video/audio codecs, and bitrate
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 font-medium">
                {status.ffprobeAvailable ? (
                  <>
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-emerald-300">Ready</span>
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-4 h-4 text-red-400" />
                    <span className="text-red-300">Unavailable</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Server Environment Documentation */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
        <div className="flex items-center gap-2">
          <FolderCog className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-display font-semibold text-white">
            Environment & Integration Configuration
          </h2>
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">
          All AI provider credentials are handled exclusively on the server via environment
          variables and are never exposed to client browser bundles. Configure secrets in the
          platform Secrets panel or server <code className="text-zinc-200">.env</code> file:
        </p>

        <div className="p-3.5 rounded-lg bg-[#09090B] border border-white/[0.08] font-mono text-xs text-zinc-300 space-y-1.5">
          <div>FISH_API_KEY — Enables Fish Audio ASR transcription and s2.1-pro-free MP3 dubbing</div>
          <div>GEMINI_API_KEY — Enables AI translation preserving context and proper nouns</div>
          <div>STORAGE_DIR — Persistent local directory for uploads, logos, audio, and exports</div>
          <div>MAX_UPLOAD_SIZE_MB — Maximum video upload threshold (default 2048 MB)</div>
          <div>TEMP_RETENTION_HOURS — Automatic temp chunk & subtitle file cleanup interval</div>
        </div>
      </section>

      {/* Storage & Temporary File Cleanup */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-display font-semibold text-white">
              Storage & Temporary File Cleanup
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Max upload limit: {status?.maxUploadSizeMb ?? 2048} MB · Retention:{' '}
              {status?.tempRetentionHours ?? 24}h
            </p>
          </div>
          <button
            onClick={handleCleanup}
            disabled={cleaning}
            className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 flex items-center gap-1.5 cursor-pointer"
          >
            {cleaning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Clean Expired Temp Files
          </button>
        </div>

        {cleanupMsg && <div className="text-xs text-emerald-400">{cleanupMsg}</div>}
      </section>

      {/* 100% Local SQLite & Portable Backup Studio */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-display font-semibold text-white">
              100% Local SQLite &amp; Portable Backups
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              All projects, media assets, and fonts are stored securely in local SQLite and server storage. No external databases required.
            </p>
          </div>
          {onOpenBackupModal && (
            <button
              type="button"
              onClick={onOpenBackupModal}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Archive className="w-3.5 h-3.5" />
              Manage Local Storage &amp; Backup
            </button>
          )}
        </div>
      </section>

      {/* Copyright & Authorized Editing Policy */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-2">
        <div className="flex items-center gap-2 text-sm font-display font-semibold text-white">
          <ShieldAlert className="w-4 h-4 text-amber-400" />
          Copyright & Authorized Media Policy
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">
          Recap Studio AI must only be used with video and audio content that you own or have
          explicit authorization to edit and redistribute. Applying blur effects, captions,
          watermarks, or AI voiceovers does not automatically remove third-party copyright
          restrictions.
        </p>
      </section>
    </div>
  );
}
