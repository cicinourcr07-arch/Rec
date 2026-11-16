/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  Cpu,
  FolderCog,
  Loader2,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { SystemStatus } from '../types/studio';
import { api } from '../lib/api';
import { formatBytes } from '../lib/formatters';

interface SettingsPageProps {
  onOpenBackupModal?: () => void;
}

export function SettingsPage({ onOpenBackupModal }: SettingsPageProps) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);
  const [quotaInfo, setQuotaInfo] = useState<{ usage: number; quota: number } | null>(null);

  useEffect(() => {
    void api.getSystemStatus().then(setStatus).catch(() => {});
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      void navigator.storage
        .estimate()
        .then((est) => setQuotaInfo({ usage: est.usage || 0, quota: est.quota || 0 }))
        .catch(() => {});
    }
  }, []);

  const handleCleanup = async () => {
    setCleaning(true);
    setCleanupMsg(null);
    try {
      const res = await api.runCleanup();
      setCleanupMsg(`Cleanup complete: ${res.removedFiles} orphaned browser media item(s) removed.`);
    } catch (err) {
      setCleanupMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCleaning(false);
    }
  };

  const hasFileApi = typeof File !== 'undefined' && typeof URL.createObjectURL === 'function';
  const hasIndexedDb = typeof indexedDB !== 'undefined';
  const hasCanvas = typeof document !== 'undefined';
  const hasMediaRecorder = typeof MediaRecorder !== 'undefined';
  const mp4RecorderSupported =
    hasMediaRecorder &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    (MediaRecorder.isTypeSupported('video/mp4') ||
      MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E,mp4a.40.2'));
  const webmRecorderSupported =
    hasMediaRecorder &&
    typeof MediaRecorder.isTypeSupported === 'function' &&
    MediaRecorder.isTypeSupported('video/webm');
  const hasWebCodecs = typeof (window as unknown as { VideoDecoder?: unknown }).VideoDecoder !== 'undefined';

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="border-b border-white/[0.08] pb-5">
        <h1 className="text-2xl font-display font-bold tracking-tight text-white">
          Settings & Browser Engine Diagnostics
        </h1>
        <p className="text-sm text-zinc-400 mt-1">
          All video file selection, preview, frame extraction, audio extraction, and rendering run 100% locally in your browser with zero video upload requests.
        </p>
      </div>

      {/* Browser Video Engine Readiness */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-4">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-display font-semibold text-white">
            Client-Side Browser Video Capabilities
          </h2>
        </div>

        <div className="divide-y divide-white/[0.06] text-xs">
          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <div className="font-medium text-zinc-100">
                Native File API &amp; Object URL Streaming (Up to 2 GB)
              </div>
              <div className="text-zinc-500 mt-0.5">
                Reads selected MP4/MOV/MKV files directly from local disk handles without loading full files into RAM or sending upload POST requests.
              </div>
            </div>
            <span className={hasFileApi ? 'text-emerald-300 font-medium' : 'text-red-300 font-medium'}>
              {hasFileApi ? 'Active' : 'Unavailable'}
            </span>
          </div>

          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <div className="font-medium text-zinc-100">
                IndexedDB Media &amp; Project Persistence
              </div>
              <div className="text-zinc-500 mt-0.5 font-mono">
                {quotaInfo
                  ? `Used: ${formatBytes(quotaInfo.usage)} · Available Quota: ${formatBytes(quotaInfo.quota)}`
                  : 'Persists projects, presets, fonts, and media blobs across reloads'}
              </div>
            </div>
            <span className={hasIndexedDb ? 'text-emerald-300 font-medium' : 'text-amber-300 font-medium'}>
              {hasIndexedDb ? 'Active' : 'Session Only'}
            </span>
          </div>

          <div className="py-3 flex items-center justify-between gap-4">
            <div>
              <div className="font-medium text-zinc-100">
                Canvas 2D + Web Audio + MediaRecorder Export Engine
              </div>
              <div className="text-zinc-500 mt-0.5 font-mono">
                {mp4RecorderSupported
                  ? 'MP4 (H.264/AAC) & WebM recording supported'
                  : webmRecorderSupported
                  ? 'WebM (VP9/VP8 + Opus) recording supported'
                  : 'Checking MediaRecorder codec support'}
                {hasWebCodecs ? ' · WebCodecs API Ready' : ''}
              </div>
            </div>
            <span className={hasCanvas && hasMediaRecorder ? 'text-emerald-300 font-medium' : 'text-amber-300 font-medium'}>
              {hasCanvas && hasMediaRecorder ? 'Ready' : 'Limited'}
            </span>
          </div>
        </div>
      </section>

      {/* AI Provider Separation & Readiness */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-4">
        <h2 className="text-sm font-display font-semibold text-white">
          AI Provider &amp; API Key Separation
        </h2>

        {!status ? (
          <div className="text-xs text-zinc-400 flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> Checking optional AI endpoints...
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06] text-xs">
            <div className="py-3 flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-zinc-100">
                  Gemini Translation Workflow (External No-Key Mode + Optional Backend API)
                </div>
                <div className="text-zinc-500 mt-0.5">
                  External Gemini (No Key) and manual SRT/VTT import run 100% in the browser. Automated API translation stays isolated behind server env secrets.
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0 font-medium">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span className="text-emerald-300">
                  {status.geminiConfigured ? 'API Key + Manual Ready' : 'Manual Mode Ready (No Key Needed)'}
                </span>
              </div>
            </div>

            <div className="py-3 flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-zinc-100">
                  Fish Audio Dubbing API (Server-Side Key Required)
                </div>
                <div className="text-zinc-500 mt-0.5">
                  Automated cloud voice dubbing requires an AI backend with FISH_API_KEY so secrets are never shipped in browser JavaScript.
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
                    <span className="text-amber-300">AI Backend Not Connected</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Optional AI Environment Documentation */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
        <div className="flex items-center gap-2">
          <FolderCog className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-display font-semibold text-white">
            Security &amp; Static Hosting Architecture
          </h2>
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">
          All video files, thumbnails, audio tracks, logos, and rendered exports remain strictly inside your browser (File API + IndexedDB) and are never uploaded to Cloudflare Pages. Secret keys such as <code className="text-zinc-200">GEMINI_API_KEY</code> and <code className="text-zinc-200">FISH_API_KEY</code> are never included in frontend bundles.
        </p>
      </section>

      {/* Storage & Temporary File Cleanup */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-display font-semibold text-white">
              Browser Storage &amp; Orphaned Media Cleanup
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Max single video size: {status?.maxUploadSizeMb ?? 2048} MB · Instant local cleanup
            </p>
          </div>
          <button
            onClick={handleCleanup}
            disabled={cleaning}
            className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 flex items-center gap-1.5 cursor-pointer"
          >
            {cleaning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
            Clean Orphaned Browser Media
          </button>
        </div>

        {cleanupMsg && <div className="text-xs text-emerald-400">{cleanupMsg}</div>}
      </section>

      {/* Portable Backups */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-display font-semibold text-white">
              Browser IndexedDB &amp; Portable Backups
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Export or restore complete project archives (.recapbackup.zip) locally between browsers or devices.
            </p>
          </div>
          {onOpenBackupModal && (
            <button
              type="button"
              onClick={onOpenBackupModal}
              className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Archive className="w-3.5 h-3.5" />
              Manage Browser Storage &amp; Backup
            </button>
          )}
        </div>
      </section>

      {/* Copyright & Authorized Editing Policy */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-2">
        <div className="flex items-center gap-2 text-sm font-display font-semibold text-white">
          <ShieldAlert className="w-4 h-4 text-amber-400" />
          Copyright &amp; Authorized Media Policy
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
