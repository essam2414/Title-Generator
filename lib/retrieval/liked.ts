import 'server-only';
import { retrieveLiked } from '@/lib/db/client';
import type { LikedTitle } from '@/lib/providers/types';
import { aboveFloor } from '@/lib/feedback/rules';
import { LIKED_MATCH_LIMIT, LIKED_MIN_SIMILARITY } from './constants';

type Row = {
  title: string;
  hook_family: string;
  visual_description: string;
  similarity: number;
};

// Reuses the query vector the orchestrator already computed for corpus
// retrieval — no extra embedding call on the generation path.
export async function matchLikedTitles(
  creatorHandle: string,
  queryEmbedding: number[],
): Promise<LikedTitle[]> {
  return aboveFloor(retrieveLiked(creatorHandle, queryEmbedding, LIKED_MATCH_LIMIT) as Row[], LIKED_MIN_SIMILARITY)
    .map((r) => ({
      title: r.title,
      hookFamily: r.hook_family,
      visualDescription: r.visual_description,
    }));
}
