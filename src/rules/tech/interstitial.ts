import { evidenceLabel, type EvidenceLabel } from '../../core/evidence.ts';
import type { Overlay } from '../../render/chrome.ts';
import type { RuleImplementation, RuleResult } from '../engine.ts';
import { citer, fail, notEvaluated, pass, shorten } from './shared.ts';

/** Google gives no size and asks that banners use "a small fraction of the screen"; this is the tool's line for a candidate. */
const candidateCoverage = 0.3;
/** A promotional overlay above this share covers most of the first screen. */
const mostOfScreen = 0.5;

const consentContainer = /(^|[\s#._>-])(cookies?|consent|gdpr|rgpd|cmp|onetrust|cybotcookiebot|didomi|usercentrics|cmplz|qc-cmp2|truste|iubenda|cookiescript|axeptio|tarteaucitron|klaro)/iu;
const legalText = /\b(cookies?|consent|consentimiento|consentiment|galetes|gdpr|rgpd|over 18|age verification|verify your age|mayor de edad|majors? d'edat|verifica tu edad)\b/iu;
const accessText = /\b(log ?in|sign ?in|iniciar sesi[oó]n|inicia sessi[oó]|subscribe to (continue|read)|suscr[ií]bete para (seguir|leer)|paywall)\b/iu;
const promotionText = /\b(newsletter|subscribe|suscr[ií]bete|subscriu-te|sign up|reg[ií]strate|discount|descuento|descompte|coupon|cup[oó]n|offer|oferta|download (our|the) app|get the app|descarga (la|nuestra) app|install (our|the) app|join our)\b|\d+ ?% off\b/iu;

type Kind = 'legal' | 'access' | 'promotion' | 'unknown';

/** What an overlay is for, read from its visible text and its container's id and classes. */
function kindOf(overlay: Overlay): Kind {
  if (consentContainer.test(overlay.selector) || legalText.test(overlay.text)) return 'legal';
  if (accessText.test(overlay.text)) return 'access';
  if (promotionText.test(overlay.text)) return 'promotion';
  return 'unknown';
}

export const intrusiveInterstitial: RuleImplementation = {
  id: 'tech-intrusive-interstitial',
  evaluate(context): RuleResult {
    const render = context.page!.userRender!.result;
    if (render.overlays === undefined) return notEvaluated('no-overlay-data');
    const cite = citer(context);
    const covering = render.overlays.filter(overlay => overlay.position === 'fixed' && overlay.coverage >= candidateCoverage).map(overlay => ({ overlay, kind: kindOf(overlay) }));
    const cited = (overlay: Overlay, label: EvidenceLabel) => cite({
      kind: 'render', url: render.finalUrl, label, path: overlay.selector,
      excerpt: `${Math.round(overlay.coverage * 100)}% of the screen, z-index ${overlay.zIndex ?? 'auto'}${overlay.dialog ? ', dialog' : ''}: ${shorten(overlay.text, 160) || '(no text)'}`,
    });
    const locked = render.scrollLocked ? [cite({ kind: 'render', url: render.finalUrl, label: evidenceLabel('page scrolling locked at load (overflow hidden on html or body)'), excerpt: 'scrollLocked=true' })] : [];
    const params = (overlay: Overlay) => ({ coverage: Math.round(overlay.coverage * 100) });
    const promotion = covering.find(entry => entry.kind === 'promotion' && entry.overlay.coverage >= mostOfScreen);
    if (promotion) return fail('medium', [cited(promotion.overlay, evidenceLabel('promotional overlay over most of the first screen at load')), ...locked], 'promotion', params(promotion.overlay));
    // Login dialogs are fine on content that is not public, and an unclassified overlay may be a notice the law requires.
    const candidate = covering.find(entry => entry.kind !== 'legal');
    if (candidate) {
      const reason = candidate.kind === 'access' ? 'access-dialog' : candidate.kind === 'promotion' ? 'promotion' : 'overlay';
      return fail('medium', [cited(candidate.overlay, reason === 'overlay' ? evidenceLabel('unclassified overlay over the first screen at load')
        : reason === 'access-dialog' ? evidenceLabel('login or subscription overlay over the first screen at load') : evidenceLabel('promotional overlay over the first screen at load')), ...locked],
        reason, params(candidate.overlay), true);
    }
    const legal = covering.find(entry => entry.kind === 'legal');
    return pass(legal ? [cited(legal.overlay, evidenceLabel('legally required notice over the first screen, which Google exempts'))] : []);
  },
};
