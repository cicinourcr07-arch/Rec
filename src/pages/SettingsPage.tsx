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
  Eye,
  EyeOff,
  FolderCog,
  KeyRound,
  Loader2,
  PlugZap,
  Save,
  ShieldAlert,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { SystemStatus } from '../types/studio';
import { api } from '../lib/api';
import {
  deletePersonalFishApiKey,
  FishConnectionStatus,
  loadPersonalFishKeyState,
  savePersonalFishApiKey,
} from '../lib/fishKeyStore';
import { formatBytes } from '../lib/formatters';

interface SettingsPageProps {
  onOpenBackupModal?: () => void;
}

const CONNECTION_STATUS_UI: Record<
  FishConnectionStatus,
  { label: string; badgeClass: string; dotClass: string }
> = {
  connected: {
    label: 'Connected',
    badgeClass: 'bg-emerald-500/15 border-emerald-500/35 text-emerald-300',
    dotClass: 'bg-emerald-400',
  },
  invalid_key: {
    label: 'Invalid API Key',
    badgeClass: 'bg-red-500/15 border-red-500/35 text-red-300',
    dotClass: 'bg-red-400',
  },
  connection_error: {
    label: 'Connection Error',
    badgeClass: 'bg-amber-500/15 border-amber-500/35 text-amber-300',
    dotClass: 'bg-amber-400',
  },
  not_configured: {
    label: 'Not Configured',
    badgeClass: 'bg-zinc-800 border-white/10 text-zinc-300',
    dotClass: 'bg-zinc-500',
  },
};

export function SettingsPage({ onOpenBackupModal }: SettingsPageProps) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupMsg, setCleanupMsg] = useState<string | null>(null);
  const [quotaInfo, setQuotaInfo] = useState<{ usage: number; quota: number } | null>(null);

  // Personal Fish Audio API Key state (stored locally in IndexedDB only)
  const [fishKeyInput, setFishKeyInput] = useState('');
  const [showFishKey, setShowFishKey] = useState(false);
  const [rememberOnDevice, setRememberOnDevice] = useState(true);
  const [hasSavedFishKey, setHasSavedFishKey] = useState(false);
  const [fishKeyUpdatedAt, setFishKeyUpdatedAt] = useState<string | null>(null);
  const [indexedDbAvailable, setIndexedDbAvailable] = useState<boolean>(true);
  const [fishStorageError, setFishStorageError] = useState<string | null>(null);
  const [fishConnectionStatus, setFishConnectionStatus] =
    useState<FishConnectionStatus>('not_configured');
  const [fishFeedback, setFishFeedback] = useState<{
    type: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);
  const [savingFishKey, setSavingFishKey] = useState(false);
  const [testingFishKey, setTestingFishKey] = useState(false);
  const [deletingFishKey, setDeletingFishKey] = useState(false);

  const refreshSystemStatus = () => {
    void api.getSystemStatus().then(setStatus).catch(() => {});
  };

  useEffect(() => {
    let active = true;
    refreshSystemStatus();
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      void navigator.storage
        .estimate()
        .then((est) => {
          if (active) setQuotaInfo({ usage: est.usage || 0, quota: est.quota || 0 });
        })
        .catch(() => {});
    }

    void loadPersonalFishKeyState().then(async (state) => {
      if (!active) return;
      setIndexedDbAvailable(state.indexedDbAvailable);
      if (state.storageError) {
        setFishStorageError(state.storageError);
      }
      if (state.apiKey) {
        setFishKeyInput(state.apiKey);
        setHasSavedFishKey(true);
        setRememberOnDevice(state.rememberOnDevice);
        setFishKeyUpdatedAt(state.updatedAt);
        setTestingFishKey(true);
        const testRes = await api.testFishConnection(state.apiKey);
        if (!active) return;
        setFishConnectionStatus(testRes.status);
        setTestingFishKey(false);
      } else {
        setHasSavedFishKey(false);
        setRememberOnDevice(state.indexedDbAvailable);
        setFishConnectionStatus('not_configured');
      }
    });

    return () => {
      active = false;
    };
  }, []);

  const handleSaveFishKey = async (e: React.FormEvent) => {
    e.preventDefault();
    setFishFeedback(null);
    setFishStorageError(null);

    if (rememberOnDevice && !indexedDbAvailable) {
      setFishFeedback({
        type: 'error',
        text: 'IndexedDB is unavailable in this browser. Uncheck "Remember API Key on this device" to keep the key only for this session, or enable browser site storage.',
      });
      return;
    }

    setSavingFishKey(true);
    try {
      const saved = await savePersonalFishApiKey(fishKeyInput, rememberOnDevice);
      setHasSavedFishKey(true);
      setRememberOnDevice(saved.rememberOnDevice);
      setFishKeyUpdatedAt(saved.updatedAt);
      refreshSystemStatus();

      setTestingFishKey(true);
      const testRes = await api.testFishConnection(fishKeyInput);
      setFishConnectionStatus(testRes.status);
      setTestingFishKey(false);

      const storageLocation = saved.rememberOnDevice
        ? 'saved locally in IndexedDB on this device'
        : 'kept in memory for this browser session only';

      if (testRes.ok) {
        setFishFeedback({
          type: 'success',
          text: `API key ${storageLocation} and verified (${testRes.message}${
            testRes.credit !== undefined ? ` · Credit: ${testRes.credit}` : ''
          }).`,
        });
      } else {
        setFishFeedback({
          type: testRes.status === 'invalid_key' ? 'error' : 'info',
          text: `API key ${storageLocation}, but connection test reported: ${testRes.message}`,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save Fish Audio API key.';
      setFishFeedback({ type: 'error', text: msg });
      if (msg.toLowerCase().includes('indexeddb')) {
        setFishStorageError(msg);
      }
    } finally {
      setSavingFishKey(false);
      setTestingFishKey(false);
    }
  };

  const handleTestFishConnection = async () => {
    setFishFeedback(null);
    const keyToTest = fishKeyInput.trim();
    if (!keyToTest) {
      setFishConnectionStatus('not_configured');
      setFishFeedback({
        type: 'error',
        text: 'Enter your Fish Audio API key before testing the connection.',
      });
      return;
    }

    setTestingFishKey(true);
    try {
      const res = await api.testFishConnection(keyToTest);
      setFishConnectionStatus(res.status);
      setFishFeedback({
        type: res.ok ? 'success' : 'error',
        text:
          res.ok && res.credit !== undefined
            ? `${res.message} · Credit: ${res.credit}`
            : res.message,
      });
    } finally {
      setTestingFishKey(false);
    }
  };

  const handleDeleteFishKey = async () => {
    setFishFeedback(null);
    setDeletingFishKey(true);
    try {
      await deletePersonalFishApiKey();
      setFishKeyInput('');
      setShowFishKey(false);
      setHasSavedFishKey(false);
      setFishKeyUpdatedAt(null);
      setFishConnectionStatus('not_configured');
      refreshSystemStatus();
      setFishFeedback({
        type: 'info',
        text: 'Personal Fish Audio API key removed from this device.',
      });
    } catch (err) {
      setFishFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Unable to delete saved API key.',
      });
    } finally {
      setDeletingFishKey(false);
    }
  };

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
  const connUi = CONNECTION_STATUS_UI[fishConnectionStatus];

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

      {/* Personal Fish Audio API Settings */}
      <section
        aria-label="Fish Audio API Settings"
        className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-violet-400" />
            <h2 className="text-sm font-display font-semibold text-white">
              Fish Audio API Settings
            </h2>
          </div>

          <span
            data-testid="fish-connection-status"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-[11px] font-medium ${connUi.badgeClass}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${connUi.dotClass}`} />
            {testingFishKey ? 'Testing Connection...' : connUi.label}
          </span>
        </div>

        <p className="text-xs text-zinc-400 leading-relaxed">
          Enter your personal Fish Audio API key to use ASR transcription, voice browsing, and{' '}
          <code className="text-zinc-200">s2.1-pro-free</code> TTS dubbing without exposing keys on any shared server or GitHub repository.
        </p>

        {fishStorageError && (
          <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2">
            <WifiOff className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Local Persistent Storage Unavailable: </span>
              <span>{fishStorageError}</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSaveFishKey} className="space-y-3.5">
          <div className="space-y-1.5">
            <label
              htmlFor="personal-fish-api-key"
              className="block text-xs font-medium text-zinc-200"
            >
              Personal Fish Audio API Key
            </label>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <input
                  id="personal-fish-api-key"
                  type={showFishKey ? 'text' : 'password'}
                  value={fishKeyInput}
                  onChange={(e) => setFishKeyInput(e.target.value)}
                  placeholder="Paste your Fish Audio API key..."
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-[#18181D] border border-white/[0.08] focus:border-violet-500/60 focus:outline-none rounded-lg pl-3 pr-24 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-500"
                />
                <button
                  type="button"
                  onClick={() => setShowFishKey((prev) => !prev)}
                  aria-label={showFishKey ? 'Hide API Key' : 'Show API Key'}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 px-2 py-1 rounded bg-zinc-800/90 hover:bg-zinc-700 text-[11px] font-medium text-zinc-200 flex items-center gap-1 cursor-pointer"
                >
                  {showFishKey ? (
                    <>
                      <EyeOff className="w-3.5 h-3.5 text-zinc-300" />
                      Hide
                    </>
                  ) : (
                    <>
                      <Eye className="w-3.5 h-3.5 text-zinc-300" />
                      Show
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
              <input
                type="checkbox"
                checked={rememberOnDevice}
                onChange={(e) => setRememberOnDevice(e.target.checked)}
                className="accent-violet-500"
              />
              <span>Remember API Key on this device</span>
            </label>

            {hasSavedFishKey && fishKeyUpdatedAt && (
              <span className="text-[11px] font-mono text-zinc-500">
                Saved {rememberOnDevice ? 'in IndexedDB' : 'for session'} ·{' '}
                {new Date(fishKeyUpdatedAt).toLocaleString()}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="submit"
              disabled={savingFishKey || !fishKeyInput.trim()}
              className="px-3.5 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-xs font-semibold text-white flex items-center gap-1.5 cursor-pointer"
            >
              {savingFishKey ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Save className="w-3.5 h-3.5" />
              )}
              Save API Key
            </button>

            <button
              type="button"
              onClick={handleTestFishConnection}
              disabled={testingFishKey || !fishKeyInput.trim()}
              className="px-3.5 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 disabled:opacity-40 text-xs font-medium text-zinc-100 flex items-center gap-1.5 cursor-pointer"
            >
              {testingFishKey ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <PlugZap className="w-3.5 h-3.5 text-violet-400" />
              )}
              Test Connection
            </button>

            <button
              type="button"
              onClick={handleDeleteFishKey}
              disabled={deletingFishKey || (!hasSavedFishKey && !fishKeyInput)}
              className="px-3.5 py-2 rounded-lg bg-zinc-900 hover:bg-red-950/50 border border-white/[0.08] hover:border-red-500/35 disabled:opacity-40 text-xs font-medium text-zinc-300 hover:text-red-300 flex items-center gap-1.5 cursor-pointer"
            >
              {deletingFishKey ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Trash2 className="w-3.5 h-3.5" />
              )}
              Delete API Key
            </button>
          </div>
        </form>

        {fishFeedback && (
          <div
            role="status"
            className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
              fishFeedback.type === 'success'
                ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-200'
                : fishFeedback.type === 'error'
                ? 'bg-red-500/10 border-red-500/30 text-red-200'
                : 'bg-zinc-900 border-white/[0.08] text-zinc-300'
            }`}
          >
            {fishFeedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <AlertCircle
                className={`w-4 h-4 shrink-0 mt-0.5 ${
                  fishFeedback.type === 'error' ? 'text-red-400' : 'text-zinc-400'
                }`}
              />
            )}
            <span>{fishFeedback.text}</span>
          </div>
        )}

        <div className="p-3 rounded-lg bg-[#09090B] border border-white/[0.06] text-[11px] text-zinc-400 leading-relaxed">
          <strong className="text-zinc-200">Device-Local Security Notice:</strong> Your key is stored only in this browser&apos;s IndexedDB (never uploaded, backed up in project ZIPs, or committed to GitHub) and sent only over HTTPS via the <code className="text-zinc-300">Authorization</code> header to <code className="text-zinc-300">/api/fish-audio</code> when generating audio. Because browser-local storage is accessible to scripts executing in the same origin, only save keys on trusted devices and delete them on shared computers.
        </div>
      </section>

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
            <Loader2 className="w-4 h-4 animate-spin" /> Checking AI capabilities...
          </div>
        ) : (
          <div className="divide-y divide-white/[0.06] text-xs">
            <div className="py-3 flex items-center justify-between gap-4">
              <div>
                <div className="font-medium text-zinc-100">
                  Gemini Translation Workflow (External No-Key Mode + Optional Backend API)
                </div>
                <div className="text-zinc-500 mt-0.5">
                  External Gemini (No Key) and manual SRT/VTT import run 100% in the browser. Automated API translation stays isolated behind optional server env secrets.
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
                  Fish Audio Dubbing API (Personal Device Key via Cloudflare Pages Function)
                </div>
                <div className="text-zinc-500 mt-0.5">
                  Uses your personal API key stored locally in IndexedDB and forwards TTS requests securely through <code className="text-zinc-300">POST /api/fish-audio</code> with zero server-side key storage.
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
                    <span className="text-amber-300">Not Configured</span>
                  </>
                )}
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Security & Static Hosting Architecture */}
      <section className="p-5 rounded-xl bg-[#111115] border border-white/[0.08] space-y-3">
        <div className="flex items-center gap-2">
          <FolderCog className="w-4 h-4 text-violet-400" />
          <h2 className="text-sm font-display font-semibold text-white">
            Security &amp; Static Hosting Architecture
          </h2>
        </div>
        <p className="text-xs text-zinc-400 leading-relaxed">
          All video files, thumbnails, audio tracks, logos, and rendered exports remain strictly inside your browser (File API + IndexedDB) and are never uploaded to Cloudflare Pages. Personal Fish Audio API keys stay inside a dedicated IndexedDB store on your device and are never included in frontend build variables, GitHub source files, or exported project backups.
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
