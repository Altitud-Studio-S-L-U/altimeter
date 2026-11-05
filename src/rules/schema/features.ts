import { googleFeatures, type GoogleFeature } from '../../data/google-features.ts';
import { isA } from './vocabulary.ts';

/** Types that carry a Google Search feature, with their common subtypes resolved through the vocabulary. */
export const featureTypes: ReadonlySet<string> = new Set(googleFeatures.flatMap(feature => feature.types));

/** Active or limited features a node with these types can carry. */
export function featuresFor(types: readonly string[]): GoogleFeature[] {
  return googleFeatures.filter(feature => feature.status !== 'retired' && feature.types.some(type => isA(types, type)));
}

/** Whether `property` is one a feature of these types requires, at its first nesting level. */
export function requiredBy(types: readonly string[], property: string): GoogleFeature | undefined {
  return featuresFor(types).find(feature => feature.required.some(path => path.split('|').some(entry => entry.split('.')[0] === property)));
}

/** Whether a feature of these types lists `property` as required or recommended, at its first nesting level. */
export function documentedFor(types: readonly string[], property: string): boolean {
  return featuresFor(types).some(feature => [...feature.required, ...feature.recommended]
    .some(path => path.split('|').some(entry => entry.split('.')[0] === property)));
}

/** Types whose markup is page content rather than site identity; used to tell which pages carry feature markup. */
export const pageFeatureTypes = ['Product', 'ProductGroup', 'Recipe', 'Event', 'JobPosting', 'VideoObject', 'Article', 'Review', 'AggregateRating',
  'Course', 'Dataset', 'QAPage', 'DiscussionForumPosting', 'SocialMediaPosting', 'ProfilePage', 'LocalBusiness', 'SoftwareApplication'] as const;
