import { PublicDietaryCategorySchema, RestaurantBriefSchema, type RestaurantBrief } from "../domain/index.js";
import type { AppDinner } from "./model.js";
/** Defense in depth: public restaurant facts cannot repeat private research context. */
export function publicRestaurantBrief(value: unknown, state: AppDinner): RestaurantBrief | undefined {
  const parsed = RestaurantBriefSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
  const privatePhrases = [
    ...Object.values(state.dinner.constraints).flatMap((constraints) => [
      ...(constraints.dietary ?? []).filter(item => !PublicDietaryCategorySchema.safeParse(normalize(item.requirement)).success).map(item => item.requirement),
      ...(constraints.travel?.origin ? [constraints.travel.origin] : []),
    ]),
    ...state.roster.flatMap(person => [person.name, ...(person.id.length >= 5 ? [person.id] : [])]),
  ].map(normalize).filter(phrase => phrase.length >= 3);
  const published = normalize(JSON.stringify(parsed.data));
  if (privatePhrases.some(phrase => published.includes(phrase))) return undefined;
  return parsed.data;
}
