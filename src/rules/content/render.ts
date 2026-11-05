import type { RenderFacts } from '../../core/facts.ts';
import type { TextBlock } from '../../render/chrome.ts';
import { fold } from './common.ts';

/** Height of the phone viewport both renders start from; the Googlebot-like render then grows it. */
export const phoneViewportHeight = 823;

/** Reasons that keep text from users entirely. Screen-reader-only text and reveal animations are not among them. */
export const removedFromView: ReadonlySet<NonNullable<TextBlock['hidden']>> = new Set(['display-none', 'visibility-hidden', 'zero-size', 'offscreen']);

const squash = (text: string) => fold(text).replace(/\s+/gu, ' ').trim();

/** Text blocks rendered inside an element with tag `tag` whose text is part of `text`. */
export function blocksWithin(render: RenderFacts | undefined, tag: string, text: string): TextBlock[] {
  if (!render) return [];
  const segment = new RegExp(`(^|> )${tag}([.#]|$| )`, 'u');
  const whole = squash(text);
  return render.result.textBlocks.filter(block => segment.test(block.selector) && whole.includes(squash(block.text)));
}

/** True when the text is shown somewhere in the render, so a hidden copy (a responsive duplicate) is not hiding it. */
export function shownIn(render: RenderFacts | undefined, text: string): boolean {
  if (!render) return false;
  const wanted = squash(text);
  return render.result.textBlocks.some(block => block.hidden === undefined && squash(block.text) === wanted);
}

/** UI components that hide text by design: menus, drawers, dialogs, tabs, accordions, sliders, tooltips, screen-reader text. */
export const designHiddenSelector = /nav|menu|drawer|off-?canvas|cookie|consent|modal|dialog|popup|popover|tooltip|\btab|accordion|collaps|slider|carousel|swiper|slick|splide|glide|marquee|ticker|sr-only|visually-hidden|screen-reader|skip|dropdown|mega|toggle|expand|faq|details|summary/iu;
