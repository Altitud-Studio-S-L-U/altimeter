import type { RuleImplementation } from '../engine.ts';
import { dataNosnippetInvalid, imagePreviewLarge, metaDescriptionDuplicate, metaDescriptionMissing, metaDescriptionQuality } from './descriptions.ts';
import { h1EmptyOrImage, h1Missing, headingLevelSkips, mainLandmark } from './headings.ts';
import { imgAltMissing, imgAltQuality, imgCssBackground, imgFilename, imgFormat, imgLazyMisuse, preferredImage } from './images.ts';
import {
  anchorTextEmpty, anchorTextQuality, linkSchemesVisible, outboundCitations, paidLinksUnqualified, thinAffiliate, ugcLinkQualifiers,
} from './link-rules.ts';
import { boilerplateRatio, fillerBeforeMc, originality, scaledDoorway } from './quality.ts';
import { aiArtifacts, cloakingUa, hackedSignals, hiddenLinks, hiddenText, keywordStuffing, sneakyRedirects } from './spam.ts';
import {
  titleBoilerplate, titleBranding, titleDuplicate, titleH1Mismatch, titleMissing, titleMultiple, titleObsoleteYear, titleRawRenderedMismatch,
  titleStuffing, titleWidth,
} from './titles.ts';
import { bylineAuthor, dateConsistency, dateManipulation, staleContent, trustPages } from './trust.ts';

export const implementations: readonly RuleImplementation[] = [
  titleMissing, titleMultiple, titleRawRenderedMismatch, titleDuplicate, titleBoilerplate, titleWidth, titleStuffing, titleH1Mismatch,
  titleObsoleteYear, titleBranding,
  metaDescriptionMissing, metaDescriptionDuplicate, metaDescriptionQuality, dataNosnippetInvalid, imagePreviewLarge,
  h1Missing, h1EmptyOrImage, headingLevelSkips, mainLandmark,
  boilerplateRatio, fillerBeforeMc, originality, scaledDoorway,
  aiArtifacts, hiddenText, hiddenLinks, keywordStuffing, cloakingUa, sneakyRedirects, hackedSignals,
  thinAffiliate, paidLinksUnqualified, ugcLinkQualifiers, linkSchemesVisible, anchorTextEmpty, anchorTextQuality, outboundCitations,
  imgAltMissing, imgAltQuality, imgFilename, imgCssBackground, imgFormat, imgLazyMisuse, preferredImage,
  bylineAuthor, dateConsistency, dateManipulation, trustPages, staleContent,
];
