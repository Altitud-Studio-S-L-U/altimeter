import { png } from '../support/assets.ts';
import { defineScenario } from '../support/scenario.ts';
import { studioHosts, studioSite } from '../support/studio.ts';

const page = '/en/';

// Swaps data-src in only after a scroll event: a crawler that never scrolls keeps the placeholder.
const scrollLoader = `<script type="module">
addEventListener('scroll', () => {
  for (const image of document.querySelectorAll('img[data-src]')) image.src = image.dataset.src;
}, { once: true, passive: true });
</script>`;

export default defineScenario({
  name: 'image-problems',
  summary: 'The real problems behind the decorative-image traps: content images with no alt attribute, a file name as alt text, and a scroll-only loader.',
  hosts: studioHosts,
  build: context => studioSite(context, page, {}, site => {
    const home = site.pages.get(page)!;
    home.body = home.body
      .replace(/(<img src="\/images\/services\/automation\.png"[^>]*?) alt=""/u, '$1')
      .replace(/(<img src="\/images\/services\/consulting\.png"[^>]*?) alt=""/u, '$1')
      .replace(/(<img src="\/images\/services\/data-platforms\.png"[^>]*?) alt=""/u, '$1 alt="data-platforms"')
      .replace(/<section class="cases" data-reveal>[\s\S]*?<\/section>/u, section => section
        .replace(/<img src="([^"]+)" srcset="[^"]*" sizes="[^"]*"/gu, '<img src="/images/placeholder.png" data-src="$1"'));
    home.body += `\n${scrollLoader}`;
    site.routes.set('/images/placeholder.png', site.file('image/png', png(24, 16, [230, 230, 230])));
  }),
  mustFail: [
    { rule: 'content-img-alt-missing', severity: 'medium', reason: 'content-image', page },
    { rule: 'content-img-alt-quality', severity: 'low', reason: 'filename', page },
    { rule: 'content-img-lazy-misuse', severity: 'medium', page },
  ],
  mustNotFail: [
    { rule: 'content-img-format', page },
  ],
});
