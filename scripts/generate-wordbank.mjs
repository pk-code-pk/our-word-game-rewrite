import fs from "node:fs";
import path from "node:path";
import wordListPath from "word-list";
// CJS package: Node's ESM interop exposes the named `words` export but no default.
import { words as popularWords } from "popular-english-words";

const projectRoot = process.cwd();
const outputPath = path.join(projectRoot, "shared", "wordLists.ts");

// How many of the most common words the bot may draw its secret from.
//
// The full dictionary is a Scrabble word list: legal, but two-thirds of it is
// words like GLISK, NUGAE, and AXOID. A bot secret drawn from all of it is
// unwinnable in practice — you can deduce the letter set perfectly and still
// have no idea what the word is — while the bot solves your ordinary word
// fine, because it searches the whole dictionary. That asymmetry is what makes
// a bot game feel rigged rather than lost.
//
// So the bot's secret comes from a frequency-ranked prefix instead. Quality
// holds well past rank 1500 (weary, inert, recap, polka, haste, peril) and is
// clearly gone by 4000 (zloty, korai, kylix, uncia, coxae). Raise this for more
// variety, lower it if bot secrets still feel obscure.
const BOT_SECRET_POOL_SIZE = 1500;

// Words that read only as proper nouns. The base dictionary (SCOWL, via
// `word-list`) includes names and places lowercased — `pedro`, `doris`, and
// `paris` are all legal words — and the frequency source is Wikipedia-derived,
// so names surface near the top. A bot secret of PEDRO isn't unguessable the
// way GLISK is, but it reads as a bug.
//
// This is a hand-picked list rather than a subtraction of a names dataset on
// purpose. Roughly 6% of the pool matches a first-name list, but most of those
// are ordinary words that happen to also be names — STONE, OCEAN, GRACE,
// STORM, TIGER, PEARL, DAISY, BLAZE, HAZEL, ROBIN, OLIVE, AMBER. Subtracting
// the whole intersection would throw away some of the best secret words in the
// game to remove a handful of bad ones. Only entries with no everyday
// common-noun reading are listed here; edit freely.
const PROPER_NOUN_EXCLUSIONS = new Set([
  "james", "paris", "henry", "louis", "lewis", "craig", "pedro", "ralph",
  "oscar", "colin", "cohen", "tyler", "devon", "homer", "logan", "denis",
  "riley", "monte", "randy", "kirby", "fritz", "malik", "brent", "shawn",
  "doris", "brock", "mitch", "rubin", "ariel", "corey", "norma", "slade",
  "erica", "louie", "monty", "clint", "garth", "butch", "kylie", "darcy",
  "lacey", "judas", "colby", "marge",
]);

const words = fs
  .readFileSync(wordListPath, "utf8")
  .split("\n")
  .map((word) => word.trim().toLowerCase())
  .filter(Boolean);

const filteredWords = words.filter(
  (word) => /^[a-z]+$/.test(word) && (word.length === 4 || word.length === 5) && new Set(word).size === word.length
);

const fourLetterWords = filteredWords.filter((word) => word.length === 4);
const fiveLetterWords = filteredWords.filter((word) => word.length === 5);

// Ranked most-common-first. Intersected with the game dictionary so every bot
// secret is a word a player could also have chosen and the validator accepts.
const legalFiveLetter = new Set(fiveLetterWords);
const botSecretWords = popularWords
  .getMostPopular(300000)
  .filter(
    (word) =>
      typeof word === "string" &&
      /^[a-z]{5}$/.test(word) &&
      new Set(word).size === 5 &&
      legalFiveLetter.has(word) &&
      !PROPER_NOUN_EXCLUSIONS.has(word)
  )
  .slice(0, BOT_SECRET_POOL_SIZE);

if (botSecretWords.length < BOT_SECRET_POOL_SIZE) {
  console.warn(
    `Warning: only ${botSecretWords.length} bot secret words available (wanted ${BOT_SECRET_POOL_SIZE}).`
  );
}

const content = `export const FOUR_LETTER_WORDS = ${JSON.stringify(fourLetterWords, null, 2)};

export const FIVE_LETTER_WORDS = ${JSON.stringify(fiveLetterWords, null, 2)};

// The pool the bot draws its own secret from — the ${BOT_SECRET_POOL_SIZE} most common
// five-letter words with no repeated letters, ranked by frequency. A subset of
// FIVE_LETTER_WORDS, so every entry is also a legal player word. See
// scripts/generate-wordbank.mjs for why the bot does not use the full list.
export const BOT_SECRET_WORDS = ${JSON.stringify(botSecretWords, null, 2)};
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, content, "utf8");

console.log(
  `Generated ${fourLetterWords.length} four-letter words, ${fiveLetterWords.length} five-letter words, ` +
    `and ${botSecretWords.length} bot secret words at ${outputPath}`
);
