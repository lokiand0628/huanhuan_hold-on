/**
 * 主窗口外壳：两页 + 页签 + 提示条。
 *
 * 只有两页。概览页和今日计数都删了 —— 用户明确说"不要，保持极简"。
 * 提醒页顶部那一行倒计时就是主窗口唯一的倒计时入口。
 */
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { state } from '../core/store.js';
import { S } from '../core/strings.js';
import { renderTasks } from './Tasks.js';
import { renderSettings } from './Settings.js';

export function renderApp({ autostartBusy }) {
  const shell = h('div', { class: 'shell' });

  // 沉浸式标题栏下红绿灯是浮在内容上的，得有东西给它们让位；
  // 同时系统不再提供可拖的标题栏，拖拽只能由这条空白承担。
  shell.append(h('div', { class: 'titlebar', 'aria-hidden': 'true' }));
  shell.append(state.tab === 'settings' ? renderSettings({ autostartBusy }) : renderTasks());
  shell.append(renderTabs());
  shell.append(renderToasts());

  return shell;
}

function renderTabs() {
  const tabs = [
    { id: 'tasks', label: S.tabTasks, icon: 'bell' },
    { id: 'settings', label: S.tabSettings, icon: 'sliders' },
  ];

  return h(
    'nav',
    { class: 'tabs', role: 'tablist' },
    ...tabs.map(tab =>
      h(
        'button',
        {
          role: 'tab',
          dataset: { act: 'tab', value: tab.id },
          'aria-selected': String(state.tab === tab.id),
        },
        icon(tab.icon, { size: 18 }),
        h('span', null, tab.label)
      )
    )
  );
}

/**
 * 提示条。只在这里重建 —— 它不在任何输入控件的祖先链上，
 * 所以重建它不会打断正在打字的人。
 */
export function renderToasts() {
  if (!state.toasts.length) return h('div', { class: 'toasts' });
  return h(
    'div',
    { class: 'toasts' },
    ...state.toasts.map(toast =>
      h('div', { class: 'toast', dataset: { tone: toast.tone || 'neutral' } }, toast.text)
    )
  );
}
