/**
 * 提醒页
 *
 * 布局：顶部一行紧凑倒计时 → 每张提醒卡（快捷间隔芯片常驻，不必展开就能改）
 *       → 添加提醒。
 */
import { h, frag } from '../ui/dom.js';
import {
  colorForIcon,
  icon,
  iconForTask,
  TASK_ICON_GROUPS,
  TASK_ICON_LABELS,
} from '../ui/icons.js';
import { state, isDaily, taskTitle, DURATION_UNITS, DURATION_MAX } from '../core/store.js';
import { S } from '../core/strings.js';
import { fmt, describeSchedule, bestRemaining } from '../core/countdown.js';

const QUICK_INTERVALS = [15, 30, 45, 60];
const QUICK_TIMES = ['09:00', '12:00', '15:00', '18:00', '22:00'];

export function renderTasks() {
  const page = h('div', { class: 'page scroll-thin' });

  page.append(renderHead(), renderCountdown());
  if (!state.settings.tasks.length) {
    page.append(h('div', { class: 'empty' }, S.noTasks));
  } else {
    for (const task of state.settings.tasks) page.append(renderCard(task));
  }
  page.append(renderAddButton());

  return page;
}

/* ============================== 顶部 ============================== */

function renderHead() {
  return h(
    'div',
    { class: 'page-head' },
    h('h1', null, S.tasksTitle),
    h(
      'button',
      {
        class: 'btn btn-ghost btn-sm',
        dataset: { act: 'pause-all' },
        'aria-pressed': String(state.isPaused),
      },
      icon(state.isPaused ? 'play' : 'pause', { size: 15 }),
      state.isPaused ? S.resumeAll : S.pauseAll
    ),
    h(
      'button',
      { class: 'btn btn-ghost btn-sm', dataset: { act: 'reset-all' }, 'aria-label': S.resetAll },
      icon('refresh', { size: 15 })
    )
  );
}

function renderCountdown() {
  const idle = state.isIdle;
  const best = state.isPaused ? null : bestRemaining();

  let text;
  let time = '--:--';
  if (state.isPaused) {
    text = S.paused;
  } else if (idle) {
    text = S.idle;
  } else if (best) {
    text = `${S.nextPrefix}：${taskTitle(best.task)}`;
    time = fmt(best.left);
  } else {
    text = S.notScheduled;
  }

  return h(
    'div',
    { class: 'countdown-strip', dataset: { idle: String(idle || state.isPaused) } },
    icon('timer', { size: 20 }),
    h('div', { class: 'cs-text' }, text),
    h('div', { class: 'cs-time num', dataset: { role: 'strip-time' } }, time)
  );
}

/* ============================== 提醒卡 ============================== */

function renderCard(task) {
  const expanded = state.expandedTaskId === task.id;

  const top = h(
    'div',
    { class: 'card-top' },
    h('div', { class: 'icon-bubble' }, icon(iconForTask(task), { size: 24 })),
    h(
      'div',
      { class: 'card-title' },
      h('b', null, taskTitle(task)),
      h(
        'small',
        null,
        `${describeSchedule(task)} · ${task.reminderMode === 'lock' ? S.modeLock : S.modeFocus}`
      )
    ),
    h('span', { class: 'dot' }),
    h('button', {
      class: 'switch',
      role: 'switch',
      dataset: { act: 'toggle-task', id: task.id },
      'aria-checked': String(task.enabled),
      'aria-label': taskTitle(task),
    }),
    h(
      'button',
      {
        class: 'card-toggle',
        dataset: { act: 'expand-task', id: task.id },
        'aria-expanded': String(expanded),
        'aria-label': expanded ? '收起' : '展开',
      },
      icon('chevron', { size: 16 })
    )
  );

  const card = h(
    'div',
    {
      class: 'card',
      dataset: {
        // 传分类不传图标名 —— 见 Reminder.js 里的同一处说明
        idColor: colorForIcon(task.icon),
        enabled: String(task.enabled),
        expanded: String(expanded),
        taskId: task.id,
      },
    },
    top,
    renderQuickIntervals(task)
  );

  if (expanded) card.append(renderBody(task));
  return card;
}

/**
 * 快捷间隔芯片常驻在卡片上。
 * 旧版把这些藏进展开区，是最伤人的一次退化 —— 改个间隔不该要点开详情。
 */
function renderQuickIntervals(task) {
  if (isDaily(task)) {
    return h(
      'div',
      { class: 'chips' },
      ...task.dailyTimes.map(time =>
        h('span', { class: 'chip chip-time' }, h('span', { class: 'num' }, time))
      ),
      h(
        'button',
        { class: 'chip chip-add', dataset: { act: 'expand-task', id: task.id } },
        `${S.addTime}…`
      )
    );
  }

  const options = QUICK_INTERVALS.includes(task.interval)
    ? QUICK_INTERVALS
    : [...QUICK_INTERVALS, task.interval].sort((a, b) => a - b);

  return h(
    'div',
    { class: 'chips' },
    ...options.map(minutes =>
      h(
        'button',
        {
          class: 'chip num',
          dataset: { act: 'set-interval', id: task.id, value: String(minutes) },
          'aria-pressed': String(task.interval === minutes),
        },
        `${minutes} 分`
      )
    )
  );
}

/* ============================== 展开后的编辑区 ============================== */

function renderBody(task) {
  return h(
    'div',
    { class: 'card-body' },
    field(S.taskName, nameInput(task)),
    field(S.taskIcon, iconPicker(task)),
    field(S.taskSchedule, schedulePicker(task)),
    isDaily(task) ? field(S.taskSchedule, timePicker(task)) : field(S.taskInterval, stepperFor(task, 'interval', 1, 1440, S.minutes)),
    field(
      S.taskMode,
      frag(
        segmented('set-mode', task.id, [
          { value: 'focus', label: S.modeFocus },
          { value: 'lock', label: S.modeLock },
        ], task.reminderMode),
        h('div', { class: 'field-hint' }, task.reminderMode === 'lock' ? S.modeLockHint : S.modeFocusHint)
      )
    ),
    task.reminderMode === 'lock' ? field(S.taskLockDuration, durationPicker(task)) : null,
    field(S.taskPreNotify, stepperFor(task, 'preNotificationSeconds', 0, 300, S.seconds)),
    field(S.taskSnooze, stepperFor(task, 'snoozeMinutes', 1, 120, S.minutes)),
    field(S.taskMaxSnooze, stepperFor(task, 'maxSnooze', 0, 10, S.times)),
    h(
      'button',
      { class: 'btn btn-ghost btn-sm', dataset: { act: 'delete-task', id: task.id } },
      icon('trash', { size: 15 }),
      S.deleteTask
    )
  );
}

function field(label, control) {
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-label' }, label),
    control
  );
}

function nameInput(task) {
  return h('input', {
    class: 'input',
    type: 'text',
    value: taskTitle(task),
    placeholder: S.newTaskTitle,
    dataset: { act: 'task-title', id: task.id },
  });
}

/**
 * 图标选择器：8 列的方形网格，24 个一眼看全，不用翻页也不用展开二级面板。
 *
 * 旧版是 4 个胶囊（只有内置那四个），既表达不了"喝牛奶""早睡"这种常见提醒，
 * 又因为四个图标是分开画的、视觉重量不齐，摆一起就是用户说的"不对称"。
 *
 * 选中态填的是**该图标所属分类的颜色**，不是一律主蓝 —— 选完就知道这张卡
 * 会变成什么颜色，不用先选再看效果。这也顺手把"颜色 = 分类"这件事教给用户。
 */
function iconPicker(task) {
  const current = iconForTask(task);
  return h(
    'div',
    { class: 'icon-picker', role: 'radiogroup', 'aria-label': S.taskIcon },
    ...TASK_ICON_GROUPS.flatMap(group =>
      group.icons.map(name =>
        h(
          'button',
          {
            class: 'icon-pick',
            role: 'radio',
            dataset: { act: 'set-icon', id: task.id, value: name, color: group.color },
            'aria-checked': String(current === name),
            'aria-label': TASK_ICON_LABELS[name] || name,
            title: TASK_ICON_LABELS[name] || name,
          },
          icon(name, { size: 18 })
        )
      )
    )
  );
}

function schedulePicker(task) {
  return segmented('set-schedule', task.id, [
    { value: 'interval', label: S.scheduleInterval },
    { value: 'daily', label: S.scheduleDaily },
  ], task.scheduleType);
}

function timePicker(task) {
  return frag(
    h(
      'div',
      { class: 'chips' },
      ...task.dailyTimes.map(time =>
        h(
          'span',
          { class: 'chip chip-time' },
          h('span', { class: 'num' }, time),
          h(
            'button',
            {
              class: 'x',
              dataset: { act: 'drop-time', id: task.id, value: time },
              'aria-label': `删除 ${time}`,
            },
            '×'
          )
        )
      ),
      ...QUICK_TIMES.filter(t => !task.dailyTimes.includes(t)).map(time =>
        h(
          'button',
          { class: 'chip chip-add num', dataset: { act: 'quick-time', id: task.id, value: time } },
          `+ ${time}`
        )
      )
    ),
    h(
      'div',
      { class: 'chips' },
      h('input', {
        class: 'input',
        type: 'text',
        inputmode: 'numeric',
        placeholder: S.timePlaceholder,
        style: { width: '110px', minHeight: '32px' },
        dataset: { act: 'time-draft', id: task.id },
      }),
      h(
        'button',
        { class: 'chip', dataset: { act: 'add-time', id: task.id } },
        S.addTime
      )
    )
  );
}

/* ============================== 通用控件 ============================== */

/**
 * 分段控件。选项上的 data-act 由父级 `act` 统一接管 ——
 * 这里刻意不给每个选项单独注册处理器，避免又出现"视图和处理器各叫各的名字"。
 */
function segmented(act, id, options, current) {
  return h(
    'div',
    { class: 'segmented' },
    ...options.map(option =>
      h(
        'button',
        {
          dataset: { act, id, value: option.value },
          'aria-pressed': String(current === option.value),
        },
        option.label
      )
    )
  );
}

/**
 * 休息时长：数字框 + 秒 / 分钟 / 小时。
 *
 * 旧版是纯秒的步进器、上限 600 —— "休息 2 小时"根本敲不进去。这里也不用
 * 步进器：从 1 分加到 2 小时要点 119 下。
 *
 * 数字**只在 change（回车 / 失焦）时提交**，不在每次按键时提交。
 * 因为往大改、且改完超过 10 分钟要验指纹 —— 逐键提交会把敲 "180" 的
 * 三次击键当成三次独立的加码，弹三次指纹。见 actions.js 的 applyDuration。
 *
 * 单位按钮改的是**这个数字的含义**，不做换算：1 → 点"小时" → 1 小时。
 * 想成"我想休息 1 小时"比"我想休息 60 秒换算成小时是多少"自然得多。
 */
function durationPicker(task) {
  const unit = task.durationUnit || 'min';
  const per = DURATION_UNITS[unit];

  return frag(
    h(
      'div',
      { class: 'duration-row' },
      h('input', {
        type: 'number',
        value: String(Math.round(task.lockDuration / per)),
        min: '1',
        max: String(Math.floor(DURATION_MAX / per)),
        dataset: { act: 'lock-duration', id: task.id },
        'aria-label': S.taskLockDuration,
      }),
      h(
        'div',
        { class: 'segmented' },
        ...[
          ['sec', S.seconds],
          ['min', S.minutes],
          ['hour', S.hours],
        ].map(([value, label]) =>
          h(
            'button',
            {
              dataset: { act: 'set-duration-unit', id: task.id, value },
              'aria-pressed': String(unit === value),
            },
            label
          )
        )
      )
    ),
    h('div', { class: 'field-hint' }, S.durationAuthHint)
  );
}

/**
 * 步进器。加减按钮和输入框共用同一个 data-act：
 *   点击 → `act`（读 data-delta），键入 → `act:change`
 * 一个名字，一个字段，不可能对不上。
 */
function stepperFor(task, fieldName, min, max, unit) {
  return h(
    'div',
    { class: 'stepper' },
    h(
      'button',
      {
        dataset: { act: fieldName, id: task.id, delta: '-1' },
        'aria-label': '减少',
      },
      '−'
    ),
    h('input', {
      type: 'number',
      value: String(task[fieldName]),
      min: String(min),
      max: String(max),
      dataset: { act: fieldName, id: task.id, delta: '0' },
    }),
    h('button', { dataset: { act: fieldName, id: task.id, delta: '1' }, 'aria-label': '增加' }, '+'),
    h('span', { class: 'unit' }, unit)
  );
}

function renderAddButton() {
  return h(
    'button',
    { class: 'btn btn-ghost btn-block', dataset: { act: 'add-task' } },
    icon('plus', { size: 16 }),
    S.addTask
  );
}
