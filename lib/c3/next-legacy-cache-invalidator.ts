/** Next adapter: requests the contracted legacy page and preview path invalidation. Queues work; observes no completion. */
import { revalidatePath } from "next/cache";
import type { LegacyCacheInvalidator } from "./cache-revalidation";

export const nextLegacyCacheInvalidator: LegacyCacheInvalidator = {
  invalidateLegacyRoast(slug: string): void {
    revalidatePath(`/r/${slug}`);
    revalidatePath(`/r/${slug}/opengraph-image`);
  },
};
