import type { RuleImplementation } from '../engine.ts';
import { cmpBlocksContent, consentModeOrdering } from './consent.ts';
import { charsetDeclaredEarly, doctypeStandardsMode, duplicateConflictingHeadTags, iframeMainContent, noscriptContent } from './document.ts';
import { faviconDeclared, faviconFileValid } from './favicon.ts';
import { framingProtection, securityHeadersInfo } from './headers.ts';
import { hstsHeader, hstsPreloadEligibility, httpToHttpsRedirect, httpsFinalUrl, httpsToHttpDowngrade, tlsCertificateValid } from './https.ts';
import { intrusiveInterstitial } from './interstitial.ts';
import { chromeBestPracticesTrust, lighthouseA11yOverlap, lighthouseSeoCategory } from './lighthouse.ts';
import { maintenance503 } from './maintenance.ts';
import { internalLinksToHttp, mixedContentActive, mixedContentPassive } from './mixed-content.ts';
import { consoleErrors, failedRenderRequests } from './render.ts';
import { socialOgImage, socialOgImageMeta, socialOgRequired, socialOgUrlCanonical } from './social.ts';
import { contentFitsViewport, legibleFontSize, tapTargetSize, viewportMeta, viewportZoomAllowed } from './viewport.ts';

export const implementations: readonly RuleImplementation[] = [
  httpsFinalUrl,
  tlsCertificateValid,
  httpToHttpsRedirect,
  httpsToHttpDowngrade,
  mixedContentActive,
  mixedContentPassive,
  hstsHeader,
  hstsPreloadEligibility,
  securityHeadersInfo,
  framingProtection,
  cmpBlocksContent,
  consentModeOrdering,
  intrusiveInterstitial,
  viewportMeta,
  viewportZoomAllowed,
  contentFitsViewport,
  legibleFontSize,
  tapTargetSize,
  faviconDeclared,
  faviconFileValid,
  duplicateConflictingHeadTags,
  doctypeStandardsMode,
  charsetDeclaredEarly,
  iframeMainContent,
  noscriptContent,
  lighthouseSeoCategory,
  lighthouseA11yOverlap,
  maintenance503,
  internalLinksToHttp,
  socialOgRequired,
  socialOgImage,
  socialOgImageMeta,
  socialOgUrlCanonical,
  consoleErrors,
  failedRenderRequests,
  chromeBestPracticesTrust,
];
