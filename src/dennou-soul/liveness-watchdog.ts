/**
 * DennouAibou Liveness Watchdog
 *
 * 上流Issue #31139 / #23020 への対策。
 * Node.js イベントループが長時間のアイドル後にタイマーを静かに止める現象
 * （`setTimeout.unref()` に起因するタイマー飢餓）を検出し、回復する。
 *
 * 設計（上流PR #31226 の watchdog アプローチを踏襲）:
 * 1. Primary: `setInterval` で定期的に alive marker をログに書き込む
 * 2. 自己監視: 各tickで `process.hrtime` の経過をチェック
 *    - >2x interval → warning (process.stderr.write = journalctlに届く)
 *    - >5x interval → critical + gateway再起動
 * 3. ログファイル監視: ディスク上のログファイル更新日時も確認
 *
 * DENNOU_RULES.md Rule 1 (Encapsulation) に従い、上流コードは一切変更しない。
 */
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { logDebug } from "../logger.js";

// ============================================================
// Constants
// ============================================================

/**
 * Alive marker の書き込み間隔（ms）
 * 30分周期の HealingWorker より十分短い間隔で監視する。
 */
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5分

/**
 * 自己監視の警告閾値（intervalの倍率）
 * タイマーが2回分飛んだら警告する。
 */
const WARN_SKIP_FACTOR = 2;

/**
 * 自己監視の critical 閾値（intervalの倍率）
 * タイマーが5回分飛んだら再起動する。
 */
const CRITICAL_SKIP_FACTOR = 5;

/**
 * ログファイルの staleness 検出閾値（ms）
 * ログファイルのmtimeがこの値を超えて更新されていなければ再起動。
 */
const LOG_STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30分

/**
 * ログファイルのベースディレクトリ
 */
const LOG_DIR = "/tmp/openclaw";

/**
 * ログファイルのプレフィックス
 */
const LOG_PREFIX = "openclaw";

// ============================================================
// State
// ============================================================

let isRunning = false;
let intervalTimer: ReturnType<typeof setInterval> | null = null;
let lastTickHrTime: bigint = 0n;
let tickCount = 0;

// ============================================================
// Helpers
// ============================================================

/**
 * 現在日付に対応するログファイルのパスを返す。
 */
function getTodayLogFilePath(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return path.join(LOG_DIR, `${LOG_PREFIX}-${y}-${m}-${d}.log`);
}

/**
 * stderr にメッセージを書き込む。
 * journalctl/systemd に確実に届くパス。
 */
function writeStderr(msg: string): void {
  try {
    process.stderr.write(`[DennouAibou/liveness] ${msg}\n`);
  } catch {
    // stderr すら死んでいる場合はどうしようもない
  }
}

/**
 * ログファイルの最終更新日時からの経過時間を返す（ms）。
 * ファイルが存在しない場合は 0 を返す。
 */
function getLogFileAgeMs(): number {
  try {
    const logFile = getTodayLogFilePath();
    if (!fs.existsSync(logFile)) {
      // ファイルがない = 最も深刻な状態。無限大で再起動トリガーする。
      return Infinity;
    }
    const stat = fs.statSync(logFile);
    return Date.now() - stat.mtimeMs;
  } catch {
    return Infinity;
  }
}

// ============================================================
// Core watchdog tick
// ============================================================

function watchdogTick(): void {
  tickCount++;

  // ---- 自己監視: hrtime の経過チェック ----
  const now = process.hrtime.bigint();
  let elapsedMs = 0;
  if (lastTickHrTime !== 0n) {
    const elapsedNs = now - lastTickHrTime;
    elapsedMs = Number(elapsedNs / 1_000_000n);
    const intervalFactor = elapsedMs / CHECK_INTERVAL_MS;

    if (intervalFactor >= CRITICAL_SKIP_FACTOR) {
      writeStderr(
        `CRITICAL: event loop timer stalled for ${elapsedMs}ms ` +
        `(${intervalFactor.toFixed(1)}x interval). Restarting gateway.`,
      );
      restartGateway();
      return;
    }

    if (intervalFactor >= WARN_SKIP_FACTOR) {
      writeStderr(
        `WARNING: timer delay detected: ${elapsedMs}ms ` +
        `(${intervalFactor.toFixed(1)}x interval). ` +
        `Event loop may be partially blocked.`,
      );
    }
  }
  lastTickHrTime = now;

  // ---- ログファイルの staleness チェック ----
  // 初回 tick は gateway がまだログを書き始めていない可能性があるためスキップする
  const logAgeMs = tickCount === 1 ? 0 : getLogFileAgeMs();
  if (logAgeMs > LOG_STALE_THRESHOLD_MS) {
    writeStderr(
      `CRITICAL: log file stale for ${(logAgeMs / 1000).toFixed(0)}s ` +
      `(threshold ${LOG_STALE_THRESHOLD_MS / 1000}s). Restarting gateway.`,
    );
    restartGateway();
    return;
  }

  // ---- alive marker を log に書き込む ----
  // logDebug を使う（ファイルログにのみ書き込み、CLI出力なし）
  logDebug(
    `liveness marker tick=${tickCount} ` +
    `logAge=${(logAgeMs / 1000).toFixed(0)}s ` +
    `elapsed=${elapsedMs}ms`,
  );
}

// ============================================================
// Gateway restart
// ============================================================

let isRestarting = false;

function restartGateway(): void {
  if (isRestarting) {
    writeStderr("Restart already in progress, skipping");
    return;
  }
  isRestarting = true;
  try {
    writeStderr(`Initiating gateway restart (PID=${process.pid})`);
    const result = spawnSync("systemctl", [
      "--user",
      "restart",
      "openclaw-gateway.service",
    ], {
      timeout: 10_000,
      stdio: "pipe",
    });
    if (result.status !== 0) {
      writeStderr(
        `Gateway restart command failed: exit=${result.status} ` +
        `stderr=${result.stderr?.toString().trim() || "(empty)"}`,
      );
    } else {
      writeStderr("Gateway restart command issued successfully");
    }
  } catch (err) {
    writeStderr(
      `Gateway restart error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    isRestarting = false;
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Liveness Watchdog を開始する。
 *
 * `process.hrtime` ベースの自己監視付き `setInterval` を起動し、
 * タイマーが止まった場合やログファイルが古すぎる場合に gateway を再起動する。
 *
 * @returns クリーンアップ関数（テストやシャットダウン時に呼び出す）
 */
export function startLivenessWatchdog(): () => void {
  if (isRunning) {
    writeStderr("Already running, skipping duplicate start");
    return () => {};
  }

  isRunning = true;
  lastTickHrTime = 0n;
  tickCount = 0;

  logDebug(
    `[DennouAibou/liveness] Starting liveness watchdog (interval=${CHECK_INTERVAL_MS}ms, ` +
    `logStaleThreshold=${LOG_STALE_THRESHOLD_MS / 1000}s)`,
  );

  // 最初の tick を即座に実行
  watchdogTick();

  // 定期 tick を開始
  intervalTimer = setInterval(watchdogTick, CHECK_INTERVAL_MS);

  // クリーンアップ関数を返す
  return () => {
    isRunning = false;
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    writeStderr("Liveness watchdog stopped");
  };
}
