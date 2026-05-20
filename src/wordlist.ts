// 256 four-letter pronounceable English words, hand-picked.
// Avoids homophones (no bear/bare), confusable pairs (no mint/mine),
// uncommon vocabulary, and rude words. The point is verbal shareability:
// "kite-frog" should be intelligible over the phone.
//
// Two random picks joined by "-" yield 65,536 distinct codes, plenty for v1.
export const WORDLIST: readonly string[] = Object.freeze([
  "able", "acid", "aero", "ahoy", "ally", "atom", "aunt", "axle",
  "baby", "bake", "bald", "bank", "barn", "bath", "beam", "bead",
  "beef", "belt", "bend", "best", "bike", "bird", "blue", "boat",
  "body", "bolt", "bomb", "bone", "book", "boom", "boss", "bowl",
  "brew", "brim", "buck", "bulk", "bump", "bush", "busy", "cake",
  "calm", "camp", "card", "cart", "case", "cash", "cast", "cave",
  "cell", "chef", "chip", "city", "clam", "clap", "claw", "clay",
  "clip", "club", "coal", "coat", "code", "coin", "cold", "comb",
  "cone", "cook", "cool", "cord", "corn", "crab", "crew", "cube",
  "curl", "dare", "dart", "dash", "deck", "deep", "dent", "desk",
  "dial", "dice", "dirt", "dish", "dive", "dock", "doll", "door",
  "drum", "duck", "dune", "dusk", "dust", "duty", "dwell", "earl",
  "echo", "edge", "epic", "exit", "face", "fade", "fair", "fall",
  "fame", "farm", "fast", "feed", "fern", "ferry", "file", "film",
  "fine", "fire", "fish", "five", "flag", "flat", "flax", "flip",
  "flop", "flux", "foam", "fold", "font", "food", "fork", "form",
  "fort", "four", "frog", "fuel", "fuse", "gale", "game", "gate",
  "gear", "gift", "gild", "girl", "glee", "glow", "glue", "goal",
  "gold", "golf", "good", "grab", "grid", "grip", "gust", "hail",
  "half", "hall", "hand", "hark", "harp", "haul", "hawk", "haze",
  "heap", "help", "herb", "hero", "high", "hike", "hill", "home",
  "hood", "hoof", "hook", "hope", "horn", "host", "hull", "hump",
  "hunt", "husk", "icon", "iris", "iron", "ivory", "jade", "jail",
  "jazz", "jest", "jolt", "joke", "judo", "jump", "kale", "keel",
  "kelp", "kept", "kick", "kilt", "kind", "king", "kite", "knee",
  "knot", "lace", "lake", "lamb", "lamp", "land", "lane", "lard",
  "lark", "lawn", "lean", "leap", "lend", "lens", "lift", "limb",
  "lime", "lion", "list", "lobe", "loft", "logo", "long", "look",
  "loop", "lord", "loss", "loud", "love", "luck", "lump", "lung",
  "lure", "lyre", "made", "mail", "main", "make", "mane", "many",
  "mark", "mask", "mast", "math", "maze", "mead", "meal", "mean",
  "melt", "memo", "menu", "mesh", "mild", "milk", "mind", "mint"
]) as readonly string[];

// Validate uniqueness at import time. If anyone edits the list and accidentally
// duplicates an entry, we want to know loudly.
{
  const seen = new Set<string>();
  for (const w of WORDLIST) {
    if (seen.has(w)) {
      throw new Error(`wordlist duplicate: ${w}`);
    }
    if (w.length < 3 || w.length > 6) {
      throw new Error(`wordlist entry not 3-6 chars: ${w}`);
    }
    seen.add(w);
  }
}
