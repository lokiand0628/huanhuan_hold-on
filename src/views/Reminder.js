/**
 * 居中浮窗（`?mode=reminder`）。
 *
 * 产品定义：桌面正中一个无边框置顶小窗，**点「确认」才消失**。
 * 它比系统通知强的地方正是这一点 —— 通知可以被无视，这个不行，
 * 它就在你正在看的地方挡着。
 *
 * 窗口本身：`decorations(false)` + `always_on_top(true)` + `skip_taskbar(true)`
 * + `closable(false)`，并且在 Rust 的 `on_window_event` 里有自己的 close guard。
 * 没有那个 guard，Cmd+W 就能把它关掉 —— 那它和通知就没区别了。
 *
 * 窗口是 `transparent(true)` 的，所以这张圆角卡片的外面必须是完全透明的：
 * 圆角外面不能有一块白。`body[data-route="reminder"]` 负责这一点。
 */
import { h } from '../ui/dom.js';
import { colorForIcon, icon, iconForTask } from '../ui/icons.js';
import { S } from '../core/strings.js';

export function renderReminder(payload, { snoozeMinutes, canSnooze }) {
  const data = payload || {};
  const title = data.title || data.name || S.appName;
  const desc = data.desc || '';

  const iconName = iconForTask({ id: data.id, icon: data.icon });

  const card = h(
    'div',
    // data-id-color 决定气泡和圆点的身份色。少了它气泡会退回默认紫 ——
    // 喝水提醒配一个紫水滴，就是那种"说不上哪里不对但一眼就不对"的错。
    //
    // 传的是**分类**不是图标名：颜色 = 分类（蓝作息 / 绿入口 / 橙休息 / 紫其它），
    // 24 个图标共用这四个色。直接把图标名丢进来只有那四个老名字能命中，
    // 其余 20 个会静默退回默认紫 —— 那正是要修掉的东西。
    { class: 'reminder-card', dataset: { idColor: colorForIcon(iconName) } },
    h('div', { class: 'icon-bubble' }, icon(iconName, { size: 28 })),
    h('h2', null, title),
    desc ? h('p', null, desc) : null,
    h(
      'div',
      { class: 'reminder-actions' },
      h(
        'button',
        { class: 'btn btn-primary btn-block', dataset: { act: 'reminder-confirm' } },
        icon('check', { size: 16 }),
        S.reminderConfirm
      ),
      // 推迟按钮只在两种情况下出现，由 main.js 判定后传进来：
      //   1. 这次触发不是推迟来的 —— 软提醒只让推迟一次，推迟到点弹出来的
      //      那一次就只剩「知道了」，否则可以无限推下去；
      //   2. 推迟时长大于 5 分钟 —— 只有 5 分钟或更短的话，
      //      "5 分钟后再提醒你"几乎等于没推，不如不给这个按钮。
      canSnooze
        ? h(
            'button',
            { class: 'btn btn-ghost btn-block', dataset: { act: 'reminder-snooze' } },
            S.reminderSnooze(snoozeMinutes)
          )
        : null
    )
  );

  return h('div', { class: 'reminder-stage' }, card);
}
