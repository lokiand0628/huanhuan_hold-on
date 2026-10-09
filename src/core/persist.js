/**
 * 落盘：settings.json 与 lock.json。
 *
 * 两件事必须一起做，所以放在一个模块里：
 *   - 存设置（纯配置）
 *   - 存强制锁状态（跨进程的存活凭据）
 * 分开的模块很容易出现"改了设置忘了存"或"锁写了一半"。
 */
import { api } from './api.js';
import { state, serialize } from './store.js';

let saveChain = Promise.resolve();

/** 写设置。串行化，避免两次快速改动互相覆盖。 */
export function saveSettings() {
  const json = serialize();
  saveChain = saveChain.then(() => api.saveSettings(json)).catch(err => console.error('[persist]', err));
  return saveChain;
}

/* ============================== 强制锁状态 ============================== */

/**
 * `lock.json` 的形状。四条硬要求（见计划 §3.2）：
 *
 *   1. **自包含**：title/desc/icon/bg/duration/strict 全部落盘，不回头从任务配置
 *      推导 —— 任务可能已经被删了。
 *   2. `armed` 的写入顺序是语义的一部分：先写 false，锁屏真的渲染出来之后再翻
 *      true。反过来就会出现"锁一出现就 kill -9 能赶在写文件之前逃掉"。
 *   3. `gate_text` / `gate_matched` 一并落盘，重启后是同一段文字、同一份进度，
 *      重启连"重打一遍"都占不到便宜。
 *   4. **不持久化 generation** —— 那是进程内概念，跨进程没有意义。
 */

export function makeLockRecord(fields) {
  return {
    schema_version: 1,
    armed: false,
    task_id: fields.taskId,
    title: fields.title,
    desc: fields.desc || '',
    icon: fields.icon || 'sparkles',
    bg_image: fields.bgImage || null,
    duration_secs: fields.durationSecs,
    strict: fields.strict !== false,
    started_at_epoch: fields.startedAtEpoch,
    elapsed_at_checkpoint: fields.elapsedAtCheckpoint || 0,
    gate_text: fields.gateText || '',
    gate_matched: fields.gateMatched || 0,
    ...(fields.extra || {}),
  };
}

export function saveLock(record) {
  return api.saveLockState(JSON.stringify(record));
}

export function clearLock() {
  return api.clearLockState();
}

export function readPendingLock() {
  return api.pendingLock();
}

/* ============================== 计算 ============================== */

/**
 * 剩余秒数。两只钟取更"不利"的那只：
 *
 *   remaining = duration - max(墙上时钟已过, 单调检查点)
 *
 * 墙上时钟那一路让「强制关机重启」在数学上失去意义 —— 重启花掉的 3 分钟照算。
 * 单调检查点那一路防的是把系统时钟往回拨（那是唯一能靠改钟缩短休息的方向）：
 * 拨回去之后 `now - started_at` 变小，但检查点再也减不动了。
 *
 * 代价是检查点最多滞后一次心跳间隔（约 10 秒）。
 */
export function remainingSeconds(record, now = Date.now()) {
  const elapsedWall = Math.max(0, Math.floor(now / 1000) - record.started_at_epoch);
  const elapsed = Math.max(elapsedWall, record.elapsed_at_checkpoint || 0);
  return Math.max(0, record.duration_secs - elapsed);
}

/** 推进单调检查点。只在变大时写，永远不会倒退。 */
export function advanceCheckpoint(record, now = Date.now()) {
  const elapsedWall = Math.max(0, Math.floor(now / 1000) - record.started_at_epoch);
  const next = Math.max(record.elapsed_at_checkpoint || 0, elapsedWall);
  if (next === record.elapsed_at_checkpoint) return false;
  record.elapsed_at_checkpoint = next;
  return true;
}
