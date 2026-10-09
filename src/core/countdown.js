/**
 * 倒计时的订阅与格式化。
 */
import { api } from './api.js';
import { state, isDaily } from './store.js';
import { taskTitle } from './strings.js';

const pad = n => String(n).padStart(2, '0');

/** 秒 → `12:34` 或 `1:02:03`。永远定宽，配合 tabular-nums 不跳。 */
export function fmt(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${pad(m)}:${pad(s)}`;
}

/** 排期的一句话描述：「每 45 分钟」/「每天 22:00、08:30」 */
export function describeSchedule(task) {
  if (isDaily(task)) return task.dailyTimes.join('、');
  return `每 ${task.interval} 分钟`;
}

export function initCountdowns(list) {
  for (const info of list || []) apply(info);
}

function apply(info) {
  if (!info?.id) return;
  state.countdowns[info.id] = info.remaining;
  if (info.task_paused !== undefined) state.pausedTasks[info.id] = !!info.task_paused;
}

/** 托盘 tooltip 那份倒计时（主窗口之外唯一还显示剩余时间的地方） */
export function trayTip() {
  const best = bestRemaining();
  if (!best) return '健康提醒';
  return `${taskTitle(best.task)} ${fmt(best.left)}`;
}

export function bestRemaining() {
  let best = null;
  let bestLeft = Infinity;
  for (const task of state.settings.tasks) {
    if (!task.enabled || state.pausedTasks[task.id]) continue;
    const left = state.countdowns[task.id];
    if (left === undefined || left <= 0) continue;
    if (left < bestLeft) {
      bestLeft = left;
      best = task;
    }
  }
  return best ? { task: best, left: bestLeft } : null;
}

export function subscribeCountdowns(onUpdate) {
  api
    .listen('countdown-update', event => {
      const list = event.payload || [];
      if (!list.length) return;
      for (const info of list) apply(info);
      onUpdate();
      api.updateTrayTooltip(trayTip());
    })
    .catch(err => console.error('[countdown]', err));
}
