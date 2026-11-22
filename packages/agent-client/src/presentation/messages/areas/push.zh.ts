import type { AreaMessages } from '../types.js';
import type { push as english } from './push.en.js';

export const push: AreaMessages<typeof english> = {
  'push.title': '在这台设备上提醒我',
  'push.hint': '助手需要你或完成时，即使 Orchard 没打开也会提醒',
  'push.on': '这台设备已开启。',
  'push.paused': '已暂停：这台设备的「通知」关着。',
  'push.install': '在 iPhone 和 iPad 上，只有主屏幕上的 Orchard 能提醒你。点「分享」，再选「添加到主屏幕」，之后从图标打开。',
  'push.unsupported': '这个浏览器没法在 Orchard 关闭时提醒你。',
  'push.server': '这台服务器不发送提醒。',
  'push.blocked': '这个网站的通知被屏蔽了，请在浏览器的网站设置里允许，再打开这里。',
  'push.failed': '没能开启提醒，再试一次吧。',
};
