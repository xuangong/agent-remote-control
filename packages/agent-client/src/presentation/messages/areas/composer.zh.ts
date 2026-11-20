import type { AreaMessages } from '../types.js';
import type { composer as english } from './composer.en.js';

export const composer: AreaMessages<typeof english> = {
  'composer.imagesAfterHistory': '第一条消息只能是文字。之前的记录带上之后，就能发图片了。',
  'composer.resourcesAfterHistory': '之前的记录带上之后，就能发文件了。',
  'composer.queueAfterHistory': '第一条消息要马上发出，不能排队。',
  'composer.queueHint': '等这一轮做完，再交给它处理',
};
