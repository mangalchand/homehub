const CATEGORIES: [string, RegExp][] = [
  ['Produce', /\b(apple|banana|orange|lemon|lime|grape|\w*berr(y|ies)|lettuce|spinach|kale|tomato|potato|onion|garlic|carrot|pepper|cucumber|avocado|broccoli|celery|mushroom|fruit|vegetable|herb|cilantro|basil|zucchini)s?\b/i],
  ['Dairy & Eggs', /\b(milk|cheese|yogh?urt|butter|cream|eggs?|sour cream|cottage)\b/i],
  ['Meat & Seafood', /\b(chicken|beef|pork|turkey|bacon|sausage|ham|steak|fish|salmon|tuna|shrimp|lamb|mince)\b/i],
  ['Bakery', /\b(bread|bagel|bun|roll|tortilla|muffin|croissant|cake|pita)s?\b/i],
  ['Pantry', /\b(rice|pasta|flour|sugar|salt|oil|vinegar|cereal|oats|beans|lentil|sauce|spice|honey|peanut butter|jam|soup|stock|broth|coffee|tea|nuts?)\b/i],
  ['Frozen', /\b(frozen|ice cream|pizza)\b/i],
  ['Snacks', /\b(chips|crackers|cookies|popcorn|candy|chocolate|granola|pretzel)s?\b/i],
  ['Beverages', /\b(juice|soda|water|sparkling|beer|wine|lemonade)\b/i],
  ['Household', /\b(paper towel|toilet paper|tissue|detergent|soap|dish|trash bag|sponge|bleach|cleaner|foil|wrap|batter(y|ies)|light bulb)s?\b/i],
  ['Personal Care', /\b(shampoo|conditioner|toothpaste|toothbrush|deodorant|lotion|razor|sunscreen|floss)\b/i],
  ['Baby & Pets', /\b(diaper|wipes|formula|dog food|cat food|litter|pet)s?\b/i],
];

/** Lightweight keyword categorizer for grocery items (user can always override). */
export function categorizeGrocery(name: string): string | null {
  for (const [cat, re] of CATEGORIES) if (re.test(name)) return cat;
  return null;
}

export const GROCERY_CATEGORY_ORDER = CATEGORIES.map(([c]) => c).concat(['Other']);
