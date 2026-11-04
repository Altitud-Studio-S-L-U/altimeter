import type { RuleImplementation } from '../engine.ts';
import {
  gtinValidity, merchantListing, offerPriceSpecification, productSnippet, productVariants, reviewAuthenticity, reviewSnippet, selfServingReviews,
  serviceOfferCatalog, shippingDetails, softwareApp,
} from './commerce.ts';
import { duplicateFeatureNodes, idDanglingOrConflicting } from './identity.ts';
import {
  article, breadcrumb, carouselItemList, dataset, discussionForum, event, imageMetadata, jobPosting, localBusiness, paywalledContent, profilePage, qaPage,
  recipe, video,
} from './page-features.ts';
import { blockedOrNonindexableCarrier, mainEntityPageFit, visibleContentParity } from './policy.ts';
import { jsOnlyMarkup, rawRenderedConflict } from './rendering.ts';
import { faqPageRetired, retiredFeatureMarkup } from './retired.ts';
import {
  authorEntityQuality, courseList, entityConsistencySitewide, featureOpportunity, inLanguage, organization, organizationIdentifiers, organizationLogo,
  returnPolicy, siteNameWebsite, sitelinksSearchboxObsolete,
} from './site.ts';
import { extractInventory, jsonLdContext, jsonLdSyntaxError, microdataRdfaStructure } from './syntax.ts';
import { dateLogic, iso8601Values, placeholderJunkValues, urlValues } from './values.ts';
import { domainRangeMismatch, enumerationValues, supersededPendingTerm, unknownProperty, unknownType } from './vocabulary-rules.ts';

export const implementations: readonly RuleImplementation[] = [
  extractInventory, jsonLdSyntaxError, jsonLdContext, microdataRdfaStructure,
  unknownType, unknownProperty, domainRangeMismatch, supersededPendingTerm, enumerationValues,
  urlValues, iso8601Values, dateLogic, placeholderJunkValues,
  jsOnlyMarkup, rawRenderedConflict, idDanglingOrConflicting, duplicateFeatureNodes,
  entityConsistencySitewide, inLanguage, organization, organizationLogo, organizationIdentifiers, siteNameWebsite, sitelinksSearchboxObsolete,
  returnPolicy, courseList, authorEntityQuality, featureOpportunity,
  mainEntityPageFit, visibleContentParity, blockedOrNonindexableCarrier,
  localBusiness, article, breadcrumb, profilePage, video, imageMetadata, event, jobPosting, dataset, qaPage, discussionForum, paywalledContent, recipe,
  carouselItemList,
  productSnippet, merchantListing, gtinValidity, productVariants, offerPriceSpecification, shippingDetails, reviewSnippet, selfServingReviews,
  reviewAuthenticity, softwareApp, serviceOfferCatalog,
  faqPageRetired, retiredFeatureMarkup,
];
