/**
 * Google Search structured data features, with the properties Google's documentation marks as required and
 * recommended. A property path uses dots for nesting (`offers.price`) and `|` between alternatives that satisfy
 * the same requirement (`price|priceSpecification.price`). `verified` is the date the documentation page was read.
 */
export interface GoogleFeature {
  readonly id: string;
  readonly name: string;
  /** schema.org types that carry the feature; subtypes count. */
  readonly types: readonly string[];
  readonly docs: string;
  readonly verified: string;
  /** `active`, `limited` (region, beta or partner only) or `retired` (no longer shown in Google Search). */
  readonly status: 'active' | 'limited' | 'retired';
  readonly required: readonly string[];
  readonly recommended: readonly string[];
}

const docs = (slug: string) => `https://developers.google.com/search/docs/appearance/structured-data/${slug}`;

export const googleFeatures: readonly GoogleFeature[] = [
  {
    id: 'article', name: 'Article', types: ['Article'], docs: docs('article'), verified: '2026-11-04', status: 'active',
    required: [], recommended: ['author', 'author.name', 'author.url|author.sameAs', 'dateModified', 'datePublished', 'headline', 'image'],
  },
  {
    id: 'breadcrumb', name: 'Breadcrumb', types: ['BreadcrumbList'], docs: docs('breadcrumb'), verified: '2026-11-04', status: 'active',
    required: ['itemListElement'], recommended: [],
  },
  {
    id: 'carousel', name: 'Carousel', types: ['ItemList'], docs: docs('carousel'), verified: '2026-11-04', status: 'active',
    required: ['itemListElement'], recommended: [],
  },
  {
    id: 'carousels-beta', name: 'Structured data carousels (beta)', types: ['ItemList'], docs: docs('carousels-beta'), verified: '2026-11-04', status: 'limited',
    required: ['itemListElement'], recommended: [],
  },
  {
    id: 'course-list', name: 'Course list', types: ['Course'], docs: docs('course'), verified: '2026-11-04', status: 'active',
    required: ['description', 'name'], recommended: ['provider'],
  },
  {
    id: 'dataset', name: 'Dataset', types: ['Dataset'], docs: docs('dataset'), verified: '2026-11-04', status: 'limited',
    required: ['description', 'name'],
    recommended: ['alternateName', 'creator', 'citation', 'funder', 'hasPart|isPartOf', 'identifier', 'isAccessibleForFree', 'keywords', 'license',
      'measurementTechnique', 'sameAs', 'spatialCoverage', 'temporalCoverage', 'variableMeasured', 'version', 'url'],
  },
  {
    id: 'discussion-forum', name: 'Discussion forum', types: ['DiscussionForumPosting', 'SocialMediaPosting'], docs: docs('discussion-forum'),
    verified: '2026-11-04', status: 'active',
    required: ['author', 'author.name', 'datePublished', 'text|image|video'],
    recommended: ['author.url', 'comment', 'commentCount', 'creativeWorkStatus', 'dateModified', 'digitalSourceType', 'headline', 'image',
      'interactionStatistic', 'isPartOf', 'sharedContent', 'text', 'url', 'video'],
  },
  {
    id: 'event', name: 'Event', types: ['Event'], docs: docs('event'), verified: '2026-11-04', status: 'active',
    required: ['location', 'location.address', 'name', 'startDate'],
    recommended: ['description', 'endDate', 'eventStatus', 'image', 'location.name', 'offers', 'offers.availability', 'offers.price',
      'offers.priceCurrency', 'offers.validFrom', 'offers.url', 'organizer', 'organizer.name', 'organizer.url', 'performer', 'performer.name',
      'previousStartDate'],
  },
  {
    id: 'image-metadata', name: 'Image metadata', types: ['ImageObject'], docs: docs('image-license-metadata'), verified: '2026-11-04', status: 'active',
    required: ['contentUrl', 'creator|creditText|copyrightNotice|license'],
    recommended: ['acquireLicensePage', 'creator', 'creator.name', 'creditText', 'copyrightNotice', 'license'],
  },
  {
    id: 'job-posting', name: 'Job posting', types: ['JobPosting'], docs: docs('job-posting'), verified: '2026-11-04', status: 'limited',
    required: ['datePosted', 'description', 'hiringOrganization', 'jobLocation|applicantLocationRequirements', 'title'],
    recommended: ['applicantLocationRequirements', 'baseSalary', 'directApply', 'employmentType', 'identifier', 'jobLocationType', 'validThrough',
      'educationRequirements', 'experienceRequirements', 'experienceInPlaceOfEducation'],
  },
  {
    id: 'local-business', name: 'Local business', types: ['LocalBusiness'], docs: docs('local-business'), verified: '2026-11-04', status: 'active',
    required: ['address', 'name'],
    recommended: ['aggregateRating', 'department', 'geo', 'geo.latitude', 'geo.longitude', 'menu', 'openingHoursSpecification', 'priceRange',
      'review', 'servesCuisine', 'telephone', 'url'],
  },
  {
    id: 'merchant-listing', name: 'Merchant listing', types: ['Product'], docs: docs('merchant-listing'), verified: '2026-11-04', status: 'active',
    required: ['name', 'image', 'offers', 'offers.price|offers.priceSpecification.price', 'offers.priceCurrency|offers.priceSpecification.priceCurrency'],
    recommended: ['aggregateRating', 'audience', 'brand.name', 'category', 'color', 'description', 'gtin|gtin8|gtin12|gtin13|gtin14|isbn',
      'hasAdultConsideration', 'hasCertification', 'inProductGroupWithID', 'isVariantOf', 'material', 'mpn', 'pattern', 'review', 'size', 'sku',
      'subjectOf', 'offers.availability', 'offers.hasMerchantReturnPolicy', 'offers.itemCondition', 'offers.priceValidUntil',
      'offers.shippingDetails', 'offers.url', 'offers.validFrom', 'offers.validThrough'],
  },
  {
    id: 'organization', name: 'Organization', types: ['Organization'], docs: docs('organization'), verified: '2026-11-03', status: 'active',
    required: [],
    recommended: ['address', 'alternateName', 'contactPoint', 'description', 'duns', 'email', 'foundingDate', 'globalLocationNumber',
      'hasMerchantReturnPolicy', 'hasMemberProgram', 'hasShippingService', 'iso6523Code', 'legalName', 'leiCode', 'logo', 'naics',
      'numberOfEmployees', 'sameAs', 'taxID', 'telephone', 'url', 'vatID', 'name'],
  },
  {
    id: 'paywalled-content', name: 'Paywalled content', types: ['CreativeWork'], docs: docs('paywalled-content'), verified: '2026-11-04', status: 'active',
    required: ['isAccessibleForFree'], recommended: ['hasPart', 'hasPart.cssSelector', 'hasPart.isAccessibleForFree'],
  },
  {
    id: 'product-snippet', name: 'Product snippet', types: ['Product'], docs: docs('product-snippet'), verified: '2026-11-04', status: 'active',
    required: ['name', 'review|aggregateRating|offers'],
    recommended: ['aggregateRating', 'offers', 'review', 'offers.availability', 'offers.priceCurrency', 'offers.priceValidUntil'],
  },
  {
    id: 'product-variants', name: 'Product variants', types: ['ProductGroup'], docs: docs('product-variants'), verified: '2026-11-04', status: 'active',
    required: ['name'],
    recommended: ['aggregateRating', 'brand', 'brand.name', 'description', 'hasAdultConsideration', 'hasVariant', 'productGroupID', 'review', 'url', 'variesBy'],
  },
  {
    id: 'profile-page', name: 'Profile page', types: ['ProfilePage'], docs: docs('profile-page'), verified: '2026-11-04', status: 'active',
    required: ['mainEntity', 'mainEntity.name|mainEntity.alternateName'],
    recommended: ['dateCreated', 'dateModified', 'mainEntity.agentInteractionStatistic', 'mainEntity.alternateName', 'mainEntity.description',
      'mainEntity.identifier', 'mainEntity.image', 'mainEntity.interactionStatistic', 'mainEntity.sameAs'],
  },
  {
    id: 'qa-page', name: 'Q&A', types: ['QAPage'], docs: docs('qapage'), verified: '2026-11-04', status: 'active',
    required: ['mainEntity', 'mainEntity.name', 'mainEntity.answerCount', 'mainEntity.acceptedAnswer|mainEntity.suggestedAnswer'],
    recommended: ['mainEntity.author', 'mainEntity.text', 'mainEntity.upvoteCount', 'mainEntity.datePublished', 'mainEntity.dateModified'],
  },
  {
    id: 'recipe', name: 'Recipe', types: ['Recipe'], docs: docs('recipe'), verified: '2026-11-04', status: 'active',
    required: ['image', 'name'],
    recommended: ['aggregateRating', 'author', 'cookTime', 'datePublished', 'description', 'keywords', 'nutrition.calories', 'prepTime',
      'recipeCategory', 'recipeCuisine', 'recipeIngredient', 'recipeInstructions', 'recipeYield', 'totalTime', 'video'],
  },
  {
    id: 'return-policy', name: 'Merchant return policy', types: ['MerchantReturnPolicy'], docs: docs('return-policy'), verified: '2026-11-04', status: 'active',
    required: ['applicableCountry|merchantReturnLink', 'returnPolicyCategory|merchantReturnLink'],
    recommended: ['merchantReturnDays', 'returnFees', 'returnMethod', 'returnShippingFeesAmount', 'returnPolicyCountry'],
  },
  {
    id: 'review-snippet', name: 'Review snippet', types: ['Review', 'AggregateRating'], docs: docs('review-snippet'), verified: '2026-11-04', status: 'active',
    required: ['author', 'reviewRating', 'reviewRating.ratingValue', 'ratingValue', 'ratingCount|reviewCount', 'itemReviewed'],
    recommended: ['datePublished', 'bestRating', 'worstRating', 'reviewRating.bestRating', 'reviewRating.worstRating'],
  },
  {
    id: 'shipping-policy', name: 'Shipping policy', types: ['OfferShippingDetails', 'ShippingService'], docs: docs('shipping-policy'),
    verified: '2026-11-03', status: 'active',
    required: ['deliveryTime', 'shippingDestination', 'shippingRate', 'shippingRate.currency', 'shippingRate.value|shippingRate.maxValue'],
    recommended: [],
  },
  {
    id: 'site-name', name: 'Site name', types: ['WebSite'], docs: 'https://developers.google.com/search/docs/appearance/site-names',
    verified: '2026-11-04', status: 'active', required: ['name', 'url'], recommended: ['alternateName'],
  },
  {
    id: 'software-app', name: 'Software app', types: ['SoftwareApplication'], docs: docs('software-app'), verified: '2026-11-04', status: 'active',
    required: ['name', 'offers.price', 'aggregateRating|review'], recommended: ['applicationCategory', 'operatingSystem'],
  },
  {
    id: 'video', name: 'Video', types: ['VideoObject'], docs: docs('video'), verified: '2026-11-04', status: 'active',
    required: ['name', 'thumbnailUrl', 'uploadDate'],
    recommended: ['contentUrl', 'creator|author', 'description', 'duration', 'embedUrl', 'expires', 'hasPart', 'ineligibleRegion',
      'interactionStatistic', 'publication', 'regionsAllowed'],
  },
  {
    id: 'faq', name: 'FAQ', types: ['FAQPage'], docs: 'https://developers.google.com/search/updates', verified: '2026-11-04', status: 'retired',
    required: [], recommended: [],
  },
];

/** Every property name that some feature lists, at any nesting level. */
export const documentedProperties: ReadonlySet<string> = new Set(googleFeatures.flatMap(feature => [...feature.required, ...feature.recommended])
  .flatMap(path => path.split('|')).flatMap(path => path.split('.')));

/**
 * Rich results Google retired, with the date it stopped showing them or removed their documentation.
 * Source: https://developers.google.com/search/updates and the June 2025 simplification post.
 */
export const retiredFeatures: Readonly<Record<string, { readonly feature: string; readonly date: string }>> = {
  HowTo: { feature: 'How-to', date: '2023-09-13' },
  SpecialAnnouncement: { feature: 'Special announcement', date: '2025-07-31' },
  ClaimReview: { feature: 'Fact check (ClaimReview)', date: '2025-09-09' },
  Occupation: { feature: 'Estimated salary', date: '2025-09-09' },
  Vehicle: { feature: 'Vehicle listing', date: '2025-09-09' },
  Quiz: { feature: 'Practice problems', date: '2026-01-06' },
};
