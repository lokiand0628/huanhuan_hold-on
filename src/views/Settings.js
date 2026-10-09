/**
 * 设置页。4 组约 10 行 —— 旧版是 5 组约 20 行，一半是没人看得懂的工程术语。
 *
 * 每任务的设置（间隔、提醒方式、休息时长、推迟）在提醒页展开里，
 * 不在这里。设置页只放全局的。
 */
import { h } from '../ui/dom.js';
import { icon, logoMark } from '../ui/icons.js';
import { state } from '../core/store.js';
import { S } from '../core/strings.js';

export function renderSettings({ autostartBusy }) {
  const s = state.settings;

  const page = h('div', { class: 'page scroll-thin' });
  page.append(h('div', { class: 'page-head' }, h('h1', null, S.settingsTitle)));

  page.append(
    group(
      'shield',
      S.groupBreak,
      row(S.mediaDuringBreak, null, mediaSegmented(s.lockMediaMode)),
      row(
        S.resetOnIdle,
        S.resetOnIdleDesc,
        switchEl('toggle-reset-idle', s.resetOnIdle)
      ),
      s.resetOnIdle
        ? row(
            S.idleThreshold,
            null,
            stepper({
              act: 'idle-threshold',
              value: Math.round(s.idleThreshold / 60),
              min: 1,
              max: 60,
              unit: S.minutes,
            })
          )
        : null
    )
  );

  page.append(
    group(
      'volume',
      S.groupGeneral,
      row(S.soundEnabled, null, switchEl('toggle-sound', s.soundEnabled)),
      row(
        S.customSound,
        s.customSoundPath ? shortPath(s.customSoundPath) : S.noCustomSound,
        h(
          'div',
          { class: 'row-actions' },
          h(
            'button',
            { class: 'btn btn-ghost btn-sm', dataset: { act: 'pick-sound' } },
            s.customSoundPath ? S.changeSound : S.pickSound
          ),
          s.customSoundPath
            ? h(
                'button',
                { class: 'btn btn-ghost btn-sm', dataset: { act: 'test-sound' } },
                S.testSound
              )
            : null,
          s.customSoundPath
            ? h('button', {
                class: 'btn btn-text btn-sm',
                dataset: { act: 'clear-sound' },
                'aria-label': S.noCustomSound,
              }, '×')
            : null
        )
      ),
      row(
        S.autoStart,
        S.autoStartDesc,
        switchEl('toggle-autostart', s.autoStart, autostartBusy)
      ),
      row(S.silentStart, S.silentStartDesc, switchEl('toggle-silent', s.silentAutoStart))
    )
  );

  page.append(
    group(
      'image',
      S.groupLook,
      row(
        S.bgImage,
        s.lockScreenBgImage ? shortPath(s.lockScreenBgImage) : S.bgImageDesc,
        h(
          'div',
          { class: 'row-actions' },
          h(
            'button',
            { class: 'btn btn-ghost btn-sm', dataset: { act: 'pick-image' } },
            s.lockScreenBgImage ? S.changeImage : S.pickImage
          ),
          s.lockScreenBgImage
            ? h(
                'button',
                { class: 'btn btn-text btn-sm', dataset: { act: 'clear-image' } },
                S.clearImage
              )
            : null
        )
      )
    )
  );

  page.append(
    group(
      'info',
      S.groupAbout,
      // 应用标记 + 名字。标记是透明底的填充图形，颜色跟随主题 ——
      // 这里**不能**给它加色块背景，套了框就成了一个缩小的 app 图标。
      h(
        'div',
        { class: 'row row-brand' },
        h('div', { class: 'brand-mark' }, logoMark(26)),
        h(
          'div',
          { class: 'row-text' },
          h('b', null, S.appName),
          h('small', null, `Hold On · ${S.appTagline}`)
        )
      ),
      row(S.version(state.version), null, null),
      row(
        S.checkUpdate,
        null,
        h(
          'button',
          { class: 'btn btn-ghost btn-sm', dataset: { act: 'check-update' } },
          icon('refresh', { size: 15 })
        )
      )
    )
  );

  return page;
}

/* ============================== 基元 ============================== */

function group(iconName, title, ...rows) {
  return h(
    'section',
    { class: 'group' },
    h('div', { class: 'group-head' }, icon(iconName, { size: 16 }), h('span', null, title)),
    h('div', { class: 'group-body' }, ...rows)
  );
}

function row(label, sub, control) {
  return h(
    'div',
    { class: 'row' },
    h('div', { class: 'row-text' }, h('b', null, label), sub ? h('small', null, sub) : null),
    control ? h('div', { class: 'row-ctl' }, control) : null
  );
}

function switchEl(act, on, busy) {
  return h('button', {
    class: 'switch',
    role: 'switch',
    dataset: { act },
    'aria-checked': String(!!on),
    'aria-label': act,
    disabled: !!busy,
  });
}

function mediaSegmented(current) {
  const options = [
    { value: 'none', label: S.mediaNone },
    { value: 'video', label: S.mediaVideo },
    { value: 'all', label: S.mediaAll },
  ];
  return h(
    'div',
    { class: 'segmented' },
    ...options.map(option =>
      h(
        'button',
        {
          dataset: { act: 'set-media', value: option.value },
          'aria-pressed': String(current === option.value),
        },
        option.label
      )
    )
  );
}

/** 步进器：和提醒页共用一套外观与同一套 data-act 约定 */
function stepper({ act, value, min, max, unit }) {
  return h(
    'div',
    { class: 'stepper' },
    h('button', { dataset: { act, delta: '-1' }, 'aria-label': '减少' }, '−'),
    h('input', {
      type: 'number',
      value: String(value),
      min: String(min),
      max: String(max),
      dataset: { act, delta: '0' },
    }),
    h('button', { dataset: { act, delta: '1' }, 'aria-label': '增加' }, '+'),
    h('span', { class: 'unit' }, unit)
  );
}

/** 路径太长会把行撑爆，只留最后两段 */
function shortPath(path) {
  const parts = String(path).split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}
