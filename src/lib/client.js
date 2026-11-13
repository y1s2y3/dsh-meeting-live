/**
 * Browser half of the meeting-minutes plugin (hand-written bundle).
 *
 * Contributes three seats to the shipped web shell:
 * - `sidebar.panellist` — the microphone + minutes glyph (recording red dot),
 * - `main` key `meeting-minutes` — the meeting list and the visual minutes doc,
 * - `shell.overlay` — toasts plus the persistent live-recording bar.
 *
 * Data comes from the host half's loopback JSON API (`/dsh-meeting`). This
 * bundle is deliberately dependency-free apart from React: every control,
 * modal and chart is plain `React.createElement`, and every colour is a
 * `--dsw-alias-*` theme token so the panel follows the light/dark shell.
 *
 * Audio pipeline (browser side):
 *   - live: getUserMedia → AudioContext → ScriptProcessor(4096) → streaming
 *     resampler → 5 s PCM16 WAV chunks → rolling POST /transcribe (append).
 *   - file: decodeAudioData → 16 kHz mono → ≤90 s WAV slices → sequential POST.
 *   The live recorder lives at module scope and survives modal/panel unmounts.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-meeting-minutes',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const API = '/dsh-meeting'
    const TARGET_RATE = 16000
    const SLICE_SECONDS = 90
    const SPEECH_POLL_MS = 1200
    const SPEECH_TIMEOUT_MS = 10 * 60 * 1000
    const TOAST_TTL_MS = 7000
    const AUDIO_MAX_SECONDS = 60 * 60

    // ── 输入设备选择（本地补丁）───────────────────────────────────────────
    // 原逻辑固定用系统默认输入设备；本机存在多个采集端（实体麦克风 / 阵列 /
    // 虚拟降噪输入）时容易录到静音。这里允许显式选设备，选择存 localStorage。
    const INPUT_DEVICE_STORAGE_KEY = 'dsh-meeting-minutes:input-device'
    let selectedInputDeviceId = ''
    function readPreferredInputDevice() {
      try {
        const stored = window.localStorage.getItem(INPUT_DEVICE_STORAGE_KEY)
        return typeof stored === 'string' ? stored : ''
      } catch {
        return ''
      }
    }
    function writePreferredInputDevice(deviceId) {
      try {
        if (deviceId === '') window.localStorage.removeItem(INPUT_DEVICE_STORAGE_KEY)
        else window.localStorage.setItem(INPUT_DEVICE_STORAGE_KEY, deviceId)
      } catch {
        // 隐私模式等写不了 localStorage：退回仅本次会话生效。
      }
    }
    selectedInputDeviceId = readPreferredInputDevice()
    async function listAudioInputDevices() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices
        || typeof navigator.mediaDevices.enumerateDevices !== 'function') return []
      try {
        const all = await navigator.mediaDevices.enumerateDevices()
        return all
          .filter((device) => device.kind === 'audioinput' && (device.deviceId || '') !== '')
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: (device.label || '').trim() === '' ? `麦克风 ${index + 1}` : device.label.trim(),
          }))
      } catch {
        return []
      }
    }

    const PRIORITY_LABELS = { high: '高', normal: '中', low: '低' }
    const SOURCE_LABELS = { recording: '录音', text: '文本', import: '导入' }
    const RISK_LABELS = { high: '高风险', medium: '待确认', low: '提示' }
    const PHASE_LABELS = {
      ready: '就绪',
      unprepared: '未加载',
      standby: '待加载',
      downloading: '下载模型',
      downloadingBytes: '下载模型',
      checking: '校验模型',
      loading: '加载模型',
      failed: '失败',
      cancelled: '已取消',
    }
    /** Live capture: one WAV chunk every five seconds of audio. */
    const LIVE_FLUSH_SECONDS = 5
    const LIVE_FLUSH_FRAMES = TARGET_RATE * LIVE_FLUSH_SECONDS
    /** At most two transcription requests in flight; pending chunks merge. */
    const LIVE_MAX_INFLIGHT = 2
    const LIVE_MAX_PENDING = 2
    /** Do not send a final sliver shorter than 200 ms. */
    const LIVE_MIN_FRAMES = Math.round(TARGET_RATE * 0.2)
    const LIVE_IDLE_TIMEOUT_MS = 120 * 1000

    // ──────────────────────────────── styles ────────────────────────────────

    const CSS = `
.dsm-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;overflow:hidden}
.dsm-hidden{display:none}
.dsm-spacer{flex:1 1 auto}
.dsm-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base)}
.dsm-brand{display:flex;align-items:baseline;gap:8px;margin-right:4px}
.dsm-brand-title{font-size:15px;font-weight:650;letter-spacing:.2px}
.dsm-brand-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-btn{display:inline-flex;align-items:center;gap:5px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:4px 10px;font-size:12px;line-height:18px;font-family:inherit;cursor:pointer;white-space:nowrap;transition:background .12s ease,color .12s ease,border-color .12s ease}
.dsm-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsm-btn:disabled{opacity:.45;cursor:not-allowed}
.dsm-btn--primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dsm-btn--primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);color:var(--dsw-alias-label-primary-foreground)}
.dsm-btn--danger{color:var(--dsw-alias-label-error);border-color:color-mix(in srgb,var(--dsw-alias-label-error) 45%,transparent)}
.dsm-btn--ghost{border-color:transparent}
.dsm-btn--sm{padding:2px 7px;font-size:11px;line-height:16px}
.dsm-chip{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 8px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);background:transparent;font-family:inherit;white-space:nowrap}
button.dsm-chip{cursor:pointer}
button.dsm-chip:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover)}
.dsm-chip--ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent)}
.dsm-chip--busy{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent)}
.dsm-chip--warn{color:var(--dsw-alias-state-warn-label);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 45%,transparent)}
.dsm-dot-live{width:6px;height:6px;border-radius:50%;background:currentColor;display:inline-block}
.dsm-errorbar{display:flex;align-items:center;gap:8px;margin:10px 16px 0;padding:7px 10px;border-radius:8px;border:1px solid var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-error);font-size:12px}
.dsm-errorbar-text{flex:1 1 auto;min-width:0;word-break:break-word}
.dsm-body{flex:1 1 auto;display:flex;min-height:0}
.dsm-side{width:302px;flex:0 0 auto;display:flex;flex-direction:column;min-height:0;border-right:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsm-side-head{padding:12px 12px 8px;display:flex;flex-direction:column;gap:8px}
.dsm-side-title{display:flex;align-items:baseline;gap:6px;font-size:13px;font-weight:600}
.dsm-side-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsm-search{position:relative;display:flex;align-items:center}
.dsm-search .dsm-search-icon{position:absolute;left:8px;color:var(--dsw-alias-label-secondary);pointer-events:none;display:flex}
/* 输入框：深一点的描边 + 内阴影，确保在白色弹窗里一眼看出是可输入的 */
.dsm-input{width:100%;box-sizing:border-box;border:1px solid #C6D2E3;border-radius:8px;background:#FFFFFF;color:#0F172A;padding:6px 9px;font-size:12.5px;line-height:19px;font-family:inherit;box-shadow:inset 0 1px 2px rgba(15,23,42,.05);transition:border-color .12s ease,box-shadow .12s ease,background .12s ease}
.dsm-input:hover:not(:disabled):not(:focus){border-color:#A8B8CE}
.dsm-input::placeholder{color:#94A3B8;opacity:1}
.dsm-input:focus{outline:none;border-color:#2F6BFF;background:#FFFFFF;box-shadow:0 0 0 3px rgba(47,107,255,.16),inset 0 1px 2px rgba(15,23,42,.04)}
.dsm-input:disabled{background:#F1F5F9;color:#8A94A6;box-shadow:none;border-color:#DCE4EF}
.dsm-input--search{padding-left:27px}
.dsm-input--cell{padding:3px 7px;font-size:12px;line-height:17px;border-radius:7px}
.dsm-textarea{resize:vertical;min-height:96px;line-height:19px}
/* 弹窗里的输入框再强调一档（弹窗背景是纯白，靠描边区分） */
.dsm-modal .dsm-input,.dsm-modal .dsm-textarea{border-color:#BFCCDF;background:#FCFDFF}
.dsm-modal .dsm-input:focus,.dsm-modal .dsm-textarea:focus{background:#FFFFFF}
.dsm-modal .dsm-label{color:#64748B;font-weight:500}
.dsm-filters{display:flex;gap:4px;flex-wrap:wrap}
.dsm-filter{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:2px 7px;font-size:11px;line-height:17px;font-family:inherit;cursor:pointer}
.dsm-filter:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-filter--active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 14%,transparent);color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.dsm-list{flex:1 1 auto;overflow:auto;padding:4px 8px 12px;display:flex;flex-direction:column;gap:3px}
    .dsm-quick{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-top:2px}
    .dsm-quick-btn{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;height:58px;box-sizing:border-box;padding:0 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:11.5px;line-height:15px;cursor:pointer;transition:background .14s ease,border-color .14s ease,transform .14s ease,box-shadow .14s ease}
    .dsm-quick-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2);transform:translateY(-1px);box-shadow:0 2px 6px color-mix(in srgb,#000 10%,transparent)}
    .dsm-quick-btn:active:not(:disabled){transform:translateY(0);box-shadow:none}
    .dsm-quick-btn:disabled{opacity:.45;cursor:not-allowed}
    .dsm-quick-btn--primary{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 13%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);color:var(--dsw-alias-brand-primary)}
    .dsm-quick-btn--primary:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-brand-primary) 21%,transparent)}
    .dsm-quick-btn--on{box-shadow:inset 0 0 0 1px rgba(255,255,255,.35),0 0 0 3px rgba(47,107,255,.16)}
    .dsm-quick-icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px}
    .dsm-meeting{display:flex;align-items:flex-start;gap:9px;width:100%;box-sizing:border-box;text-align:left;border:1px solid transparent;background:transparent;color:inherit;border-radius:10px;padding:9px 10px;font-family:inherit;cursor:pointer;transition:background .12s ease,border-color .12s ease}
    .dsm-meeting-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:4px}
    .dsm-meeting-sep{width:2px;height:2px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.7}
    .dsm-meeting-source{font-size:10.5px;line-height:15px;color:var(--dsw-alias-label-secondary)}
    .dsm-meeting-status{color:#0B7A3B;border-color:#8FD9AE;background:#E8F8EE;font-weight:600}
.dsm-meeting-status--idle{border-color:#F7B267;color:#B45309;background:#FFF3E0;font-weight:600}
    .dsm-meeting-icon{flex:0 0 auto;display:inline-flex;color:var(--dsw-alias-label-secondary)}
    .dsm-meeting-time{flex:0 0 auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;letter-spacing:.2px}
    .dsm-meeting-status{flex:0 0 auto;font-size:10px;line-height:15px;padding:0 5px;border-radius:999px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent);color:var(--dsw-alias-brand-primary);white-space:nowrap}
.dsm-export{position:relative;display:inline-flex}
.dsm-export-menu{position:absolute;top:calc(100% + 5px);right:0;z-index:30;min-width:168px;padding:5px;display:flex;flex-direction:column;gap:2px;background:var(--dsw-alias-bg-base,#fff);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;box-shadow:0 10px 26px rgba(15,23,42,.16)}
.dsm-export-item{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:18px;padding:7px 9px;border-radius:7px;cursor:pointer;text-align:left}
.dsm-export-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-export-ext{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dsm-meeting:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-meeting:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsm-meeting--active{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 34%,transparent)}
.dsm-meeting-top{display:flex;align-items:flex-start;gap:6px}
.dsm-meeting-title{font-size:13px;font-weight:600;line-height:19px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.dsm-meeting-icon{margin-top:2px}
.dsm-meeting-check{flex:0 0 auto;color:var(--dsw-alias-state-success-primary);font-size:11px;line-height:18px}
.dsm-meeting-meta{display:flex;align-items:center;gap:5px;flex-wrap:wrap;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-sep{width:2px;height:2px;border-radius:50%;background:var(--dsw-alias-label-secondary);opacity:.7}
.dsm-meeting-badges{display:flex;align-items:center;gap:4px;flex-wrap:wrap}
.dsm-badge{display:inline-flex;align-items:center;gap:3px;padding:0 6px;border-radius:999px;line-height:16px;font-size:10.5px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsm-badge--warn{color:var(--dsw-alias-state-warn-label);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 70%,transparent)}
.dsm-badge--ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-tertiary) 75%,transparent)}
.dsm-badge--brand{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.dsm-avatars{display:inline-flex;align-items:center;margin-left:auto}
.dsm-avatar{width:18px;height:18px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;margin-left:-5px;border:1px solid var(--dsw-alias-bg-layer-1);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary)}
.dsm-empty-list{margin:14px 8px;padding:16px 10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px}
.dsm-detail{flex:1 1 auto;min-width:0;min-height:0;overflow:auto;background:var(--dsw-alias-bg-base)}
.dsm-loading{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;height:100%;min-height:200px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsm-spin{width:14px;height:14px;border-radius:50%;border:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 26%,transparent);border-top-color:var(--dsw-alias-brand-primary);animation:dsm-spin .8s linear infinite;display:inline-block;flex:0 0 auto}
.dsm-spin--lg{width:26px;height:26px;border-width:3px}
@keyframes dsm-spin{to{transform:rotate(360deg)}}
.dsm-service-error{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;height:100%;padding:32px;text-align:center}
.dsm-service-title{font-size:16px;font-weight:600}
.dsm-service-text{font-size:12px;color:var(--dsw-alias-label-secondary);max-width:460px;line-height:20px}
.dsm-empty{flex:1 1 auto;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;padding:32px 28px;min-height:0;overflow:auto}
.dsm-empty-icon{width:64px;height:64px;border-radius:20px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 24%,transparent)}
.dsm-empty-title{font-size:20px;font-weight:650;letter-spacing:.2px;text-align:center}
.dsm-empty-sub{font-size:12.5px;color:var(--dsw-alias-label-secondary);text-align:center;line-height:20px;max-width:520px}
.dsm-entries{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;width:100%;max-width:720px;margin-top:2px}
.dsm-entry{display:flex;flex-direction:column;gap:6px;text-align:left;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);padding:14px;font-family:inherit;color:inherit;cursor:pointer;transition:border-color .12s ease,background .12s ease}
.dsm-entry:hover{border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 48%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1))}
.dsm-entry:disabled{opacity:.5;cursor:not-allowed}
.dsm-entry-icon{width:30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent)}
.dsm-entry-title{font-size:13px;font-weight:600}
.dsm-entry-text{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-empty-note{font-size:11px;color:var(--dsw-alias-label-secondary);text-align:center}
.dsm-doc{max-width:960px;margin:0 auto;padding:20px 26px 64px;box-sizing:border-box}
.dsm-cover{display:flex;flex-direction:column;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;padding:20px 22px;background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,var(--dsw-alias-bg-layer-1)),var(--dsw-alias-bg-layer-1) 58%)}
.dsm-cover-top{display:flex;align-items:flex-start;gap:10px}
.dsm-eyebrow{flex:1 1 auto;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-brand-primary);font-weight:600}
.dsm-cover-actions{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.dsm-cover-title{margin:0;font-size:25px;line-height:34px;font-weight:680;letter-spacing:.2px;word-break:break-word}
.dsm-meta-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsm-meta-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-meta-chip--brand{color:var(--dsw-alias-brand-primary);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 35%,transparent);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent)}
.dsm-oneline{position:relative;display:flex;gap:10px;border-radius:11px;border-left:3px solid var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-base));padding:11px 14px}
.dsm-oneline-mark{font-size:26px;line-height:22px;color:var(--dsw-alias-brand-primary);font-weight:700;flex:0 0 auto}
.dsm-oneline-text{font-size:15px;line-height:23px;font-weight:600;word-break:break-word}
.dsm-overview{margin-top:5px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);word-break:break-word;white-space:pre-wrap}
.dsm-doc-section{margin-top:20px}
.dsm-section-band{display:flex;align-items:center;gap:8px;margin-bottom:9px}
.dsm-section-icon{color:var(--dsw-alias-label-secondary);display:flex}
.dsm-section-title{margin:0;font-size:13px;font-weight:650;letter-spacing:.2px}
.dsm-section-count{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsm-section-sub{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto}
.dsm-points{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:8px}
.dsm-point{display:flex;gap:9px;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);padding:10px 11px}
.dsm-point-num{flex:0 0 auto;font-size:11px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);line-height:19px;min-width:16px}
.dsm-point-text{font-size:12.5px;line-height:19px;word-break:break-word}
.dsm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:8px}
.dsm-decision{display:flex;gap:8px;align-items:flex-start;border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 32%,var(--dsw-alias-border-l1));border-radius:11px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,var(--dsw-alias-bg-layer-1));padding:10px 11px}
.dsm-decision-check{flex:0 0 auto;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsm-decision-body{flex:1 1 auto;min-width:0}
.dsm-decision-text{font-size:12.5px;line-height:19px;word-break:break-word}
.dsm-owner{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-risk{display:flex;gap:8px;align-items:flex-start;border-radius:11px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);padding:10px 11px}
.dsm-risk--medium{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 38%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 55%,var(--dsw-alias-bg-layer-1))}
.dsm-risk--high{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,var(--dsw-alias-bg-layer-1))}
.dsm-risk-sign{flex:0 0 auto;color:var(--dsw-alias-label-secondary);display:flex;margin-top:1px}
.dsm-risk--medium .dsm-risk-sign{color:var(--dsw-alias-state-warn-label)}
.dsm-risk--high .dsm-risk-sign{color:var(--dsw-alias-state-error-primary)}
.dsm-risk-body{flex:1 1 auto;min-width:0}
.dsm-risk-text{font-size:12.5px;line-height:19px;word-break:break-word}
.dsm-risk-level{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.dsm-risk--medium .dsm-risk-level{color:var(--dsw-alias-state-warn-label)}
.dsm-risk--high .dsm-risk-level{color:var(--dsw-alias-state-error-primary)}
.dsm-blocks{display:flex;flex-direction:column;gap:9px}
.dsm-block{border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);padding:11px 13px}
.dsm-block-heading{font-size:12.5px;font-weight:600;margin-bottom:6px;word-break:break-word}
.dsm-bullets{margin:0;padding:0 0 0 2px;list-style:none;display:flex;flex-direction:column;gap:4px}
.dsm-bullet{position:relative;padding-left:13px;font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);word-break:break-word}
.dsm-bullet::before{content:'';position:absolute;left:3px;top:8px;width:4px;height:4px;border-radius:50%;background:var(--dsw-alias-brand-primary);opacity:.75}
.dsm-notes{white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:20px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:11px;background:var(--dsw-alias-bg-layer-1);padding:11px 13px}
.dsm-todo-card{border:1px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsm-table-wrap{overflow-x:auto}
.dsm-table{width:100%;border-collapse:collapse;min-width:720px}
.dsm-table th{text-align:left;font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);padding:7px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 4%,transparent)}
.dsm-table td{padding:8px 9px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;font-size:12px;line-height:18px}
.dsm-table tbody tr:hover{background:color-mix(in srgb,var(--dsw-alias-label-secondary) 4%,transparent)}
.dsm-table tbody tr:last-child td{border-bottom:0}
.dsm-table .dsm-col-check{width:34px}
.dsm-table .dsm-col-owner{width:88px}
.dsm-table .dsm-col-due{width:116px}
.dsm-table .dsm-col-priority{width:64px}
.dsm-table .dsm-col-status{width:122px}
.dsm-table .dsm-col-actions{width:74px}
.dsm-checkbox{accent-color:var(--dsw-alias-button-primary-fill);width:14px;height:14px;margin:2px 0 0;cursor:pointer}
.dsm-checkbox:disabled{cursor:not-allowed;opacity:.5}
.dsm-todo-title{font-weight:500;word-break:break-word}
.dsm-todo-note{margin-top:3px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);word-break:break-word;white-space:pre-wrap}
.dsm-todo--pushed .dsm-todo-title{color:var(--dsw-alias-label-secondary)}
.dsm-prio{display:inline-flex;padding:0 6px;border-radius:999px;font-size:10.5px;line-height:17px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsm-prio--high{color:var(--dsw-alias-label-error);border-color:color-mix(in srgb,var(--dsw-alias-label-error) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.dsm-prio--low{color:var(--dsw-alias-label-secondary)}
.dsm-status{display:inline-flex;align-items:center;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsm-status--ok{color:var(--dsw-alias-state-success-primary)}
.dsm-cal-id{display:inline-block;margin-top:2px;font-size:10px;color:var(--dsw-alias-label-secondary);max-width:100%;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsm-row-actions{display:flex;gap:4px;flex-wrap:wrap}
.dsm-todo-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 3%,transparent)}
.dsm-todo-hint{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:17px}
.dsm-todo-hint--warn{color:var(--dsw-alias-state-warn-label)}
.dsm-empty-table{padding:16px;text-align:center;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-transcript{border:1px solid var(--dsw-alias-border-l1);border-radius:13px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dsm-transcript-head{display:flex;align-items:center;gap:8px;padding:9px 12px;flex-wrap:wrap}
.dsm-transcript-toggle{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;padding:0}
.dsm-transcript-toggle:hover{color:var(--dsw-alias-brand-primary)}
.dsm-chevron--open{transform:rotate(90deg);transition:transform .12s ease}
.dsm-transcript-meta{font-size:11px;color:var(--dsw-alias-label-secondary);font-weight:400}
.dsm-transcript-body{margin:0;padding:12px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:19px;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow:auto}
.dsm-detail-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;height:100%;min-height:260px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsm-cta{display:flex;align-items:center;gap:12px;border:1px dashed color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l1));border-radius:13px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-layer-1));padding:14px 16px;margin-top:20px;flex-wrap:wrap}
.dsm-cta-icon{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);flex:0 0 auto}
.dsm-cta-body{flex:1 1 220px;min-width:0}
.dsm-cta-title{font-size:13px;font-weight:600;margin-bottom:2px}
.dsm-cta-text{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-summarizing{display:flex;align-items:center;gap:10px;margin-top:20px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dsw-alias-border-l1));border-radius:13px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 7%,var(--dsw-alias-bg-layer-1));padding:12px 14px;font-size:12px;flex-wrap:wrap}
.dsm-summarizing-text{flex:1 1 200px;line-height:18px}
.dsm-summarizing-sub{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-modal-root{position:fixed;inset:0;z-index:130;display:flex;align-items:center;justify-content:center;padding:24px}
.dsm-modal-mask{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);backdrop-filter:blur(1px)}
.dsm-modal{position:relative;display:flex;flex-direction:column;width:min(560px,94vw);max-height:86vh;background:var(--dsw-alias-bg-overlay);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 18px 52px color-mix(in srgb,var(--dsw-alias-label-primary) 20%,transparent);overflow:hidden}
.dsm-modal--wide{width:min(660px,94vw)}
.dsm-modal-head{display:flex;align-items:flex-start;gap:10px;padding:16px 18px 10px}
.dsm-modal-heading{flex:1 1 auto;min-width:0}
.dsm-modal-title{font-size:15px;font-weight:650}
.dsm-modal-sub{margin-top:3px;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-modal-lock{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;padding-top:3px}
.dsm-settings-btn{height:27px;padding:0 11px;gap:6px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);font-size:12px;font-weight:550;color:var(--dsw-alias-label-primary);box-shadow:0 1px 1px color-mix(in srgb,#000 4%,transparent)}
.dsm-settings-btn svg{color:var(--dsw-alias-brand-primary)}
.dsm-settings-btn:hover{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 36%,transparent);color:var(--dsw-alias-brand-primary)}
.dsm-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;padding:0}
.dsm-iconbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-iconbtn:disabled{opacity:.6;cursor:default}
.dsm-modal-body{padding:4px 18px 14px;overflow:auto;display:flex;flex-direction:column;gap:10px}
.dsm-modal-foot{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap;padding:11px 18px;border-top:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-label-secondary) 3%,transparent)}
.dsm-field{display:flex;flex-direction:column;gap:4px}
.dsm-label{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-row{display:flex;gap:8px}
.dsm-row>.dsm-field{flex:1 1 0;min-width:0}
.dsm-record-mode{display:flex;align-items:flex-start;gap:10px;padding:0 2px 10px;border:0;border-bottom:1px dashed #E6ECF5;border-radius:0;background:transparent}
    .dsm-record-mode-icon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:#EAF1FF;color:#2563EB}
    .dsm-record-mode-body{min-width:0;padding-top:1px}
    .dsm-record-mode-title{font-size:13.5px;font-weight:650;line-height:19px;color:#0F172A}
    .dsm-record-mode-text{font-size:11.5px;line-height:17px;color:#8A94A6;margin-top:1px}
.dsm-check{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:18px;cursor:pointer;color:var(--dsw-alias-label-primary)}
.dsm-check input{margin:2px 0 0;accent-color:var(--dsw-alias-brand-primary)}
.dsm-check--off{cursor:not-allowed;opacity:.6}
.dsm-media-list{display:flex;flex-direction:column;gap:6px;width:100%;margin-top:6px;padding:10px 11px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover)}
.dsm-media-title{font-size:11.5px;font-weight:600}
.dsm-media-row{display:flex;align-items:center;gap:8px;font-size:11.5px}
.dsm-media-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-media-size{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.dsm-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px;margin-bottom:2px}
.dsm-tab{border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:3px 9px;font-size:12px;font-family:inherit;cursor:pointer}
.dsm-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsm-tab--active{color:var(--dsw-alias-brand-primary);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 11%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-brand-primary) 28%,transparent)}
.dsm-hint{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dsm-hint--warn{color:var(--dsw-alias-state-warn-label)}
.dsm-inline-error{border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 9%,transparent);color:var(--dsw-alias-label-error);border-radius:8px;padding:7px 9px;font-size:11.5px;line-height:18px;word-break:break-word}
.dsm-radio-row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.dsm-radio{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsm-radio input{accent-color:var(--dsw-alias-button-primary-fill)}
.dsm-file-pick{display:flex;align-items:center;gap:8px;flex-wrap:wrap;border:1px dashed var(--dsw-alias-border-l2);border-radius:9px;padding:10px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 3%,transparent)}
.dsm-file-name{font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsm-progress-card{display:flex;flex-direction:column;gap:7px;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 32%,var(--dsw-alias-border-l1));border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 6%,var(--dsw-alias-bg-base));padding:10px 12px}
.dsm-progress-head{display:flex;align-items:center;gap:8px;font-size:12px;line-height:18px}
.dsm-progress-title{flex:1 1 auto;min-width:0}
.dsm-progress-pct{font-size:11px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-brand-primary);font-weight:600}
.dsm-progress{height:6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 20%,transparent);overflow:hidden}
.dsm-progress-bar{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.dsm-progress-meta{font-size:10.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dsm-record-stage{display:flex;flex-direction:column;align-items:center;gap:12px;padding:18px 10px;text-align:center}
.dsm-rec-dot{width:11px;height:11px;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:dsm-pulse 1.2s ease-in-out infinite}
@keyframes dsm-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.45;transform:scale(.82)}}
.dsm-rec-timer{font-size:34px;line-height:40px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:.06em}
.dsm-rec-status{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-level{width:min(320px,80%);height:8px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-secondary) 20%,transparent);overflow:hidden}
.dsm-level-bar{height:100%;border-radius:999px;background:linear-gradient(90deg,var(--dsw-alias-brand-primary),var(--dsw-alias-state-success-primary));transition:width .12s linear}
.dsm-stage-title{font-size:14px;font-weight:600}
.dsm-stage-text{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:19px;max-width:420px;word-break:break-word}
.dsm-done-icon{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.dsm-toast-stack{position:fixed;right:18px;bottom:18px;z-index:200;display:flex;flex-direction:column;gap:8px;max-width:min(400px,90vw);pointer-events:none}
.dsm-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:10px;border:1px solid #E4E9F2;border-radius:12px;background:#FFFFFF;color:#0F172A;box-shadow:0 12px 28px rgba(15,23,42,.14);padding:11px 12px;padding:9px 12px;animation:dsm-toast-in .16s ease}
@keyframes dsm-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dsm-toast-icon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:#EAF1FF;color:#2563EB}
.dsm-toast--success .dsm-toast-icon{background:#E8F8EE;color:#0B7A3B}
.dsm-toast--error .dsm-toast-icon{background:#FEF2F2;color:#DC2626}
.dsm-toast--warn .dsm-toast-icon{background:#FFF4E5;color:#B45309}
.dsm-toast-content{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;padding-top:2px}
.dsm-toast-title{font-size:12.5px;font-weight:650;line-height:18px;color:#0F172A}
.dsm-toast-body{font-size:11.5px;line-height:17px;color:#8A94A6;word-break:break-word}
.dsm-toast-close{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:6px;background:transparent;color:#8A94A6;cursor:pointer;margin-top:1px}
.dsm-toast-close:hover{background:#F3F7FE;color:#2563EB}
.dsm-icon-badge{position:relative;display:inline-flex}
.dsm-icon-dot{position:absolute;top:-3px;right:-4px;min-width:12px;height:12px;border-radius:999px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font-size:9px;line-height:12px;text-align:center;padding:0 3px;font-weight:600}
.dsm-dialog-text{font-size:12.5px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0;word-break:break-word}
.dsm-kbd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;border:1px solid var(--dsw-alias-border-l1);border-radius:4px;padding:0 3px;color:var(--dsw-alias-label-secondary)}
.dsm-livebar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:210;display:flex;align-items:center;gap:10px;max-width:min(780px,94vw);box-sizing:border-box;padding:8px 10px 8px 12px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,var(--dsw-alias-border-l2));border-radius:12px;background:var(--dsw-alias-toast-bg);color:var(--dsw-alias-toast-label);box-shadow:0 12px 34px color-mix(in srgb,var(--dsw-alias-label-primary) 24%,transparent)}
.dsm-livebar-dot{width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-error-primary);animation:dsm-pulse 1.2s ease-in-out infinite;flex:0 0 auto}
.dsm-livebar-main{flex:1 1 260px;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsm-livebar-title{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:650;white-space:nowrap}
.dsm-livebar-timer{font-variant-numeric:tabular-nums}
.dsm-livebar-meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-livebar-actions{display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.dsm-livebar .dsm-btn{color:var(--dsw-alias-toast-label);border-color:color-mix(in srgb,var(--dsw-alias-toast-label) 24%,transparent)}
.dsm-livebar .dsm-btn:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-toast-label) 12%,transparent);color:var(--dsw-alias-toast-label)}
.dsm-livebar .dsm-btn--danger{color:var(--dsw-alias-label-error);border-color:color-mix(in srgb,var(--dsw-alias-label-error) 55%,transparent)}
.dsm-live-panel{display:flex;flex-direction:column;gap:10px;padding:4px 0 2px}
.dsm-live-head{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;word-break:break-word}
.dsm-live-head .dsm-livebar-dot{width:10px;height:10px}
.dsm-live-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsm-live-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-base)}
.dsm-live-stat-label{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dsm-live-stat-value{font-size:19px;line-height:25px;font-weight:650;font-variant-numeric:tabular-nums}
.dsm-live-last{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 11px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 5%,var(--dsw-alias-bg-base));min-height:48px;font-size:12px;line-height:19px;word-break:break-word}
.dsm-live-last-label{font-size:10.5px;color:var(--dsw-alias-label-secondary);margin-bottom:3px}
.dsm-live-queue{font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsm-live-stopping{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px}
.dsm-icon-live-dot{position:absolute;bottom:-2px;right:-3px;width:9px;height:9px;border-radius:50%;background:var(--dsw-alias-state-error-primary);border:1.5px solid var(--dsw-alias-bg-base);animation:dsm-pulse 1.2s ease-in-out infinite}
.dsm-settings-section{display:flex;flex-direction:column;gap:7px;padding:11px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-l2,#F8FAFE);margin-bottom:2px}
/* ── 设置弹窗：左导航 + 右内容 ── */
.dsm-set-layout{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;min-height:420px;max-height:64vh}
.dsm-set-nav{display:flex;flex-direction:column;gap:4px;padding:6px 4px;border-right:1px solid #EDF1F7}
.dsm-set-nav-item{display:flex;align-items:center;gap:7px;width:100%;border:0;background:transparent;color:#475569;font-family:inherit;font-size:12.5px;line-height:18px;padding:8px 10px;border-radius:8px;cursor:pointer;text-align:left}
.dsm-set-nav-item:hover{background:#F3F7FE;color:#2563EB}
.dsm-set-nav-item--on{background:#EAF1FF;color:#2563EB;font-weight:600}
.dsm-set-content{overflow:auto;padding:2px 4px 6px 2px}
.dsm-set-page{display:flex;flex-direction:column;gap:12px}
.dsm-set-section{display:flex;flex-direction:column;gap:8px;padding:12px 13px;border:1px solid #E4E9F2;border-radius:12px;background:#FBFCFE}
.dsm-set-section-head{display:flex;flex-direction:column;gap:2px}
.dsm-set-section-title{font-size:13px;font-weight:650;color:#0F172A}
.dsm-set-section-desc{font-size:11px;line-height:16px;color:#8A94A6}
.dsm-set-option{display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border:1px solid #E4E9F2;border-radius:10px;background:#FFFFFF;cursor:pointer}
.dsm-set-option:hover{border-color:#C7DAFF;background:#F8FBFF}
.dsm-set-option--on{border-color:#9FBDFF;background:#F2F7FF}
.dsm-set-option input{margin-top:2px;accent-color:#2F6BFF}
.dsm-set-option-body{flex:1;min-width:0}
.dsm-set-option-title{font-size:12.5px;font-weight:600;line-height:18px;color:#0F172A}
.dsm-set-option-desc{font-size:11px;line-height:16px;color:#8A94A6;margin-top:1px}
.dsm-set-badge{flex:0 0 auto;font-size:10px;line-height:16px;padding:1px 7px;border-radius:999px;border:1px solid #E4E9F2;color:#8A94A6;white-space:nowrap}
.dsm-set-badge--ok{border-color:#B9E3C9;color:#15803D;background:#F2FBF6}
.dsm-set-models{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px dashed #D9E2F0;border-radius:10px;background:#FFFFFF}
.dsm-set-model-row{display:flex;align-items:center;gap:10px}
.dsm-set-model-info{flex:1;min-width:0;display:flex;flex-direction:column}
.dsm-set-model-name{font-size:12px;line-height:17px;color:#0F172A}
.dsm-set-model-size{font-size:10.5px;line-height:15px;color:#8A94A6}
.dsm-set-model-progress{font-size:11px;color:#2563EB}
.dsm-set-model-actions{display:flex;gap:6px;align-items:center}
.dsm-set-inline{display:flex;align-items:center;gap:10px}
.dsm-set-tabs{display:flex;gap:4px}
.dsm-set-tab{border:1px solid #E4E9F2;background:#FFFFFF;color:#475569;font-family:inherit;font-size:11.5px;line-height:16px;padding:4px 10px;border-radius:999px;cursor:pointer}
.dsm-set-tab--on{border-color:#9FBDFF;background:#EAF1FF;color:#2563EB;font-weight:600}
.dsm-set-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dsm-set-grid--cards{grid-template-columns:repeat(3,minmax(0,1fr))}
.dsm-set-card{border:1px solid #E4E9F2;border-radius:10px;padding:8px 10px;background:#FFFFFF}
.dsm-set-card-k{font-size:10.5px;color:#8A94A6;line-height:15px}
.dsm-set-card-v{font-size:12.5px;font-weight:600;line-height:18px;color:#0F172A;margin-top:1px}
.dsm-settings-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.dsm-settings-title{font-size:13px;font-weight:650;color:var(--dsw-alias-label-primary)}
.dsm-settings-desc{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.dsm-settings-section-head{font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary);margin:6px 0 -2px}
.dsm-auto-toggles{display:flex;flex-direction:column;gap:8px}
.dsm-auto-toggle{display:flex;align-items:flex-start;gap:9px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 11px;background:var(--dsw-alias-bg-base);cursor:pointer}
.dsm-auto-toggle input{margin:2px 0 0;accent-color:var(--dsw-alias-button-primary-fill);width:14px;height:14px;flex:0 0 auto}
.dsm-auto-toggle-body{flex:1 1 auto;min-width:0}
.dsm-auto-toggle-title{display:block;font-size:12.5px;font-weight:600;line-height:18px}
.dsm-auto-toggle-text{display:block;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);margin-top:1px;word-break:break-word}
.dsm-auto-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsm-auto-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:8px 10px;background:var(--dsw-alias-bg-base);min-width:0}
.dsm-auto-card--wide{grid-column:1 / -1}
.dsm-auto-k{font-size:10.5px;color:var(--dsw-alias-label-secondary);line-height:15px}
.dsm-auto-v{font-size:12px;line-height:18px;font-weight:500;word-break:break-word;margin-top:1px}
.dsm-auto-v--ok{color:var(--dsw-alias-state-success-primary)}
.dsm-auto-v--warn{color:var(--dsw-alias-state-warn-label)}
.dsm-auto-v--error{color:var(--dsw-alias-label-error)}
.dsm-auto-path{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary);word-break:break-all;margin-top:2px}
.dsm-auto-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsm-auto-note{font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);border-left:2px solid var(--dsw-alias-brand-primary);padding:2px 0 2px 8px}
.dsm-auto-recent{display:flex;flex-direction:column;gap:4px}
.dsm-auto-recent-item{display:flex;align-items:baseline;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;background:var(--dsw-alias-bg-base);font-family:inherit;color:inherit;font-size:11.5px;text-align:left;cursor:pointer;width:100%;box-sizing:border-box}
.dsm-auto-recent-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-auto-recent-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-auto-recent-time{flex:0 0 auto;font-size:10.5px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.dsm-auto-empty{font-size:11px;color:var(--dsw-alias-label-secondary);padding:4px 0}
@media (max-width:900px){.dsm-side{width:250px}.dsm-doc{padding:16px 16px 48px}.dsm-entries{grid-template-columns:1fr 1fr}.dsm-cover-title{font-size:21px;line-height:29px}}
@media (max-width:720px){.dsm-body{flex-direction:column}.dsm-side{width:auto;max-height:250px;border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dsm-entries{grid-template-columns:1fr}.dsm-toolbar{padding:8px 10px}.dsm-errorbar{margin:8px 10px 0}}
/* ── AI 会议纪要卡片（浅灰底 + 白卡片 + 浅蓝主题） ── */
.dsm-minutes{margin-top:14px;background:#FFFFFF;border:1px solid #E3E9F2;border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,.05);overflow:hidden}
.dsm-minutes-head{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid #EDF1F7;background:linear-gradient(180deg,#F7FAFF,#FFFFFF)}
.dsm-minutes-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:#E8F0FF;color:#2563EB;flex:0 0 auto}
.dsm-minutes-title{font-size:12.5px;font-weight:650;color:#0F172A;letter-spacing:.1px}
.dsm-minutes-meta{font-size:11px;color:#8A94A6}
.dsm-minutes-spacer{flex:1 1 auto}
.dsm-minutes-action{display:inline-flex;align-items:center;gap:4px;border:1px solid transparent;background:transparent;color:#5A6474;font-family:inherit;font-size:11px;line-height:16px;padding:3px 7px;border-radius:7px;cursor:pointer}
.dsm-minutes-action:hover{background:#EEF3FB;color:#2563EB}
.dsm-minutes-action--primary{background:#2563EB;border-color:#2563EB;color:#FFFFFF}
.dsm-minutes-action--primary:hover:not(:disabled){background:#1D4ED8;border-color:#1D4ED8;color:#FFFFFF}
.dsm-minutes-action:disabled{opacity:.5;cursor:not-allowed}
.dsm-minutes-caret{display:inline-block;font-size:12px;line-height:12px;transform:translateY(-1px);transition:transform .16s ease}
.dsm-minutes-caret--up{transform:translateY(-3px) rotate(180deg)}
.dsm-minutes-body{position:relative;height:96px;overflow:hidden;padding:11px 14px;transition:height .18s ease}
.dsm-minutes--expanded .dsm-minutes-body{height:340px;overflow:auto}
.dsm-minutes-body::after{content:"";position:absolute;left:0;right:0;bottom:0;height:26px;background:linear-gradient(180deg,rgba(255,255,255,0),#FFFFFF);pointer-events:none}
.dsm-minutes--expanded .dsm-minutes-body::after{display:none}
.dsm-minutes-oneline{font-size:12.5px;font-weight:600;line-height:20px;color:#0F172A}
.dsm-minutes-overview{font-size:12px;line-height:20px;color:#475569;margin-top:6px;white-space:pre-wrap}
.dsm-minutes-group{margin-top:10px}
.dsm-minutes-group-title{font-size:11.5px;font-weight:650;color:#2563EB;margin-bottom:3px}
.dsm-minutes-item{display:flex;gap:6px;font-size:12px;line-height:20px;color:#334155}
.dsm-minutes-dot{flex:0 0 auto;width:5px;height:5px;margin-top:7px;border-radius:50%;background:#93B4F5}
.dsm-minutes-empty{font-size:12px;color:#8A94A6}
/* ── 录音弹窗：关键信息更醒目 ── */
.dsm-rec-overview{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.dsm-rec-item--wide{grid-column:span 2}
.dsm-rec-item--full{grid-column:1 / -1;align-items:flex-end}
.dsm-rec-item--full .dsm-rec-item-icon{align-self:flex-start;margin-top:2px}
.dsm-rec-item--full .dsm-rec-item-body{align-self:stretch}
.dsm-rec-item--full .dsm-rec-toggle{align-self:flex-end}
.dsm-rec-select{min-width:0}
.dsm-rec-select > select{height:30px;width:100%;border:1px solid #E4E9F2;border-radius:8px;background:#FFFFFF;color:#0F172A;font-family:inherit;font-size:12.5px;font-weight:650;padding:0 8px;cursor:pointer}
.dsm-rec-select > select:hover{border-color:#C7DAFF}
.dsm-rec-toggle{flex:0 0 auto;display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 12px;border-radius:8px;border:1px solid #2F6BFF;background:#2F6BFF;color:#FFFFFF;font-family:inherit;font-size:12px;font-weight:650;cursor:pointer}
.dsm-rec-toggle:hover:not(:disabled){background:#2459E6;border-color:#2459E6}
.dsm-rec-toggle--on{background:#FFFFFF;border-color:#F4C7C7;color:#DC2626}
.dsm-rec-toggle--on:hover:not(:disabled){background:#FEF2F2;border-color:#F0AFAF}
.dsm-rec-toggle:disabled{opacity:.55;cursor:not-allowed}
.dsm-rec-toggle--ghost{background:#FFFFFF;border-color:#E1E7F1;color:#475569}
.dsm-rec-toggle--ghost:hover:not(:disabled){background:#EEF3FB;border-color:#C7DAFF;color:#2563EB}
.dsm-mic-meter{display:flex;gap:2px;align-items:stretch;height:14px;margin-top:7px;width:100%}
.dsm-mic-seg{flex:1 1 0;border-radius:2px;background:#E4E9F2;transition:background .06s ease}
.dsm-mic-seg--on.dsm-mic-seg--low{background:#22A06B}
.dsm-mic-seg--on.dsm-mic-seg--mid{background:#2F6BFF}
.dsm-mic-seg--on.dsm-mic-seg--high{background:#E0574B}
.dsm-rec-item{display:flex;align-items:center;gap:9px;padding:10px 11px;border:1px solid #E4E9F2;border-radius:12px;background:#F8FAFE}
.dsm-rec-item-icon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:9px;background:#E8F0FF;color:#2563EB}
.dsm-rec-item-icon--screen{background:#EAF3FF;color:#1D4ED8}
.dsm-rec-item-icon--speech{background:#F1ECFF;color:#6D4AFF}
.dsm-rec-item-body{min-width:0}
.dsm-rec-item-label{font-size:10.5px;line-height:14px;color:#8A94A6}
.dsm-rec-item-value{font-size:12.5px;line-height:18px;font-weight:650;color:#0F172A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-rec-item-value--on{color:#15803D}
.dsm-rec-item-value--warn{color:#B45309}
.dsm-rec-produce{display:flex;align-items:center;gap:6px;margin-top:8px;padding:7px 10px;border-radius:9px;background:#EAF1FF;border:1px solid #C7DAFF;color:#2563EB;font-size:11.5px;line-height:16px}
.dsm-rec-form{display:flex;flex-direction:column;gap:10px}
.dsm-rec-title .dsm-input{height:40px;font-size:14px;font-weight:650;letter-spacing:.2px}
.dsm-rec-settings{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;align-items:end;padding:11px 12px;border:1px dashed #D9E2F0;border-radius:12px;background:#FBFCFF}
.dsm-rec-settings .dsm-check{align-self:center;margin-top:2px}
.dsm-rec-tip{font-size:11px;line-height:16px;color:#8A94A6}
.dsm-btn--lg{height:36px;padding:0 18px;font-size:13px;font-weight:650;border-radius:9px}
.dsm-live-badge{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;line-height:16px;padding:1px 7px;border-radius:999px;background:#FEF2F2;border:1px solid #FBC7C7;color:#DC2626}
.dsm-root .dsm-live-stat{background:#F8FAFE;border:1px solid #E4E9F2;border-radius:12px;padding:9px 11px}
.dsm-root .dsm-live-stat-value{font-size:22px;font-weight:700;letter-spacing:.5px;line-height:28px}
.dsm-root .dsm-live-stat-label{font-size:11px;color:#8A94A6}
.dsm-root .dsm-level{height:8px;border-radius:999px;background:#E9EEF6;overflow:hidden}

/* ── 待办 / 原始转写：与会议纪要一致的卡片样式 ── */
.dsm-root .dsm-section-card{background:#FFFFFF;border:1px solid #E3E9F2;border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,.05);overflow:hidden;padding:0}
.dsm-root .dsm-section-card .dsm-section-band{margin:0;padding:10px 13px;border-bottom:1px solid #EDF1F7;background:linear-gradient(180deg,#F7FAFF,#FFFFFF)}
.dsm-root .dsm-section-card .dsm-section-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:#E8F0FF;color:#2563EB}
.dsm-root .dsm-section-card .dsm-section-title{font-size:12.5px;font-weight:650;color:#0F172A;letter-spacing:.1px}
.dsm-root .dsm-section-card .dsm-section-count,.dsm-root .dsm-section-card .dsm-section-sub{font-size:11px;color:#8A94A6}
.dsm-section-actions{margin-left:auto;display:inline-flex;align-items:center}
.dsm-section-action-row{display:inline-flex;align-items:center;gap:4px}
.dsm-root .dsm-section-card > *:not(.dsm-section-band){margin:11px 13px}
.dsm-root .dsm-section-card > *:last-child{margin-bottom:13px}
.dsm-root .dsm-section-card > .dsm-todo-card{border:0;padding:0;background:transparent}
.dsm-root .dsm-section-card > .dsm-transcript{border:0;background:transparent;padding:0}
.dsm-transcript-lines{position:relative;max-height:132px;overflow:hidden;display:flex;flex-direction:column;gap:6px}
.dsm-transcript-lines--open{max-height:420px;overflow:auto}
.dsm-transcript-lines:not(.dsm-transcript-lines--open)::after{content:"";position:absolute;left:0;right:0;bottom:0;height:26px;background:linear-gradient(180deg,rgba(255,255,255,0),#FFFFFF);pointer-events:none}
.dsm-transcript-line{display:flex;align-items:flex-start;gap:7px;font-size:12px;line-height:20px;color:#334155}
.dsm-transcript-text{flex:1 1 auto;min-width:0;white-space:pre-wrap;word-break:break-word}
.dsm-speaker{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;margin-top:1px;padding:0 4px;border-radius:6px;font-size:10.5px;font-weight:700;color:#FFFFFF;background:#2F6BFF}
.dsm-speaker--b{background:#7C3AED}
.dsm-speaker--c{background:#059669}
.dsm-speaker--d{background:#D97706}
.dsm-speaker--x{background:#94A3B8}
.dsm-transcript-plain{font-size:12px;line-height:20px;color:#334155;white-space:pre-wrap;max-height:220px;overflow:auto;font-family:inherit}
.dsm-transcript-note{margin-top:8px;font-size:11px;line-height:16px;color:#8A94A6}

/* ── 会议文件（音频/视频）行 ── */
.dsm-files{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.dsm-file{display:flex;align-items:center;gap:10px;padding:9px 11px;background:#FBFCFE;border:1px solid #E9EEF6;border-radius:12px}
.dsm-file:hover{background:#F5F8FF;border-color:#C7DAFF}
.dsm-file-icon{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:9px;background:#E8F0FF;color:#2563EB}
.dsm-file-icon--audio{background:#E7F6EF;color:#0F8A5F}
.dsm-file-main{flex:1 1 auto;min-width:0}
.dsm-file-name{font-size:12.5px;line-height:18px;font-weight:600;color:#0F172A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsm-file-meta{font-size:11px;line-height:16px;color:#8A94A6;margin-top:1px}
.dsm-file-actions{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px}
.dsm-file-action{display:inline-flex;align-items:center;gap:4px;font-family:inherit;font-size:11.5px;line-height:16px;padding:4px 9px;border-radius:8px;border:1px solid #E1E7F1;background:#FFFFFF;color:#5A6474;cursor:pointer}
.dsm-file-action:hover:not(:disabled){border-color:#C7DAFF;background:#EEF3FB;color:#2563EB}
.dsm-file-action:disabled{opacity:.5;cursor:not-allowed}
.dsm-file-action--primary{border-color:#2563EB;background:#2563EB;color:#FFFFFF}
.dsm-file-action--primary:hover:not(:disabled){border-color:#1D4ED8;background:#1D4ED8;color:#FFFFFF}

/* ── 浅灰底 + 白色/浅蓝主题 ── */
.dsm-root{--dsm-accent:#2F6BFF;--dsm-accent-strong:#2459E6;--dsm-accent-soft:#EAF1FF;--dsm-accent-line:#C7DAFF;--dsm-canvas:#F4F6FA;--dsm-surface:#FFFFFF;--dsm-line:#E4E9F2;--dsm-ink:#0F172A;--dsm-ink-2:#475569;--dsm-ink-3:#8A94A6;background:var(--dsm-canvas)}
.dsm-root .dsm-toolbar{background:var(--dsm-surface);border-bottom:1px solid var(--dsm-line)}
.dsm-root .dsm-brand-title{color:var(--dsm-ink)}
.dsm-root .dsm-brand-sub{color:var(--dsm-ink-3)}
.dsm-root .dsm-side{background:var(--dsm-canvas);border-right:1px solid var(--dsm-line)}
.dsm-root .dsm-side-head{background:var(--dsm-canvas)}
.dsm-root .dsm-side-title{color:var(--dsm-ink)}
.dsm-root .dsm-side-count{color:var(--dsm-ink-3)}
.dsm-root .dsm-quick-btn{background:var(--dsm-surface);border-color:var(--dsm-line);color:var(--dsm-ink);box-shadow:0 1px 2px rgba(15,23,42,.04)}
.dsm-root .dsm-quick-btn:hover:not(:disabled){background:var(--dsm-accent-soft);border-color:var(--dsm-accent-line);color:var(--dsm-accent)}
.dsm-root .dsm-quick-btn--primary{background:var(--dsm-accent);border-color:var(--dsm-accent);color:#FFFFFF}
.dsm-root .dsm-quick-btn--primary:hover:not(:disabled){background:var(--dsm-accent-strong);border-color:var(--dsm-accent-strong);color:#FFFFFF}
.dsm-root .dsm-search input{background:var(--dsm-surface);border-color:var(--dsm-line);color:var(--dsm-ink)}
.dsm-root .dsm-filter{color:var(--dsm-ink-3)}
.dsm-root .dsm-filter--active{background:var(--dsm-accent-soft);color:var(--dsm-accent);border-color:var(--dsm-accent-line)}
.dsm-root .dsm-meeting{color:var(--dsm-ink)}
.dsm-root .dsm-meeting:hover{background:#EDF2FA}
.dsm-root .dsm-meeting--active{background:var(--dsm-accent-soft);border-color:var(--dsm-accent-line)}
.dsm-root .dsm-meeting-title{color:var(--dsm-ink)}
.dsm-root .dsm-meeting-time{color:var(--dsm-ink-3)}
.dsm-root .dsm-meeting-status{border-color:var(--dsm-accent-line);color:var(--dsm-accent)}
.dsm-root .dsm-body{background:var(--dsm-canvas)}
.dsm-root .dsm-detail{background:var(--dsm-canvas)}
.dsm-root .dsm-detail-empty{color:var(--dsm-ink-3)}
.dsm-root .dsm-doc{padding:18px 20px 40px}
.dsm-root .dsm-cover{background:var(--dsm-surface);border:1px solid var(--dsm-line);border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,.05);padding:16px 18px}
.dsm-root .dsm-eyebrow{color:var(--dsm-ink-3)}
.dsm-root .dsm-cover-title{color:var(--dsm-ink)}
.dsm-root .dsm-meta-chip{background:#F7F9FC;border-color:var(--dsm-line);color:var(--dsm-ink-2)}
.dsm-root .dsm-meta-chip--brand{background:var(--dsm-accent-soft);border-color:var(--dsm-accent-line);color:var(--dsm-accent)}
.dsm-root .dsm-btn{background:var(--dsm-surface);border-color:var(--dsm-line);color:var(--dsm-ink-2)}
.dsm-root .dsm-btn:hover:not(:disabled){background:var(--dsm-accent-soft);border-color:var(--dsm-accent-line);color:var(--dsm-accent)}
.dsm-root .dsm-btn--primary{background:var(--dsm-accent);border-color:var(--dsm-accent);color:#FFFFFF}
.dsm-root .dsm-btn--primary:hover:not(:disabled){background:var(--dsm-accent-strong);border-color:var(--dsm-accent-strong);color:#FFFFFF}
.dsm-root .dsm-btn--danger{color:#DC2626;border-color:#F4C7C7;background:var(--dsm-surface)}
.dsm-root .dsm-btn--danger:hover:not(:disabled){background:#FEF2F2;border-color:#F0AFAF;color:#B91C1C}
.dsm-root .dsm-chip{background:var(--dsm-surface);border-color:var(--dsm-line);color:var(--dsm-ink-2)}
.dsm-root .dsm-chip--ok{color:#15803D;border-color:#BBE3C8;background:#F3FBF6}
.dsm-root .dsm-chip--warn{color:#B45309;border-color:#F4D3A6;background:#FFFAF0}
.dsm-root .dsm-cta{background:var(--dsm-surface);border:1px dashed var(--dsm-line);border-radius:14px}
.dsm-root .dsm-cta-title{color:var(--dsm-ink)}
.dsm-root .dsm-cta-text{color:var(--dsm-ink-3)}
.dsm-root .dsm-entry{background:var(--dsm-surface);border-color:var(--dsm-line)}
.dsm-root .dsm-entry:hover:not(:disabled){border-color:var(--dsm-accent-line);background:var(--dsm-accent-soft)}
.dsm-root .dsm-entry-title{color:var(--dsm-ink)}
.dsm-root .dsm-entry-text{color:var(--dsm-ink-3)}
.dsm-root .dsm-tabs{border-bottom-color:var(--dsm-line)}
.dsm-root .dsm-tab{color:var(--dsm-ink-3)}
.dsm-root .dsm-tab--active{background:var(--dsm-accent-soft);color:var(--dsm-accent);border-color:var(--dsm-accent-line)}
.dsm-root .dsm-record-mode{background:transparent;border-color:transparent;border-bottom-color:#E6ECF5}
.dsm-root .dsm-record-mode-icon{background:#DCE8FF;color:var(--dsm-accent)}
.dsm-root .dsm-record-mode-title{color:var(--dsm-ink)}
.dsm-root .dsm-hint{color:var(--dsm-ink-3)}
.dsm-root .dsm-doc-section{background:var(--dsm-surface);border:1px solid var(--dsm-line);border-radius:14px}
.dsm-root .dsm-section-title{color:var(--dsm-ink)}
.dsm-root .dsm-transcript{background:var(--dsm-surface);border-color:var(--dsm-line)}
.dsm-root .dsm-transcript-body{color:var(--dsm-ink-2)}
.dsm-root .dsm-modal{background:var(--dsm-surface);border-color:var(--dsm-line)}
.dsm-root .dsm-modal-title{color:var(--dsm-ink)}
.dsm-root .dsm-modal-sub{color:var(--dsm-ink-3)}
.dsm-root .dsm-todo-card{background:var(--dsm-surface);border-color:var(--dsm-line)}
.dsm-root .dsm-live-panel{background:var(--dsm-surface);border-color:var(--dsm-line)}
.dsm-root .dsm-level{background:#E9EEF6}
.dsm-root .dsm-level-bar{background:linear-gradient(90deg,#7FA8FF,#2F6BFF)}

`

    const STYLE_TAG_ID = 'dsh-plugin-meeting-minutes/client.css'

    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_TAG_ID)}]`) !== null) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-plugin-meeting-minutes'
      style.dataset.pluginCss = STYLE_TAG_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ─────────────────────────────── store ────────────────────────────────

    let snapshot = {
      status: 'loading',
      error: null,
      data: null,
      meetings: [],
      selectedId: null,
      meeting: null,
      meetingLoading: false,
      busy: false,
      exporting: null,
      summarizing: null,
      transcribing: null,
      speech: null,
      speechPhase: null,
      speechProgress: null,
      speechMessage: '',
      speechPreparing: false,
      live: initialLiveState(),
      orbActive: false,
      toasts: [],
    }
    const listeners = new Set()
    let toastSeq = 0
    /** Auto-imported meeting ids already announced; null until the first /state. */
    let autoIngestKnownIds = null

    function emit() {
      for (const listener of [...listeners]) listener()
    }

    function commit(patch) {
      snapshot = { ...snapshot, ...patch }
      emit()
    }

    function subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }

    function useSnapshot() {
      const [value, setValue] = useState(snapshot)
      useEffect(() => subscribe(() => setValue(snapshot)), [])
      return value
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function notify(level, title, body) {
      const id = ++toastSeq
      commit({ toasts: [...snapshot.toasts, { id, level, title, body }] })
      window.setTimeout(() => {
        commit({ toasts: snapshot.toasts.filter((toast) => toast.id !== id) })
      }, TOAST_TTL_MS)
    }

    function dismissToast(id) {
      commit({ toasts: snapshot.toasts.filter((toast) => toast.id !== id) })
    }

    function reportError(error, title = '操作失败') {
      const message = messageOf(error)
      commit({ error: message })
      notify('error', title, message)
      return message
    }

    function notifySuccess(title, body) {
      notify('success', title, body)
    }

    // ─────────────────────────────── helpers ──────────────────────────────

    function pad2(value) {
      return String(value).padStart(2, '0')
    }

    function todayKey(date = new Date()) {
      return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    }

    function nowMinuteKey(date = new Date()) {
      return `${todayKey(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    function formatStamp(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      return `${todayKey(date)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    }

    /**
     * 列表时间按新旧分级展示：
     * 今天 → 14:02:36；昨天/前天 → 昨天 14:02:36 / 前天 14:02:36；
     * 本年 → 11-05 09:30:12；非本年 → 2025-06-12 09:30:12。
     */
    function relativeStamp(value) {
      if (!value) return ''
      const date = new Date(value)
      if (Number.isNaN(date.getTime())) return String(value)
      const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
      const now = new Date()
      const startOfDay = (input) => new Date(input.getFullYear(), input.getMonth(), input.getDate()).getTime()
      const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / 86400000)
      if (dayDiff === 0) return clock
      if (dayDiff === 1) return `昨天 ${clock}`
      if (dayDiff === 2) return `前天 ${clock}`
      const monthDay = `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
      if (date.getFullYear() === now.getFullYear()) return `${monthDay} ${clock}`
      return `${date.getFullYear()}-${monthDay} ${clock}`
    }

    function humanDate(key) {
      if (!key) return '未定日期'
      const text = String(key).slice(0, 10)
      const parts = text.split('-').map(Number)
      if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return text
      const date = new Date(parts[0], parts[1] - 1, parts[2])
      const weekdays = ['日', '一', '二', '三', '四', '五', '六']
      return `${parts[0]}-${pad2(parts[1])}-${pad2(parts[2])} 周${weekdays[date.getDay()]}`
    }

    function formatChars(count) {
      const value = Number(count)
      return `${Number.isFinite(value) && value > 0 ? Math.round(value).toLocaleString('zh-CN') : '0'} 字`
    }

    function formatDuration(seconds) {
      const value = Number(seconds)
      if (!Number.isFinite(value) || value <= 0) return ''
      const total = Math.round(value)
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const rest = total % 60
      if (hours > 0) return `${hours}:${pad2(minutes)}:${pad2(rest)}`
      return `${minutes}:${pad2(rest)}`
    }

    function formatTimer(seconds) {
      const total = Math.max(0, Math.round(Number(seconds) || 0))
      return `${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`
    }

    function formatBytes(bytes) {
      const value = Number(bytes)
      if (!Number.isFinite(value) || value <= 0) return '0 B'
      if (value < 1024) return `${Math.round(value)} B`
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
      if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`
      return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`
    }

    function splitAttendees(text) {
      return String(text ?? '')
        .split(/[,，、;；\s]+/)
        .map((name) => name.trim())
        .filter((name) => name !== '')
    }

    function safeFilename(name, extension) {
      const base = String(name ?? '').trim() || '会议纪要'
      return `${base.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 70)}.${extension}`
    }

    function defaultRecordingTitle(date = new Date()) {
      return `录音纪要 ${nowMinuteKey(date)}`
    }

    function defaultMeetingTitle(date = new Date()) {
      return `会议纪要 ${nowMinuteKey(date)}`
    }

    function defaultImportTitle(fileName) {
      const base = String(fileName ?? '').replace(/\.[^.]+$/, '').trim()
      return base !== '' ? base : `会议纪要 ${todayKey()}`
    }

    function isPushed(todo) {
      return Boolean(todo && (todo.calendarTaskId || todo.pushedAt))
    }

    function cleanImportedText(raw) {
      let text = String(raw ?? '').replace(/\r\n/g, '\n')
      if (/<\/?[a-z][\s\S]*>/i.test(text)) {
        text = text
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/&#39;/gi, "'")
      }
      return text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }

    /**
     * Pull plain text out of a Tencent-Meeting-style JSON export. The walker
     * looks for the fields those exports commonly carry (`minutes`, `content`,
     * `summary`, `transcript`, `sentences[].text`, …) and falls back to the
     * original string when nothing usable is found.
     */
    function extractTencentText(raw) {
      const text = String(raw ?? '').trim()
      if (text === '') return ''
      if (!text.startsWith('{') && !text.startsWith('[')) return cleanImportedText(text)
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return cleanImportedText(text)
      }
      const parts = []
      const seen = new Set()
      const push = (value) => {
        const piece = cleanImportedText(value)
        if (piece === '' || seen.has(piece)) return
        seen.add(piece)
        parts.push(piece)
      }
      const stringKeys = ['minutes', 'content', 'summary', 'transcript']
      const walk = (node, depth) => {
        if (node === null || node === undefined || depth > 5) return
        if (typeof node === 'string') return
        if (Array.isArray(node)) {
          for (const item of node) {
            if (typeof item === 'string') push(item)
            else walk(item, depth + 1)
          }
          return
        }
        if (typeof node !== 'object') return
        for (const key of stringKeys) {
          const value = node[key]
          if (typeof value === 'string') push(value)
          else if (value && typeof value === 'object') walk(value, depth + 1)
        }
        if (Array.isArray(node.sentences)) {
          for (const sentence of node.sentences) {
            if (typeof sentence === 'string') push(sentence)
            else if (sentence && typeof sentence === 'object' && typeof sentence.text === 'string') push(sentence.text)
          }
        }
        if (Array.isArray(node.paragraphs)) {
          for (const paragraph of node.paragraphs) {
            if (typeof paragraph === 'string') push(paragraph)
            else if (paragraph && typeof paragraph === 'object' && typeof paragraph.text === 'string') push(paragraph.text)
          }
        }
        for (const [key, value] of Object.entries(node)) {
          if (stringKeys.includes(key) || key === 'sentences' || key === 'paragraphs' || key === 'text') continue
          if (value && typeof value === 'object') walk(value, depth + 1)
        }
      }
      walk(parsed, 0)
      if (parts.length > 0) return parts.join('\n')
      const fallback = []
      const scan = (node, depth) => {
        if (depth > 6) return
        if (typeof node === 'string') {
          const piece = cleanImportedText(node)
          if (piece.length > 20) fallback.push(piece)
          return
        }
        if (Array.isArray(node)) {
          for (const item of node) scan(item, depth + 1)
          return
        }
        if (node && typeof node === 'object') {
          for (const value of Object.values(node)) scan(value, depth + 1)
        }
      }
      scan(parsed, 0)
      return fallback.length > 0 ? fallback.join('\n') : cleanImportedText(text)
    }

    function speechProvider(speech) {
      if (!speech || typeof speech !== 'object') return null
      const providers = Array.isArray(speech.providers) ? speech.providers : []
      const selectedId = speech.selection?.providerId
      return providers.find((provider) => provider.id === selectedId) ?? providers[0] ?? null
    }

    function speechUsable(speech) {
      if (!speech || typeof speech !== 'object') return false
      if (speech.available === false) return false
      return Array.isArray(speech.providers) && speech.providers.length > 0
    }

    function speechReady(speech) {
      const provider = speechProvider(speech)
      // The host's `speechToText` service treats `standby` as usable too: the
      // provider is registered and can transcribe without another prepare.
      return provider?.phase === 'ready' || provider?.phase === 'standby'
    }

    function speechPhaseLabel(phase) {
      return PHASE_LABELS[phase] ?? (phase ? String(phase) : '未知')
    }

    function sleep(ms) {
      return new Promise((resolve) => { window.setTimeout(resolve, ms) })
    }

    // ─────────────────────────────── API ──────────────────────────────────

    async function requestJson(path, options = {}) {
      const init = { method: options.method ?? 'GET', headers: {} }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetch(API + path, init)
      } catch {
        throw new Error('无法连接会议纪要服务，请重新加载页面')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) {
        if (response.status === 404) throw new Error('会议纪要服务未启动，请重新加载页面')
        throw new Error(`会议纪要接口无响应（HTTP ${response.status}）`)
      }
      if (payload.ok === false) {
        const error = new Error(typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : `会议纪要接口出错（HTTP ${response.status}）`)
        error.payload = payload
        throw error
      }
      if (!response.ok) {
        const error = new Error(typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : `会议纪要接口出错（HTTP ${response.status}）`)
        error.payload = payload
        throw error
      }
      // A successful call makes a stale error banner obsolete.
      if (snapshot.error !== null) commit({ error: null })
      return payload
    }

    async function loadMeeting(id, options = {}) {
      if (!id) {
        commit({ meeting: null, meetingLoading: false })
        return null
      }
      if (!options.silent) commit({ meetingLoading: true, selectedId: id })
      try {
        const payload = await requestJson(`/meetings/${encodeURIComponent(id)}`)
        if (snapshot.selectedId === id) commit({ meeting: payload.meeting ?? null, meetingLoading: false })
        return payload.meeting ?? null
      } catch (error) {
        if (snapshot.selectedId === id) commit({ meetingLoading: false })
        if (!options.quiet) reportError(error, '会议加载失败')
        return null
      }
    }

    /**
     * Announce auto-imported meetings that appeared since the previous state
     * load. The first load only seeds the set, so opening the panel never
     * replays old imports as toasts.
     */
    function detectNewAutoImports(meetings) {
      const auto = meetings.filter((item) => item.autoImported === true)
      const currentIds = new Set(auto.map((item) => item.id))
      if (autoIngestKnownIds === null) {
        autoIngestKnownIds = currentIds
        return []
      }
      const fresh = auto.filter((item) => !autoIngestKnownIds.has(item.id))
      autoIngestKnownIds = currentIds
      for (const meeting of fresh) {
        notify('success', `已自动导入：${meeting.title}（待整理）`, '可在左侧列表打开，生成 AI 纪要或写入DSH 待办')
      }
      return fresh
    }

    async function loadState(options = {}) {
      const withDetail = options.detail !== false
      const data = await requestJson('/state')
      const meetings = Array.isArray(data.meetings) ? data.meetings : []
      const previousId = snapshot.selectedId
      let selectedId = previousId
      if (!meetings.some((item) => item.id === selectedId)) {
        selectedId = meetings.length > 0 ? meetings[0].id : null
      }
      const patch = {
        status: 'ready',
        error: null,
        data,
        meetings,
        speech: data.speech ?? snapshot.speech,
      }
      if (selectedId !== previousId) {
        patch.selectedId = selectedId
        patch.meeting = null
      }
      commit(patch)
      const fresh = detectNewAutoImports(meetings)
      if (!withDetail && snapshot.selectedId !== null
        && fresh.some((item) => item.id === snapshot.selectedId)) {
        await loadMeeting(snapshot.selectedId, { silent: true, quiet: true })
      }
      if (withDetail) await loadMeeting(selectedId, { silent: true, quiet: !options.quietDetail })
      return data
    }

    async function refreshAll() {
      if (snapshot.data === null) commit({ status: 'loading' })
      try {
        await loadState({ detail: true, quietDetail: true })
      } catch (error) {
        const message = messageOf(error)
        commit({ status: snapshot.data === null ? 'error' : 'ready', error: message })
      }
    }

    async function refreshList() {
      try {
        await loadState({ detail: false })
      } catch (error) {
        commit({ error: messageOf(error) })
      }
    }

    async function selectMeeting(id) {
      if (!id) {
        commit({ selectedId: null, meeting: null })
        return
      }
      if (id === snapshot.selectedId && snapshot.meeting !== null) return
      commit({ selectedId: id, meeting: null })
      await loadMeeting(id)
    }

    async function reloadMeetingQuietly(id) {
      if (!id) return
      await loadMeeting(id, { silent: true, quiet: true })
    }

    async function createMeeting(input) {
      const payload = await requestJson('/meetings', { method: 'POST', body: input })
      const meeting = payload.meeting
      commit({ meeting, selectedId: meeting.id })
      await refreshList()
      await reloadMeetingQuietly(meeting.id)
      return meeting
    }

    async function patchMeeting(id, patch) {
      const payload = await requestJson(`/meetings/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch })
      if (payload.meeting) commit({ meeting: payload.meeting, selectedId: id })
      await refreshList()
      await reloadMeetingQuietly(id)
      return payload.meeting
    }

    async function deleteMeetingById(id) {
      await requestJson(`/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' })
      if (snapshot.selectedId === id) commit({ selectedId: null, meeting: null })
      await loadState({ detail: true })
    }

    async function discardMeetingQuietly(id) {
      try {
        await requestJson(`/meetings/${encodeURIComponent(id)}`, { method: 'DELETE' })
      } catch {
        // Best effort: the meeting may already be gone.
      }
      if (snapshot.selectedId === id) commit({ selectedId: null, meeting: null })
      try {
        await loadState({ detail: true })
      } catch {
        // Ignore: the panel already reports its own connection state.
      }
    }

    async function summarizeMeetingById(id, force) {
      const payload = await requestJson(`/meetings/${encodeURIComponent(id)}/summarize`, {
        method: 'POST',
        body: { force: Boolean(force) },
      })
      if (payload.meeting) commit({ meeting: payload.meeting, selectedId: id })
      await refreshList()
      await reloadMeetingQuietly(id)
      return payload
    }

    async function updateMeetingTodo(meetingId, todoId, patch) {
      const payload = await requestJson(
        `/meetings/${encodeURIComponent(meetingId)}/todos/${encodeURIComponent(todoId)}`,
        { method: 'PATCH', body: patch },
      )
      if (payload.meeting) commit({ meeting: payload.meeting, selectedId: meetingId })
      await refreshList()
      return payload.meeting
    }

    async function pushMeetingTodos(meetingId, todoIds) {
      const body = Array.isArray(todoIds) && todoIds.length > 0 ? { todoIds } : {}
      try {
        const payload = await requestJson(`/meetings/${encodeURIComponent(meetingId)}/todos/push`, {
          method: 'POST',
          body,
        })
        if (payload.meeting) commit({ meeting: payload.meeting, selectedId: meetingId })
        await refreshList()
        await reloadMeetingQuietly(meetingId)
        return payload
      } catch (error) {
        // A partial calendar failure comes back as 400 with the already-created
        // entries and the refreshed meeting; keep the UI truthful about both.
        const partial = error && typeof error === 'object' ? error.payload : null
        if (partial && partial.meeting) {
          commit({ meeting: partial.meeting, selectedId: meetingId })
          try { await refreshList() } catch { /* the error is reported by the caller */ }
          const created = Array.isArray(partial.created) ? partial.created : []
          if (created.length > 0 && error instanceof Error) {
            error.message = `${error.message}（已成功写入 ${created.length} 条）`
          }
        }
        throw error
      }
    }

    async function exportMeetingFile(meeting, format) {
      const safeFormat = format === 'md' ? 'md' : format === 'docx' ? 'docx' : 'html'
      const payload = await requestJson(
        `/meetings/${encodeURIComponent(meeting.id)}/export?format=${safeFormat}`,
      )
      const filename = typeof payload.filename === 'string' && payload.filename !== ''
        ? payload.filename
        : safeFilename(meeting.title, safeFormat)
      if (safeFormat === 'docx') {
        downloadBinaryFile(
          filename,
          String(payload.base64 ?? ''),
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        )
      } else {
        const mime = safeFormat === 'md' ? 'text/markdown;charset=utf-8' : 'text/html;charset=utf-8'
        downloadTextFile(filename, String(payload.content ?? ''), mime)
      }
      return { ...payload, filename }
    }

    /** 下载二进制文件（base64 → Blob）。 */
    function downloadBinaryFile(filename, base64, mime) {
      const binary = atob(base64)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      const blob = new Blob([bytes], { type: mime })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      window.setTimeout(() => {
        URL.revokeObjectURL(url)
        anchor.remove()
      }, 2000)
    }

    function downloadTextFile(filename, content, mime) {
      const blob = new Blob([content], { type: mime })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.style.display = 'none'
      document.body.appendChild(anchor)
      anchor.click()
      window.setTimeout(() => {
        URL.revokeObjectURL(url)
        anchor.remove()
      }, 2000)
    }

    async function copyText(text) {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text)
        return
      }
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }

    // ─────────────────────────── auto ingest ──────────────────────────────

    function applyAutoIngestStatus(status) {
      if (!status || typeof status !== 'object' || snapshot.data === null) return
      commit({ data: { ...snapshot.data, autoIngest: status } })
    }

    function parseAutoIngestDirs(text) {
      const seen = new Set()
      const dirs = []
      for (const line of String(text ?? '').split(/\r?\n/)) {
        const dir = line.trim()
        if (dir === '' || seen.has(dir)) continue
        seen.add(dir)
        dirs.push(dir)
        if (dirs.length >= 20) break
      }
      return dirs
    }

    function autoIngestSummaryLabel(status) {
      if (!status || typeof status !== 'object') return '自动入库'
      if (status.scanning === true) return '自动入库 · 扫描中'
      return status.enabled === false ? '自动入库 · 关' : '自动入库 · 开'
    }

    async function saveAutoIngestSettings(patch) {
      const payload = await requestJson('/auto-ingest', { method: 'POST', body: patch })
      const status = payload.autoIngest ?? null
      applyAutoIngestStatus(status)
      return status
    }

    async function triggerAutoIngestScanNow() {
      const payload = await requestJson('/auto-ingest/scan', { method: 'POST' })
      const status = payload.autoIngest ?? null
      applyAutoIngestStatus(status)
      return status
    }

    /**
     * Trigger a scan and poll `/state` every two seconds until `scanning` turns
     * false (60 s ceiling). Both the scan response and every poll update the
     * shared `/state` projection, so the list and the settings dialog stay live.
     */
    async function scanAutoIngestAndWait() {
      let status = await triggerAutoIngestScanNow()
      if (status === null) throw new Error('自动入库不可用')
      if (status.scanning !== true) return status
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        await sleep(2000)
        const data = await loadState({ detail: false })
        status = data.autoIngest ?? status
        if (status?.scanning !== true) {
          await reloadMeetingQuietly(snapshot.selectedId)
          return status
        }
      }
      throw new Error('扫描超时（超过 60 秒），请稍后查看自动入库状态')
    }

    // ─────────────────────────── speech service ───────────────────────────

    function applySpeechStatus(speech) {
      if (!speech || typeof speech !== 'object') return
      const provider = speechProvider(speech)
      const progress = provider?.progress
      const total = Number(progress?.totalBytes) || 0
      const done = Number(progress?.completedBytes) || 0
      commit({
        speech,
        data: snapshot.data === null ? snapshot.data : { ...snapshot.data, speech },
        speechPhase: provider?.phase ?? 'unprepared',
        speechProgress: total > 0
          ? {
            done,
            total,
            ratio: Math.max(0, Math.min(1, done / total)),
            resource: typeof progress?.resource === 'string' ? progress.resource : '',
          }
          : null,
        speechMessage: typeof provider?.message === 'string' ? provider.message : '',
      })
    }

    /**
     * Ensure the local ASR model is loaded. Triggers `POST /speech/prepare`
     * when needed and polls `GET /speech/status` every 1.2 s while exposing
     * download/load progress to the store. Throws a Chinese error on failure.
     */
    async function waitForSpeechReady() {
      let speech = snapshot.speech ?? snapshot.data?.speech ?? null
      // The contract asks for a fresh status read before every transcription;
      // fall back to the cached projection if the status route is unavailable.
      try {
        const status = await requestJson('/speech/status')
        if (status.speech) {
          speech = status.speech
          applySpeechStatus(status.speech)
        }
      } catch {
        // Keep using the cached `/state` projection.
      }
      if (speechReady(speech)) return speech
      if (!speechUsable(speech)) {
        throw new Error('本机语音识别服务不可用，请改用「导入纪要」的文本方式')
      }
      const providerId = speechProvider(speech)?.id
      commit({ speechPreparing: true, speechMessage: '正在启动语音识别服务…' })
      try {
        const body = typeof providerId === 'string' && providerId !== '' ? { providerId } : {}
        try {
          const payload = await requestJson('/speech/prepare', { method: 'POST', body })
          if (payload.speech) applySpeechStatus(payload.speech)
        } catch (error) {
          throw new Error(`语音识别服务启动失败：${messageOf(error)}`)
        }
        const deadline = Date.now() + SPEECH_TIMEOUT_MS
        let current = snapshot.speech
        let polls = 0
        while (Date.now() < deadline) {
          if (speechReady(current)) return current
          const provider = speechProvider(current)
          const phase = provider?.phase
          // The prepare response can still carry the previous failed phase; give
          // the service one polling interval to publish its new state.
          if (polls > 0 && phase === 'failed') {
            throw new Error(provider?.message || '语音识别模型加载失败，请改用文本导入')
          }
          if (polls > 0 && phase === 'cancelled') throw new Error('语音识别模型加载已取消，请重试')
          await sleep(SPEECH_POLL_MS)
          const payload = await requestJson('/speech/status')
          polls += 1
          if (payload.speech) {
            current = payload.speech
            applySpeechStatus(payload.speech)
          }
        }
        throw new Error('语音识别服务启动超时，请稍后重试，或改用文本导入')
      } finally {
        commit({ speechPreparing: false, speechMessage: '' })
      }
    }

    async function prepareSpeechManually() {
      try {
        await waitForSpeechReady()
        notifySuccess('语音识别已就绪', '现在可以录音，或导入音频文件转写')
      } catch (error) {
        reportError(error, '语音识别启动失败')
      }
    }

    // ──────────────────────────── audio pipeline ──────────────────────────

    function stopStream(stream) {
      if (!stream || typeof stream.getTracks !== 'function') return
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          // Ignore: stopping an already-ended track is harmless.
        }
      }
    }

    function explainMediaError(error) {
      const name = error && typeof error === 'object' ? error.name : ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        return '麦克风权限被拒绝，请在浏览器设置中允许访问麦克风后重试'
      }
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        return '未找到可用的麦克风设备，请检查设备连接'
      }
      if (name === 'NotReadableError') {
        return '麦克风被其他应用占用，请关闭占用程序后重试'
      }
      return `无法开始录音：${messageOf(error)}`
    }

    function decodeAudioBlob(blob) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (!AudioCtor) {
        return Promise.reject(new Error('当前浏览器不支持音频解码，请改用「导入纪要」的文本方式'))
      }
      const context = new AudioCtor()
      return blob.arrayBuffer().then((bytes) => new Promise((resolve, reject) => {
        let settled = false
        const accept = (buffer) => {
          if (settled) return
          settled = true
          resolve(buffer)
        }
        const fail = () => {
          if (settled) return
          settled = true
          reject(new Error('音频解码失败，请换成 WAV / MP3 / M4A 格式后重试'))
        }
        try {
          const maybe = context.decodeAudioData(bytes, accept, fail)
          if (maybe && typeof maybe.then === 'function') maybe.then(accept, fail)
        } catch {
          fail()
        }
      })).finally(() => {
        try {
          const closing = context.close()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch {
          // Ignore close failures.
        }
      })
    }

    function downmixToMono(buffer) {
      const channels = Math.max(1, buffer.numberOfChannels)
      const length = buffer.length
      const mono = new Float32Array(length)
      for (let channel = 0; channel < channels; channel += 1) {
        const data = buffer.getChannelData(channel)
        for (let index = 0; index < length; index += 1) mono[index] += data[index]
      }
      if (channels > 1) {
        for (let index = 0; index < length; index += 1) mono[index] /= channels
      }
      return mono
    }

    function resampleLinear(input, sourceRate, targetRate) {
      if (!Number.isFinite(sourceRate) || sourceRate <= 0) return input
      if (sourceRate === targetRate) return input
      const ratio = targetRate / sourceRate
      const length = Math.max(1, Math.round(input.length * ratio))
      const output = new Float32Array(length)
      for (let index = 0; index < length; index += 1) {
        const position = index / ratio
        const left = Math.floor(position)
        const right = Math.min(left + 1, input.length - 1)
        const fraction = position - left
        output[index] = input[left] * (1 - fraction) + input[right] * fraction
      }
      return output
    }

    async function resampleTo16k(buffer) {
      const duration = Number(buffer.duration) || 0
      if (duration > AUDIO_MAX_SECONDS) {
        throw new Error('音频超过 60 分钟，请分段后再导入')
      }
      if (typeof OfflineAudioContext !== 'undefined') {
        try {
          const mono = downmixToMono(buffer)
          const frames = Math.max(1, Math.ceil(duration * TARGET_RATE))
          const offline = new OfflineAudioContext(1, frames, TARGET_RATE)
          const sourceBuffer = offline.createBuffer(1, mono.length, buffer.sampleRate)
          sourceBuffer.copyToChannel(mono, 0)
          const source = offline.createBufferSource()
          source.buffer = sourceBuffer
          source.connect(offline.destination)
          source.start(0)
          const rendered = await offline.startRendering()
          return rendered.getChannelData(0)
        } catch {
          // Fall back to the manual resampler below.
        }
      }
      return resampleLinear(downmixToMono(buffer), buffer.sampleRate, TARGET_RATE)
    }

    function writeAscii(view, offset, text) {
      for (let index = 0; index < text.length; index += 1) {
        view.setUint8(offset + index, text.charCodeAt(index))
      }
    }

    function encodePcm16Wav(samples, sampleRate = TARGET_RATE) {
      const frames = samples.length
      const buffer = new ArrayBuffer(44 + frames * 2)
      const view = new DataView(buffer)
      writeAscii(view, 0, 'RIFF')
      view.setUint32(4, 36 + frames * 2, true)
      writeAscii(view, 8, 'WAVE')
      writeAscii(view, 12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(view, 36, 'data')
      view.setUint32(40, frames * 2, true)
      let offset = 44
      for (let index = 0; index < frames; index += 1) {
        const sample = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
        offset += 2
      }
      return new Blob([buffer], { type: 'audio/wav' })
    }

    /** Decode any browser-supported audio blob into ≤90 s 16 kHz mono WAV slices. */
    async function audioBlobToWavChunks(blob) {
      const decoded = await decodeAudioBlob(blob)
      if (!decoded || decoded.length === 0) throw new Error('音频为空，无法转写')
      if (decoded.duration < 0.3) throw new Error('音频太短，无法识别')
      const samples = await resampleTo16k(decoded)
      const samplesPerSlice = TARGET_RATE * SLICE_SECONDS
      const chunks = []
      for (let start = 0; start < samples.length; start += samplesPerSlice) {
        const end = Math.min(samples.length, start + samplesPerSlice)
        const piece = samples.subarray(start, end)
        if (piece.length < TARGET_RATE * 0.2) continue
        chunks.push(encodePcm16Wav(piece))
      }
      if (chunks.length === 0) throw new Error('没有可转写的音频片段')
      return chunks
    }

    async function postTranscription(meetingId, wavBlob) {
      let response
      try {
        response = await fetch(
          `${API}/meetings/${encodeURIComponent(meetingId)}/transcribe?language=zh`,
          {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: wavBlob,
          },
        )
      } catch {
        throw new Error('无法连接会议纪要服务，请重新加载页面')
      }
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (payload === null) {
        if (response.status === 404) throw new Error('会议纪要服务未启动，请重新加载页面')
        throw new Error(`语音识别接口无响应（HTTP ${response.status}）`)
      }
      if (payload.ok === false) {
        throw new Error(typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : `语音识别失败（HTTP ${response.status}）`)
      }
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' && payload.error !== ''
          ? payload.error
          : `语音识别失败（HTTP ${response.status}）`)
      }
      return payload
    }

    /** Transcribe the slices sequentially and publish per-slice progress. */
    async function transcribeAudioChunks(meetingId, chunks) {
      const total = chunks.length
      const startedAt = Date.now()
      let text = ''
      let audioSeconds = 0
      const publish = (index) => {
        commit({
          transcribing: {
            meetingId,
            index,
            total,
            chars: text.length,
            startedAt,
          },
        })
      }
      publish(0)
      try {
        for (let index = 0; index < total; index += 1) {
          publish(index)
          const payload = await postTranscription(meetingId, chunks[index])
          const piece = String(payload.text ?? '').trim()
          if (piece !== '') text = text === '' ? piece : `${text}\n${piece}`
          audioSeconds += Number(payload.audioSeconds) || 0
          publish(index + 1)
        }
        return { text, audioSeconds, total }
      } finally {
        commit({ transcribing: null })
      }
    }

    // ─────────────────────────── live recorder ────────────────────────────
    //
    // Everything below is module-scoped on purpose: closing RecordModal,
    // switching the main panel, or unmounting React must not stop an active
    // meeting recording. Components only read `snapshot.live`.

    /** Browser plugin context, kept so the floating bar can select our panel. */
    let clientContext = null

    function initialLiveState() {
      return {
        status: 'idle',
        meetingId: null,
        meetingTitle: '',
        startedAt: 0,
        elapsedSeconds: 0,
        level: 0,
        chars: 0,
        lastText: '',
        transcript: '',
        error: null,
        inFlight: 0,
        queued: 0,
        sentChunks: 0,
        result: null,
      }
    }

    function liveIsActive(live = snapshot.live) {
      return live !== null && live !== undefined
        && (live.status === 'preparing' || live.status === 'recording'
          || live.status === 'paused' || live.status === 'stopping')
    }

    /**
     * Streaming linear resampler. The fractional read position AND the unconsumed
     * source tail survive `push()` calls, so concatenated blocks stay continuous
     * instead of each block being resampled independently.
     */
    class StreamingResampler {
      constructor(sourceRate, targetRate = TARGET_RATE) {
        this.sourceRate = sourceRate
        this.targetRate = targetRate
        this.ratio = sourceRate / targetRate
        this.buffer = new Float32Array(0)
        this.position = 0
      }

      push(input) {
        if (!input || input.length === 0) return new Float32Array(0)
        const combined = new Float32Array(this.buffer.length + input.length)
        combined.set(this.buffer, 0)
        combined.set(input, this.buffer.length)
        this.buffer = combined
        if (this.ratio === 1) {
          const passthrough = this.buffer
          this.buffer = new Float32Array(0)
          this.position = 0
          return passthrough
        }
        const available = this.buffer.length
        const output = new Float32Array(Math.max(0, Math.ceil((available - this.position) / this.ratio)))
        let write = 0
        while (this.position + 1 < available) {
          const index = Math.floor(this.position)
          const fraction = this.position - index
          output[write] = this.buffer[index] * (1 - fraction) + this.buffer[index + 1] * fraction
          write += 1
          this.position += this.ratio
        }
        const result = output.subarray(0, write)
        const consumed = Math.floor(this.position)
        if (consumed > 0) {
          // The read position may run slightly past the buffered tail; only drop
          // samples that actually exist and move the fractional position by the
          // same amount, otherwise the phase would reset at block boundaries.
          const drop = Math.min(consumed, this.buffer.length)
          this.buffer = this.buffer.slice(drop)
          this.position -= drop
        }
        return new Float32Array(result)
      }
    }

    function concatFloat32(parts) {
      let total = 0
      for (const part of parts) total += part.length
      const merged = new Float32Array(total)
      let offset = 0
      for (const part of parts) {
        merged.set(part, offset)
        offset += part.length
      }
      return merged
    }

    /**
     * 估算一段音频的「音色特征」（基频中位数 + 能量）。
     * 只用于把不同说话人粗略分成 A/B/C/D 四组，不参与语音识别本身。
     * @param samples - 16kHz Float32 音频。
     * @returns `{ pitch, energy }`，静音段返回 null。
     */
    function extractVoiceFeature(samples) {
      const rate = TARGET_RATE
      const frameSize = Math.round(rate * 0.04)
      const hop = Math.round(rate * 0.02)
      if (samples.length < frameSize * 2) return null
      const frames = []
      let totalEnergy = 0
      let frameCount = 0
      for (let offset = 0; offset + frameSize <= samples.length; offset += hop) {
        let energy = 0
        for (let index = 0; index < frameSize; index += 1) {
          const value = samples[offset + index]
          energy += value * value
        }
        energy /= frameSize
        totalEnergy += energy
        frameCount += 1
        if (energy > 1e-4) frames.push({ offset, energy })
      }
      if (frameCount === 0 || frames.length === 0) return null
      const medianEnergy = totalEnergy / frameCount
      // 取能量最高的若干帧估计基频，避免噪声段干扰
      frames.sort((left, right) => right.energy - left.energy)
      const picked = frames.slice(0, 12)
      const minLag = Math.floor(rate / 400)
      const maxLag = Math.floor(rate / 80)
      const pitches = []
      for (const frame of picked) {
        let bestLag = 0
        let bestScore = 0
        for (let lag = minLag; lag <= maxLag && lag < frameSize - 8; lag += 1) {
          let score = 0
          for (let index = 0; index < frameSize - lag; index += 1) {
            score += samples[frame.offset + index] * samples[frame.offset + index + lag]
          }
          if (score > bestScore) {
            bestScore = score
            bestLag = lag
          }
        }
        if (bestLag > 0) pitches.push(rate / bestLag)
      }
      if (pitches.length === 0) return null
      pitches.sort((left, right) => left - right)
      return {
        pitch: pitches[Math.floor(pitches.length / 2)],
        energy: medianEnergy,
      }
    }

    /**
     * 在线聚类：按基频（对数尺度）把每段音频归到 A/B/C/D 某个说话人。
     * 超过 4 人时归到最接近的一组；静音段返回 -1。
     */
    function assignLiveSpeaker(feature) {
      if (feature === null) return -1
      const centroids = liveEngine.speakerCentroids
      const logPitch = Math.log2(feature.pitch)
      let best = -1
      let bestDistance = Infinity
      for (let index = 0; index < centroids.length; index += 1) {
        const distance = Math.abs(logPitch - Math.log2(centroids[index].pitch))
        if (distance < bestDistance) {
          bestDistance = distance
          best = index
        }
      }
      // 约 1 个半音以内视为同一人
      const threshold = 0.09
      if (best >= 0 && bestDistance <= threshold) {
        centroids[best].pitch = centroids[best].pitch * 0.7 + feature.pitch * 0.3
        centroids[best].energy = centroids[best].energy * 0.7 + feature.energy * 0.3
        return best
      }
      if (centroids.length >= 4) {
        if (best >= 0) {
          centroids[best].pitch = centroids[best].pitch * 0.8 + feature.pitch * 0.2
          return best
        }
        return 0
      }
      centroids.push({ pitch: feature.pitch, energy: feature.energy })
      return centroids.length - 1
    }


    const liveEngine = {
      stream: null,
      context: null,
      source: null,
      processor: null,
      sink: null,
      resampler: null,
      accumulator: [],
      accumulatedFrames: 0,
      queue: [],
      inFlight: 0,
      pumping: false,
      timer: 0,
      heartbeat: null,
      chunkFailures: 0,
      level: 0,
      sentChunks: 0,
      startToken: 0,
      sessionId: 0,
      failureMessage: null,
      lastAudioAt: 0,
      captureLost: false,
      emptyChunks: 0,
      orbWarned: false,
      pcmParts: [],
      screenStream: null,
      videoRecorder: null,
      videoChunks: [],
      videoMime: '',
      pendingDisplay: null,
      speakerCentroids: [],
      segments: [],
      screenActive: false,
      waiters: [],
      beforeUnload: null,
    }

    // Background tabs may auto-suspend audio; resume as soon as the user comes
    // back. Flushing itself never depends on this timer.
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        const context = liveEngine.context
        if (!document.hidden && context && context.state === 'suspended') {
          try {
            const resumed = context.resume()
            if (resumed && typeof resumed.catch === 'function') resumed.catch(() => {})
          } catch {
            // Best effort.
          }
        }
      })
    }

    function publishLive(patch) {
      commit({ live: { ...snapshot.live, ...patch } })
    }

    function resetLiveState(extra = {}) {
      commit({ live: { ...initialLiveState(), ...extra } })
    }

    function publishLiveQueue() {
      publishLive({
        inFlight: liveEngine.inFlight,
        queued: liveEngine.queue.length,
        sentChunks: liveEngine.sentChunks,
      })
    }

    function updateLiveBeforeUnload() {
      const active = liveIsActive()
      if (active && liveEngine.beforeUnload === null) {
        liveEngine.beforeUnload = (event) => {
          event.preventDefault()
          event.returnValue = '录音正在进行，离开页面会中断录音。'
          return event.returnValue
        }
        window.addEventListener('beforeunload', liveEngine.beforeUnload)
      } else if (!active && liveEngine.beforeUnload !== null) {
        window.removeEventListener('beforeunload', liveEngine.beforeUnload)
        liveEngine.beforeUnload = null
      }
    }

    /** 录音期间每秒向宿主上报一次状态，并取回浮窗下发的指令。 */
    function startLiveHeartbeat() {
      stopLiveHeartbeat()
      liveEngine.heartbeat = window.setInterval(() => { void pushLiveHeartbeat() }, 1000)
    }

    function stopLiveHeartbeat() {
      if (liveEngine.heartbeat !== null) {
        window.clearInterval(liveEngine.heartbeat)
        liveEngine.heartbeat = null
      }
    }

    async function pushLiveHeartbeat() {
      const live = snapshot.live
      if (!liveIsActive(live)) {
        stopLiveHeartbeat()
        return
      }
      try {
        const payload = await requestJson('/live/status', {
          method: 'POST',
          body: {
            status: live.status,
            meetingId: live.meetingId,
            title: live.meetingTitle,
            elapsedSeconds: live.elapsedSeconds,
            chars: live.chars,
            lastText: live.lastText,
            level: Number.isFinite(live.level) ? live.level : 0,
            startedAt: live.startedAt,
          },
        })
        if (payload?.orb === true || payload?.orb === false) commit({ orbActive: payload.orb === true })
        if (payload?.orb === false && live.status === 'recording' && liveEngine.orbWarned !== true
          && Number(live.elapsedSeconds) >= 5) {
          liveEngine.orbWarned = true
          notify('warn', '桌面浮窗未启动', '可在左侧「实时录音」里暂停或停止；重启桌面端可恢复浮窗')
        }
        const command = payload?.command ?? null
        if (command === 'pause') await pauseLiveRecording()
        else if (command === 'resume') await resumeLiveRecording()
        else if (command === 'stop') await stopLiveRecording('user', { fromOrb: true })
      } catch {
        // 宿主可能在重启：下一次心跳重试即可。
      }
    }

    /** 会话结束时补发一次终态心跳：宿主的浮窗据此立即收起。 */
    async function reportLiveSessionEnd(finalStatus) {
      const live = snapshot.live
      try {
        await requestJson('/live/status', {
          method: 'POST',
          body: {
            status: finalStatus,
            meetingId: live.meetingId,
            title: live.meetingTitle,
            elapsedSeconds: live.elapsedSeconds,
            chars: live.chars,
            lastText: live.lastText,
          },
        })
      } catch {
        // 宿主可能已重启：浮窗侧还有「20 秒无心跳自动收起」的兜底。
      }
    }

    /** 暂停：先冲洗未发出的片段，再放开采集，计时冻结。 */
    async function pauseLiveRecording() {
      if (snapshot.live.status !== 'recording') return false
      flushLiveSamples(true)
      stopLiveCapture()
      await waitForLiveIdle(8000)
      const elapsedSeconds = snapshot.live.elapsedSeconds
      publishLive({ status: 'paused', level: 0, elapsedSeconds })
      publishLiveQueue()
      notify('info', '已暂停录音', '点浮窗或页面上的「继续」接着录，同一场会议')
      return true
    }

    /** 继续：重新打开采集，计时从暂停点接着走。 */
    async function resumeLiveRecording() {
      if (snapshot.live.status !== 'paused') return false
      try {
        const capture = await openLiveCapture()
        liveEngine.stream = capture.stream
        liveEngine.context = capture.context
        liveEngine.source = capture.source
        liveEngine.processor = capture.processor
        liveEngine.sink = capture.sink
        liveEngine.resampler = capture.resampler
        capture.processor.onaudioprocess = onLiveAudioProcess
        watchLiveCapture(capture)
        const elapsed = snapshot.live.elapsedSeconds
        publishLive({
          status: 'recording',
          startedAt: Date.now() - elapsed * 1000,
          level: 0,
          error: null,
        })
        startLiveTimer()
        return true
      } catch (error) {
        publishLive({ status: 'error', error: messageOf(error) })
        reportError(error, '继续录音失败')
        return false
      }
    }

    /** 浮窗里点「停止」后：切回会议纪要面板并选中这场会议。 */
    function returnToMeetingPanel() {
      const meetingId = snapshot.live.result?.meetingId ?? snapshot.live.meetingId
      openMeetingPanel()
      if (meetingId) {
        commit({ selectedId: meetingId, meetingLoading: true })
        void loadMeeting(meetingId, { quiet: true })
      }
      void refreshList()
    }

    function startLiveTimer() {
      stopLiveTimer()
      liveEngine.timer = window.setInterval(() => {
        const status = snapshot.live.status
        if (status !== 'recording' && status !== 'stopping') return
        const startedAt = snapshot.live.startedAt
        const elapsed = startedAt > 0 ? Math.floor((Date.now() - startedAt) / 1000) : 0
        publishLive({ elapsedSeconds: elapsed, level: liveEngine.level })
      }, 500)
    }

    function stopLiveTimer() {
      if (liveEngine.timer) {
        window.clearInterval(liveEngine.timer)
        liveEngine.timer = 0
      }
    }

    function resolveLiveIdle() {
      if (liveEngine.pumping) return
      if (liveEngine.inFlight !== 0 || liveEngine.queue.length !== 0) return
      const waiters = liveEngine.waiters.splice(0)
      for (const resolve of waiters) resolve(true)
    }

    function waitForLiveIdle(timeoutMs = LIVE_IDLE_TIMEOUT_MS) {
      if (liveEngine.inFlight === 0 && liveEngine.queue.length === 0) return Promise.resolve(true)
      return new Promise((resolve) => {
        let settled = false
        let timer = 0
        const finish = (value) => {
          if (settled) return
          settled = true
          if (timer) window.clearTimeout(timer)
          const index = liveEngine.waiters.indexOf(finish)
          if (index !== -1) liveEngine.waiters.splice(index, 1)
          resolve(value)
        }
        timer = window.setTimeout(() => finish(false), timeoutMs)
        liveEngine.waiters.push(finish)
      })
    }

    /** Jump back to our main panel from the floating recording bar. */
    function openMeetingPanel() {
      try {
        clientContext?.layout?.selectPanel?.('meeting-minutes')
      } catch {
        // Navigation is best effort; the bar itself stays useful.
      }
    }

    async function openLiveCapture() {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices
        || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw new Error('当前浏览器不支持实时录音，请改用音频文件导入或文本导入')
      }
      let stream = null
      const preferredDeviceId = selectedInputDeviceId
      const baseAudio = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      }
      const openStream = async (useSelected) => {
        const audio = useSelected && preferredDeviceId !== ''
          ? { ...baseAudio, deviceId: { exact: preferredDeviceId } }
          : baseAudio
        return navigator.mediaDevices.getUserMedia({ audio })
      }
      try {
        stream = await openStream(true)
      } catch (error) {
        // 选中的设备可能已拔出 / 被占用：回退系统默认设备并告知用户。
        const fallbackNames = ['OverconstrainedError', 'NotFoundError', 'NotReadableError', 'TypeError']
        if (preferredDeviceId !== '' && error && fallbackNames.includes(error.name)) {
          selectedInputDeviceId = ''
          writePreferredInputDevice('')
          notify('warn', '所选麦克风不可用', '已回退到系统默认输入设备')
        }
        try {
          stream = await openStream(false)
        } catch (inner) {
          if (inner && (inner.name === 'OverconstrainedError' || inner.name === 'TypeError')) {
            try {
              stream = await navigator.mediaDevices.getUserMedia({ audio: true })
            } catch (last) {
              throw new Error(explainMediaError(last))
            }
          } else {
            throw new Error(explainMediaError(inner))
          }
        }
      }
      const AudioCtor = window.AudioContext || window.webkitAudioContext
      if (typeof AudioCtor !== 'function') {
        stopStream(stream)
        throw new Error('当前浏览器不支持实时录音，请改用音频文件导入')
      }
      let context = null
      try {
        try {
          context = new AudioCtor({ sampleRate: TARGET_RATE })
        } catch {
          context = new AudioCtor()
        }
      } catch (error) {
        stopStream(stream)
        throw new Error(`无法启动实时录音：${messageOf(error)}`)
      }
      if (context.state === 'suspended') {
        try { await context.resume() } catch { /* user gesture usually allows it */ }
      }
      if (typeof context.createScriptProcessor !== 'function') {
        stopStream(stream)
        try { context.close() } catch { /* ignore */ }
        throw new Error('当前浏览器不支持实时音频处理，请改用音频文件导入')
      }
      let source = null
      let processor = null
      try {
        source = context.createMediaStreamSource(stream)
        processor = context.createScriptProcessor(4096, 1, 1)
      } catch (error) {
        stopStream(stream)
        try { context.close() } catch { /* ignore */ }
        throw new Error(`无法启动实时音频处理：${messageOf(error)}`)
      }
      const sink = context.createGain()
      sink.gain.value = 0
      const resampler = context.sampleRate === TARGET_RATE
        ? null
        : new StreamingResampler(context.sampleRate, TARGET_RATE)
      source.connect(processor)
      processor.connect(sink)
      sink.connect(context.destination)
      if (context.state !== 'running') {
        try { await context.resume() } catch { /* ignore */ }
      }
      if (context.state !== 'running') {
        stopStream(stream)
        try { context.close() } catch { /* ignore */ }
        throw new Error('浏览器阻止了实时音频采集，请点击页面后重试')
      }
      // Return resources instead of publishing them: a cancelled start must be
      // able to release its own nodes without touching a newer session.
      return { stream, context, source, processor, sink, resampler }
    }

    /** Release one capture set that may not have been adopted by the engine. */
    function releaseCaptureResources(capture) {
      if (!capture) return
      const processor = capture.processor
      if (processor) {
        processor.onaudioprocess = null
        try { processor.disconnect() } catch { /* ignore */ }
      }
      const source = capture.source
      if (source) {
        try { source.disconnect() } catch { /* ignore */ }
      }
      const sink = capture.sink
      if (sink) {
        try { sink.disconnect() } catch { /* ignore */ }
      }
      stopStream(capture.stream)
      const context = capture.context
      if (context) {
        try {
          const closing = context.close()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch {
          // Ignore close failures.
        }
      }
    }

    /** Audio-thread callback: accumulate by AUDIO time, flush there (not by timer). */
    function onLiveAudioProcess(event) {
      if (snapshot.live.status !== 'recording') return
      const input = event.inputBuffer?.getChannelData?.(0)
      if (!input || input.length === 0) return
      liveEngine.lastAudioAt = Date.now()
      const mono = new Float32Array(input.length)
      mono.set(input)
      let energy = 0
      for (let index = 0; index < mono.length; index += 1) energy += mono[index] * mono[index]
      liveEngine.level = Math.min(1, Math.sqrt(energy / mono.length) * 4)
      const resampled = liveEngine.resampler === null ? mono : liveEngine.resampler.push(mono)
      if (resampled.length === 0) return
      liveEngine.pcmParts.push(toRecordingPcm(resampled))
      liveEngine.accumulator.push(resampled)
      liveEngine.accumulatedFrames += resampled.length
      if (liveEngine.accumulatedFrames >= LIVE_FLUSH_FRAMES) flushLiveSamples(false)
    }

    function flushLiveSamples(force = false) {
      const frames = liveEngine.accumulatedFrames
      if (frames === 0) return
      if (!force && frames < LIVE_FLUSH_FRAMES) return
      if (force && frames < LIVE_MIN_FRAMES) {
        liveEngine.accumulator = []
        liveEngine.accumulatedFrames = 0
        return
      }
      const merged = concatFloat32(liveEngine.accumulator)
      liveEngine.accumulator = []
      liveEngine.accumulatedFrames = 0
      enqueueLiveSamples(merged)
    }

    function enqueueLiveSamples(samples) {
      if (!samples || samples.length === 0) return
      const queue = liveEngine.queue
      // When transcription falls behind, merge new audio into the newest pending
      // slice instead of growing the queue without bound.
      if (queue.length >= LIVE_MAX_PENDING) {
        queue[queue.length - 1] = concatFloat32([queue[queue.length - 1], samples])
      } else {
        queue.push(samples)
      }
      publishLiveQueue()
      void pumpLiveQueue()
    }

    async function pumpLiveQueue() {
      if (liveEngine.pumping) return
      liveEngine.pumping = true
      try {
        while (liveEngine.inFlight < LIVE_MAX_INFLIGHT && liveEngine.queue.length > 0) {
          const samples = liveEngine.queue.shift()
          liveEngine.inFlight += 1
          liveEngine.sentChunks += 1
          publishLiveQueue()
          void sendLiveChunk(samples)
        }
      } finally {
        liveEngine.pumping = false
        resolveLiveIdle()
      }
    }

    function applyLiveChunk(payload, speakerIndex = -1) {
      const status = snapshot.live.status
      if (status !== 'preparing' && status !== 'recording' && status !== 'stopping') return
      const text = String(payload?.text ?? '').trim()
      const serverTranscript = typeof payload?.transcript === 'string' ? payload.transcript : ''
      let transcript = serverTranscript
      if (transcript === '') {
        transcript = text === ''
          ? snapshot.live.transcript
          : (snapshot.live.transcript === '' ? text : `${snapshot.live.transcript}\n${text}`)
      }
      if (text === '' && snapshot.live.chars === 0) {
        liveEngine.emptyChunks += 1
        if (liveEngine.emptyChunks === 4) {
          notify('warn', '一直没识别到语音', '请确认麦克风输入设备与系统音量（录音弹窗里可改选设备）')
        }
      } else if (text !== '') {
        liveEngine.emptyChunks = 0
      }
      if (text !== '') {
        // 记一段「说话人 + 文本」，结束后存进会议，用于按 A/B/C/D 展示。
        const startedAt = Number(snapshot.live.startedAt) || Date.now()
        liveEngine.segments.push({
          speaker: speakerIndex >= 0 ? String.fromCharCode(65 + (speakerIndex % 26)) : '',
          text,
          at: Math.max(0, Math.round((Date.now() - startedAt) / 1000)),
        })
      }
      const patch = { transcript, chars: transcript.length, error: null }
      if (text !== '') patch.lastText = text.length > 90 ? text.slice(-90) : text
      publishLive(patch)
      if (snapshot.meeting !== null && snapshot.meeting.id === snapshot.live.meetingId) {
        const nextMeeting = { ...snapshot.meeting, transcript }
        const seconds = Number(payload?.transcriptSeconds)
        if (Number.isFinite(seconds) && seconds > 0) nextMeeting.transcriptSeconds = seconds
        if (liveEngine.segments.length > 0) nextMeeting.transcriptSegments = liveEngine.segments
        commit({ meeting: nextMeeting })
      }
    }

    function handleLiveChunkError(error) {
      if (!liveIsActive()) return
      const message = messageOf(error)
      if (liveEngine.failureMessage === null) liveEngine.failureMessage = message
      publishLive({ error: message })
      reportError(error, '实时转写中断')
      if (snapshot.live.status === 'recording') void stopLiveRecording('error')
    }

    async function sendLiveChunk(samples) {
      const meetingId = snapshot.live.meetingId
      const session = liveEngine.sessionId
      // 音色分组在录音线程里算好，跟着这段文本一起入库（只用于展示 A/B/C/D）。
      const speakerIndex = assignLiveSpeaker(extractVoiceFeature(samples))
      try {
        if (meetingId === null) throw new Error('录制的会议不存在，无法转写')
        // 单段转写失败自动重试一次：网络抖动 / 识别服务短暂忙都常见，
        // 不该让一整场录音因为一次失败而中断。
        let payload = null
        let lastError = null
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            payload = await postTranscription(meetingId, encodePcm16Wav(samples))
            lastError = null
            break
          } catch (error) {
            lastError = error
            if (attempt === 0) await new Promise((resolve) => window.setTimeout(resolve, 600))
          }
        }
        if (payload === null) throw lastError ?? new Error('实时转写失败')
        if (liveEngine.sessionId === session) {
          liveEngine.chunkFailures = 0
          applyLiveChunk(payload, speakerIndex)
        }
      } catch (error) {
        if (liveEngine.sessionId === session) {
          liveEngine.chunkFailures += 1
          // 第一次失败（已重试过一次）先不中断：提示一下，继续录下一段。
          if (liveEngine.chunkFailures < 2) {
            notify('warn', '这一段没转写成功，已继续录音', messageOf(error))
            publishLive({ error: null })
          } else {
            handleLiveChunkError(error)
          }
        }
      } finally {
        if (liveEngine.sessionId === session) {
          liveEngine.inFlight = Math.max(0, liveEngine.inFlight - 1)
          publishLiveQueue()
          resolveLiveIdle()
          void pumpLiveQueue()
        }
      }
    }

    /** 麦克风轨道被系统掐断（拔设备 / 被其它程序独占）时收尾，别让浮窗一直挂着。 */
    function watchLiveCapture(capture) {
      try {
        const track = capture?.stream?.getAudioTracks?.()[0]
        if (!track || typeof track.addEventListener !== 'function') return
        track.addEventListener('ended', () => {
          if (snapshot.live.status !== 'recording') return
          liveEngine.captureLost = true
          notify('warn', '麦克风已断开', '正在结束本次录音并保留已识别内容')
          void stopLiveRecording('error')
        })
      } catch {
        // 拿不到轨道也不影响录音本身。
      }
    }

    function stopLiveCapture() {
      const processor = liveEngine.processor
      if (processor) {
        processor.onaudioprocess = null
        try { processor.disconnect() } catch { /* ignore */ }
        liveEngine.processor = null
      }
      const source = liveEngine.source
      if (source) {
        try { source.disconnect() } catch { /* ignore */ }
        liveEngine.source = null
      }
      const sink = liveEngine.sink
      if (sink) {
        try { sink.disconnect() } catch { /* ignore */ }
        liveEngine.sink = null
      }
      stopStream(liveEngine.stream)
      liveEngine.stream = null
      const context = liveEngine.context
      liveEngine.context = null
      if (context) {
        try {
          const closing = context.close()
          if (closing && typeof closing.catch === 'function') closing.catch(() => {})
        } catch {
          // Ignore close failures.
        }
      }
      liveEngine.resampler = null
    }

    function releaseLiveAudio() {
      stopLiveCapture()
      liveEngine.accumulator = []
      liveEngine.accumulatedFrames = 0
      liveEngine.queue = []
      liveEngine.inFlight = 0
      liveEngine.pumping = false
      liveEngine.level = 0
      liveEngine.resampler = null
      resolveLiveIdle()
    }

    /** float32 → int16（留存整场音频，用于结束后生成 WAV） */

    function toRecordingPcm(frames) {
      const out = new Int16Array(frames.length)
      for (let index = 0; index < frames.length; index += 1) {
        const value = Math.max(-1, Math.min(1, frames[index]))
        out[index] = value < 0 ? value * 0x8000 : value * 0x7fff
      }
      return out
    }

    function concatRecordingPcm(parts) {
      let total = 0
      for (const part of parts) total += part.length
      const merged = new Int16Array(total)
      let offset = 0
      for (const part of parts) {
        merged.set(part, offset)
        offset += part.length
      }
      return merged
    }

    function encodeRecordingWav(samples, sampleRate) {
      const buffer = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(buffer)
      const writeText = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
      }
      writeText(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      writeText(8, 'WAVE')
      writeText(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, sampleRate, true)
      view.setUint32(28, sampleRate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeText(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      for (let index = 0; index < samples.length; index += 1) view.setInt16(44 + index * 2, samples[index], true)
      return new Blob([buffer], { type: 'audio/wav' })
    }

    function formatBytes(bytes) {
      const value = Number(bytes) || 0
      if (value < 1024) return value + ' B'
      if (value < 1024 * 1024) return (value / 1024).toFixed(0) + ' KB'
      if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(1) + ' MB'
      return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    }

    function mediaFileName(prefix, extension) {
      const now = new Date()
      const pad = (value) => String(value).padStart(2, '0')
      return prefix + '-' + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + '.' + extension
    }

    async function uploadMeetingMedia(meetingId, kind, blob, name, seconds) {
      const query = '?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(name) + '&seconds=' + String(Math.round(seconds || 0))
      const response = await fetch(API + '/meetings/' + encodeURIComponent(meetingId) + '/media/upload' + query, {
        method: 'POST',
        headers: { 'content-type': blob.type || 'application/octet-stream' },
        body: blob,
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload === null || payload.ok !== true) {
        throw new Error(payload?.error ?? ('保存文件失败（HTTP ' + response.status + '）'))
      }
      return payload
    }

    /** 录屏转 MP4 是宿主后台做的：这里轮询会议，转换完成后刷新文件列表。 */
    async function pollMediaConversion(meetingId) {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        await new Promise((resolve) => { window.setTimeout(resolve, 3000) })
        try {
          const payload = await requestJson('/meetings/' + encodeURIComponent(meetingId))
          const media = Array.isArray(payload?.meeting?.media)
            ? payload.meeting.media
            : (Array.isArray(payload?.media) ? payload.media : [])
          if (media.length > 0) publishLive({ media })
          if (!media.some((item) => item.converting === true)) return
        } catch { }
      }
    }

    async function revealMedia(meetingId, kind) {
      if (meetingId === null || meetingId === undefined) return
      try {
        await requestJson('/meetings/' + encodeURIComponent(meetingId) + '/media/reveal', { method: 'POST', body: { kind } })
      } catch (error) {
        reportError(error, '打开文件夹失败')
      }
    }

    /** 用电脑默认播放软件打开录制的视频/音频。 */
    async function openMedia(meetingId, kind) {
      if (meetingId === null || meetingId === undefined) return
      try {
        const payload = await requestJson('/meetings/' + encodeURIComponent(meetingId) + '/media/open', { method: 'POST', body: { kind } })
        if (payload !== null && payload !== undefined && payload.opened === false) {
          notify('warn', '文件打不开', '文件可能已被移动或删除，可点「查看目录」确认位置')
        }
      } catch (error) {
        reportError(error, '打开文件失败')
      }
    }

    function screenRecorderMime() {
      if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') return ''
      const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      for (const type of candidates) {
        if (MediaRecorder.isTypeSupported(type)) return type
      }
      return ''
    }

    async function beginScreenCapture(micStream) {
      const pending = liveEngine.pendingDisplay
      liveEngine.pendingDisplay = null
      if (pending === null || pending === undefined) return false
      let display = null
      try {
        display = await pending
      } catch (error) {
        publishLive({ screen: false })
        notify('warn', '录屏未开始', '没有选中屏幕窗口，已改为只录音频；' + messageOf(error))
        return false
      }
      try {
        const videoTrack = display.getVideoTracks()[0]
        if (!videoTrack) return false
        const tracks = [videoTrack]
        const audioTrack = micStream && typeof micStream.getAudioTracks === 'function' ? micStream.getAudioTracks()[0] : null
        if (audioTrack) tracks.push(audioTrack)
        const stream = new MediaStream(tracks)
        const mimeType = screenRecorderMime()
        const recorder = mimeType === '' ? new MediaRecorder(stream) : new MediaRecorder(stream, { mimeType })
        liveEngine.videoChunks = []
        liveEngine.videoMime = recorder.mimeType || 'video/webm'
        recorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) liveEngine.videoChunks.push(event.data)
        }
        videoTrack.addEventListener('ended', () => { void finishScreenCapture() })
        recorder.start(1000)
        liveEngine.screenStream = display
        liveEngine.videoRecorder = recorder
        publishLive({ screen: true })
        return true
      } catch (error) {
        publishLive({ screen: false })
        notify('warn', '录屏未开始', '已改为只录音频；' + messageOf(error))
        return false
      }
    }

    function finishScreenCapture() {
      const recorder = liveEngine.videoRecorder
      const display = liveEngine.screenStream
      liveEngine.videoRecorder = null
      liveEngine.screenStream = null
      publishLive({ screen: false })
      const finished = new Promise((resolve) => {
        if (recorder === null || recorder.state === 'inactive') {
          resolve(null)
          return
        }
        recorder.onstop = () => {
          try {
            resolve(new Blob(liveEngine.videoChunks, { type: liveEngine.videoMime || 'video/webm' }))
          } catch {
            resolve(null)
          }
        }
        try {
          recorder.stop()
        } catch {
          resolve(null)
        }
      })
      if (display !== null) {
        for (const track of display.getTracks()) {
          try { track.stop() } catch { }
        }
      }
      return finished
    }

    async function saveRecordingMedia(meetingId, videoBlob, seconds) {
      const saved = []
      if (videoBlob !== null && videoBlob.size > 0) {
        try {
          const payload = await uploadMeetingMedia(meetingId, 'video', videoBlob, mediaFileName('会议录屏', 'webm'), seconds)
          if (Array.isArray(payload.media)) saved.push(...payload.media)
        } catch (error) {
          reportError(error, '保存录屏视频失败')
        }
      }
      const parts = liveEngine.pcmParts
      liveEngine.pcmParts = []
      if (parts.length > 0) {
        try {
          const samples = concatRecordingPcm(parts)
          if (samples.length > 0) {
            const payload = await uploadMeetingMedia(meetingId, 'audio', encodeRecordingWav(samples, 16000), mediaFileName('会议录音', 'wav'), seconds)
            if (Array.isArray(payload.media)) saved.push(...payload.media)
          }
        } catch (error) {
          reportError(error, '保存录音文件失败')
        }
      }
      return saved
    }

    async function startLiveRecording(input) {
      if (liveIsActive()) return false
      const token = liveEngine.startToken + 1
      liveEngine.startToken = token
      liveEngine.sessionId += 1
      liveEngine.failureMessage = null
      stopLiveTimer()
      releaseLiveAudio()
      liveEngine.waiters = []
      liveEngine.sentChunks = 0
      liveEngine.chunkFailures = 0
      liveEngine.orbWarned = false
      liveEngine.pcmParts = []
      liveEngine.speakerCentroids = []
      liveEngine.segments = []
      liveEngine.screenActive = false
      liveEngine.pendingDisplay = input?.display ?? null
      liveEngine.level = 0
      resetLiveState({
        status: 'preparing',
        meetingTitle: String(input?.title ?? defaultRecordingTitle()),
      })
      updateLiveBeforeUnload()
      startLiveHeartbeat()
      let meeting = null
      try {
        await waitForSpeechReady()
        if (liveEngine.startToken !== token) return false
        meeting = await createMeeting({
          title: String(input?.title ?? defaultRecordingTitle()).trim() || defaultRecordingTitle(),
          date: input?.date || todayKey(),
          attendees: Array.isArray(input?.attendees) ? input.attendees : splitAttendees(input?.attendees),
          sourceType: 'recording',
        })
        if (liveEngine.startToken !== token) {
          void discardMeetingQuietly(meeting.id)
          return false
        }
        publishLive({ meetingId: meeting.id, meetingTitle: meeting.title })
        const capture = await openLiveCapture()
        if (liveEngine.startToken !== token) {
          releaseCaptureResources(capture)
          void discardMeetingQuietly(meeting.id)
          return false
        }
        liveEngine.stream = capture.stream
        liveEngine.context = capture.context
        liveEngine.source = capture.source
        liveEngine.processor = capture.processor
        liveEngine.sink = capture.sink
        liveEngine.resampler = capture.resampler
        capture.processor.onaudioprocess = onLiveAudioProcess
        if (input?.screen === true) {
          // 录屏由宿主 ffmpeg 采集（桌面端 Electron 没有实现屏幕采集处理器，浏览器拿不到画面）。
          try {
            const screenPayload = await requestJson('/meetings/' + encodeURIComponent(meeting.id) + '/screen/start', {
              method: 'POST',
              body: { source: input.screenSource ?? 'desktop' },
            })
            if (screenPayload?.ok !== true) throw new Error(screenPayload?.error ?? '录屏启动失败')
            liveEngine.screenActive = true
            notifySuccess('已开始录屏', String(screenPayload?.label ?? '整个桌面'))
          } catch (error) {
            liveEngine.screenActive = false
            notify('warn', '录屏未开始', '已改为只录音频；' + messageOf(error))
          }
        }
        publishLive({
          status: 'recording',
          screen: liveEngine.screenActive === true,
          startedAt: Date.now(),
          elapsedSeconds: 0,
          level: 0,
          error: null,
        })
        startLiveTimer()
        updateLiveBeforeUnload()
        return true
      } catch (error) {
        releaseLiveAudio()
        const message = messageOf(error)
        publishLive({ status: 'error', error: message })
        updateLiveBeforeUnload()
        reportError(error, '录音启动失败')
        return false
      }
    }

    async function stopLiveRecording(reason = 'user', options = {}) {
      const status = snapshot.live.status
      if (status === 'preparing') {
        await cancelLiveRecording()
        return
      }
      if (status !== 'recording') return
      publishLive({ status: 'stopping' })
      updateLiveBeforeUnload()
      stopLiveTimer()
      stopLiveCapture()
      let videoBlob = null
      if (liveEngine.screenActive === true && snapshot.live.meetingId !== null) {
        try {
          const stopped = await requestJson('/meetings/' + encodeURIComponent(snapshot.live.meetingId) + '/screen/stop', { method: 'POST' })
          if (stopped?.ok !== true) throw new Error(stopped?.error ?? '录屏收尾失败')
        } catch (error) {
          reportError(error, '录屏收尾失败')
        }
        liveEngine.screenActive = false
        publishLive({ screen: false })
      }
      // Flush whatever the audio thread already handed us, then wait for every
      // in-flight request before finalising the meeting.
      flushLiveSamples(true)
      publishLiveQueue()
      const idle = await waitForLiveIdle(LIVE_IDLE_TIMEOUT_MS)
      await finalizeLiveRecording(reason, idle, videoBlob)
      const finishedId = snapshot.live.meetingId
      if (typeof finishedId === 'string' && finishedId !== '') {
        // 后台还会跑说话人分离 + 纠错（几秒到几十秒），延迟刷新把结果取回来
        window.setTimeout(() => { void reloadMeetingQuietly(finishedId) }, 6000)
        window.setTimeout(() => { void reloadMeetingQuietly(finishedId) }, 20000)
      }
      stopLiveHeartbeat()
      await reportLiveSessionEnd(snapshot.live.status === 'error' ? 'error' : 'done')
      if (options.fromOrb === true) returnToMeetingPanel()
    }

    async function finalizeLiveRecording(reason, idleOk, videoBlob = null) {
      const meetingId = snapshot.live.meetingId
      let meeting = null
      if (meetingId !== null) {
        try {
          const payload = await requestJson(`/meetings/${encodeURIComponent(meetingId)}`)
          meeting = payload.meeting ?? null
        } catch (error) {
          reportError(error, '读取会议失败')
        }
      }
      if (meeting !== null) {
        if (snapshot.selectedId === meetingId) commit({ meeting })
        const transcript = typeof meeting.transcript === 'string' && meeting.transcript !== ''
          ? meeting.transcript
          : snapshot.live.transcript
        publishLive({ transcript, chars: transcript.length })
      } else if (snapshot.live.transcript !== '' && snapshot.selectedId === meetingId && snapshot.meeting !== null) {
        commit({ meeting: { ...snapshot.meeting, transcript: snapshot.live.transcript } })
      }
      await refreshList()
      const transcript = snapshot.live.transcript
      const chars = transcript.length
      const seconds = Number(meeting?.transcriptSeconds) || 0
      // 录屏 / 整场音频：停止后先生成文件并交给宿主存盘（即使转写失败也保留）。
      let savedMedia = []
      if (meetingId !== null && (videoBlob !== null || liveEngine.pcmParts.length > 0)) {
        savedMedia = await saveRecordingMedia(meetingId, videoBlob, seconds)
        if (savedMedia.length > 0) publishLive({ media: savedMedia })
        if (savedMedia.some((item) => item.converting === true)) void pollMediaConversion(meetingId)
      }
      // 把「说话人 + 文本」的分段写回会议，原始转写卡片据此按 A/B/C/D 展示。
      const speakerSegments = liveEngine.segments
      if (meetingId !== null && speakerSegments.length > 0) {
        try {
          const updated = await patchMeeting(meetingId, { transcriptSegments: speakerSegments })
          if (updated !== null && updated !== undefined) commit({ meeting: updated, selectedId: meetingId })
        } catch (error) {
          reportError(error, '保存说话人标记失败')
        }
      }
      const failure = liveEngine.failureMessage
      releaseLiveAudio()
      stopLiveTimer()
      stopLiveHeartbeat()
      if (reason === 'error' || failure !== null) {
        publishLive({
          status: 'error',
          chars,
          error: failure || snapshot.live.error || '实时转写中断，已保留已识别内容',
          result: { meetingId, chars, seconds, sentChunks: liveEngine.sentChunks },
        })
        updateLiveBeforeUnload()
        return
      }
      if (!idleOk) {
        publishLive({
          status: 'error',
          chars,
          error: '等待最后几段识别超时，已保留已识别内容',
          result: { meetingId, chars, seconds, sentChunks: liveEngine.sentChunks },
        })
        updateLiveBeforeUnload()
        return
      }
      if (meetingId === null || (chars === 0 && savedMedia.length === 0)) {
        // 一个字都没识别到的录音不留空壳记录：删掉临时会议，避免列表里堆空的「0 字」会议。
        if (meetingId !== null) void discardMeetingQuietly(meetingId)
        publishLive({
          status: 'error',
          chars: 0,
          error: '本次录音没有识别到内容，未生成会议记录。请确认麦克风设备与音量后重试，或改用文本导入。',
          result: { meetingId: null, chars: 0, seconds, sentChunks: liveEngine.sentChunks },
        })
        updateLiveBeforeUnload()
        notify('error', '录音结束但未识别到文字', '本次未生成记录；请检查麦克风，或改用「导入纪要」的文本方式')
        return
      }
      publishLive({
        status: 'done',
        chars,
        transcript,
        result: { meetingId, chars, seconds, sentChunks: liveEngine.sentChunks },
      })
      updateLiveBeforeUnload()
      notifySuccess('实时转写完成', `已识别 ${formatChars(chars)}，可以生成 AI 纪要或写入DSH 待办`)
    }

    async function cancelLiveRecording() {
      liveEngine.startToken += 1
      liveEngine.sessionId += 1
      stopLiveTimer()
      releaseLiveAudio()
      stopLiveHeartbeat()
      updateLiveBeforeUnload()
      const meetingId = snapshot.live.meetingId
      resetLiveState()
      void reportLiveSessionEnd('idle')
      updateLiveBeforeUnload()
      if (meetingId !== null) await discardMeetingQuietly(meetingId)
      notify('warn', '已取消录音', meetingId === null ? '录音已停止' : '本次录音的临时会议已删除')
    }

    function clearLiveRecording() {
      if (liveIsActive()) return
      resetLiveState()
      updateLiveBeforeUnload()
    }

    async function deleteLiveMeeting() {
      if (liveIsActive()) {
        await cancelLiveRecording()
        return
      }
      const meetingId = snapshot.live.meetingId
      resetLiveState()
      updateLiveBeforeUnload()
      if (meetingId !== null) {
        await discardMeetingQuietly(meetingId)
        notify('warn', '已删除录音会议', '会议与转写内容已删除')
      }
    }

    // ─────────────────────────────── icons ────────────────────────────────

    const ICON_PATHS = {
      plus: ['M8 3.5v9M3.5 8h9'],
      mic: [
        'M8 2.5a2 2 0 0 1 2 2v3.2a2 2 0 0 1-4 0V4.5a2 2 0 0 1 2-2Z',
        'M4.2 7.4v.6a3.8 3.8 0 0 0 7.6 0v-.6',
        'M8 11.8v1.9',
        'M5.9 13.7h4.2',
      ],
      upload: [
        'M8 10.6V2.9',
        'M5.2 5.7 8 2.9l2.8 2.8',
        'M3 10.7v1.5a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-1.5',
      ],
      sparkle: [
        'M7.2 2.2 8.5 5.4l3.2 1.3-3.2 1.3-1.3 3.2-1.3-3.2L2.7 6.7l3.2-1.3L7.2 2.2Z',
        'M12.4 10.9l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4Z',
      ],
      download: ['M8 2.9v7.6', 'M5.2 7.7 8 10.5l2.8-2.8', 'M3 12.8h10'],
      trash: [
        'M2.9 4.6h10.2',
        'M5.7 4.6V3.3h4.6v1.3',
        'M4.4 4.6l.6 8.3h6l.6-8.3',
        'M6.7 6.9v3.9',
        'M9.3 6.9v3.9',
      ],
      search: ['M7.1 2.9a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 0 0 0-8.4Z', 'm10.3 10.3 2.6 2.6'],
      close: ['M4 4l8 8', 'M12 4l-8 8'],
      check: ['M3.2 8.4l3 3 6.6-6.8'],
      edit: ['M3 13h2.6l6.6-6.6-2.6-2.6L3 10.4V13Z', 'M9.4 4.2l2.4 2.4'],
      copy: ['M5.6 5.6V3.2h7.2v7.2h-2.4', 'M3.2 5.6h7.2v7.2H3.2Z'],
      refresh: ['M13 8a5 5 0 1 1-1.6-3.7', 'M13.1 2.9v3.5h-3.5'],
      calendar: [
        'M3.1 3.9h9.8v9H3.1z',
        'M3.1 6.5h9.8',
        'M5.5 2.6v2.4',
        'M10.5 2.6v2.4',
      ],
      clock: ['M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Z', 'M8 5.4V8l1.9 1.1'],
      users: [
        'M6 3.1a2.2 2.2 0 1 0 0 4.4 2.2 2.2 0 0 0 0-4.4Z',
        'M2.6 13c0-1.9 1.5-3.3 3.4-3.3s3.4 1.4 3.4 3.3',
        'M10.3 3.5a1.9 1.9 0 1 0 .1 3.8',
        'M11 9.8c1.4.2 2.4 1.5 2.4 3.2',
      ],
      doc: [
        'M4.2 2.6h5.1l2.5 2.5v8.3H4.2z',
        'M9.3 2.6v2.7h2.5',
        'M6 8h4',
        'M6 10.2h4',
      ],
      list: ['M5.6 4.2h7M5.6 8h7M5.6 11.8h7', 'M3 4.2h.8M3 8h.8M3 11.8h.8'],
      alert: ['M8 2.9 13 12.6H3L8 2.9Z', 'M8 6.5v2.9', 'M8 11.1v.2'],
      chevron: ['M6 4l4 4-4 4'],
      stop: ['M5 5h6v6H5z'],
      play: ['M6 4.3l5 3.7-5 3.7z'],
      folder: ['M2.8 4.2h4l1.2 1.5h5.2v6.8H2.8z'],
      info: ['M8 3a5 5 0 1 0 0 10A5 5 0 0 0 8 3Z', 'M8 7.4v3.4', 'M8 5.2v.2'],
      screen: ['M2.6 3.6h10.8v6.6H2.6z', 'M5.6 12.6h4.8', 'M8 10.2v2.4'],
      sliders: ['M2.6 4.6h3.2', 'M10 4.6h3.4', 'M2.6 8h1.4', 'M8.2 8h5.2', 'M2.6 11.4h4.8', 'M11.6 11.4h1.8', 'M7.5 3.4a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z', 'M5.9 6.8a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z', 'M9.4 10.2a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5Z'],
    }

    function Icon(props) {
      const paths = ICON_PATHS[props.name] ?? []
      return h(
        'svg',
        {
          width: props.size ?? 14,
          height: props.size ?? 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          className: props.className ?? undefined,
        },
        ...paths.map((d, index) => h('path', {
          key: index,
          d,
          stroke: 'currentColor',
          strokeWidth: props.strokeWidth ?? 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        })),
      )
    }

    /** Sidebar glyph: microphone + minutes lines, 18 px, inherits currentColor. */
    function MeetingGlyph(props) {
      const size = props?.size ?? 18
      const active = props?.active === true
      const state = useSnapshot()
      const pending = (state.meetings ?? []).reduce(
        (sum, item) => sum + (Number(item.pendingTodoCount) || 0),
        0,
      )
      const recording = liveIsActive(state.live)
      const stroke = active ? 1.6 : 1.3
      const glyph = h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('rect', { x: 3.1, y: 1.5, width: 4.2, height: 6.6, rx: 2.1, stroke: 'currentColor', strokeWidth: stroke }),
        h('path', { d: 'M1.8 7.1a3.8 3.8 0 0 0 7.6 0', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' }),
        h('path', { d: 'M5.6 10.9v1.5M3.7 13h3.8', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' }),
        h('path', { d: 'M10.7 3.3h3.1M10.7 6h3.1M10.7 8.7h2.1', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round' }),
        h('path', { d: 'M10.7 11.4h3.1', stroke: 'currentColor', strokeWidth: stroke, strokeLinecap: 'round', opacity: 0.55 }),
      )
      if (pending <= 0 && !recording) return glyph
      return h(
        'span',
        { className: 'dsm-icon-badge' },
        glyph,
        pending > 0 ? h('span', { className: 'dsm-icon-dot' }, pending > 99 ? '99+' : String(pending)) : null,
        recording ? h('span', { className: 'dsm-icon-live-dot', title: '正在录音' }) : null,
      )
    }

    // ─────────────────────────── shared controls ──────────────────────────

    function Field(props) {
      return h(
        'label',
        { className: 'dsm-field' },
        h('span', { className: 'dsm-label' }, props.label),
        props.children,
      )
    }

    function TextInput(props) {
      return h('input', {
        className: `dsm-input${props.compact ? ' dsm-input--cell' : ''}`,
        type: props.type ?? 'text',
        value: props.value ?? '',
        placeholder: props.placeholder ?? '',
        onChange: (event) => { props.onChange(event.target.value) },
        onKeyDown: props.onKeyDown,
      })
    }

    function TextArea(props) {
      return h('textarea', {
        className: `dsm-input dsm-textarea${props.compact ? ' dsm-input--cell' : ''}`,
        rows: props.rows ?? 4,
        value: props.value ?? '',
        placeholder: props.placeholder ?? '',
        onChange: (event) => { props.onChange(event.target.value) },
      })
    }

    function Select(props) {
      return h(
        'select',
        {
          className: `dsm-input${props.compact ? ' dsm-input--cell' : ''}`,
          value: props.value,
          onChange: (event) => { props.onChange(event.target.value) },
        },
        ...props.options.map((option) => h('option', { key: option.value, value: option.value }, option.label)),
      )
    }

    function ToolbarButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: `dsm-btn${props.variant ? ` dsm-btn--${props.variant}` : ''}${props.className ? ` ${props.className}` : ''}`,
          onClick: props.onClick,
          disabled: props.disabled === true,
          title: props.title ?? undefined,
        },
        props.icon ? h(Icon, { name: props.icon, size: props.iconSize ?? 13 }) : null,
        h('span', null, props.label),
      )
    }

    function MetaChip(props) {
      return h(
        'span',
        {
          className: `dsm-meta-chip${props.tone ? ` dsm-meta-chip--${props.tone}` : ''}`,
          title: props.title ?? undefined,
        },
        props.icon ? h(Icon, { name: props.icon, size: 11 }) : null,
        h('span', null, props.label),
      )
    }

    function Badge(props) {
      return h('span', { className: `dsm-badge${props.tone ? ` dsm-badge--${props.tone}` : ''}` }, props.label)
    }

    function ProgressBar(props) {
      const ratio = Math.max(0, Math.min(1, Number(props.ratio) || 0))
      return h(
        'div',
        { className: 'dsm-progress' },
        h('div', { className: 'dsm-progress-bar', style: { width: `${Math.round(ratio * 100)}%` } }),
      )
    }

    function Modal(props) {
      const onClose = props.onClose
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape' && props.dismissible !== false) onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose, props.dismissible])
      return h(
        'div',
        { className: 'dsm-modal-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': props.title },
        h('div', {
          className: 'dsm-modal-mask',
          onClick: props.dismissible === false ? undefined : onClose,
        }),
        h(
          'div',
          { className: `dsm-modal${props.wide ? ' dsm-modal--wide' : ''}` },
          h(
            'div',
            { className: 'dsm-modal-head' },
            h(
              'div',
              { className: 'dsm-modal-heading' },
              h('div', { className: 'dsm-modal-title' }, props.title),
              props.subtitle ? h('div', { className: 'dsm-modal-sub' }, props.subtitle) : null,
            ),
            props.dismissible === false
              ? h('span', { className: 'dsm-modal-lock' }, '处理中…')
              : h(
                'button',
                { type: 'button', className: 'dsm-iconbtn', onClick: onClose, 'aria-label': '关闭' },
                h(Icon, { name: 'close', size: 14 }),
              ),
          ),
          h('div', { className: 'dsm-modal-body' }, props.children),
          props.footer ? h('div', { className: 'dsm-modal-foot' }, props.footer) : null,
        ),
      )
    }

    function Section(props) {
      return h(
        'section',
        { className: 'dsm-doc-section' + (props.card === true ? ' dsm-section-card' : '') },
        h(
          'div',
          { className: 'dsm-section-band' },
          h('span', { className: 'dsm-section-icon' }, h(Icon, { name: props.icon ?? 'list', size: 13 })),
          h('h2', { className: 'dsm-section-title' }, props.title),
          props.count !== undefined ? h('span', { className: 'dsm-section-count' }, `（${props.count}）`) : null,
          props.sub ? h('span', { className: 'dsm-section-sub' }, props.sub) : null,
          props.actions ? h('span', { className: 'dsm-section-actions' }, props.actions) : null,
        ),
        props.children,
      )
    }

    // ────────────────────────────── dialogs ───────────────────────────────

    function NewMeetingModal(props) {
      const [title, setTitle] = useState('')
      const [date, setDate] = useState(todayKey())
      const [attendees, setAttendees] = useState('')
      const [notes, setNotes] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const submit = async () => {
        setBusy(true)
        setError(null)
        try {
          const meeting = await createMeeting({
            title: title.trim() || defaultMeetingTitle(),
            date: date || todayKey(),
            attendees: splitAttendees(attendees),
            notes: notes.trim(),
          })
          notifySuccess('已创建会议', meeting.title)
          props.onClose()
        } catch (caught) {
          setError(messageOf(caught))
          reportError(caught, '创建会议失败')
        } finally {
          setBusy(false)
        }
      }
      return h(
        Modal,
        {
          title: '新建会议',
          subtitle: '先建好会议，再录音、导入转写或让 AI 生成纪要。',
          onClose: props.onClose,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: props.onClose }, '取消'),
            h('button', {
              key: 'ok',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: submit,
              disabled: busy,
            }, busy ? '创建中…' : '创建会议'),
          ],
        },
        h(Field, { label: '会议标题（可留空，稍后自动命名）' }, h(TextInput, {
          value: title,
          onChange: setTitle,
          placeholder: `留空 = ${defaultMeetingTitle()}；也可以之后在会议里改`,
        })),
        h(
          'div',
          { className: 'dsm-row' },
          h(Field, { label: '会议日期' }, h(TextInput, { type: 'date', value: date, onChange: setDate })),
          h(Field, { label: '参会人（逗号分隔）' }, h(TextInput, {
            value: attendees,
            onChange: setAttendees,
            placeholder: '张三，李四',
          })),
        ),
        h(Field, { label: '备注（可选）' }, h(TextArea, {
          value: notes,
          onChange: setNotes,
          rows: 3,
          placeholder: '会议背景、目标…',
        })),
        error !== null ? h('div', { className: 'dsm-inline-error' }, error) : null,
      )
    }

    function EditMeetingModal(props) {
      const meeting = props.meeting
      const [form, setForm] = useState(() => ({
        title: meeting?.title ?? '',
        date: meeting?.date ?? todayKey(),
        attendees: (meeting?.attendees ?? []).join('，'),
        notes: meeting?.notes ?? '',
      }))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const update = (key) => (value) => setForm((previous) => ({ ...previous, [key]: value }))
      const submit = async () => {
        if (form.title.trim() === '') {
          setError('会议标题不能为空')
          return
        }
        setBusy(true)
        setError(null)
        try {
          await patchMeeting(meeting.id, {
            title: form.title.trim(),
            date: form.date || todayKey(),
            attendees: splitAttendees(form.attendees),
            notes: form.notes,
          })
          notifySuccess('会议信息已更新', form.title.trim())
          props.onClose()
        } catch (caught) {
          setError(messageOf(caught))
          reportError(caught, '保存会议失败')
        } finally {
          setBusy(false)
        }
      }
      return h(
        Modal,
        {
          title: '编辑会议信息',
          onClose: props.onClose,
          footer: [
            h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: props.onClose }, '取消'),
            h('button', {
              key: 'ok',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: submit,
              disabled: busy,
            }, busy ? '保存中…' : '保存'),
          ],
        },
        h(Field, { label: '会议标题' }, h(TextInput, { value: form.title, onChange: update('title') })),
        h(
          'div',
          { className: 'dsm-row' },
          h(Field, { label: '会议日期' }, h(TextInput, { type: 'date', value: form.date, onChange: update('date') })),
          h(Field, { label: '参会人（逗号分隔）' }, h(TextInput, {
            value: form.attendees,
            onChange: update('attendees'),
          })),
        ),
        h(Field, { label: '备注' }, h(TextArea, { value: form.notes, onChange: update('notes'), rows: 3 })),
        error !== null ? h('div', { className: 'dsm-inline-error' }, error) : null,
      )
    }

    /**
     * 设置弹窗（两页）：模型配置（语音转写 / 会议总结）+ 自动入库。
     * 布局参考 DSH 设置：左侧导航 + 右侧内容卡片。
     */
    function SettingsModal(props) {
      const status = props.status ?? null
      const available = status !== null && typeof status === 'object'
      const [page, setPage] = useState('model')
      const [enabled, setEnabled] = useState(status?.enabled !== false)
      const [tencent, setTencent] = useState(status?.tencent !== false)
      const [dirsText, setDirsText] = useState(() => (Array.isArray(status?.dirs) ? status.dirs.join('\n') : ''))
      const [busy, setBusy] = useState(false)
      const [scanning, setScanning] = useState(status?.scanning === true)
      const [error, setError] = useState(null)
      const [settingsData, setSettingsData] = useState(null)
      const [modelsState, setModelsState] = useState(null)
      const [dshModels, setDshModels] = useState([])
      const [defaultModel, setDefaultModel] = useState(null)
      const [downloading, setDownloading] = useState('')
      const [cloudTab, setCloudTab] = useState('iflytek')
      const [summarySelection, setSummarySelection] = useState('')
      const [localSummaryMode, setLocalSummaryMode] = useState(null)
      const [localTranscribeMode, setLocalTranscribeMode] = useState(null)
      const [termsText, setTermsText] = useState('')
      const [termsSaving, setTermsSaving] = useState(false)
      const termsTouchedRef = useRef(false)
      const mountedRef = useRef(true)

      useEffect(() => {
        mountedRef.current = true
        return () => { mountedRef.current = false }
      }, [])

      const loadSettings = async () => {
        const payload = await requestJson('/settings')
        if (!mountedRef.current) return
        setSettingsData(payload?.settings ?? null)
        setModelsState(payload?.modelsState ?? null)
        setDshModels(Array.isArray(payload?.models) ? payload.models : [])
        setDefaultModel(payload?.defaultModel ?? null)
        const chosen = payload?.model
        setSummarySelection(chosen !== null && chosen !== undefined ? String(chosen.provider) + '|' + String(chosen.model) : '')
        if (termsTouchedRef.current !== true) setTermsText(payload?.settings?.terms ?? '')
      }

      useEffect(() => {
        void loadSettings().catch((caught) => { setError(messageOf(caught)) })
      }, [])

      const downloadMissRef = useRef(0)

      useEffect(() => {
        if (downloading === '') return undefined
        const kind = downloading
        const timer = window.setInterval(() => {
          void requestJson('/models/status').then((payload) => {
            if (!mountedRef.current) return
            const state = payload?.state ?? null
            setModelsState(state)
            const active = state?.downloading ?? null
            if (active !== null) { downloadMissRef.current = 0; return }
            if (state?.assets?.[kind]?.ready === true) {
              downloadMissRef.current = 0
              setDownloading('')
              notifySuccess('模型下载完成', modelTitle(kind) + ' 已就绪')
              void loadSettings().catch(() => {})
              return
            }
            downloadMissRef.current += 1
            if (downloadMissRef.current >= 3) {
              downloadMissRef.current = 0
              setDownloading('')
              setError('模型下载中断（网络到模型源不稳定），可点「下载/重装」再试一次')
              void loadSettings().catch(() => {})
            }
          }).catch(() => {})
        }, 1500)
        return () => { window.clearInterval(timer) }
      }, [downloading])

      const settings = settingsData ?? {
        transcribe: { provider: 'sensevoice-local', cloud: { iflytek: {}, tencent: {}, aliyun: {} } },
        summary: { mode: 'dsh', custom: { baseUrl: '', apiKey: '', model: '', temperature: 0.3, maxTokens: 8192 } },
        terms: '',
        correctTranscript: true,
        diarize: true,
      }

      const patchSettings = async (patch, message) => {
        setError(null)
        try {
          const payload = await requestJson('/settings', { method: 'PATCH', body: { settings: patch } })
          if (!mountedRef.current) return
          setSettingsData(payload?.settings ?? null)
          if (typeof message === 'string' && message !== '') notifySuccess(message, '')
          await loadSettings()
        } catch (caught) {
          setError(messageOf(caught))
        }
      }

      const updateTranscribe = (patch) => {
        void patchSettings({ transcribe: { ...settings.transcribe, ...patch } })
      }
      const updateCloud = (key, field, value) => {
        const cloud = { ...(settings.transcribe.cloud ?? {}) }
        cloud[key] = { ...(cloud[key] ?? {}), [field]: value }
        void patchSettings({ transcribe: { ...settings.transcribe, cloud } })
      }
      const updateSummary = (patch) => {
        void patchSettings({ summary: { ...settings.summary, ...patch } })
      }
      const updateSummaryCustom = (field, value) => {
        const custom = { ...(settings.summary.custom ?? {}), [field]: value }
        void patchSettings({ summary: { ...settings.summary, custom } })
      }

      const saveSummarySelection = async (value) => {
        try {
          if (value === '') {
            await requestJson('/settings', { method: 'PATCH', body: { model: null } })
          } else {
            const [provider, model] = value.split('|')
            await requestJson('/settings', { method: 'PATCH', body: { model: { provider, model } } })
          }
          setSummarySelection(value)
          notifySuccess('总结模型已更新', value === '' ? '跟随 DSH 默认模型' : value.split('|')[1])
          await loadSettings()
        } catch (caught) {
          setError(messageOf(caught))
        }
      }

      /** 术语表失焦时保存；保存期间不清空本地输入。 */
      const saveTerms = async () => {
        setTermsSaving(true)
        try {
          await requestJson('/settings', { method: 'PATCH', body: { settings: { terms: termsText } } })
          termsTouchedRef.current = false
        } catch (caught) {
          setError(messageOf(caught))
        } finally {
          setTermsSaving(false)
        }
      }

      const modelTitle = (kind) => (kind === 'paraformer' ? 'Paraformer 中文识别模型' : kind === 'segmentation' ? '说话人分段模型' : '说话人声纹模型')

      const downloadModel = async (kind, force) => {
        setDownloading(kind)
        setError(null)
        downloadMissRef.current = 0
        try {
          if (force === true) {
            await requestJson('/models/' + kind, { method: 'DELETE' }).catch(() => {})
          }
          await requestJson('/models/' + kind + '/download', { method: 'POST' })
          notify('info', '开始下载', modelTitle(kind) + '（大模型需要几分钟，可关闭弹窗）')
          // 进度与完成提示交给轮询（见下面的 effect），不要在这里提示"完成"
          setModelsState((previous) => previous === null ? previous : { ...previous, downloading: { kind, percent: 0, fileName: '' } })
        } catch (caught) {
          setDownloading('')
          setError(messageOf(caught))
        }
      }

      const removeModel = async (kind) => {
        try {
          await requestJson('/models/' + kind, { method: 'DELETE' })
          await loadSettings()
          notifySuccess('已卸载模型', modelTitle(kind) + ' 已从本机移除，可随时重装')
        } catch (caught) {
          setError(messageOf(caught))
        }
      }

      const handleSaveAuto = async () => {
        setBusy(true)
        setError(null)
        try {
          const next = await saveAutoIngestSettings({
            enabled,
            tencent,
            dirs: parseAutoIngestDirs(dirsText),
          })
          if (next !== null) applyAutoIngestStatus(next)
          setBusy(false)
          notifySuccess('自动入库设置已保存', '')
        } catch (caught) {
          setBusy(false)
          setError(messageOf(caught))
        }
      }

      const handleScan = async () => {
        setScanning(true)
        setError(null)
        try {
          await triggerAutoIngestScanNow()
          if (mountedRef.current) setScanning(false)
        } catch (caught) {
          if (mountedRef.current) {
            setScanning(false)
            setError(messageOf(caught))
          }
        }
      }

      const defaultModelLabel = defaultModel === null || defaultModel === undefined || String(defaultModel.model ?? '') === ''
        ? '跟随 DSH 默认模型'
        : '跟随 DSH 默认模型（' + String(defaultModel.model) + '）'
      const summaryMode = localSummaryMode ?? (settings.summary.mode === 'custom' ? 'custom' : 'dsh')
      const modelReady = (kind) => modelsState?.assets?.[kind]?.ready === true
      const downloadingState = modelsState?.downloading ?? null
      const percent = typeof downloadingState?.percent === 'number' ? downloadingState.percent : 0

      const radioRow = (checked, onSelect, title, desc, right) => h(
        'div',
        {
          className: 'dsm-set-option' + (checked ? ' dsm-set-option--on' : ''),
          onClick: () => { if (!checked) onSelect() },
        },
        h('input', { type: 'radio', checked, onChange: () => { onSelect() } }),
        h(
          'div',
          { className: 'dsm-set-option-body' },
          h('div', { className: 'dsm-set-option-title' }, title),
          desc ? h('div', { className: 'dsm-set-option-desc' }, desc) : null,
        ),
        right ?? null,
      )

      const transcribeProvider = settings.transcribe.provider
      const cloudConfig = settings.transcribe.cloud ?? {}
      const transcribeMode = localTranscribeMode ?? (transcribeProvider.startsWith('cloud-') ? 'cloud' : 'local')

      const modelPage = h(
        'div',
        { className: 'dsm-set-page' },
        h('div', { className: 'dsm-set-section' },
          h('div', { className: 'dsm-set-section-head' },
            h('span', { className: 'dsm-set-section-title' }, '语音转写模型'),
            h('span', { className: 'dsm-set-section-desc' }, '把会议音频转成文字；本地模型离线运行，云端模型需联网与凭据。'),
          ),
          h('div', { className: 'dsm-set-tabs' },
            h('button', {
              key: 'mode-local',
              type: 'button',
              className: 'dsm-set-tab' + (transcribeMode === 'local' ? ' dsm-set-tab--on' : ''),
              onClick: () => { setLocalTranscribeMode('local'); updateTranscribe({ provider: 'paraformer-local' }) },
            }, '本地模型'),
            h('button', {
              key: 'mode-cloud',
              type: 'button',
              className: 'dsm-set-tab' + (transcribeMode === 'cloud' ? ' dsm-set-tab--on' : ''),
              onClick: () => { setLocalTranscribeMode('cloud'); updateTranscribe({ provider: 'cloud-' + cloudTab }) },
            }, '云端模型'),
          ),
          transcribeMode === 'local'
            ? radioRow(
              transcribeProvider === 'paraformer-local',
              () => { if (transcribeProvider !== 'paraformer-local') updateTranscribe({ provider: 'paraformer-local' }) },
              'Paraformer-zh（本地，支持说话人分离）',
              '中文长句与专业词更稳；配合 pyannote + cam++ 可输出 S1/S2 真说话人，音频不出本机',
              modelReady('paraformer') && modelReady('segmentation') && modelReady('campplus')
                ? h('span', { className: 'dsm-set-badge dsm-set-badge--ok' }, '已就绪')
                : h('span', { className: 'dsm-set-badge' }, '未下载'),
            )
            : null,
          transcribeMode === 'local' ? h('div', { className: 'dsm-set-models' },
            ...[
              ['paraformer', '识别模型 Paraformer-zh', '约 217 MB'],
              ['segmentation', '说话人分段（pyannote）', '约 1 MB'],
              ['campplus', '说话人声纹（cam++）', '约 27 MB'],
            ].map(([kind, title, size]) => h(
              'div',
              { key: 'model-' + kind, className: 'dsm-set-model-row' },
              h('div', { className: 'dsm-set-model-info' },
                h('span', { className: 'dsm-set-model-name' }, title),
                h('span', { className: 'dsm-set-model-size' }, modelReady(kind) ? '已安装' : size),
              ),
              downloadingState !== null && downloadingState.kind === kind
                ? h('span', { className: 'dsm-set-model-progress' }, '下载中 ' + String(percent) + '%')
                : (modelReady(kind)
                  ? h('div', { className: 'dsm-set-model-actions' },
                    h('button', {
                      type: 'button',
                      className: 'dsm-btn dsm-btn--sm',
                      disabled: downloading !== '',
                      onClick: () => { void downloadModel(kind, true) },
                    }, '重装'),
                    h('button', {
                      type: 'button',
                      className: 'dsm-btn dsm-btn--sm dsm-btn--danger',
                      onClick: () => { void removeModel(kind) },
                    }, '卸载'),
                  )
                  : h('button', {
                    type: 'button',
                    className: 'dsm-btn dsm-btn--sm dsm-btn--primary',
                    disabled: downloading !== '',
                    onClick: () => { void downloadModel(kind) },
                  }, downloading === kind ? '下载中…' : '下载')),
            )),
          )
            : null,
          transcribeMode === 'local'
            ? h('div', { className: 'dsm-set-inline' },
              h('label', { className: 'dsm-check' },
                h('input', {
                  type: 'checkbox',
                  checked: settings.diarize === true,
                  onChange: (event) => { void patchSettings({ diarize: event.target.checked }) },
                }),
                h('span', null, '启用真说话人分离（需三个模型就绪）'),
              ),
            )
            : null,
          transcribeMode === 'cloud'
            ? h(
              'div',
              { className: 'dsm-set-cloud' },
              h('div', { className: 'dsm-set-tabs' },
                ...Object.entries({ iflytek: '讯飞', tencent: '腾讯云', aliyun: '阿里云' }).map(([key, label]) => h(
                  'button',
                  {
                    key: 'cloud-tab-' + key,
                    type: 'button',
                    className: 'dsm-set-tab' + (cloudTab === key ? ' dsm-set-tab--on' : ''),
                    onClick: () => {
                      setCloudTab(key)
                      if (transcribeMode === 'cloud') updateTranscribe({ provider: 'cloud-' + key })
                    },
                  },
                  h('span', { className: 'dsm-set-dot' + (cloudConfigured(key) ? ' dsm-set-dot--on' : '') }),
                  h('span', null, label),
                )),
              ),
              h('div', { className: 'dsm-set-cloud-actions' },
                h('button', {
                  type: 'button',
                  className: 'dsm-btn dsm-btn--sm dsm-btn--primary',
                  disabled: transcribeProvider === 'cloud-' + cloudTab,
                  onClick: () => setAsTranscribeEngine(cloudTab),
                }, transcribeProvider === 'cloud-' + cloudTab ? '当前使用中' : '设为转写引擎'),
                h('button', {
                  type: 'button',
                  className: 'dsm-btn dsm-btn--sm',
                  onClick: () => { void testCloud(cloudTab) },
                }, '校验配置'),
                cloudConfigured(cloudTab)
                  ? h('span', { className: 'dsm-set-badge dsm-set-badge--ok' }, '已填写凭据')
                  : h('span', { className: 'dsm-set-badge' }, '未填写凭据'),
              ),
              cloudTab === 'iflytek'
                ? h('div', { className: 'dsm-set-grid' },
                  h(Field, { label: 'AppID' }, h(TextInput, { value: cloudConfig.iflytek?.appId ?? '', onChange: (value) => updateCloud('iflytek', 'appId', value), placeholder: '讯飞控制台 AppID' })),
                  h(Field, { label: 'APIKey' }, h(TextInput, { value: cloudConfig.iflytek?.apiKey ?? '', onChange: (value) => updateCloud('iflytek', 'apiKey', value) })),
                  h(Field, { label: 'APISecret' }, h(TextInput, { value: cloudConfig.iflytek?.apiSecret ?? '', onChange: (value) => updateCloud('iflytek', 'apiSecret', value) })),
                )
                : null,
              cloudTab === 'tencent'
                ? h('div', { className: 'dsm-set-grid' },
                  h(Field, { label: 'SecretId' }, h(TextInput, { value: cloudConfig.tencent?.secretId ?? '', onChange: (value) => updateCloud('tencent', 'secretId', value) })),
                  h(Field, { label: 'SecretKey' }, h(TextInput, { value: cloudConfig.tencent?.secretKey ?? '', onChange: (value) => updateCloud('tencent', 'secretKey', value) })),
                  h(Field, { label: '地域' }, h(TextInput, { value: cloudConfig.tencent?.region ?? 'ap-shanghai', onChange: (value) => updateCloud('tencent', 'region', value) })),
                  h(Field, { label: '引擎' }, h(TextInput, { value: cloudConfig.tencent?.engine ?? '16k_zh', onChange: (value) => updateCloud('tencent', 'engine', value) })),
                )
                : null,
              cloudTab === 'aliyun'
                ? h('div', { className: 'dsm-set-grid' },
                  h(Field, { label: 'AppKey' }, h(TextInput, { value: cloudConfig.aliyun?.appKey ?? '', onChange: (value) => updateCloud('aliyun', 'appKey', value) })),
                  h(Field, { label: 'AccessKeyId' }, h(TextInput, { value: cloudConfig.aliyun?.accessKeyId ?? '', onChange: (value) => updateCloud('aliyun', 'accessKeyId', value) })),
                  h(Field, { label: 'AccessKeySecret' }, h(TextInput, { value: cloudConfig.aliyun?.accessKeySecret ?? '', onChange: (value) => updateCloud('aliyun', 'accessKeySecret', value) })),
                  h(Field, { label: '地域' }, h(TextInput, { value: cloudConfig.aliyun?.region ?? 'cn-shanghai', onChange: (value) => updateCloud('aliyun', 'region', value) })),
                )
                : null,
              h('div', { className: 'dsm-hint' }, '凭据只保存在本机会议数据文件里；切换云端后，录音会实时上传到对应云服务。'),
            )
            : null,
        ),
        h('div', { className: 'dsm-set-section' },
          h('div', { className: 'dsm-set-section-head' },
            h('span', { className: 'dsm-set-section-title' }, '会议总结模型'),
            h('span', { className: 'dsm-set-section-desc' }, '把转写整理成结构化纪要（一句话结论/决策/待办）。'),
          ),
          radioRow(
            summaryMode === 'dsh',
            () => { if (summaryMode === 'custom') { setLocalSummaryMode('dsh'); updateSummary({ mode: 'dsh' }) } },
            '使用 DSH 已配置模型',
            '与 DSH 设置里的模型一致；也可以在这里单独指定',
            null,
          ),
          summaryMode === 'dsh'
            ? h('div', { className: 'dsm-set-grid' },
              h(Field, { label: 'DSH 模型' }, h(Select, {
                value: summarySelection,
                onChange: (value) => { void saveSummarySelection(value) },
                options: [
                  { value: '', label: defaultModelLabel },
                  ...dshModels.map((item) => ({ value: item.provider + '|' + item.id, label: item.name + '（' + (item.displayName || item.provider) + '）' })),
                ],
              })),
            )
            : null,
          radioRow(
            summaryMode === 'custom',
            () => { if (summaryMode !== 'custom') { setLocalSummaryMode('custom'); updateSummary({ mode: 'custom' }) } },
            '手动配置模型接口',
            '任意 OpenAI 兼容接口（/chat/completions）',
            null,
          ),
          summaryMode === 'custom'
            ? h('div', { className: 'dsm-set-grid' },
              h(Field, { label: '接口地址' }, h(TextInput, { value: settings.summary.custom?.baseUrl ?? '', onChange: (value) => updateSummaryCustom('baseUrl', value), placeholder: 'https://api.example.com/v1' })),
              h(Field, { label: '模型名' }, h(TextInput, { value: settings.summary.custom?.model ?? '', onChange: (value) => updateSummaryCustom('model', value), placeholder: 'qwen-max' })),
              h(Field, { label: 'API Key' }, h(TextInput, { value: settings.summary.custom?.apiKey ?? '', onChange: (value) => updateSummaryCustom('apiKey', value), placeholder: '可留空（本地服务）' })),
              h(Field, { label: '温度' }, h(TextInput, { value: String(settings.summary.custom?.temperature ?? 0.3), onChange: (value) => updateSummaryCustom('temperature', Number(value) || 0.3) })),
            )
            : null,
        ),
        h('div', { className: 'dsm-set-section' },
          h('div', { className: 'dsm-set-section-head' },
            h('span', { className: 'dsm-set-section-title' }, '转写纠错与术语'),
            h('span', { className: 'dsm-set-section-desc' }, '录音结束后用总结模型把转写里的错别字、人名、术语改正确（不改内容）。'),
          ),
          h('label', { className: 'dsm-check' },
            h('input', {
              type: 'checkbox',
              checked: settings.correctTranscript === true,
              onChange: (event) => { void patchSettings({ correctTranscript: event.target.checked }) },
            }),
            h('span', null, '录音结束后自动纠错一次'),
          ),
          h(Field, { label: '术语表（一行一个，最多 60 字/条）' }, h(TextArea, {
            rows: 4,
            value: termsText,
            onChange: (value) => { termsTouchedRef.current = true; setTermsText(value) },
            onBlur: () => { void saveTerms() },
            placeholder: '多个名词换行输入',
          })),
          termsSaving ? h('div', { className: 'dsm-hint' }, '术语保存中…') : null,
        ),
        error !== null ? h('div', { className: 'dsm-inline-error' }, error) : null,
      )

      const autoPage = h(
        'div',
        { className: 'dsm-set-page' },
        h('div', { className: 'dsm-set-section' },
          h('div', { className: 'dsm-set-section-head' },
            h('span', { className: 'dsm-set-section-title' }, '自动入库'),
            h('span', { className: 'dsm-set-section-desc' }, '定时扫描本机录制文件，自动导入成待整理会议。'),
          ),
          h('label', { className: 'dsm-check' },
            h('input', { type: 'checkbox', checked: enabled, disabled: !available, onChange: (event) => setEnabled(event.target.checked) }),
            h('span', null, '开启自动入库'),
          ),
          h('label', { className: 'dsm-check' },
            h('input', { type: 'checkbox', checked: tencent, disabled: !available, onChange: (event) => setTencent(event.target.checked) }),
            h('span', null, '读取腾讯会议本地录制'),
          ),
          h(Field, { label: '额外监控目录（一行一个路径）' }, h(TextArea, {
            rows: 4,
            value: dirsText,
            onChange: setDirsText,
            placeholder: 'C:\\Users\\me\\Videos\\TencentMeeting\nC:\\Users\\me\\Documents\\会议录音',
          })),
          h('div', { className: 'dsm-hint' }, '支持 audio / video / txt / md / docx；新文件在下一次扫描时导入。'),
        ),
        available
          ? h('div', { className: 'dsm-set-grid dsm-set-grid--cards' },
            h('div', { className: 'dsm-set-card' },
              h('div', { className: 'dsm-set-card-k' }, '运行状态'),
              h('div', { className: 'dsm-set-card-v' }, scanning || status?.scanning === true ? '扫描中…' : (status?.enabled === false ? '已停用' : '运行中')),
            ),
            h('div', { className: 'dsm-set-card' },
              h('div', { className: 'dsm-set-card-k' }, '已自动导入 / 失败'),
              h('div', { className: 'dsm-set-card-v' }, String(Number(status?.importedCount) || 0) + ' 场 · ' + String(Number(status?.failedCount) || 0) + ' 个失败来源'),
            ),
            h('div', { className: 'dsm-set-card' },
              h('div', { className: 'dsm-set-card-k' }, '上次扫描'),
              h('div', { className: 'dsm-set-card-v' }, status?.lastScanAt ? formatStamp(status.lastScanAt) : '尚未扫描'),
            ),
          )
          : h('div', { className: 'dsm-hint dsm-hint--warn' }, '宿主未提供自动入库服务，当前无法配置。'),
        error !== null ? h('div', { className: 'dsm-inline-error' }, error) : null,
      )

      const footer = page === 'auto'
        ? [
          h('button', { key: 'close', type: 'button', className: 'dsm-btn', onClick: props.onClose }, '关闭'),
          h('button', {
            key: 'scan',
            type: 'button',
            className: 'dsm-btn',
            disabled: scanning || !enabled,
            onClick: () => { void handleScan() },
          }, scanning ? h('span', { className: 'dsm-spin' }) : h(Icon, { name: 'refresh', size: 13 }), h('span', null, scanning ? '扫描中…' : '立即扫描')),
          h('button', { key: 'save', type: 'button', className: 'dsm-btn dsm-btn--primary', disabled: busy, onClick: () => { void handleSaveAuto() } }, '保存'),
        ]
        : [h('button', { key: 'close', type: 'button', className: 'dsm-btn dsm-btn--primary', onClick: props.onClose }, '完成')]

      return h(
        Modal,
        {
          title: '设置',
          subtitle: '模型与自动入库。改动即时保存。',
          wide: true,
          onClose: props.onClose,
          footer,
        },
        h(
          'div',
          { className: 'dsm-set-layout' },
          h(
            'nav',
            { className: 'dsm-set-nav' },
            h('button', {
              key: 'nav-model',
              type: 'button',
              className: 'dsm-set-nav-item' + (page === 'model' ? ' dsm-set-nav-item--on' : ''),
              onClick: () => setPage('model'),
            }, h(Icon, { name: 'sliders', size: 13 }), h('span', null, '模型配置')),
            h('button', {
              key: 'nav-auto',
              type: 'button',
              className: 'dsm-set-nav-item' + (page === 'auto' ? ' dsm-set-nav-item--on' : ''),
              onClick: () => setPage('auto'),
            }, h(Icon, { name: 'folder', size: 13 }), h('span', null, '自动入库')),
          ),
          h('div', { className: 'dsm-set-content' }, page === 'model' ? modelPage : autoPage),
        ),
      )
    }

    function ImportTextModal(props) {
      const meeting = props.meeting
      const [tab, setTab] = useState('paste')
      const [text, setText] = useState('')
      const [fileName, setFileName] = useState('')
      const [mode, setMode] = useState('replace')
      const [title, setTitle] = useState(meeting ? meeting.title : `会议纪要 ${todayKey()}`)
      const [date, setDate] = useState(meeting?.date ?? todayKey())
      const [attendees, setAttendees] = useState((meeting?.attendees ?? []).join('，'))
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const fileRef = useRef(null)
      // Parsing a large Tencent JSON export on every keystroke would be wasteful;
      // derive the preview once per text change instead.
      const preview = useMemo(() => extractTencentText(text), [text])

      const readFile = async (file) => {
        if (!file) return
        setError(null)
        try {
          const raw = await file.text()
          setText(raw)
          setFileName(file.name)
          setTab('paste')
          if (!meeting) {
            const nextTitle = defaultImportTitle(file.name)
            setTitle((previous) => (previous.trim() === '' ? nextTitle : previous))
          }
        } catch (caught) {
          setError(`读取文件失败：${messageOf(caught)}`)
        }
      }

      const submit = async () => {
        const extracted = preview
        if (extracted === '') {
          setError('请先粘贴或导入会议纪要文本')
          return
        }
        setBusy(true)
        setError(null)
        try {
          if (meeting) {
            const patch = mode === 'append'
              ? { transcript: extracted, appendTranscript: true }
              : { transcript: extracted }
            await patchMeeting(meeting.id, patch)
            notifySuccess(
              mode === 'append' ? '已追加转写文本' : '已替换转写文本',
              `${formatChars(extracted.length)} · ${meeting.title} · 建议重新生成 AI 纪要`,
            )
          } else {
            const created = await createMeeting({
              title: title.trim() || `会议纪要 ${todayKey()}`,
              date: date || todayKey(),
              attendees: splitAttendees(attendees),
              sourceType: 'text',
              transcript: extracted,
            })
            notifySuccess('已导入会议纪要', `${created.title} · ${formatChars(extracted.length)}`)
          }
          props.onClose()
        } catch (caught) {
          setError(messageOf(caught))
          reportError(caught, '导入纪要失败')
        } finally {
          setBusy(false)
        }
      }

      const footer = [
        h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: props.onClose }, '取消'),
        h('button', {
          key: 'ok',
          type: 'button',
          className: 'dsm-btn dsm-btn--primary',
          onClick: submit,
          disabled: busy,
        }, busy ? '导入中…' : meeting ? (mode === 'append' ? '追加到当前会议' : '替换当前转写') : '创建并导入'),
      ]

      return h(
        Modal,
        {
          title: meeting ? '导入纪要文本' : '导入腾讯会议纪要',
          subtitle: meeting
            ? `目标会议：${meeting.title}。可粘贴腾讯会议导出的文本，或选择 .txt / .md / .json 文件。`
            : '粘贴腾讯会议纪要文本，或选择 .txt / .md / .json 文件；JSON 会自动提取正文。',
          onClose: props.onClose,
          footer,
        },
        h(
          'div',
          { className: 'dsm-tabs' },
          h('button', {
            type: 'button',
            className: `dsm-tab${tab === 'paste' ? ' dsm-tab--active' : ''}`,
            onClick: () => setTab('paste'),
          }, '粘贴文本'),
          h('button', {
            type: 'button',
            className: `dsm-tab${tab === 'file' ? ' dsm-tab--active' : ''}`,
            onClick: () => setTab('file'),
          }, '选择文件'),
        ),
        tab === 'paste'
          ? h(TextArea, {
            value: text,
            onChange: setText,
            rows: 10,
            placeholder: '在此粘贴会议纪要、转写文本或腾讯会议导出的 JSON…',
          })
          : h(
            'div',
            { className: 'dsm-file-pick' },
            h('button', {
              type: 'button',
              className: 'dsm-btn',
              onClick: () => { fileRef.current?.click() },
            }, h(Icon, { name: 'folder', size: 13 }), h('span', null, '选择 .txt / .md / .json 文件')),
            fileName !== '' ? h('span', { className: 'dsm-file-name' }, `已选择：${fileName}`) : null,
            h('input', {
              ref: fileRef,
              type: 'file',
              className: 'dsm-hidden',
              accept: '.txt,.md,.json,text/plain,text/markdown,application/json',
              onChange: (event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (file) void readFile(file)
              },
            }),
          ),
        text !== '' ? h('div', { className: 'dsm-hint' }, `将导入 ${formatChars(preview.length)}，JSON 会自动提取正文。`) : null,
        meeting
          ? h(
            'div',
            { className: 'dsm-field' },
            h('span', { className: 'dsm-label' }, '写入方式'),
            h(
              'div',
              { className: 'dsm-radio-row' },
              h('label', { className: 'dsm-radio' }, h('input', {
                type: 'radio',
                name: 'dsm-import-mode',
                checked: mode === 'replace',
                onChange: () => setMode('replace'),
              }), '替换现有转写'),
              h('label', { className: 'dsm-radio' }, h('input', {
                type: 'radio',
                name: 'dsm-import-mode',
                checked: mode === 'append',
                onChange: () => setMode('append'),
              }), '追加到现有转写'),
            ),
          )
          : h(
            'div',
            null,
            h(
              'div',
              { className: 'dsm-row' },
              h(Field, { label: '会议标题' }, h(TextInput, { value: title, onChange: setTitle })),
              h(Field, { label: '会议日期' }, h(TextInput, { type: 'date', value: date, onChange: setDate })),
            ),
            h(Field, { label: '参会人（逗号分隔）' }, h(TextInput, {
              value: attendees,
              onChange: setAttendees,
              placeholder: '张三，李四',
            })),
          ),
        error !== null ? h('div', { className: 'dsm-inline-error' }, error) : null,
      )
    }

    function SpeechProgressCard() {
      const state = useSnapshot()
      const speech = state.speech ?? state.data?.speech
      const provider = speechProvider(speech)
      const progress = state.speechProgress
      const percent = progress !== null ? Math.round(progress.ratio * 100) : null
      const label = state.speechMessage !== '' ? state.speechMessage : `语音识别：${speechPhaseLabel(provider?.phase)}`
      return h(
        'div',
        { className: 'dsm-progress-card' },
        h(
          'div',
          { className: 'dsm-progress-head' },
          h('span', { className: 'dsm-spin' }),
          h('span', { className: 'dsm-progress-title' }, label),
          percent !== null ? h('span', { className: 'dsm-progress-pct' }, `${percent}%`) : null,
        ),
        progress !== null ? h(ProgressBar, { ratio: progress.ratio }) : null,
        progress !== null && progress.total > 0
          ? h('div', { className: 'dsm-progress-meta' }, `${formatBytes(progress.done)} / ${formatBytes(progress.total)}${progress.resource ? ` · ${progress.resource}` : ''}`)
          : null,
        h('div', { className: 'dsm-hint' }, '首次使用需要下载并加载本地语音模型，请保持页面打开。'),
      )
    }

    function RecordModal(props) {
      const state = useSnapshot()
      const live = state.live ?? initialLiveState()
      const [tab, setTab] = useState(props.initialTab === 'file' ? 'file' : 'record')
      const [form, setForm] = useState(() => ({
        title: defaultRecordingTitle(),
        date: todayKey(),
        attendees: '',
        screen: false,
        screenSource: 'desktop',
      }))
      const [screenSources, setScreenSources] = useState(() => [])
      const [screenSourceError, setScreenSourceError] = useState(null)
      const [localError, setLocalError] = useState(null)
      const [fileStage, setFileStage] = useState('idle')
      const [fileError, setFileError] = useState(null)
      const [fileResult, setFileResult] = useState(null)
      const [processLabel, setProcessLabel] = useState('')
      const [pickedName, setPickedName] = useState('')
      const [inputDevices, setInputDevices] = useState(() => [])
      const [inputDeviceId, setInputDeviceId] = useState(() => selectedInputDeviceId)
      const fileRef = useRef(null)
      const mountedRef = useRef(true)
      const runSeqRef = useRef(0)
      const createdRef = useRef(null)

      const speech = state.speech ?? state.data?.speech
      const speechAvailable = speechUsable(speech) || state.data?.transcribe?.ready === true
      const liveActive = liveIsActive(live)
      const liveStatus = live.status
      const fileBusy = fileStage === 'preparing' || fileStage === 'processing'
      const dismissible = liveActive || fileStage !== 'processing'

      // 桌面浮窗接管后自动收起这个白色弹窗（录音中才收，避免误关文件转写进度）
      useEffect(() => {
        if (liveStatus !== 'recording') return
        if (state.orbActive !== true) return
        props.onClose()
      }, [liveStatus, state.orbActive])

      const update = (key) => (value) => setForm((previous) => ({ ...previous, [key]: value }))
      const [micTesting, setMicTesting] = useState(false)
      const [micLevel, setMicLevel] = useState(0)
      const micTestRef = useRef(null)

      /** 停止麦克风检测并释放音频资源。 */
      const stopMicTest = () => {
        const handle = micTestRef.current
        micTestRef.current = null
        if (handle !== null && handle !== undefined) {
          try { window.clearInterval(handle.timer) } catch { }
          try { handle.source.disconnect() } catch { }
          try { handle.analyser.disconnect() } catch { }
          try { handle.context.close() } catch { }
          try { handle.stream.getTracks().forEach((track) => track.stop()) } catch { }
        }
        setMicTesting(false)
        setMicLevel(0)
      }

      /** 开始麦克风检测：实时读取音量，用横向格子条显示。 */
      const startMicTest = async () => {
        if (micTesting) { stopMicTest(); return }
        try {
          const audio = inputDeviceId === ''
            ? { channelCount: 1, echoCancellation: true, noiseSuppression: true }
            : { deviceId: { exact: inputDeviceId }, channelCount: 1, echoCancellation: true, noiseSuppression: true }
          const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false })
          const Ctor = window.AudioContext ?? window.webkitAudioContext
          if (typeof Ctor !== 'function') throw new Error('当前环境不支持音频检测')
          const context = new Ctor()
          const source = context.createMediaStreamSource(stream)
          const analyser = context.createAnalyser()
          analyser.fftSize = 512
          analyser.smoothingTimeConstant = 0.6
          source.connect(analyser)
          const data = new Uint8Array(analyser.fftSize)
          const timer = window.setInterval(() => {
            analyser.getByteTimeDomainData(data)
            let sum = 0
            for (let index = 0; index < data.length; index += 1) {
              const value = (data[index] - 128) / 128
              sum += value * value
            }
            const rms = Math.sqrt(sum / data.length)
            // 放大到 0~1：安静时约 0.02，正常说话 0.15~0.5
            setMicLevel((previous) => {
              const next = Math.min(1, rms * 3.4)
              return next > previous ? next : previous * 0.72
            })
          }, 70)
          micTestRef.current = { stream, context, source, analyser, timer }
          setMicTesting(true)
          setLocalError(null)
        } catch (error) {
          reportError(error, '麦克风检测失败')
        }
      }

      useEffect(() => () => {
        const handle = micTestRef.current
        if (handle !== null && handle !== undefined) {
          try { window.clearInterval(handle.timer) } catch { }
          try { handle.stream.getTracks().forEach((track) => track.stop()) } catch { }
          try { handle.context.close() } catch { }
        }
        micTestRef.current = null
      }, [])

      /** 在被选中的屏幕上闪一下「当前录制屏幕」。 */
      async function identifyScreenNow() {
        try {
          const payload = await requestJson('/screen/identify', { method: 'POST', body: { source: form.screenSource } })
          if (payload?.ok !== true) throw new Error(payload?.error ?? '屏幕识别失败')
          notifySuccess(
            '已在「' + String(payload?.label ?? '所选屏幕') + '」上显示提示',
            '约 3 秒后自动消失；若没看到，请确认这块显示器在你当前视野内',
          )
        } catch (error) {
          reportError(error, '屏幕识别失败')
        }
      }

      /** 状态卡里的「开启/关闭录屏」：开启时按需拉取屏幕列表。 */
      const toggleScreen = () => {
        const next = form.screen !== true
        update('screen')(next)
        if (next && screenSources.length === 0) {
          void requestJson('/screen/sources').then((payload) => {
            const list = Array.isArray(payload?.sources) ? payload.sources : []
            setScreenSources(list)
            setScreenSourceError(list.length === 0 ? '没有发现可录制的屏幕' : null)
            if (list.length > 0) update('screenSource')(list[0].id)
          }).catch((error) => {
            setScreenSourceError(messageOf(error))
          })
        }
      }

      useEffect(() => {
        mountedRef.current = true
        return () => {
          mountedRef.current = false
          runSeqRef.current += 1
        }
      }, [])

      // 设备列表：弹窗打开时枚举一次，插拔设备时刷新；开始录音后再枚举一次
      // （拿到麦克风权限后 label 才有可读名称，之前只能显示「麦克风 N」）。
      useEffect(() => {
        let cancelled = false
        const refresh = async () => {
          const devices = await listAudioInputDevices()
          if (!cancelled) setInputDevices(devices)
        }
        void refresh()
        const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
        if (media && typeof media.addEventListener === 'function') {
          media.addEventListener('devicechange', refresh)
          return () => {
            cancelled = true
            media.removeEventListener('devicechange', refresh)
          }
        }
        return () => { cancelled = true }
      }, [])

      useEffect(() => {
        if (!liveActive) return undefined
        let cancelled = false
        void listAudioInputDevices().then((devices) => {
          if (!cancelled) setInputDevices(devices)
        })
        return () => { cancelled = true }
      }, [liveActive])

      async function runFileImport(file) {
        if (!file) return
        const run = runSeqRef.current + 1
        runSeqRef.current = run
        const alive = () => mountedRef.current && runSeqRef.current === run
        setPickedName(file.name)
        setFileError(null)
        setFileStage('preparing')
        try {
          await waitForSpeechReady()
          if (!alive()) return
          const meeting = await createMeeting({
            title: form.title.trim() || defaultImportTitle(file.name),
            date: form.date || todayKey(),
            attendees: splitAttendees(form.attendees),
            sourceType: 'recording',
          })
          if (!alive()) {
            void discardMeetingQuietly(meeting.id)
            return
          }
          createdRef.current = meeting.id
          setFileStage('processing')
          setProcessLabel('正在解码音频…')
          const chunks = await audioBlobToWavChunks(file)
          if (!alive()) return
          setProcessLabel(`音频已切分为 ${chunks.length} 段，开始识别…`)
          const outcome = await transcribeAudioChunks(meeting.id, chunks)
          if (!alive()) return
          const text = outcome.text.trim()
          if (text === '') {
            throw new Error('没有识别到文字，请确认音频中有清晰语音，或改用文本导入')
          }
          setProcessLabel('正在保存转写…')
          await patchMeeting(meeting.id, { transcript: text })
          if (!alive()) return
          setFileResult({
            meetingId: meeting.id,
            chars: text.length,
            seconds: Math.round(outcome.audioSeconds),
            chunks: outcome.total,
          })
          setFileStage('done')
          notifySuccess('音频转写完成', `已识别 ${formatChars(text.length)}，可以生成 AI 纪要`)
        } catch (caught) {
          if (!alive()) return
          setFileStage('error')
          setFileError(messageOf(caught))
          reportError(caught, '音频转写失败')
        }
      }

      function closeModal() {
        runSeqRef.current += 1
        props.onClose()
      }

      function closeAfterFileDone() {
        props.onClose()
      }

      function deleteFileMeeting() {
        const id = createdRef.current
        props.onClose()
        if (id !== null) void discardMeetingQuietly(id)
      }

      function fallbackToTextImport() {
        runSeqRef.current += 1
        props.onClose()
        props.onOpenTextImport()
      }

      function startLive() {
        // Urgent meeting: start first, name later. An empty title becomes the
        // automatic placeholder and the summarizer proposes a real one later.
        setLocalError(null)
        const wantScreen = form.screen === true
        void startLiveRecording({
          title: form.title.trim() === '' ? undefined : form.title.trim(),
          date: form.date || todayKey(),
          attendees: splitAttendees(form.attendees),
          screen: wantScreen,
          screenSource: form.screenSource ?? screenSources[0]?.id ?? 'desktop',
        })
      }

      function finishLiveAndClose() {
        clearLiveRecording()
        props.onClose()
      }

      function summarizeLive() {
        const meetingId = live.result?.meetingId ?? live.meetingId
        clearLiveRecording()
        props.onClose()
        if (meetingId) props.onSummarize(meetingId)
      }

      function fallbackLive() {
        clearLiveRecording()
        props.onClose()
        props.onOpenTextImport()
      }

      function keepLiveAndClose() {
        clearLiveRecording()
        props.onClose()
      }

      function deleteLive() {
        void deleteLiveMeeting()
        props.onClose()
      }

      const liveTitle = liveStatus === 'preparing'
        ? '正在准备会议'
        : liveStatus === 'paused'
          ? '会议已暂停'
          : liveStatus === 'recording'
            ? '会议进行中'
          : liveStatus === 'stopping'
            ? '正在结束会议'
            : liveStatus === 'done'
              ? '会议已结束'
              : liveStatus === 'error'
                ? '会议中断'
                : (tab === 'file' ? '录音转写' : '实时录音')
      const title = liveStatus !== 'idle'
        ? liveTitle
        : fileStage === 'done'
          ? '音频转写完成'
          : fileStage === 'error'
            ? '音频转写失败'
            : (tab === 'file' ? '录音转写' : '实时录音/录屏')
      const subtitle = liveStatus === 'preparing'
        ? '正在启动语音识别，就绪后自动开始录音。'
        : liveStatus === 'paused'
          ? '已暂停采集，点「继续」接着录。'
          : liveStatus === 'recording'
          ? '实时转写约 6–10 秒延迟；关闭弹窗后仍在后台录音。'
          : liveStatus === 'stopping'
            ? '正在等待最后几段识别结果，完成后自动保存。'
            : liveStatus === 'done' || liveStatus === 'error'
              ? '录音已结束，转写内容已保存到会议。'
              : fileStage === 'preparing'
                ? '正在准备语音识别，就绪后自动转写文件。'
                : fileStage === 'processing'
                  ? '正在解码并识别音频文件，请保持页面打开。'
                  : (tab === 'file'
                    ? '选择音频或视频文件，识别完成后自动保存到会议。'
                    : '实时转写约 6–10 秒延迟；关闭弹窗后仍在后台录音。')

      let body = null
      if (liveActive) {
        const preparing = liveStatus === 'preparing'
        const stopping = liveStatus === 'stopping'
        body = [
          h(
            'div',
            { key: 'live', className: 'dsm-live-panel' },
            h(
              'div',
              { className: 'dsm-live-head' },
              h('span', { className: 'dsm-livebar-dot' }),
              h('span', null, preparing
                ? '正在准备语音识别…'
                : stopping
                  ? '正在结束会议…'
                  : liveStatus === 'paused'
                    ? '已暂停录音'
                    : '正在录音'),
              h('span', { className: 'dsm-hint' }, live.meetingTitle ?? ''),
              live.screen === true
                ? h('span', { className: 'dsm-live-badge' }, '录屏中')
                : null,
            ),
            h(
              'div',
              { className: 'dsm-live-grid' },
              h(
                'div',
                { className: 'dsm-live-stat' },
                h('div', { className: 'dsm-live-stat-label' }, '录音时长'),
                h('div', { className: 'dsm-live-stat-value' }, formatTimer(live.elapsedSeconds)),
              ),
              h(
                'div',
                { className: 'dsm-live-stat' },
                h('div', { className: 'dsm-live-stat-label' }, '已转写字数'),
                h('div', { className: 'dsm-live-stat-value' }, formatChars(live.chars)),
              ),
            ),
            h('div', { className: 'dsm-level' }, h('div', {
              className: 'dsm-level-bar',
              style: { width: `${Math.max(4, Math.round((live.level ?? 0) * 100))}%` },
            })),
            h(
              'div',
              { className: 'dsm-live-last' },
              h('div', { className: 'dsm-live-last-label' }, '最近一句'),
              live.lastText !== ''
                ? live.lastText
                : (preparing
                  ? '等待语音模型就绪…'
                  : liveStatus === 'paused'
                    ? '已暂停采集，已识别内容已保留'
                    : '等待第一段识别结果…（约 6–10 秒）'),
            ),
            preparing ? h(SpeechProgressCard, { key: 'speech' }) : null,
            stopping
              ? h(
                'div',
                { className: 'dsm-live-stopping' },
                h('span', { className: 'dsm-spin' }),
                h('span', null, '正在等待最后几段识别结果…'),
              )
              : null,
            h('div', { className: 'dsm-live-queue' }, `识别队列：在飞 ${live.inFlight} · 待发 ${live.queued} · 已发送 ${live.sentChunks} 段`),
            live.screen === true
              ? h('div', { className: 'dsm-hint' }, '屏幕录制中：停止录音后会生成「带配音的视频」和「音频文件」，可在下方点开所在文件夹。')
              : null,
            h('div', { className: 'dsm-hint' }, preparing
              ? '语音模型就绪后自动开始录音；关闭弹窗不会中断。'
              : liveStatus === 'paused'
                ? '暂停中不采集音频，也不计入时长；点「继续」在同一场会议里接着录。'
                : '可在后台录音，关闭弹窗不中断；停止后会等待所有在飞识别完成。'),
          ),
        ]
      } else if (liveStatus === 'done') {
        const result = live.result ?? { meetingId: live.meetingId, chars: live.chars, seconds: 0, sentChunks: live.sentChunks }
        body = [
          h(
            'div',
            { key: 'live-done', className: 'dsm-record-stage' },
            h('div', { className: 'dsm-done-icon' }, h(Icon, { name: 'check', size: 24 })),
            h('div', { className: 'dsm-stage-title' }, '会议已结束并已保存'),
            h('div', { className: 'dsm-stage-text' }, `已识别 ${formatChars(result.chars)}${result.seconds > 0 ? ` · 音频 ${formatDuration(result.seconds)}` : ''} · 共 ${result.sentChunks ?? live.sentChunks} 段。`),
            h('div', { className: 'dsm-hint' }, '接下来可以生成 AI 结构化纪要，或把待办写入DSH 待办。'),
            Array.isArray(live.media) && live.media.length > 0
              ? h(
                'div',
                { className: 'dsm-media-list' },
                h('div', { className: 'dsm-media-title' }, '本次已生成文件'),
                ...live.media.map((item, index) => h(
                  'div',
                  { key: 'media-' + String(index), className: 'dsm-media-row' },
                  h('span', { className: 'dsm-media-name' }, (item.kind === 'video' ? '视频' : '音频') + '：' + String(item.name ?? '') + (item.converting === true ? '（正在转换 MP4…）' : '')),
                  h('span', { className: 'dsm-media-size' }, formatBytes(item.bytes)),
                  h('button', {
                    type: 'button',
                    className: 'dsm-btn dsm-btn--sm',
                    disabled: item.converting === true,
                    title: item.converting === true ? '正在转换 MP4，稍后即可播放' : '用电脑默认播放器打开',
                    onClick: () => { void openMedia(result.meetingId ?? live.meetingId, item.kind) },
                  }, '播放'),
                  h('button', {
                    type: 'button',
                    className: 'dsm-btn dsm-btn--sm',
                    onClick: () => { void revealMedia(result.meetingId ?? live.meetingId, item.kind) },
                  }, '在文件夹中显示'),
                )),
              )
              : null,
          ),
        ]
      } else if (liveStatus === 'error') {
        body = [
          h(
            'div',
            { key: 'live-error', className: 'dsm-record-stage' },
            h('div', { className: 'dsm-inline-error' }, live.error ?? '实时转写失败'),
            live.chars > 0
              ? h('div', { className: 'dsm-stage-text' }, `已保留已识别的 ${formatChars(live.chars)}，可在会议里继续编辑或重新生成纪要。`)
              : h('div', { className: 'dsm-stage-text' }, '本次录音没有可用的转写内容，可以改用文本导入。'),
          ),
        ]
      } else if (fileStage === 'preparing') {
        body = [
          h(SpeechProgressCard, { key: 'speech' }),
          h('div', { key: 'hint', className: 'dsm-hint' }, '语音模型就绪后自动转写音频文件。'),
        ]
      } else if (fileStage === 'processing') {
        const active = state.transcribing
        body = [
          h(
            'div',
            { key: 'processing', className: 'dsm-record-stage' },
            h('span', { className: 'dsm-spin dsm-spin--lg' }),
            h('div', { className: 'dsm-stage-title' }, active !== null ? '正在转写音频文件' : (processLabel || '正在处理音频')),
            active !== null
              ? h('div', { className: 'dsm-stage-text' }, `正在识别第 ${Math.min(active.index + 1, active.total)} / ${active.total} 段 · 已识别 ${formatChars(active.chars)}`)
              : h('div', { className: 'dsm-stage-text' }, processLabel),
            active !== null ? h(ProgressBar, { ratio: active.total > 0 ? active.index / active.total : 0 }) : null,
            h('div', { className: 'dsm-hint' }, '文件转写可能需要几分钟，完成后会自动保存到会议。'),
          ),
        ]
      } else if (fileStage === 'done' && fileResult !== null) {
        body = [
          h(
            'div',
            { key: 'file-done', className: 'dsm-record-stage' },
            h('div', { className: 'dsm-done-icon' }, h(Icon, { name: 'check', size: 24 })),
            h('div', { className: 'dsm-stage-title' }, '音频转写完成并已保存'),
            h('div', { className: 'dsm-stage-text' }, `已识别 ${formatChars(fileResult.chars)}${fileResult.seconds > 0 ? ` · 音频 ${formatDuration(fileResult.seconds)}` : ''} · 共 ${fileResult.chunks} 段。`),
            h('div', { className: 'dsm-hint' }, '接下来可以生成 AI 结构化纪要，或把待办写入DSH 待办。'),
          ),
        ]
      } else if (fileStage === 'error') {
        body = [
          h('div', { key: 'file-error', className: 'dsm-inline-error' }, fileError ?? '音频转写失败'),
          h('div', { key: 'file-hint', className: 'dsm-hint' }, '可以改用「导入纪要」粘贴文本，或删除本次会议后重试。'),
        ]
      } else {
        body = [
          h(
            'div',
            { key: 'mode', className: 'dsm-record-mode' },
            h('span', { className: 'dsm-record-mode-icon' }, h(Icon, { name: tab === 'file' ? 'upload' : 'mic', size: 14 })),
            h(
              'div',
              { className: 'dsm-record-mode-body' },
              h('div', { className: 'dsm-record-mode-title' }, tab === 'file' ? '录音转写' : '实时录音/录屏'),
              h('div', { className: 'dsm-record-mode-text' }, tab === 'file'
                ? '导入已有的音频 / 视频文件，自动转成文字并保存到会议'
                : '打开麦克风边说边出字，关闭弹窗后仍在后台录音'),
            ),
          ),
                    tab === 'record'
            ? h(
              'div',
              { key: 'overview', className: 'dsm-rec-overview' },
              h(
                'div',
                { className: 'dsm-rec-item dsm-rec-item--wide' },
                h('span', { className: 'dsm-rec-item-icon' }, h(Icon, { name: 'mic', size: 15 })),
                h(
                  'div',
                  { className: 'dsm-rec-item-body' },
                  h('div', { className: 'dsm-rec-item-label' }, micTesting ? '麦克风（检测中，对着话筒说句话）' : '麦克风（点这里直接切换）'),
                  h(
                    'div',
                    { className: 'dsm-rec-select' },
                    h(Select, {
                      compact: true,
                      value: inputDeviceId,
                      onChange: (value) => {
                        if (micTesting) stopMicTest()
                        setInputDeviceId(value)
                        selectedInputDeviceId = value
                        writePreferredInputDevice(value)
                      },
                      options: [
                        { value: '', label: '系统默认输入设备' },
                        ...inputDevices.map((device) => ({ value: device.deviceId, label: device.label })),
                      ],
                    }),
                  ),
                  micTesting
                    ? h(
                      'div',
                      { className: 'dsm-mic-meter', title: '当前麦克风音量' },
                      ...Array.from({ length: 24 }, (_, index) => {
                        const active = micLevel >= (index + 1) / 24 * 0.92
                        const tone = index < 14 ? 'low' : (index < 20 ? 'mid' : 'high')
                        return h('span', {
                          key: 'mic-seg-' + String(index),
                          className: 'dsm-mic-seg dsm-mic-seg--' + tone + (active ? ' dsm-mic-seg--on' : ''),
                        })
                      }),
                    )
                    : null,
                ),
                h('button', {
                  type: 'button',
                  className: 'dsm-rec-toggle dsm-rec-toggle--ghost' + (micTesting ? ' dsm-rec-toggle--on' : ''),
                  disabled: liveActive,
                  title: micTesting ? '停止检测' : '检测麦克风音量（不说话时也应接近 0）',
                  onClick: () => { void startMicTest() },
                }, h(Icon, { name: micTesting ? 'stop' : 'mic', size: 12 }), h('span', null, micTesting ? '停止' : '检测')),
              ),
              h(
                'div',
                { className: 'dsm-rec-item' },
                h('span', { className: 'dsm-rec-item-icon dsm-rec-item-icon--speech' }, h(Icon, { name: 'sparkle', size: 15 })),
                h(
                  'div',
                  { className: 'dsm-rec-item-body' },
                  h('div', { className: 'dsm-rec-item-label' }, '语音识别'),
                  h('div', { className: 'dsm-rec-item-value' + (speechAvailable ? ' dsm-rec-item-value--on' : ' dsm-rec-item-value--warn') }, speechAvailable ? '已就绪' : (speech === null ? '检查中…' : '不可用')),
                ),
              ),
              h(
                'div',
                { className: 'dsm-rec-item dsm-rec-item--full' },
                h('span', { className: 'dsm-rec-item-icon dsm-rec-item-icon--screen' }, h(Icon, { name: 'screen', size: 15 })),
                h(
                  'div',
                  { className: 'dsm-rec-item-body' },
                  h('div', { className: 'dsm-rec-item-label' }, '录屏' + (form.screen === true ? '（已开启，结束后自动合成 MP4）' : '')),
                  form.screen === true
                    ? h(
                        'div',
                        { className: 'dsm-rec-select' },
                        h(Select, {
                          compact: true,
                          value: form.screenSource,
                          onChange: (value) => update('screenSource')(value),
                          options: screenSources.length > 0
                            ? screenSources.map((item) => ({ value: item.id, label: item.label }))
                            : [{ value: 'desktop', label: '整个桌面' }],
                        }),
                      )
                    : h('div', { className: 'dsm-rec-item-value' }, '未开启 · 点右侧按钮开启录屏'),
                ),
                form.screen === true
                  ? h('button', {
                    type: 'button',
                    className: 'dsm-rec-toggle dsm-rec-toggle--ghost',
                    title: '在被选中的屏幕上闪一下「当前录制屏幕」',
                    onClick: () => { void identifyScreenNow() },
                  }, h(Icon, { name: 'screen', size: 12 }), h('span', null, '识别'))
                  : null,
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dsm-rec-toggle' + (form.screen === true ? ' dsm-rec-toggle--on' : ''),
                    disabled: liveActive,
                    title: form.screen === true ? "关闭录屏" : "开启录屏（结束后自动合成 MP4）",
                    onClick: () => { toggleScreen() },
                  },
                  h(Icon, { name: form.screen === true ? 'close' : 'play', size: 12 }),
                  h('span', null, form.screen === true ? '关闭' : '开启'),
                ),
              ),
              screenSourceError !== null ? h('div', { className: 'dsm-hint dsm-hint--warn', style: { gridColumn: '1 / -1' } }, '读取屏幕列表失败：' + screenSourceError) : null,
            )
            : null,
          tab === 'record' && form.screen === true
            ? h(
              'div',
              { key: 'produce', className: 'dsm-rec-produce' },
              h(Icon, { name: 'play', size: 12 }),
              h('span', null, '结束后自动生成：MP4 视频（带配音） + WAV 音频'),
            )
            : null,
          h(
            'div',
            { key: 'form', className: 'dsm-rec-form' },
            h(
              'div',
              { className: 'dsm-rec-title' },
              h(Field, { label: '会议标题（留空自动命名）' }, h(TextInput, {
                value: form.title,
                onChange: update('title'),
                placeholder: defaultRecordingTitle(),
              })),
            ),
            h(
              'div',
              { className: 'dsm-row' },
              h(Field, { label: '会议日期' }, h(TextInput, { type: 'date', value: form.date, onChange: update('date') })),
              h(Field, { label: '参会人（逗号分隔）' }, h(TextInput, {
                value: form.attendees,
                onChange: update('attendees'),
                placeholder: '张三，李四',
              })),
            ),
          ),
          h(
            'div',
            { key: 'hint', className: 'dsm-rec-tip' },
            tab === 'record'
              ? '麦克风选择会记住；识别不出文字时，可先切换设备再试说一句。'
              : '文件转写使用浏览器解码 → 16kHz 单声道 PCM16 WAV → 90 秒切片逐段识别；支持 WAV / MP3 / M4A / MP4 / WebM。',
          ),

          speechAvailable
            ? null
            : h('div', {
              key: 'speech-warn',
              className: 'dsm-hint dsm-hint--warn',
            }, speech === null
              ? '正在检查语音识别服务…'
              : '本机语音识别服务不可用，录音按钮不可用；请改用「导入纪要」的文本方式。'),
          tab === 'file'
            ? h(
              'div',
              { key: 'file', className: 'dsm-file-pick' },
              h('button', {
                type: 'button',
                className: 'dsm-btn',
                onClick: () => { fileRef.current?.click() },
                disabled: !speechAvailable || fileBusy,
              }, h(Icon, { name: 'upload', size: 13 }), h('span', null, '选择音频 / 视频文件')),
              pickedName !== '' ? h('span', { className: 'dsm-file-name' }, `已选择：${pickedName}`) : null,
              h('input', {
                ref: fileRef,
                type: 'file',
                className: 'dsm-hidden',
                accept: 'audio/*,video/*,.m4a,.mp4,.wav,.mp3,.webm',
                onChange: (event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void runFileImport(file)
                },
              }),
            )
            : null,
          localError !== null
            ? h('div', { key: 'local-error', className: 'dsm-inline-error' }, localError)
            : null,
        ]
      }

      let footer = null
      if (liveActive) {
        if (liveStatus === 'preparing') {
          footer = [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsm-btn dsm-btn--danger',
              onClick: () => { void cancelLiveRecording(); props.onClose() },
            }, '取消并删除会议'),
            h('button', { key: 'bg', type: 'button', className: 'dsm-btn', onClick: closeAfterFileDone }, '后台准备（关闭）'),
          ]
        } else if (liveStatus === 'paused') {
          footer = [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsm-btn dsm-btn--danger',
              onClick: () => { void cancelLiveRecording(); props.onClose() },
            }, '取消并删除会议'),
            h('button', { key: 'bg', type: 'button', className: 'dsm-btn', onClick: closeAfterFileDone }, '后台（关闭）'),
            h('button', {
              key: 'resume',
              type: 'button',
              className: 'dsm-btn',
              onClick: () => { void resumeLiveRecording() },
            }, '继续录音'),
            h('button', {
              key: 'stop',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: () => { void stopLiveRecording('user') },
            }, h(Icon, { name: 'stop', size: 12 }), h('span', null, '结束会议')),
          ]
        } else if (liveStatus === 'recording') {
          footer = [
            h('button', {
              key: 'cancel',
              type: 'button',
              className: 'dsm-btn dsm-btn--danger',
              onClick: () => { void cancelLiveRecording(); props.onClose() },
            }, '取消并删除会议'),
            h('button', { key: 'bg', type: 'button', className: 'dsm-btn', onClick: closeAfterFileDone }, '后台录音（关闭）'),
            h('button', {
              key: 'stop',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: () => { void stopLiveRecording('user') },
            }, h(Icon, { name: 'stop', size: 12 }), h('span', null, '结束会议')),
          ]
        } else {
          footer = [
            h('button', { key: 'bg', type: 'button', className: 'dsm-btn', onClick: closeAfterFileDone }, '后台等待（关闭）'),
          ]
        }
      } else if (liveStatus === 'done') {
        footer = [
          h('button', { key: 'close', type: 'button', className: 'dsm-btn', onClick: finishLiveAndClose }, '完成'),
          h('button', {
            key: 'summarize',
            type: 'button',
            className: 'dsm-btn dsm-btn--primary',
            onClick: summarizeLive,
          }, h(Icon, { name: 'sparkle', size: 13 }), h('span', null, 'AI 生成纪要')),
        ]
      } else if (liveStatus === 'error') {
        footer = [
          h('button', { key: 'fallback', type: 'button', className: 'dsm-btn', onClick: fallbackLive }, '改用文本导入'),
          h('button', { key: 'keep', type: 'button', className: 'dsm-btn', onClick: keepLiveAndClose }, '保留并关闭'),
          live.meetingId !== null
            ? h('button', { key: 'delete', type: 'button', className: 'dsm-btn dsm-btn--danger', onClick: deleteLive }, '删除会议')
            : null,
        ]
      } else if (fileStage === 'preparing') {
        footer = [
          h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: closeModal }, '取消'),
        ]
      } else if (fileStage === 'processing') {
        footer = [h('span', { key: 'hint', className: 'dsm-hint' }, '正在处理，请保持页面打开…')]
      } else if (fileStage === 'done' && fileResult !== null) {
        footer = [
          h('button', { key: 'close', type: 'button', className: 'dsm-btn', onClick: closeAfterFileDone }, '完成'),
          h('button', {
            key: 'summarize',
            type: 'button',
            className: 'dsm-btn dsm-btn--primary',
            onClick: () => {
              const meetingId = fileResult.meetingId
              props.onClose()
              props.onSummarize(meetingId)
            },
          }, h(Icon, { name: 'sparkle', size: 13 }), h('span', null, 'AI 生成纪要')),
        ]
      } else if (fileStage === 'error') {
        footer = [
          h('button', { key: 'fallback', type: 'button', className: 'dsm-btn', onClick: fallbackToTextImport }, '改用文本导入'),
          h('button', { key: 'delete', type: 'button', className: 'dsm-btn dsm-btn--danger', onClick: deleteFileMeeting }, '删除会议并关闭'),
        ]
      } else {
        footer = [
          h('button', { key: 'cancel', type: 'button', className: 'dsm-btn', onClick: closeModal }, '取消'),
          tab === 'record'
            ? h('button', {
              key: 'start',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary dsm-btn--lg',
              onClick: startLive,
              disabled: !speechAvailable,
              title: speechAvailable ? undefined : '本机语音识别服务不可用',
            }, h(Icon, { name: 'mic', size: 13 }), h('span', null, '开始会议'))
            : h('button', {
              key: 'pick',
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: () => { fileRef.current?.click() },
              disabled: !speechAvailable || fileBusy,
              title: speechAvailable ? undefined : '本机语音识别服务不可用',
            }, h(Icon, { name: 'upload', size: 13 }), h('span', null, '选择文件并转写')),
        ]
      }

      return h(
        Modal,
        {
          title,
          subtitle,
          wide: true,
          dismissible,
          onClose: closeModal,
          footer,
        },
        ...body,
      )
    }

    // ─────────────────────────────── list ─────────────────────────────────

    function MeetingList(props) {
      const { meetings, selectedId, search, onSearch, filter, onFilter, onSelect } = props
      const actions = props.actions || {}
      const total = Number(props.total) || meetings.length
      const filters = [
        { id: 'all', label: '全部' },
        { id: 'summarized', label: '已总结' },
        { id: 'unsummarized', label: '未总结' },
        { id: 'pending', label: '有未写入待办' },
      ]
      return h(
        'aside',
        { className: 'dsm-side' },
        h(
          'div',
          { className: 'dsm-side-head' },
          h(
            'div',
            { className: 'dsm-side-title' },
            h('span', null, '会议'),
            h('span', { className: 'dsm-side-count' }, meetings.length === total ? `${total} 场` : `${meetings.length} / ${total} 场`),
          ),
          h(
            'div',
            { className: 'dsm-quick' },
            h('button', {
              type: 'button',
              className: 'dsm-quick-btn dsm-quick-btn--primary' + (actions.liveActive ? ' dsm-quick-btn--on' : ''),
              title: actions.liveActive ? '正在后台录音，点击查看实时转写' : '打开麦克风实时录音，边说边出字',
              onClick: () => { if (typeof actions.record === 'function') actions.record('record') },
              disabled: actions.recordDisabled === true && actions.liveActive !== true,
            },
            h('span', { className: 'dsm-quick-icon' }, h(Icon, { name: 'mic', size: 15 })),
            h('span', null, actions.liveActive ? '会议中…' : '实时录音/录屏')),
            h('button', {
              type: 'button',
              className: 'dsm-quick-btn',
              title: '导入已有的录音 / 视频文件，自动转成文字',
              onClick: () => { if (typeof actions.record === 'function') actions.record('file') },
              disabled: actions.recordDisabled === true,
            },
            h('span', { className: 'dsm-quick-icon' }, h(Icon, { name: 'upload', size: 15 })),
            h('span', null, '录音转写')),
            h('button', {
              type: 'button',
              className: 'dsm-quick-btn',
              title: '粘贴腾讯会议纪要，或导入 txt / md / json 文件',
              onClick: () => { if (typeof actions.importText === 'function') actions.importText() },
            },
            h('span', { className: 'dsm-quick-icon' }, h(Icon, { name: 'doc', size: 15 })),
            h('span', null, '导入纪要')),
          ),
          h(
            'div',
            { className: 'dsm-search' },
            h('span', { className: 'dsm-search-icon' }, h(Icon, { name: 'search', size: 13 })),
            h('input', {
              className: 'dsm-input dsm-input--search',
              value: search,
              placeholder: '搜索标题、参会人…',
              onChange: (event) => onSearch(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dsm-filters' },
            ...filters.map((item) => h('button', {
              key: item.id,
              type: 'button',
              className: `dsm-filter${filter === item.id ? ' dsm-filter--active' : ''}`,
              onClick: () => onFilter(item.id),
            }, item.label)),
          ),
        ),
        h(
          'div',
          { className: 'dsm-list' },
          meetings.length === 0
            ? h(
              'div',
              { className: 'dsm-empty-list' },
              search.trim() !== '' ? '没有匹配的会议，试试其他关键词。' : '当前筛选条件下没有会议。',
              h('div', { style: { marginTop: 8 } }, h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm',
                onClick: () => { onSearch(''); onFilter('all') },
              }, '清除筛选')),
            )
            : null,
                    ...meetings.map((item) => {
            // 单行列表：一行 = 一次会议记录（来源图标 + 标题 + 已总结标记 + 时间）
            const time = relativeStamp(item.createdAt ?? item.updatedAt ?? '')
            const sourceIcon = item.sourceType === 'recording' ? 'mic' : (item.sourceType === 'import' ? 'upload' : 'doc')
            return h(
              'button',
              {
                key: item.id,
                type: 'button',
                title: `${item.title || '未命名会议'} · ${humanDate(item.date)} · ${SOURCE_LABELS[item.sourceType] ?? '文本'}${item.hasSummary ? ' · 已总结' : ''}`,
                className: `dsm-meeting${item.id === selectedId ? ' dsm-meeting--active' : ''}`,
                onClick: () => onSelect(item.id),
              },
              h('span', { className: 'dsm-meeting-icon' }, h(Icon, { name: sourceIcon, size: 13 })),
              h(
                'span',
                { className: 'dsm-meeting-body' },
                h('span', { className: 'dsm-meeting-title' }, item.title || '未命名会议'),
                h(
                  'span',
                  { className: 'dsm-meeting-meta' },
                  h('span', { className: 'dsm-meeting-time' }, time),
                  h('span', { className: 'dsm-meeting-sep' }),
                  h('span', { className: 'dsm-meeting-source' }, SOURCE_LABELS[item.sourceType] ?? '文本'),
                  item.hasSummary
                    ? h('span', { className: 'dsm-meeting-status', title: '已生成 AI 纪要' }, '已总结')
                    : h('span', { className: 'dsm-meeting-status dsm-meeting-status--idle' }, '未总结'),
                ),
              ),
            )
          }),
        ),
      )
    }

    // ────────────────────────────── document ──────────────────────────────

    function SummarizingCard(props) {
      const [now, setNow] = useState(Date.now())
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
      }, [])
      const seconds = Math.max(0, Math.round((now - (props.startedAt ?? now)) / 1000))
      return h(
        'div',
        { className: 'dsm-summarizing' },
        h('span', { className: 'dsm-spin' }),
        h(
          'div',
          { className: 'dsm-summarizing-text' },
          h('div', null, 'AI 正在梳理会议内容并提取待办…'),
          h('div', { className: 'dsm-summarizing-sub' }, `已等待 ${seconds} 秒，通常需要 30–120 秒，请保持页面打开。`),
        ),
      )
    }

    function CoverSection(props) {
      const [exportOpen, setExportOpen] = useState(false)
      const exportRef = useRef(null)

      useEffect(() => {
        if (!exportOpen) return undefined
        // 点组件外部关闭下拉；Esc 也关闭（详情卡片在面板里可滚动，不能只靠 blur）。
        const onPointerDown = (event) => {
          const node = exportRef.current
          if (node !== null && node !== undefined && typeof node.contains === 'function' && node.contains(event.target)) return
          setExportOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setExportOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [exportOpen])

      const meeting = props.meeting
      const summary = meeting.summary
      const attendees = (Array.isArray(meeting.attendees) && meeting.attendees.length > 0
        ? meeting.attendees
        : (summary?.attendees ?? []))
      const chips = [
        h(MetaChip, { key: 'date', icon: 'calendar', label: humanDate(meeting.date) }),
        h(MetaChip, {
          key: 'source',
          icon: meeting.autoImported ? 'folder' : 'doc',
          label: meeting.autoImported ? '来源：自动入库' : `来源：${SOURCE_LABELS[meeting.sourceType] ?? '文本'}`,
          tone: 'brand',
          title: meeting.autoImported ? '由自动入库从本机录制文件导入' : undefined,
        }),
        h(MetaChip, {
          key: 'attendees',
          icon: 'users',
          label: attendees.length > 0 ? `参会人：${attendees.join('、')}` : '参会人未填写',
          title: attendees.join('、'),
        }),
        meeting.transcriptSeconds > 0
          ? h(MetaChip, { key: 'duration', icon: 'clock', label: `时长 ${formatDuration(meeting.transcriptSeconds)}` })
          : null,
        h(MetaChip, { key: 'chars', icon: 'list', label: formatChars(meeting.transcriptChars ?? (meeting.transcript ?? '').length) }),
        summary?.generatedAt
          ? h(MetaChip, { key: 'generated', icon: 'sparkle', label: `生成于 ${formatStamp(summary.generatedAt)}` })
          : null,
        summary?.model
          ? h(MetaChip, { key: 'model', icon: 'info', label: `模型 ${summary.model}` })
          : null,
      ].filter(Boolean)
      const oneline = summary?.oneLine ?? ''
      const overview = summary?.overview ?? ''
      return h(
        'header',
        { className: 'dsm-cover' },
        h(
          'div',
          { className: 'dsm-cover-top' },
          h('div', { className: 'dsm-eyebrow' }, '会议纪要 · 结构化纪要'),
          h(
            'div',
            { className: 'dsm-cover-actions' },
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--sm',
              onClick: props.onEdit,
            }, h(Icon, { name: 'edit', size: 12 }), h('span', null, '编辑信息')),
            props.onExport
              ? h(
                'div',
                { className: 'dsm-export' + (exportOpen ? ' dsm-export--open' : ''), ref: exportRef },
                h('button', {
                  type: 'button',
                  className: 'dsm-btn dsm-btn--sm',
                  onClick: () => setExportOpen((open) => open !== true),
                  disabled: props.exporting === true,
                  title: '导出为 HTML / Markdown / Word',
                },
                h(Icon, { name: 'download', size: 12 }),
                h('span', null, props.exporting === true ? '导出中…' : '导出'),
                h(Icon, { name: 'chevron', size: 12 })),
                exportOpen
                  ? h(
                    'div',
                    { className: 'dsm-export-menu' },
                    h('button', {
                      type: 'button',
                      className: 'dsm-export-item',
                      onClick: () => { setExportOpen(false); props.onExport('html') },
                    }, h('span', { className: 'dsm-export-label' }, 'HTML 网页'), h('span', { className: 'dsm-export-ext' }, '.html')),
                    h('button', {
                      type: 'button',
                      className: 'dsm-export-item',
                      onClick: () => { setExportOpen(false); props.onExport('md') },
                    }, h('span', { className: 'dsm-export-label' }, 'Markdown 文档'), h('span', { className: 'dsm-export-ext' }, '.md')),
                    h('button', {
                      type: 'button',
                      className: 'dsm-export-item',
                      onClick: () => { setExportOpen(false); props.onExport('docx') },
                    }, h('span', { className: 'dsm-export-label' }, 'Word 文档'), h('span', { className: 'dsm-export-ext' }, '.docx')),
                  )
                  : null,
              )
              : null,
            props.onDelete
              ? h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm dsm-btn--danger',
                onClick: props.onDelete,
                title: '删除这场会议',
              }, h(Icon, { name: 'trash', size: 12 }), h('span', null, '删除'))
              : null,
          ),
        ),
        h('h1', { className: 'dsm-cover-title' }, meeting.title || '未命名会议'),
        h('div', { className: 'dsm-meta-chips' }, ...chips),
        h(MeetingFiles, { meetingId: meeting.id, media: meeting.media }),
      )
    }

    /** 会议文件：音频/视频一行一条，icon + 文件名 + 播放/查看目录（参考文件卡片样式）。 */
    function MeetingFiles(props) {
      const media = Array.isArray(props.media) ? props.media : []
      if (media.length === 0) return null
      return h(
        'div',
        { className: 'dsm-files' },
        ...media.map((item, index) => {
          const isVideo = item.kind === 'video'
          const converting = item.converting === true
          const metaParts = [isVideo ? '视频' : '音频']
          if (converting) metaParts.push('正在转换 MP4…')
          if (Number(item.bytes) > 0) metaParts.push(formatBytes(Number(item.bytes)))
          if (Number(item.seconds) > 0) metaParts.push(formatDuration(Number(item.seconds)))
          return h(
            'div',
            { key: 'file-' + String(index), className: 'dsm-file' },
            h(
              'span',
              { className: 'dsm-file-icon' + (isVideo ? ' dsm-file-icon--video' : ' dsm-file-icon--audio') },
              h(Icon, { name: isVideo ? 'play' : 'doc', size: 16 }),
            ),
            h(
              'div',
              { className: 'dsm-file-main' },
              h('div', { className: 'dsm-file-name', title: String(item.name ?? '') }, String(item.name ?? '')),
              h('div', { className: 'dsm-file-meta' }, metaParts.join(' · ')),
            ),
            h(
              'div',
              { className: 'dsm-file-actions' },
              h('button', {
                type: 'button',
                className: 'dsm-file-action dsm-file-action--primary',
                disabled: converting,
                title: converting ? '正在转换 MP4，稍后即可播放' : '用电脑默认播放器打开',
                onClick: () => { void openMedia(props.meetingId, item.kind) },
              }, h(Icon, { name: 'play', size: 12 }), h('span', null, '播放')),
              h('button', {
                type: 'button',
                className: 'dsm-file-action',
                title: '在文件夹中显示',
                onClick: () => { void revealMedia(props.meetingId, item.kind) },
              }, h(Icon, { name: 'folder', size: 12 }), h('span', null, '查看目录')),
            ),
          )
        }),
      )
    }

    function TodoRow(props) {
      const { todo, selected, onToggle, onPatch, calendarAvailable } = props
      const pushed = isPushed(todo)
      const [editing, setEditing] = useState(false)
      const [draft, setDraft] = useState(() => ({
        title: todo.title ?? '',
        owner: todo.owner ?? '',
        due: todo.due ?? '',
        priority: todo.priority ?? 'normal',
        notes: todo.notes ?? '',
      }))
      const [saving, setSaving] = useState(false)
      const update = (key) => (value) => setDraft((previous) => ({ ...previous, [key]: value }))
      const begin = () => {
        setDraft({
          title: todo.title ?? '',
          owner: todo.owner ?? '',
          due: todo.due ?? '',
          priority: todo.priority ?? 'normal',
          notes: todo.notes ?? '',
        })
        setEditing(true)
      }
      const save = async () => {
        if (draft.title.trim() === '') return
        setSaving(true)
        try {
          const ok = await onPatch(todo.id, {
            title: draft.title.trim(),
            owner: draft.owner.trim(),
            due: draft.due.trim(),
            priority: draft.priority,
            notes: draft.notes,
          })
          if (ok) setEditing(false)
        } finally {
          setSaving(false)
        }
      }
      if (editing) {
        return h(
          'tr',
          { className: 'dsm-todo' },
          h('td', { className: 'dsm-col-check' }),
          h(
            'td',
            null,
            h(TextInput, { compact: true, value: draft.title, onChange: update('title') }),
            h('div', { style: { height: 4 } }),
            h(TextInput, { compact: true, value: draft.notes, onChange: update('notes'), placeholder: '备注 / 验收标准' }),
          ),
          h('td', null, h(TextInput, { compact: true, value: draft.owner, onChange: update('owner'), placeholder: '负责人' })),
          h('td', null, h(TextInput, { compact: true, value: draft.due, onChange: update('due'), placeholder: '2026-10-28 18:00' })),
          h('td', null, h(Select, {
            compact: true,
            value: draft.priority,
            onChange: update('priority'),
            options: Object.keys(PRIORITY_LABELS).map((value) => ({ value, label: PRIORITY_LABELS[value] })),
          })),
          h('td', null, pushed ? h('span', { className: 'dsm-status dsm-status--ok' }, '✓ 已写入') : h('span', { className: 'dsm-status' }, '未写入')),
          h(
            'td',
            null,
            h(
              'div',
              { className: 'dsm-row-actions' },
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm dsm-btn--primary',
                onClick: () => { void save() },
                disabled: saving,
              }, saving ? '保存…' : '保存'),
              h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--sm',
                onClick: () => setEditing(false),
                disabled: saving,
              }, '取消'),
            ),
          ),
        )
      }
      return h(
        'tr',
        { className: pushed ? 'dsm-todo dsm-todo--pushed' : 'dsm-todo' },
        h(
          'td',
          { className: 'dsm-col-check' },
          h('input', {
            className: 'dsm-checkbox',
            type: 'checkbox',
            checked: selected,
            disabled: pushed || !calendarAvailable,
            title: pushed ? '已写入待办' : (!calendarAvailable ? 'DSH 待办不可用' : '选择后写入DSH 待办'),
            onChange: () => onToggle(todo.id),
          }),
        ),
        h(
          'td',
          null,
          h('div', { className: 'dsm-todo-title' }, todo.title || '未命名待办'),
          todo.notes ? h('div', { className: 'dsm-todo-note' }, todo.notes) : null,
        ),
        h('td', null, todo.owner || '—'),
        h('td', null, todo.due || '—'),
        h(
          'td',
          null,
          h('span', { className: `dsm-prio dsm-prio--${todo.priority ?? 'normal'}` }, PRIORITY_LABELS[todo.priority] ?? '中'),
        ),
        h(
          'td',
          null,
          pushed
            ? h(
              'div',
              null,
              h('span', { className: 'dsm-status dsm-status--ok' }, h(Icon, { name: 'check', size: 11 }), h('span', null, '已写入待办')),
              todo.calendarTaskId
                ? h('span', { className: 'dsm-cal-id', title: `日历任务 ID：${todo.calendarTaskId}` }, todo.calendarTaskId)
                : null,
            )
            : h('span', { className: 'dsm-status' }, '未写入'),
        ),
        h(
          'td',
          null,
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--sm dsm-btn--ghost',
            onClick: begin,
            title: pushed ? '已写入待办的修改不会同步到待办清单' : '编辑待办',
          }, h(Icon, { name: 'edit', size: 11 }), h('span', null, '编辑')),
        ),
      )
    }

    function TodoSection(props) {
      const { meeting, calendarAvailable, calendarError, onPatchTodo, onPushTodos } = props
      const summary = meeting.summary
      const todos = summary?.todos ?? []
      const [selected, setSelected] = useState(() => new Set())
      const [pushing, setPushing] = useState(false)
      const pending = useMemo(() => todos.filter((todo) => !isPushed(todo)), [todos])
      useEffect(() => {
        setSelected(new Set())
      }, [meeting.id])
      const selectedPending = pending.filter((todo) => selected.has(todo.id))
      const targetCount = selectedPending.length > 0 ? selectedPending.length : pending.length
      const allSelected = pending.length > 0 && selected.size === pending.length
      const toggle = (id) => {
        setSelected((previous) => {
          const next = new Set(previous)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      }
      const toggleAll = () => {
        if (allSelected) setSelected(new Set())
        else setSelected(new Set(pending.map((todo) => todo.id)))
      }
      const push = async () => {
        const ids = selectedPending.length > 0 ? selectedPending.map((todo) => todo.id) : pending.map((todo) => todo.id)
        if (ids.length === 0) return
        setPushing(true)
        try {
          const payload = await onPushTodos(ids)
          if (payload) setSelected(new Set())
        } finally {
          setPushing(false)
        }
      }
      const calendarHint = calendarAvailable
        ? (pending.length > 0
          ? `已勾选 ${selectedPending.length > 0 ? selectedPending.length : 0} 条；不勾选时写入全部未写入待办（${pending.length} 条）`
          : '所有待办都已写入待办')
        : `DSH 待办不可用：${calendarError || '请确认 dsh-memory-evolve 插件已启用'}`
      return h(
        Section,
        {
          title: '待办事项',
          icon: 'check',
          count: todos.length,
          card: true,
          sub: summary ? `已写入 ${todos.length - pending.length} / ${todos.length}` : undefined,
        },
        h(
          'div',
          { className: 'dsm-todo-card' },
          todos.length === 0
            ? h('div', { className: 'dsm-empty-table' }, 'AI 没有从这场会议中提取到待办事项。')
            : h(
              'div',
              { className: 'dsm-table-wrap' },
              h(
                'table',
                { className: 'dsm-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', { className: 'dsm-col-check' }, h('input', {
                      className: 'dsm-checkbox',
                      type: 'checkbox',
                      checked: allSelected,
                      disabled: pending.length === 0 || !calendarAvailable,
                      title: '全选未写入的待办',
                      onChange: toggleAll,
                    })),
                    h('th', null, '标题'),
                    h('th', { className: 'dsm-col-owner' }, '负责人'),
                    h('th', { className: 'dsm-col-due' }, '截止'),
                    h('th', { className: 'dsm-col-priority' }, '优先级'),
                    h('th', { className: 'dsm-col-status' }, '状态'),
                    h('th', { className: 'dsm-col-actions' }, '操作'),
                  ),
                ),
                h(
                  'tbody',
                  null,
                  ...todos.map((todo) => h(TodoRow, {
                    key: todo.id,
                    todo,
                    selected: selected.has(todo.id),
                    onToggle: toggle,
                    onPatch: onPatchTodo,
                    calendarAvailable,
                  })),
                ),
              ),
            ),
          h(
            'div',
            { className: 'dsm-todo-foot' },
            h(
              'span',
              { className: `dsm-todo-hint${calendarAvailable ? '' : ' dsm-todo-hint--warn'}` },
              calendarHint,
            ),
            h('span', { className: 'dsm-spacer' }),
            h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--primary',
              onClick: () => { void push() },
              disabled: targetCount === 0 || pushing || !calendarAvailable,
              title: calendarAvailable ? undefined : '待办功能不可用',
            }, h(Icon, { name: 'list', size: 13 }), h('span', null, pushing ? '写入中…' : `写入待办（${targetCount}）`)),
          ),
        ),
      )
    }

    function TranscriptSection(props) {
      const text = String(props.transcript ?? '')
      const segments = Array.isArray(props.segments) ? props.segments : []
      const [open, setOpen] = useState(false)
      const [copied, setCopied] = useState(false)
      const speakerCount = segments.reduce((count, segment) => {
        const label = typeof segment?.speaker === 'string' ? segment.speaker : ''
        return label !== '' && !count.includes(label) ? [...count, label] : count
      }, []).length
      const plainOf = () => {
        if (segments.length === 0) return text
        return segments.map((segment) => {
          const label = typeof segment?.speaker === 'string' && segment.speaker !== '' ? segment.speaker + '：' : ''
          return label + String(segment?.text ?? '')
        }).join('\n')
      }
      const copy = async () => {
        try {
          await copyText(plainOf())
          setCopied(true)
          notifySuccess('已复制原始转写', formatChars(text.length))
          window.setTimeout(() => setCopied(false), 2000)
        } catch (caught) {
          reportError(caught, '复制失败')
        }
      }
      const actions = [
        h('button', {
          key: 'copy',
          type: 'button',
          className: 'dsm-minutes-action',
          onClick: () => { void copy() },
          disabled: text === '',
          title: '复制转写全文（带说话人标记）',
        }, h(Icon, { name: 'copy', size: 12 }), h('span', null, copied ? '已复制' : '复制')),
        h('button', {
          key: 'toggle',
          type: 'button',
          className: 'dsm-minutes-action',
          onClick: () => setOpen((previous) => !previous),
          title: open ? '收起' : '展开全文',
        }, h('span', null, open ? '收起' : '展开'), h('span', { className: 'dsm-minutes-caret' + (open ? ' dsm-minutes-caret--up' : '') }, '⌄')),
      ]
      return h(
        Section,
        {
          title: '原始转写',
          icon: 'doc',
          card: true,
          sub: speakerCount > 0 ? formatChars(text.length) + ' · ' + speakerCount + ' 位说话人' : formatChars(text.length),
          actions: h('div', { className: 'dsm-section-action-row' }, ...actions),
        },
        h(
          'div',
          { className: 'dsm-transcript dsm-transcript--card' },
          segments.length > 0
            ? h(
              'div',
              { className: 'dsm-transcript-lines' + (open ? ' dsm-transcript-lines--open' : '') },
              ...segments.map((segment, index) => {
                const label = typeof segment?.speaker === 'string' ? segment.speaker : ''
                const tone = label === '' ? 'x' : label.toLowerCase()
                return h(
                  'div',
                  { key: 'seg-' + String(index), className: 'dsm-transcript-line' },
                  label === ''
                    ? null
                    : h('span', { className: 'dsm-speaker dsm-speaker--' + tone }, label),
                  h('span', { className: 'dsm-transcript-text' }, String(segment?.text ?? '')),
                )
              }),
            )
            : h('div', { className: 'dsm-transcript-plain' }, text === '' ? '（暂无转写文本）' : text),
          speakerCount > 0
            ? h('div', { className: 'dsm-transcript-note' }, 'A/B/C/D 为按音色自动分组的估算结果，仅供参考；导入的音频文件暂不区分说话人。')
            : null,
        ),
      )
    }

    /** AI 会议纪要卡片：固定高度、可展开收起、可复制全文（参考腾讯会议卡片样式）。 */
    function AiMinutesCard(props) {
      const summary = props.summary
      const [expanded, setExpanded] = useState(false)
      const [copied, setCopied] = useState(false)
      if (summary === null || summary === undefined) return null
      const oneLine = typeof summary.oneLine === 'string' ? summary.oneLine : ''
      const overview = typeof summary.overview === 'string' ? summary.overview : ''
      const decisions = Array.isArray(summary.decisions) ? summary.decisions : []
      const textOf = (item) => (typeof item === 'string' ? item : String(item?.text ?? ''))
      const plain = []
      if (oneLine !== '') plain.push(oneLine)
      if (overview !== '') plain.push('', '【概述】', overview)
      if (decisions.length > 0) {
        plain.push('', '【决策事项】')
        for (const item of decisions) plain.push('· ' + textOf(item))
      }
      const copyAll = async () => {
        try {
          await copyText(plain.join('\n'))
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1600)
        } catch { }
      }
      const groups = []
      if (decisions.length > 0) groups.push({ title: '决策事项', items: decisions })
      return h(
        'section',
        { className: 'dsm-minutes' + (expanded ? ' dsm-minutes--expanded' : '') },
        h(
          'div',
          { className: 'dsm-minutes-head' },
          h('span', { className: 'dsm-minutes-icon' }, h(Icon, { name: 'sparkle', size: 13 })),
          h('span', { className: 'dsm-minutes-title' }, 'AI 会议纪要'),
          summary.generatedAt ? h('span', { className: 'dsm-minutes-meta' }, '生成于 ' + formatStamp(summary.generatedAt)) : null,
          h('span', { className: 'dsm-minutes-spacer' }),
          props.canSummarize === true
            ? h(
              'button',
              {
                type: 'button',
                className: 'dsm-minutes-action dsm-minutes-action--primary',
                onClick: () => { if (typeof props.onSummarize === 'function') props.onSummarize() },
                disabled: props.summarizing === true,
                title: props.summarizing === true ? '正在重新生成…' : '重新生成会覆盖当前 AI 纪要',
              },
              h(Icon, { name: 'refresh', size: 12 }),
              h('span', null, props.summarizing === true ? '生成中…' : '重新生成纪要'),
            )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dsm-minutes-action',
              onClick: () => { void copyAll() },
              title: '复制纪要全文',
            },
            h(Icon, { name: copied ? 'check' : 'doc', size: 12 }),
            h('span', null, copied ? '已复制' : '复制'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsm-minutes-action',
              onClick: () => setExpanded((previous) => !previous),
              title: expanded ? '收起' : '展开全文',
            },
            h('span', null, expanded ? '收起' : '展开'),
            h('span', { className: 'dsm-minutes-caret' + (expanded ? ' dsm-minutes-caret--up' : '') }, '⌄'),
          ),
        ),
        h(
          'div',
          { className: 'dsm-minutes-body' },
          oneLine !== '' ? h('div', { className: 'dsm-minutes-oneline' }, oneLine) : null,
          overview !== '' ? h('div', { className: 'dsm-minutes-overview' }, overview) : null,
          ...groups.map((group) => h(
            'div',
            { key: group.title, className: 'dsm-minutes-group' },
            h('div', { className: 'dsm-minutes-group-title' }, group.title),
            ...group.items.map((item, index) => h(
              'div',
              { key: group.title + '-' + String(index), className: 'dsm-minutes-item' },
              h('span', { className: 'dsm-minutes-dot' }),
              h('span', null, textOf(item)),
            )),
          )),
          oneLine === '' && overview === '' && groups.length === 0
            ? h('div', { className: 'dsm-minutes-empty' }, '还没有生成的纪要内容')
            : null,
        ),
      )
    }

    function MeetingDocument(props) {
      const meeting = props.meeting
      const summary = meeting.summary
      const attendees = Array.isArray(meeting.attendees) ? meeting.attendees : []
      const summaryStartedAt = props.summarizing?.id === meeting.id ? props.summarizing.startedAt : null
      const keyPoints = Array.isArray(summary?.keyPoints) ? summary.keyPoints : []
      const decisions = Array.isArray(summary?.decisions) ? summary.decisions : []
      const risks = Array.isArray(summary?.risks) ? summary.risks : []
      const sections = Array.isArray(summary?.sections) ? summary.sections : []
      const hasSummary = summary !== null && summary !== undefined
      const hasTranscript = typeof meeting.transcript === 'string' && meeting.transcript.trim() !== ''

      return h(
        'article',
        { className: 'dsm-doc' },
        h(CoverSection, {
          meeting,
          onEdit: props.onEdit,
          onSummarize: props.onSummarize,
          onExport: props.onExport,
          onDelete: props.onDelete,
          summarizing: props.summarizing !== null && props.summarizing !== undefined,
          exporting: props.exporting === true,
          hasTranscript,
          hasSummary,
        }),
        h(AiMinutesCard, {
          summary,
          onSummarize: props.onSummarize,
          summarizing: props.summarizing !== null,
          canSummarize: hasTranscript,
        }),
        summaryStartedAt !== null
          ? h(SummarizingCard, { startedAt: summaryStartedAt })
          : null,
        !hasSummary && summaryStartedAt === null
          ? h(
            'div',
            { className: 'dsm-cta' },
            h('div', { className: 'dsm-cta-icon' }, h(Icon, { name: 'sparkle', size: 18 })),
            h(
              'div',
              { className: 'dsm-cta-body' },
              h('div', { className: 'dsm-cta-title' }, hasTranscript ? '还没有 AI 纪要' : '还没有转写内容'),
              h(
                'div',
                { className: 'dsm-cta-text' },
                hasTranscript
                  ? '转写已就绪。点击生成会议概述、决策事项与待办清单（约 30–120 秒）。'
                  : '先录音、导入音频或粘贴会议文本，然后让 AI 生成结构化纪要。',
              ),
            ),
            hasTranscript
              ? h('button', {
                type: 'button',
                className: 'dsm-btn dsm-btn--primary',
                onClick: props.onSummarize,
                disabled: props.summarizing !== null,
              }, h(Icon, { name: 'sparkle', size: 13 }), h('span', null, 'AI 生成纪要'))
              : h(
                'div',
                { className: 'dsm-row-actions' },
                h('button', {
                  type: 'button',
                  className: 'dsm-btn dsm-btn--primary',
                  onClick: props.onRecord,
                  disabled: props.recordDisabled,
                }, h(Icon, { name: 'mic', size: 13 }), h('span', null, '录音转文字')),
                h('button', {
                  type: 'button',
                  className: 'dsm-btn',
                  onClick: props.onImport,
                }, h(Icon, { name: 'upload', size: 13 }), h('span', null, '导入纪要')),
              ),
          )
          : null,
        decisions.length > 0
          ? h(
            Section,
            { title: '决策清单', icon: 'check', count: decisions.length },
            h(
              'div',
              { className: 'dsm-cards' },
              ...decisions.map((decision, index) => h(
                'div',
                { key: `${index}-${decision.text}`, className: 'dsm-decision' },
                h('span', { className: 'dsm-decision-check' }, h(Icon, { name: 'check', size: 11, strokeWidth: 1.8 })),
                h(
                  'div',
                  { className: 'dsm-decision-body' },
                  h('div', { className: 'dsm-decision-text' }, decision.text),
                  decision.owner ? h('div', { className: 'dsm-owner' }, `负责人：${decision.owner}`) : null,
                ),
              )),
            ),
          )
          : null,
        hasSummary && Array.isArray(summary?.todos)
          ? h(TodoSection, {
            meeting,
            calendarAvailable: props.calendarAvailable,
            calendarError: props.calendarError,
            onPatchTodo: props.onPatchTodo,
            onPushTodos: props.onPushTodos,
          })
          : null,
        typeof meeting.notes === 'string' && meeting.notes.trim() !== ''
          ? h(
            Section,
            { title: '会议备注', icon: 'info' },
            h('div', { className: 'dsm-notes' }, meeting.notes),
          )
          : null,
        hasTranscript
          ? h(TranscriptSection, { transcript: meeting.transcript, segments: meeting.transcriptSegments })
          : null,
        attendees.length === 0
          ? null
          : h('div', { className: 'dsm-hint', style: { marginTop: 16 } }, `参会人：${attendees.join('、')}`),
      )
    }

    // ─────────────────────────────── empty ────────────────────────────────

    function EmptyState(props) {
      const speech = props.speech
      const speechAvailable = speechUsable(speech)
      return h(
        'div',
        { className: 'dsm-empty' },
        h('div', { className: 'dsm-empty-icon' }, h(Icon, { name: 'mic', size: 30, strokeWidth: 1.3 })),
        h('div', { className: 'dsm-empty-title' }, '把会议变成可执行的纪要'),
        h('div', { className: 'dsm-empty-sub' }, '录音或导入转写后，AI 会自动整理会议概述、决策事项与待办；确认后一键写入 DSH 待办。'),
        h(
          'div',
          { className: 'dsm-entries' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsm-entry',
              onClick: () => { if (typeof props.onRecord === 'function') props.onRecord('record') },
              disabled: !speechAvailable,
              title: speechAvailable ? undefined : '本机语音识别服务不可用，请改用文本导入',
            },
            h('div', { className: 'dsm-entry-icon' }, h(Icon, { name: 'mic', size: 17 })),
            h('div', { className: 'dsm-entry-title' }, '实时录音/录屏'),
            h('div', { className: 'dsm-entry-text' }, speechAvailable
              ? '边说边出字，约 6–10 秒延迟，可后台录音'
              : '语音识别服务未就绪，可先在顶部预加载，或改用文本导入'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsm-entry',
              onClick: () => { if (typeof props.onRecord === 'function') props.onRecord('file') },
              disabled: !speechAvailable,
              title: speechAvailable ? undefined : '本机语音识别服务不可用，请改用文本导入',
            },
            h('div', { className: 'dsm-entry-icon' }, h(Icon, { name: 'upload', size: 17 })),
            h('div', { className: 'dsm-entry-title' }, '录音转写'),
            h('div', { className: 'dsm-entry-text' }, '导入已有的录音 / 视频文件，自动转成文字'),
          ),
          h(
            'button',
            { type: 'button', className: 'dsm-entry', onClick: props.onImport },
            h('div', { className: 'dsm-entry-icon' }, h(Icon, { name: 'doc', size: 17 })),
            h('div', { className: 'dsm-entry-title' }, '导入腾讯会议纪要'),
            h('div', { className: 'dsm-entry-text' }, '粘贴文本，或导入 .txt / .md / .json 文件'),
          ),
        ),
        h('div', { className: 'dsm-empty-note' }, '会议数据保存在本机；AI 纪要使用当前配置的模型服务。'),
      )
    }

    // ─────────────────────────────── toolbar ──────────────────────────────

    function SpeechChip() {
      const state = useSnapshot()
      const speech = state.speech ?? state.data?.speech
      const provider = speechProvider(speech)
      if (speech === null) {
        return h('span', { className: 'dsm-chip' }, '语音识别：检查中')
      }
      if (!speechUsable(speech)) {
        return h('span', {
          className: 'dsm-chip dsm-chip--warn',
          title: typeof speech?.error === 'string' ? speech.error : '本机未配置语音识别服务',
        }, '语音识别：不可用')
      }
      const phase = provider?.phase ?? 'unprepared'
      if (speechReady(speech)) {
        return h('span', { className: 'dsm-chip dsm-chip--ok' }, h('span', { className: 'dsm-dot-live' }), '语音识别就绪')
      }
      if (state.speechPreparing || phase === 'downloading' || phase === 'checking' || phase === 'loading') {
        const percent = state.speechProgress !== null ? Math.round(state.speechProgress.ratio * 100) : null
        return h('button', {
          type: 'button',
          className: 'dsm-chip dsm-chip--busy',
          onClick: () => { void prepareSpeechManually() },
          disabled: state.speechPreparing,
          title: '正在准备本地语音识别模型',
        }, h('span', { className: 'dsm-spin', style: { width: 9, height: 9, borderWidth: 1.5 } }), `语音识别：${speechPhaseLabel(phase)}${percent !== null ? ` ${percent}%` : ''}`)
      }
      return h('button', {
        type: 'button',
        className: 'dsm-chip',
        onClick: () => { void prepareSpeechManually() },
        title: '点击预加载本地语音识别模型',
      }, `语音识别：${speechPhaseLabel(phase)}`)
    }

    function Toolbar(props) {
      const { state, handlers } = props
      const meeting = state.meeting
      const summarizing = state.summarizing !== null
      const exporting = state.exporting !== null
      const speech = state.speech ?? state.data?.speech
      const speechAvailable = speechUsable(speech)
      const liveActive = liveIsActive(state.live)
      return h(
        'div',
        { className: 'dsm-toolbar' },
        h(
          'div',
          { className: 'dsm-brand' },
          h('span', { className: 'dsm-brand-title' }, '会议纪要'),
        ),
        h('span', { className: 'dsm-spacer' }),
        h(SpeechChip, null),
        h('button', {
          type: 'button',
          className: 'dsm-iconbtn',
          onClick: () => { if (typeof handlers.refresh === 'function') handlers.refresh() },
          disabled: refreshing === true,
          title: refreshing === true ? '正在刷新…' : '刷新（重新拉取会议列表与当前详情）',
          'aria-label': '刷新',
        }, refreshing === true ? h('span', { className: 'dsm-spin' }) : h(Icon, { name: 'refresh', size: 14 })),
        h(ToolbarButton, {
          icon: 'sliders',
          iconSize: 14,
          className: 'dsm-settings-btn',
          label: '设置',
          onClick: handlers.settings,
          title: '设置：生成纪要用哪个模型、自动入库开关与扫描',
        }),
      )
    }

    // ─────────────────────────────── overlay ──────────────────────────────

    /** Persistent floating bar: the recording survives panel/modal unmounts. */
    function LiveRecordingBar() {
      const state = useSnapshot()
      const live = state.live
      if (!live || !liveIsActive(live)) return null
      // 桌面浮窗接管时不再显示页面底部那条黑色录音条，避免两个入口打架。
      if (state.orbActive) return null
      const preparing = live.status === 'preparing'
      const stopping = live.status === 'stopping'
      const paused = live.status === 'paused'
      const lastText = live.lastText ?? ''
      const tail = lastText.length > 38 ? `…${lastText.slice(-38)}` : lastText
      const meta = preparing
        ? '正在启动语音识别…'
        : paused
          ? `已暂停 · 已转写 ${formatChars(live.chars)}`
          : stopping
            ? `已转写 ${formatChars(live.chars)} · 正在等待最后几段`
            : `已转写 ${formatChars(live.chars)}${tail !== '' ? ` · ${tail}` : ' · 等待第一段识别…'}`
      return h(
        'div',
        { className: 'dsm-livebar', role: 'status', 'aria-live': 'polite' },
        preparing || stopping
          ? h('span', { className: 'dsm-spin', style: { width: 10, height: 10, borderWidth: 2 } })
          : h('span', { className: 'dsm-livebar-dot' }),
        h(
          'div',
          { className: 'dsm-livebar-main' },
          h(
            'div',
            { className: 'dsm-livebar-title' },
            h('span', null, preparing ? '正在准备会议' : stopping ? '正在结束会议' : paused ? '已暂停' : '会议中'),
            !preparing && !stopping ? h('span', { className: 'dsm-livebar-timer' }, formatTimer(live.elapsedSeconds)) : null,
            live.meetingTitle !== ''
              ? h('span', { className: 'dsm-hint', style: { fontWeight: 400 } }, live.meetingTitle)
              : null,
          ),
          h('div', { className: 'dsm-livebar-meta' }, meta),
        ),
        h(
          'div',
          { className: 'dsm-livebar-actions' },
          !preparing && !stopping
            ? h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--sm',
              onClick: () => { void (paused ? resumeLiveRecording() : pauseLiveRecording()) },
            }, h('span', null, paused ? '继续' : '暂停'))
            : null,
          !preparing && !stopping
            ? h('button', {
              type: 'button',
              className: 'dsm-btn dsm-btn--sm dsm-btn--danger',
              onClick: () => { void stopLiveRecording('user') },
            }, h(Icon, { name: 'stop', size: 11 }), h('span', null, '停止'))
            : null,
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--sm',
            onClick: openMeetingPanel,
          }, h(Icon, { name: 'doc', size: 11 }), h('span', null, '打开纪要')),
        ),
      )
    }

    function ToastOverlay() {
      const state = useSnapshot()
      useEffect(() => {
        ensureStyle()
      }, [])
      return h(
        React.Fragment,
        null,
        // 底部录音条已移除：录音中的操作交给桌面浮窗（或「实时录音」弹窗）。
        state.toasts.length === 0
          ? null
          : h(
            'div',
            { className: 'dsm-toast-stack' },
            ...state.toasts.map((toast) => h(
              'div',
              { key: toast.id, className: `dsm-toast dsm-toast--${toast.level ?? 'info'}` },
              h(
                'span',
                { className: 'dsm-toast-icon' },
                h(Icon, {
                  name: toast.level === 'error' ? 'alert' : toast.level === 'success' ? 'check' : toast.level === 'warn' ? 'info' : 'info',
                  size: 14,
                }),
              ),
              h(
                'div',
                { className: 'dsm-toast-content' },
                h('div', { className: 'dsm-toast-title' }, toast.title),
                toast.body ? h('div', { className: 'dsm-toast-body' }, toast.body) : null,
              ),
              h('button', {
                type: 'button',
                className: 'dsm-toast-close',
                'aria-label': '关闭提示',
                onClick: () => dismissToast(toast.id),
              }, h(Icon, { name: 'close', size: 12 })),
            )),
          ),
      )
    }

    // ─────────────────────────────── panel ────────────────────────────────

    function MeetingPanel() {
      const state = useSnapshot()
      const [search, setSearch] = useState('')
      const [filter, setFilter] = useState('all')
      const [dialog, setDialog] = useState(null)
      const [recordTab, setRecordTab] = useState('record')
      const [deleteOpen, setDeleteOpen] = useState(false)
      const [refreshing, setRefreshing] = useState(false)

      useEffect(() => {
        ensureStyle()
        const onVisible = () => {
          if (document.visibilityState === 'visible') void refreshAll()
        }
        window.addEventListener('focus', onVisible)
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          window.removeEventListener('focus', onVisible)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [])

      const meetings = state.meetings ?? []
      const selected = state.meeting
      const speech = state.speech ?? state.data?.speech
      const speechAvailable = speechUsable(speech)
      const calendar = state.data?.calendar ?? null
      const calendarAvailable = calendar === null ? true : calendar.available !== false
      const calendarError = calendar !== null && calendar.available === false
        ? (typeof calendar.error === 'string' ? calendar.error : 'DSH 待办不可用')
        : ''

      const filtered = useMemo(() => {
        const keyword = search.trim().toLowerCase()
        const kept = meetings.filter((item) => {
          if (filter === 'summarized' && !item.hasSummary) return false
          if (filter === 'unsummarized' && item.hasSummary) return false
          if (filter === 'pending' && !(Number(item.pendingTodoCount) > 0)) return false
          if (keyword === '') return true
          const haystack = `${item.title ?? ''} ${(item.attendees ?? []).join(' ')} ${item.date ?? ''}`.toLowerCase()
          return haystack.includes(keyword)
        })
        kept.sort((left, right) => {
          const byDate = String(right.date ?? '').localeCompare(String(left.date ?? ''))
          if (byDate !== 0) return byDate
          return String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
        })
        return kept
      }, [meetings, search, filter])

      const openSummarize = async (meetingId, force) => {
        const id = meetingId ?? selected?.id
        if (!id) return
        commit({ summarizing: { id, startedAt: Date.now() } })
        try {
          const payload = await summarizeMeetingById(id, force)
          const meeting = payload?.meeting
          const oneLine = meeting?.summary?.oneLine ?? '会议概述、决策与待办已更新'
          notifySuccess(
            force ? '已重新生成纪要' : '已生成 AI 纪要',
            payload?.renamedTo
              ? `${oneLine}（会议已自动命名为「${payload.renamedTo}」）`
              : oneLine,
          )
        } catch (caught) {
          reportError(caught, '生成纪要失败')
        } finally {
          commit({ summarizing: null })
        }
      }

      const openExport = async (format) => {
        if (!selected) return
        commit({ exporting: format })
        try {
          const payload = await exportMeetingFile(selected, format)
          const formatLabel = format === 'docx' ? 'Word 文档' : format === 'md' ? 'Markdown' : 'HTML'
          notifySuccess(
            `${formatLabel} 导出完成`,
            payload.path ? `已保存到 ${payload.path}` : payload.filename,
          )
        } catch (caught) {
          reportError(caught, '导出失败')
        } finally {
          commit({ exporting: null })
        }
      }

      const patchTodo = async (todoId, patch) => {
        if (!selected) return false
        try {
          await updateMeetingTodo(selected.id, todoId, patch)
          notifySuccess('待办已更新', patch.title ?? '')
          return true
        } catch (caught) {
          reportError(caught, '保存待办失败')
          return false
        }
      }

      const pushTodos = async (todoIds) => {
        if (!selected) return null
        try {
          const payload = await pushMeetingTodos(selected.id, todoIds)
          const created = Array.isArray(payload.created) ? payload.created : []
          notifySuccess(
            `已写入待办 ${created.length} 条`,
            created.slice(0, 3).map((item) => `${item.title} → ${item.calendarTaskId}`).join('；') || '待办已同步',
          )
          return payload
        } catch (caught) {
          reportError(caught, '写入DSH 待办失败')
          return null
        }
      }

      const confirmDelete = async () => {
        if (!selected) return
        setDeleteOpen(false)
        try {
          const title = selected.title
          await deleteMeetingById(selected.id)
          notifySuccess('已删除会议', title)
        } catch (caught) {
          reportError(caught, '删除会议失败')
        }
      }

      const handlers = {
        newMeeting: () => setDialog('new'),
        record: (mode) => {
          setRecordTab(mode === 'file' ? 'file' : 'record')
          const live = snapshot.live ?? initialLiveState()
          if (liveIsActive(live)) {
            setDialog('record')
            return
          }
          if (live.status === 'done' || live.status === 'error') clearLiveRecording()
          if (!speechAvailable) {
            notify('warn', '语音识别不可用', '本机语音识别服务未就绪，请改用「导入纪要」的文本方式')
            return
          }
          setDialog('record')
        },
        importText: () => setDialog('import'),
        summarize: () => { void openSummarize(selected?.id, Boolean(selected?.summary)) },
        export: (format) => { void openExport(format) },
        delete: () => setDeleteOpen(true),
        settings: () => setDialog('auto'),
        refresh: () => {
          if (refreshing === true) return
          setRefreshing(true)
          void refreshAll()
            .then(() => { notifySuccess('已刷新', '会议列表与当前会议详情已重新拉取') })
            .catch(() => {})
            .finally(() => { setRefreshing(false) })
        },
      }

      const closeDialog = () => setDialog(null)

      let content = null
      if (state.status === 'loading' && state.data === null) {
        content = h(
          'div',
          { className: 'dsm-loading' },
          h('span', { className: 'dsm-spin dsm-spin--lg' }),
          h('span', null, '正在加载会议纪要…'),
        )
      } else if (state.status === 'error' && state.data === null) {
        content = h(
          'div',
          { className: 'dsm-service-error' },
          h('div', { className: 'dsm-service-title' }, '会议纪要服务未启动'),
          h('div', { className: 'dsm-service-text' }, state.error ?? '会议纪要服务未启动，请重新加载页面'),
          h('button', {
            type: 'button',
            className: 'dsm-btn dsm-btn--primary',
            onClick: () => { window.location.reload() },
          }, '重新加载页面'),
        )
      } else if (meetings.length === 0) {
        content = h(EmptyState, {
          speech,
          onRecord: handlers.record,
          onImport: handlers.importText,
          onNew: handlers.newMeeting,
        })
      } else {
        const detail = selected === null
          ? h('div', { className: 'dsm-detail-empty' }, h(Icon, { name: 'doc', size: 22 }), h('span', null, '从左侧选择一场会议'))
          : state.meetingLoading && state.meeting === null
            ? h(
              'div',
              { className: 'dsm-loading' },
              h('span', { className: 'dsm-spin' }),
              h('span', null, '正在加载会议…'),
            )
            : h(MeetingDocument, {
              meeting: selected,
              summarizing: state.summarizing,
              calendarAvailable,
              calendarError,
              onEdit: () => setDialog('edit'),
              onRecord: handlers.record,
              onImport: handlers.importText,
              onSummarize: handlers.summarize,
              onExport: handlers.export,
              onDelete: handlers.delete,
              exporting: state.exporting !== null,
              onPatchTodo: patchTodo,
              onPushTodos: pushTodos,
              recordDisabled: !speechAvailable,
            })
        content = h(
          'div',
          { className: 'dsm-body' },
          h(MeetingList, {
            meetings: filtered,
            total: meetings.length,
            selectedId: state.selectedId,
            search,
            onSearch: setSearch,
            filter,
            onFilter: setFilter,
            onSelect: (id) => { void selectMeeting(id) },
            actions: {
              newMeeting: handlers.newMeeting,
              record: handlers.record,
              importText: handlers.importText,
              liveActive: liveIsActive(state.live),
              recordDisabled: !speechAvailable,
            },
          }),
          h('div', { className: 'dsm-detail' }, detail),
        )
      }

      return h(
        'div',
        { className: 'dsm-root' },
        h(Toolbar, { state, handlers }),
        state.error !== null && !(state.status === 'error' && state.data === null)
          ? h(
            'div',
            { className: 'dsm-errorbar' },
            h(Icon, { name: 'alert', size: 13 }),
            h('span', { className: 'dsm-errorbar-text' }, state.error),
            h('button', {
              type: 'button',
              className: 'dsm-iconbtn',
              onClick: () => commit({ error: null }),
              'aria-label': '关闭错误提示',
            }, h(Icon, { name: 'close', size: 12 })),
          )
          : null,
        content,
        dialog === 'new'
          ? h(NewMeetingModal, { onClose: closeDialog })
          : null,
        dialog === 'edit' && selected !== null
          ? h(EditMeetingModal, { meeting: selected, onClose: closeDialog })
          : null,
        dialog === 'import'
          ? h(ImportTextModal, { meeting: selected, onClose: closeDialog })
          : null,
        dialog === 'auto'
          ? h(SettingsModal, {
            status: state.data?.autoIngest ?? null,
            onClose: closeDialog,
            onSelectMeeting: (meetingId) => {
              closeDialog()
              void selectMeeting(meetingId)
            },
          })
          : null,
        dialog === 'record'
          ? h(RecordModal, {
            onClose: closeDialog,
            initialTab: recordTab,
            onSummarize: (meetingId) => {
              closeDialog()
              void openSummarize(meetingId, false)
            },
            onOpenTextImport: () => { setDialog('import') },
          })
          : null,
        deleteOpen && selected !== null
          ? h(
            Modal,
            {
              title: '删除会议',
              subtitle: selected.title,
              onClose: () => setDeleteOpen(false),
              footer: [
                h('button', {
                  key: 'cancel',
                  type: 'button',
                  className: 'dsm-btn',
                  onClick: () => setDeleteOpen(false),
                }, '取消'),
                h('button', {
                  key: 'delete',
                  type: 'button',
                  className: 'dsm-btn dsm-btn--danger',
                  onClick: () => { void confirmDelete() },
                }, '确认删除'),
              ],
            },
            h('p', { className: 'dsm-dialog-text' }, '确定删除这场会议吗？转写文本和 AI 纪要会一并删除；已经写入待办的条目不会被删除。'),
          )
          : null,
      )
    }

    // ──────────────────────────── plugin body ─────────────────────────────

    const inject = ['slots', 'layout']

    function apply(ctx) {
      clientContext = ctx
      ensureStyle()
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: 'meeting-minutes',
        order: 45,
        label: '会议纪要',
      }, MeetingGlyph))
      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: 'meeting-minutes',
      }, MeetingPanel))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'meeting-minutes-toasts',
        order: 30,
        label: '会议纪要通知',
      }, ToastOverlay))
      // Poll for auto-ingested meetings and fresh status; the interval is owned
      // by the plugin effect so unloading the bundle clears it.
      ctx.effect(() => {
        const timer = window.setInterval(() => { void refreshAll() }, 27_000)
        return () => { window.clearInterval(timer) }
      }, 'meeting-minutes: auto-ingest poll')
      void refreshAll()
    }

    exports.apply = apply
    exports.inject = inject

    return module.exports
  },
})
